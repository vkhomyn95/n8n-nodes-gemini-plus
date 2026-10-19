import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError, updateDisplayOptions } from 'n8n-workflow';

import {
	createInteraction,
	getOutputImages,
	toInteractionContent,
	toInteractionModel,
} from '../../helpers/interactions';
import type { InteractionContent } from '../../helpers/interfaces';
import { getFilenameFromMimeType, uploadFile } from '../../helpers/utils';
import { modelRLC } from '../descriptions';

interface ImagesParameter {
	values?: Array<{ binaryPropertyName?: string }>;
}

function isImagesParameter(param: unknown): param is ImagesParameter {
	if (typeof param !== 'object' || param === null) {
		return false;
	}

	const paramObj = param as Record<string, unknown>;

	if (!('values' in paramObj)) {
		return true; // values is optional
	}

	if (!Array.isArray(paramObj.values)) {
		return false;
	}

	return paramObj.values.every((item: unknown) => {
		if (typeof item !== 'object' || item === null) {
			return false;
		}

		const itemObj = item as Record<string, unknown>;

		if (!('binaryPropertyName' in itemObj)) {
			return true; // binaryPropertyName is optional
		}

		return (
			typeof itemObj.binaryPropertyName === 'string' || itemObj.binaryPropertyName === undefined
		);
	});
}

const properties: INodeProperties[] = [
	modelRLC('imageEditModelSearch'),
	{
		displayName: 'Prompt',
		name: 'prompt',
		type: 'string',
		placeholder: 'e.g. combine the first image with the second image',
		description: 'Instruction describing how to edit the image',
		default: '',
		typeOptions: {
			rows: 2,
		},
	},
	{
		displayName: 'Images',
		name: 'images',
		type: 'fixedCollection',
		placeholder: 'Add Image',
		typeOptions: {
			multipleValues: true,
			multipleValueButtonText: 'Add Image',
		},
		default: { values: [{ binaryPropertyName: 'data' }] },
		description: 'Add one or more binary fields to include images with your prompt',
		options: [
			{
				displayName: 'Image',
				name: 'values',
				values: [
					{
						displayName: 'Binary Field Name',
						name: 'binaryPropertyName',
						type: 'string',
						default: 'data',
						placeholder: 'e.g. data',
						description: 'The name of the binary field containing the image data',
					},
				],
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
				displayName: 'Put Output in Field',
				name: 'binaryPropertyOutput',
				type: 'string',
				default: 'edited',
				hint: 'The name of the output field to put the binary file data in',
			},
		],
	},
];

const displayOptions = {
	show: {
		operation: ['edit'],
		resource: ['image'],
	},
};

export const description = updateDisplayOptions(displayOptions, properties);

export async function execute(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const prompt = this.getNodeParameter('prompt', i, '');
	if (typeof prompt === 'string' && !prompt.trim()) {
		throw new NodeOperationError(this.getNode(), 'A non-empty prompt is required.', {
			itemIndex: i,
		});
	}
	let model = this.getNodeParameter('modelId', i, '', { extractValue: true }) as string;
	if (!model) {
		model = 'gemini-2.5-flash-image';
	}

	const binaryPropertyOutput = this.getNodeParameter('options.binaryPropertyOutput', i, 'edited');
	const outputKey = typeof binaryPropertyOutput === 'string' ? binaryPropertyOutput : 'data';

	// Collect image binary field names from collection
	const imagesParam = this.getNodeParameter('images', i, {
		values: [{ binaryPropertyName: 'data' }],
	});

	if (!isImagesParameter(imagesParam)) {
		throw new Error('Invalid images parameter format');
	}

	const imagesUi = imagesParam.values ?? [];
	const imageFieldNames = imagesUi
		.map((v) => v.binaryPropertyName)
		.filter((n): n is string => Boolean(n));

	// Upload all images and gather input content blocks
	const imageContents: InteractionContent[] = [];
	for (const fieldName of imageFieldNames) {
		const bin = this.helpers.assertBinaryData(i, fieldName);
		const buf = await this.helpers.getBinaryDataBuffer(i, fieldName);
		const uploaded = await uploadFile.call(this, buf, bin.mimeType);
		imageContents.push(toInteractionContent(uploaded.fileUri, uploaded.mimeType));
	}

	const response = await createInteraction.call(this, {
		model: toInteractionModel(model),
		input: [...imageContents, { type: 'text', text: prompt }],
		response_modalities: ['image'],
	} as unknown as IDataObject);

	const images = getOutputImages(response);
	if (!images.length) {
		throw new Error('No image data returned from Gemini API');
	}

	const promises = images.map(async (image) => {
		const fileName = getFilenameFromMimeType(image.mimeType, 'image', 'png');
		const bufferOut = Buffer.from(image.data, 'base64');
		const binaryOut = await this.helpers.prepareBinaryData(bufferOut, fileName, image.mimeType);
		return {
			binary: {
				[outputKey]: binaryOut,
			},
			json: {
				...binaryOut,
				data: undefined,
			},
			pairedItem: { item: i },
		};
	});

	return await Promise.all(promises);
}
