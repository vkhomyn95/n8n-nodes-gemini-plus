import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

import type { Interaction, InteractionContent } from './interfaces';
import { apiRequest } from '../transport';

type MediaType = 'image' | 'audio' | 'video' | 'document';

function getMediaType(mimeType: string): MediaType {
	if (mimeType.startsWith('image/')) return 'image';
	if (mimeType.startsWith('audio/')) return 'audio';
	if (mimeType.startsWith('video/')) return 'video';
	return 'document';
}

/**
 * В Interactions API модель передається без префікса "models/"
 * (у RLC значення лишилось у старому форматі "models/gemini-...").
 */
export function toInteractionModel(rawModel: string): string {
	return rawModel.replace(/^models\//, '');
}

/**
 * Файл з Files API ({ fileUri, mimeType }) -> типізований блок input.
 */
export function toInteractionContent(uri: string, mimeType: string): InteractionContent {
	// У SDK mime_type — вузький union для кожного типу (в ранніх 2.x без `string`),
	// а API приймає будь-який підтримуваний mime, тому тут свідомий cast.
	return { type: getMediaType(mimeType), uri, mime_type: mimeType } as InteractionContent;
}

export async function createInteraction(
	this: IExecuteFunctions,
	body: IDataObject,
): Promise<Interaction> {
	// За замовчуванням Interactions API зберігає запити на сервері (store=true).
	return (await apiRequest.call(this, 'POST', '/v1beta/interactions', { body })) as Interaction;
}

/**
 * Зливає всі текстові блоки з усіх model_output кроків в один рядок.
 */
export function getOutputText(response: Interaction): string {
	return (response.steps ?? [])
		.filter((s) => s.type === 'model_output')
		.flatMap((s) => s.content ?? [])
		.map((c) => (c.type === 'text' ? c.text : ''))
		.join('');
}

/**
 * Усі згенеровані зображення (inline base64) з model_output кроків.
 */
export function getOutputImages(response: Interaction): Array<{ data: string; mimeType: string }> {
	return (response.steps ?? [])
		.filter((s) => s.type === 'model_output')
		.flatMap((s) => s.content ?? [])
		.flatMap((c) =>
			c.type === 'image' && c.data ? [{ data: c.data, mimeType: c.mime_type ?? 'image/png' }] : [],
		);
}
