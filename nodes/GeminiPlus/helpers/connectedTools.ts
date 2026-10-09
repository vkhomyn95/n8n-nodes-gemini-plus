import {
	NodeConnectionTypes,
	NodeOperationError,
	type IExecuteFunctions,
} from 'n8n-workflow';
import zodToJsonSchema from 'zod-to-json-schema';

export interface ConnectedTool {
	name: string;
	description: string;
	schema: unknown;
	invoke(input: unknown): Promise<unknown>;
	asDynamicTool?: () => ConnectedTool;
}

type Toolkit = { tools: ConnectedTool[] };

function isToolkit(item: unknown): item is Toolkit {
	return (
		typeof item === 'object' && item !== null && Array.isArray((item as { tools?: unknown }).tools)
	);
}

function isZodSchema(schema: unknown): boolean {
	return (
		typeof schema === 'object' &&
		schema !== null &&
		typeof (schema as { safeParse?: unknown }).safeParse === 'function'
	);
}

export async function getConnectedTools(
	ctx: IExecuteFunctions,
	enforceUniqueNames = true,
): Promise<ConnectedTool[]> {
	const connections = (await ctx.getInputConnectionData(NodeConnectionTypes.AiTool, 0)) as
		| Array<ConnectedTool | Toolkit>
		| undefined;

	const flat = (connections ?? []).flatMap((item) => (isToolkit(item) ? item.tools : [item]));

	// N8nTool у оригіналі перетворюється на DynamicTool, повторюємо цю поведінку
	const tools = flat.map((tool) =>
		typeof tool.asDynamicTool === 'function' ? tool.asDynamicTool() : tool,
	);

	if (enforceUniqueNames) {
		const seen = new Set<string>();
		for (const { name } of tools) {
			if (seen.has(name)) {
				throw new NodeOperationError(
					ctx.getNode(),
					`You have multiple tools with the same name: '${name}', please rename them to avoid conflicts`,
				);
			}
			seen.add(name);
		}
	}

	return tools;
}

export function toGeminiParameters(schema: unknown) {
	let json: unknown;
	if (isZodSchema(schema)) {
		json = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
			target: 'openApi3',
		});
	} else if (schema && typeof schema === 'object') {
		// звичайна JSON-схема: прибираємо поле, яке Gemini не приймає
		const { $schema, ...rest } = schema as Record<string, unknown>;
		void $schema;
		json = rest;
	} else {
		json = { type: 'object', properties: {} };
	}

	return {
		...(json as ReturnType<typeof zodToJsonSchema>),
		// Google Gemini API видає помилку, якщо є поле additionalProperties
		additionalProperties: undefined,
	};
}
