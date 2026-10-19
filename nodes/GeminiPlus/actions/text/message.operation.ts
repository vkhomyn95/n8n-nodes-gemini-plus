import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	NodeOperationError,
	accumulateTokenUsage,
	jsonParse,
	updateDisplayOptions,
	validateNodeParameters,
} from 'n8n-workflow';

import { getConnectedTools, toGeminiParameters } from '../../helpers/connectedTools';
import {
	createInteraction,
	getOutputText,
	toInteractionModel,
} from '../../helpers/interactions';
import type {
	BuiltInTools,
	Interaction,
	InteractionGenerationConfig,
	InteractionStep,
	InteractionTextContent,
	InteractionTool,
} from '../../helpers/interfaces';
import { modelRLC } from '../descriptions';

const properties: INodeProperties[] = [
	{ ...modelRLC('modelSearch'), displayOptions: { show: { '@version': [{ _cnd: { lt: 1.2 } }] } } },
	{
		...modelRLC('modelSearch'),
		default: { mode: 'list', value: 'models/gemini-3-flash-preview' },
		displayOptions: { show: { '@version': [{ _cnd: { gte: 1.2 } }] } },
	},
	{
		displayName: 'Messages',
		name: 'messages',
		type: 'fixedCollection',
		typeOptions: {
			sortable: true,
			multipleValues: true,
		},
		placeholder: 'Add Message',
		default: { values: [{ content: '' }] },
		options: [
			{
				displayName: 'Values',
				name: 'values',
				values: [
					{
						displayName: 'Prompt',
						name: 'content',
						type: 'string',
						description: 'The content of the message to be send',
						default: '',
						placeholder: 'e.g. Hello, how can you help me?',
						typeOptions: {
							rows: 2,
						},
					},
					{
						displayName: 'Role',
						name: 'role',
						type: 'options',
						description:
							"Role in shaping the model's response, it tells the model how it should behave and interact with the user",
						options: [
							{
								name: 'User',
								value: 'user',
								description: 'Send a message as a user and get a response from the model',
							},
							{
								name: 'Model',
								value: 'model',
								description: 'Tell the model to adopt a specific tone or personality',
							},
						],
						default: 'user',
					},
				],
			},
		],
	},
	{
		displayName: 'Simplify Output',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to return a simplified version of the response instead of the raw data',
	},
	{
		displayName: 'Output Content as JSON',
		name: 'jsonOutput',
		type: 'boolean',
		description: 'Whether to attempt to return the response in JSON format',
		default: false,
	},
	{
		displayName: 'Built-in Tools',
		name: 'builtInTools',
		placeholder: 'Add Built-in Tool',
		type: 'collection',
		default: {},
		displayOptions: {
			show: {
				'@version': [{ _cnd: { gte: 1.1 } }],
			},
		},
		options: [
			{
				displayName: 'Google Search',
				name: 'googleSearch',
				type: 'boolean',
				default: true,
				description:
					'Whether to allow the model to search the web using Google Search to get real-time information',
			},
			{
				displayName: 'Google Maps',
				name: 'googleMaps',
				type: 'collection',
				default: { latitude: '', longitude: '' },
				options: [
					{
						displayName: 'Latitude',
						name: 'latitude',
						type: 'number',
						default: '',
						description: 'The latitude coordinate for location-based queries',
						typeOptions: {
							numberPrecision: 6,
						},
					},
					{
						displayName: 'Longitude',
						name: 'longitude',
						type: 'number',
						default: '',
						description: 'The longitude coordinate for location-based queries',
						typeOptions: {
							numberPrecision: 6,
						},
					},
				],
			},
			{
				displayName: 'URL Context',
				name: 'urlContext',
				type: 'boolean',
				default: true,
				description: 'Whether to allow the model to read and analyze content from specific URLs',
			},
			{
				displayName: 'File Search',
				name: 'fileSearch',
				type: 'collection',
				default: { fileSearchStoreNames: '[]' },
				options: [
					{
						displayName: 'File Search Store Names',
						name: 'fileSearchStoreNames',
						description:
							'The file search store names to use for the file search. File search stores are managed via Google AI Studio.',
						type: 'json',
						default: '[]',
						required: true,
					},
					{
						displayName: 'Metadata Filter',
						name: 'metadataFilter',
						type: 'string',
						default: '',
						description:
							'Use metadata filter to search within a subset of documents. Example: author="Robert Graves".',
						placeholder: 'e.g. author="John Doe"',
					},
				],
			},
			{
				displayName: 'Code Execution',
				name: 'codeExecution',
				type: 'boolean',
				default: true,
				description:
					'Whether to allow the model to execute code it generates to produce a response. Supported only by certain models.',
			},
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		placeholder: 'Add Option',
		type: 'collection',
		default: {},
		options: [
			{
				displayName: 'System Message',
				name: 'systemMessage',
				type: 'string',
				default: '',
				placeholder: 'e.g. You are a helpful assistant',
			},
			{
				displayName: 'Code Execution',
				name: 'codeExecution',
				type: 'boolean',
				default: false,
				description:
					'Whether to allow the model to execute code it generates to produce a response. Supported only by certain models.',
				displayOptions: {
					show: {
						'@version': [{ _cnd: { eq: 1 } }],
					},
				},
			},
			{
				displayName: 'Maximum Number of Tokens',
				name: 'maxOutputTokens',
				default: 16,
				description: 'The maximum number of tokens to generate in the completion',
				type: 'number',
				typeOptions: {
					minValue: 1,
					numberPrecision: 0,
				},
			},
			{
				displayName: 'Output Randomness (Temperature)',
				name: 'temperature',
				default: 1,
				description:
					'Controls the randomness of the output. Lowering results in less random completions. As the temperature approaches zero, the model will become deterministic and repetitive',
				type: 'number',
				typeOptions: {
					minValue: 0,
					maxValue: 2,
					numberPrecision: 1,
				},
			},
			{
				displayName: 'Output Randomness (Top P)',
				name: 'topP',
				default: 1,
				description: 'The maximum cumulative probability of tokens to consider when sampling',
				type: 'number',
				typeOptions: {
					minValue: 0,
					maxValue: 1,
					numberPrecision: 1,
				},
			},
			{
				displayName: 'Thinking Level',
				name: 'thinkingLevel',
				type: 'options',
				default: 'medium',
				description: 'Configuration for dynamic thinking behavior (default is Medium). Used only for Gemini 3 models',
				options: [
					{ name: 'Minimal', value: 'minimal' },
					{ name: 'Low', value: 'low' },
					{ name: 'Medium', value: 'medium' },
					{ name: 'High', value: 'high' },
				],
			},
			{
				displayName: 'Max Tool Calls Iterations',
				name: 'maxToolsIterations',
				type: 'number',
				default: 15,
				description: 'The maximum number of tool iteration cycles the LLM will run before stopping. A single iteration can contain multiple tool calls. Set to 0 for no limit',
				typeOptions: {
					minValue: 0,
					numberPrecision: 0,
				},
			},
		],
	},
];

const displayOptions = {
	show: {
		operation: ['message'],
		resource: ['text'],
	},
};

export const description = updateDisplayOptions(displayOptions, properties);


type FunctionCallStep = Extract<InteractionStep, { type: 'function_call' }>;
type FunctionResultStep = Extract<InteractionStep, { type: 'function_result' }>;

function getToolCalls(response: Interaction): FunctionCallStep[] {
	return (response.steps ?? []).filter((s): s is FunctionCallStep => s.type === 'function_call');
}

export async function execute(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const rawModel = this.getNodeParameter('modelId', i, '', { extractValue: true }) as string;
	const model = toInteractionModel(rawModel);
	const messages = this.getNodeParameter('messages.values', i, []) as Array<{
		content: string;
		role: string;
	}>;
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const jsonOutput = this.getNodeParameter('jsonOutput', i, false) as boolean;
	const options = this.getNodeParameter('options', i, {});
	const builtInTools = this.getNodeParameter('builtInTools', i, {}) as BuiltInTools;
	validateNodeParameters(
		options,
		{
			systemMessage: { type: 'string', required: false },
			codeExecution: { type: 'boolean', required: false },
			maxOutputTokens: { type: 'number', required: false },
			temperature: { type: 'number', required: false },
			topP: { type: 'number', required: false },
			thinkingLevel: { type: 'string', required: false },
			maxToolsIterations: { type: 'number', required: false },
		},
		this.getNode(),
	);

	// frequencyPenalty / presencePenalty / topK / candidateCount / thinkingBudget
	// в Interactions API відсутні, тому з опцій їх прибрано
	const generationConfig: InteractionGenerationConfig = {};
	if (options.maxOutputTokens !== undefined) {
		generationConfig.max_output_tokens = options.maxOutputTokens;
	}
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.topP !== undefined) {
		generationConfig.top_p = options.topP;
	}
	if (options.thinkingLevel && /^gemini-3/.test(model)) {
		generationConfig.thinking_level = options.thinkingLevel;
	}

	const nodeInputs = this.getNodeInputs();
	const availableTools = nodeInputs.some((i) => i.type === 'ai_tool')
		? await getConnectedTools(this, true)
		: [];
	const tools = availableTools.map((t): InteractionTool => ({
		type: 'function',
		name: t.name,
		description: t.description,
		parameters: toGeminiParameters(t.schema),
	}));

	if (this.getNode().typeVersion === 1) {
		if (options.codeExecution) {
			tools.push({ type: 'code_execution' });
		}
	}

	if (this.getNode().typeVersion >= 1.1) {
		if (builtInTools) {
			if (builtInTools.googleSearch) {
				tools.push({ type: 'google_search' });
			}

			const googleMapsOptions = builtInTools.googleMaps;
			if (googleMapsOptions) {
				// latitude/longitude тепер задаються прямо в tool, а не через toolConfig.retrievalConfig
				const { latitude, longitude } = googleMapsOptions;
				const hasLocation =
					latitude !== undefined && latitude !== '' && longitude !== undefined && longitude !== '';
				tools.push({
					type: 'google_maps',
					...(hasLocation && { latitude: Number(latitude), longitude: Number(longitude) }),
				});
			}

			if (builtInTools.urlContext) {
				tools.push({ type: 'url_context' });
			}

			const fileSearchOptions = builtInTools.fileSearch;
			if (fileSearchOptions) {
				const fileSearchStoreNamesRaw = fileSearchOptions.fileSearchStoreNames;
				const metadataFilter = fileSearchOptions.metadataFilter;
				let fileSearchStoreNames: string[] | undefined;
				if (fileSearchStoreNamesRaw) {
					const parsed = jsonParse(fileSearchStoreNamesRaw, {
						errorMessage: 'Failed to parse file search store names',
					});
					if (Array.isArray(parsed)) {
						fileSearchStoreNames = parsed;
					}
				}

				tools.push({
					type: 'file_search',
					...(fileSearchStoreNames && { file_search_store_names: fileSearchStoreNames }),
					...(metadataFilter && { metadata_filter: metadataFilter }),
				});
			}

			if (builtInTools.codeExecution) {
				tools.push({ type: 'code_execution' });
			}
		}
	}

	const nonEmptyMessages = messages.filter((m) => m.content.trim() !== '');
	if (!nonEmptyMessages.length) {
		throw new NodeOperationError(this.getNode(), 'A non-empty prompt is required.', {
			itemIndex: i,
		});
	}
	// contents[{ role, parts }]  ->  steps: user_input / model_output
	const input = nonEmptyMessages.map((m): InteractionStep => {
		const text: InteractionTextContent = { type: 'text', text: m.content };
		const content = [text];
		return m.role === 'model' ? { type: 'model_output', content } : { type: 'user_input', content };
	});

	// tools / system_instruction / generation_config не успадковуються через
	// previous_interaction_id, тому передаємо їх у кожному запиті
	const baseBody = {
		model,
		...(tools.length && { tools }),
		...(options.systemMessage && { system_instruction: options.systemMessage }),
		...(jsonOutput && { response_format: { type: 'text', mime_type: 'application/json' } }),
		...(Object.keys(generationConfig).length && { generation_config: generationConfig }),
	};

	let response = await createInteraction.call(this, { ...baseBody, input } as unknown as IDataObject);

	const captureUsage = () => {
		if (response.usage) {
			accumulateTokenUsage(
				this,
				response.usage.total_input_tokens ?? 0,
				response.usage.total_output_tokens ?? 0,
			);
		}
	};

	captureUsage();

	const maxToolsIterations = this.getNodeParameter('options.maxToolsIterations', i, 15) as number;
	const abortSignal = this.getExecutionCancelSignal();
	let currentIteration = 1;
	let toolCalls = getToolCalls(response);
	while (toolCalls.length) {
		if (
			(maxToolsIterations > 0 && currentIteration >= maxToolsIterations) ||
			abortSignal?.aborted
		) {
			break;
		}

		const functionResults: FunctionResultStep[] = [];
		for (const functionCall of toolCalls) {
			const tool = availableTools.find((t) => t.name === functionCall.name);
			if (!tool) {
				functionResults.push({
					type: 'function_result',
					call_id: functionCall.id,
					name: functionCall.name,
					is_error: true,
					result: `Tool '${functionCall.name}' is not available`,
				});
				continue;
			}

			const toolResponse = await tool.invoke(functionCall.arguments);
			functionResults.push({
				type: 'function_result',
				call_id: functionCall.id,
				name: functionCall.name,
				result:
					typeof toolResponse === 'string' ? toolResponse : { result: toolResponse as IDataObject },
			});
		}

		// Історію (включно з thought signatures) тримає сервер, тому шлемо лише результати.
		// Це вимагає store=true (значення за замовчуванням).
		response = await createInteraction.call(this, {
			...baseBody,
			previous_interaction_id: response.id,
			input: functionResults,
		} as unknown as IDataObject);
		captureUsage();
		toolCalls = getToolCalls(response);
		currentIteration++;
	}

	if (simplify) {
		return [{ json: { text: getOutputText(response) }, pairedItem: { item: i } }];
	}

	return [{ json: response as unknown as IDataObject, pairedItem: { item: i } }];
}
