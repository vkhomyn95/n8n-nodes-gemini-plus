import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	NodeOperationError,
	validateNodeParameters,
} from 'n8n-workflow';

import type {
	Interaction,
	InteractionContent,
	InteractionGenerationConfig,
} from './interfaces';
import { downloadFile, uploadFile } from './utils';
import { apiRequest } from '../transport';

type MediaType = 'image' | 'audio' | 'video' | 'document';

function getMediaType(mimeType: string): MediaType {
	if (mimeType.startsWith('image/')) return 'image';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType.startsWith('video/')) return 'video';
	return 'document';
}

function toInteractionContent(uri: string, mimeType: string): InteractionContent {
	// У SDK mime_type — вузький union для кожного типу (в ранніх 2.x без `string`),
	// а API приймає будь-який підтримуваний mime, тому тут свідомий cast.
	return { type: getMediaType(mimeType), uri, mime_type: mimeType } as InteractionContent;
}

/**
 * Перетворює відповідь Interactions API у формат generateContent:
 * candidates / usageMetadata / modelVersion / responseId.
 *
 * Назви полів `usage.*` взято з beta-схеми Interactions API. Якщо щось не збігається —
 * тимчасово поверніть сиру відповідь і перевірте реальні назви.
 */
function toLegacyResponse(response: Interaction): IDataObject {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const r = response as any;
	const u = r.usage ?? {};

	// Усі текстові частини з усіх model_output кроків зливаємо в одного candidate
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const parts = (r.steps ?? [])
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		.filter((s: any) => s.type === 'model_output')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		.flatMap((s: any) =>
			(s.content ?? [])
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.filter((c: any) => c.type === 'text')
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.map((c: any) => ({ text: c.text })),
		);

	const finishReasonMap: Record<string, string> = {
		completed: 'STOP',
		incomplete: 'MAX_TOKENS',
		failed: 'OTHER',
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const promptTokensDetails = (u.input_tokens_by_modality ?? []).map((m: any) => ({
		modality: String(m.modality).toUpperCase(),
		tokenCount: m.tokens ?? m.token_count ?? 0,
	}));

	return {
		candidates: [
			{
				content: { parts, role: 'model' },
				finishReason: finishReasonMap[r.status] ?? 'STOP',
				index: 0,
			},
		],
		usageMetadata: {
			promptTokenCount: u.total_input_tokens ?? 0,
			candidatesTokenCount: u.total_output_tokens ?? 0,
			totalTokenCount: u.total_tokens ?? 0,
			promptTokensDetails,
			thoughtsTokenCount: u.total_thought_tokens ?? 0,
			serviceTier: r.service_tier ?? 'standard',
		},
		modelVersion: r.model,
		responseId: r.id,
	};
}

export async function baseAnalyze(
	this: IExecuteFunctions,
	i: number,
	urlsPropertyName: string,
	fallbackMimeType: string,
): Promise<INodeExecutionData[]> {
	const rawModel = this.getNodeParameter('modelId', i, '', { extractValue: true }) as string;
	// Раніше було "models/gemini-..." (для URL), в Interactions API потрібен просто
	const model = rawModel.replace(/^models\//, '');

	const inputType = this.getNodeParameter('inputType', i, 'url') as string;
	const text = this.getNodeParameter('text', i, '') as string;
	if (!text.trim()) {
		throw new NodeOperationError(this.getNode(), 'A non-empty prompt is required.', {
			itemIndex: i,
		});
	}
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const options = this.getNodeParameter('options', i, {});
	validateNodeParameters(
		options,
		{
			maxOutputTokens: { type: 'number', required: false },
			thinkingLevel: { type: 'string', required: false },
		},
		this.getNode(),
	);

	const generationConfig: InteractionGenerationConfig = {};
	if (options.maxOutputTokens !== undefined) {
		generationConfig.max_output_tokens = options.maxOutputTokens as number;
	}
	if (options.thinkingLevel) {
		generationConfig.thinking_level = options.thinkingLevel as string;
	}

	// Files API не змінився: uploadFile повертає { fileUri, mimeType }
	let filesData: Array<{ fileUri: string; mimeType: string }>;

	if (inputType === 'url') {
		const urls = this.getNodeParameter(urlsPropertyName, i, '') as string;
		const filesDataPromises = urls
			.split(',')
			.map((url) => url.trim())
			.filter((url) => url)
			.map(async (url) => {
				if (url.startsWith('https://generativelanguage.googleapis.com')) {
					const { mimeType } = (await apiRequest.call(this, 'GET', '', {
						option: { url },
					})) as { mimeType: string };
					return { fileUri: url, mimeType };
				} else {
					const { fileContent, mimeType } = await downloadFile.call(this, url, fallbackMimeType);
					return await uploadFile.call(this, fileContent, mimeType as string);
				}
			});
		filesData = await Promise.all(filesDataPromises);
	} else {
		const binaryPropertyNames = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
		const promises = binaryPropertyNames
			.split(',')
			.map((name) => name.trim())
			.filter((name) => name)
			.map(async (binaryPropertyName) => {
				const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
				const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
				return await uploadFile.call(this, buffer, binaryData.mimeType);
			});
		filesData = await Promise.all(promises);
	}

	// contents[].parts[].fileData  ->  input[] з типізованими блоками
	const input: InteractionContent[] = [
		...filesData.map((f) => toInteractionContent(f.fileUri, f.mimeType)),
		{ type: 'text', text },
	];

	const body = {
		model,
		input,
		// За замовчуванням Interactions API зберігає запити на сервері (store=true).
		// Якщо не хочеш зберігати документи/промпти — розкоментуй:
		// store: false,
		...(Object.keys(generationConfig).length ? { generation_config: generationConfig } : {}),
	};

	const response = (await apiRequest.call(this, 'POST', '/v1beta/interactions', {
		body: body as unknown as IDataObject,
	})) as Interaction;

	// Відладка: щоб побачити сиру відповідь API, тимчасово розкоментуйте
	// return [{ json: response as unknown as IDataObject, pairedItem: { item: i } }];

	const legacy = toLegacyResponse(response);

	if (simplify) {
		// Як у старій ноді: лише content першого кандидата.
		// Вирази на кшталт {{ $json.content.parts[0].text }} продовжують працювати.
		return [
			{
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				json: { content: (legacy.candidates as any[])[0].content },
				pairedItem: { item: i },
			},
		];
	}

	// Без simplify — той самий вигляд, що на скріншоті:
	// candidates, usageMetadata, modelVersion, responseId
	return [{ json: legacy, pairedItem: { item: i } }];
}