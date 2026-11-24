/**
 * @file src/openai/parser.js
 * @module openai/parser
 * @purpose The answers of the model: the text, the calls of the tools and the parts.
 *
 *   The parser is the only place that knows the wire names of the API. Everything above
 *   it speaks in terms of a turn: the text the model said, the tools it asked for and the
 *   parts it attached.
 *
 * @depends none
 * @usedBy openai/client
 * @exports parseModelAnswer, textPart, imagePart, modelToolCalls, modelText
 * @ai.tags subagent, openai, parser
 * @ai.hint pure
 */

import { textOf } from '../shared/utils.js';

/**
 * A text part of the input.
 * @param {string} text
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function textPart(text) {
    return { type: 'input_text', text: textOf(text) };
}

/**
 * An image part of the input: the API takes a data URL, not a file.
 * @param {Buffer|Uint8Array} bytes the bytes of the picture
 * @param {string} [mime] the type of the picture
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function imagePart(bytes, mime = 'image/png') {
    const data = Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(bytes).toString('base64');
    return { type: 'input_image', image_url: `data:${mime};base64,${data}` };
}

/**
 * The calls of the tools the model asked for.
 * @param {object} raw the answer of the API
 * @returns {Array<{ id: string|null, callId: string|null, name: string, arguments: object, raw: string }>}
 * @exports
 * @ai.hint pure
 */
export function modelToolCalls(raw = {}) {
    const out = [];
    for (const item of Array.isArray(raw?.output) ? raw.output : []) {
        if (item?.type !== 'function_call') continue;
        const args = textOf(item.arguments) || '{}';
        let parsed = null;
        try {
            parsed = JSON.parse(args);
        } catch {
            parsed = null;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
        out.push({
            id: item.id ?? null,
            callId: item.call_id ?? null,
            name: textOf(item.name),
            arguments: parsed,
            raw: args,
        });
    }
    return out;
}

/**
 * The text of the answer of the model.
 * @param {object} raw the answer of the API
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function modelText(raw = {}) {
    const direct = textOf(raw?.output_text);
    if (direct) return direct;
    const parts = [];
    for (const item of Array.isArray(raw?.output) ? raw.output : []) {
        if (item?.type !== 'message') continue;
        for (const part of Array.isArray(item?.content) ? item.content : []) {
            if (part?.type !== 'output_text') continue;
            const text = textOf(part?.text);
            if (text) parts.push(text);
        }
    }
    return parts.join('\n');
}

/**
 * Parse the answer of the API into the shape the loop reads.
 * @param {object} raw the answer of the API
 * @returns {{ id: string|null, status: string, model: string|null, text: string,
 *   toolCalls: object[], refusal: string, error: object|null, raw: object }}
 * @exports
 * @ai.hint pure
 */
export function parseModelAnswer(raw = {}) {
    return {
        id: raw?.id ?? null,
        status: textOf(raw?.status) || 'completed',
        model: raw?.model ?? null,
        text: modelText(raw),
        toolCalls: modelToolCalls(raw),
        refusal: textOf(raw?.error?.message),
        error: raw?.error ?? null,
        raw,
    };
}
