import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	NodeOperationError,
	validateNodeParameters,
} from 'n8n-workflow';

import type {
	InteractionContent,
	InteractionGenerationConfig,
} from './interfaces';
import {
	createInteraction,
	getOutputText,
	toInteractionContent,
	toInteractionModel,
} from './interactions';
import { downloadFile, uploadFile } from './utils';
import { apiRequest } from '../transport';

export async function baseAnalyze(
	this: IExecuteFunctions,
	i: number,
	urlsPropertyName: string,
	fallbackMimeType: string,
): Promise<INodeExecutionData[]> {
	const rawModel = this.getNodeParameter('modelId', i, '', { extractValue: true }) as string;
	const model = toInteractionModel(rawModel);

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

	const supportsThinkingLevel = /^gemini-3/.test(model);

	if (options.thinkingLevel && supportsThinkingLevel) {
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

	const response = await createInteraction.call(this, body as unknown as IDataObject);

	if (simplify) {
		return [{ json: { text: getOutputText(response) }, pairedItem: { item: i } }];
	}

	return [{ json: response as unknown as IDataObject, pairedItem: { item: i } }];
}
