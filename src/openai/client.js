/**
 * @file src/openai/client.js
 * @module openai/client
 * @purpose The API client of a sub-agent: one request to the Responses API.
 *
 *   The sub-agent does its own model cycle, so it needs its own client. The client is
 *   small on purpose: the configuration of the model comes from the parent in the spec
 *   (the model, the effort, the backend, the key of the environment), and the client
 *   only has to send the request and answer with the parsed result.
 *
 *   A sub-agent that cannot reach the API says so and stops: it never pretends that the
 *   work is done.
 *
 * @depends node:timers/promises, openai/parser, shared/utils
 * @usedBy agent/core
 * @exports createModelClient, ModelError, modelRequest
 * @ai.tags subagent, openai, client
 * @ai.hint io
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { intOf, textOf } from '../shared/utils.js';
import { parseModelAnswer, textPart, imagePart } from './parser.js';

/** The error of a request that did not come through. */
export class ModelError extends Error {
    /**
     * @param {string} message the reason
     * @param {{ status?: number|null, retriable?: boolean }} [info]
     */
    constructor(message, info = {}) {
        super(message);
        this.name = 'ModelError';
        this.status = Number.isInteger(info.status) ? info.status : null;
        this.retriable = info.retriable === true;
    }
}

/**
 * The statuses worth another try.
 */
const RETRIABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * The delay before the next try.
 * @param {number} attempt the number of the try
 * @param {number|null} retryAfter the `Retry-After` of the answer
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function retryDelayMs(attempt, retryAfter = null) {
    const header = Number(retryAfter);
    const fromHeader = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 60_000) : 0;
    const backoff = Math.min(500 * 2 ** attempt + Math.random() * 250, 20_000);
    const delay = Math.max(fromHeader, backoff);
    return delay >= 3000 ? delay : Math.max(delay, 3000);
}

/**
 * Build the body of a request of the Responses API.
 * @param {{ model: string, instructions?: string|null, input?: object[], tools?: object[],
 *   schema?: object|null, schemaName?: string, effort?: string|null, summary?: string|null,
 *   maxOutputTokens?: number|null, store?: boolean }} request
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function buildModelBody(request = {}) {
    const body = { model: textOf(request.model) };
    const instructions = textOf(request.instructions).trim();
    if (instructions) body.instructions = instructions;
    body.input = Array.isArray(request.input) ? request.input : [];
    const tools = Array.isArray(request.tools) ? request.tools.filter((tool) => tool && tool.name) : [];
    const schema = request.schema && typeof request.schema === 'object' ? request.schema : null;
    if (schema) {
        tools.push({
            type: 'function',
            name: textOf(request.schemaName) || 'response',
            description: 'Submit the final answer. Call this tool exactly once, with the complete answer; do not answer in prose.',
            parameters: schema,
            strict: true,
        });
    }
    if (tools.length) body.tools = tools;
    const reasoning = {};
    if (request.effort) reasoning.effort = request.effort;
    if (request.summary) reasoning.summary = request.summary;
    if (Object.keys(reasoning).length) body.reasoning = reasoning;
    if (Number.isInteger(request.maxOutputTokens) && request.maxOutputTokens > 0) {
        body.max_output_tokens = request.maxOutputTokens;
    }
    if (request.store) body.store = true;
    return body;
}

/**
 * Send one request to the API and answer with the parsed result.
 * @param {{ baseURL: string, apiKey: string, body: object, timeoutMs?: number,
 *   signal?: AbortSignal|null, fetchImpl?: Function|null }} request
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function modelRequest({ baseURL, apiKey, body, timeoutMs = 0, signal = null, fetchImpl = null } = {}) {
    const url = `${textOf(baseURL).replace(/\/+$/, '')}/responses`;
    const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    timer?.unref?.();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const answer = await doFetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${textOf(apiKey)}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await answer.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = null;
        }
        if (!answer.ok) {
            const detail = textOf(parsed?.error?.message) || textOf(parsed?.message) || text.slice(0, 400);
            throw new ModelError(`The model refused the request (${answer.status}): ${detail}`, {
                status: answer.status,
                retriable: RETRIABLE.has(answer.status),
            });
        }
        if (!parsed) throw new ModelError('The model answered with something that is not JSON.', { retriable: false });
        return parseModelAnswer(parsed);
    } catch (error) {
        if (error instanceof ModelError) throw error;
        const aborted = error?.name === 'AbortError';
        throw new ModelError(aborted ? 'The request was aborted.' : (error?.message ?? String(error)), {
            retriable: !aborted,
        });
    } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * The client of the model of a sub-agent.
 *
 * The client retries what can be retried and gives up on what cannot: a refused request
 * stays refused, and the sub-agent has to know that the work is not done.
 *
 * @param {{ model?: string, baseURL?: string, apiKey?: string, effort?: string|null,
 *   summary?: string|null, retries?: number, timeoutMs?: number, fetchImpl?: Function|null }} [config]
 * @returns {{ request: Function, config: object }}
 * @exports
 * @ai.hint io
 */
export function createModelClient(config = {}) {
    const settings = {
        model: textOf(config.model).trim(),
        baseURL: textOf(config.baseURL).trim(),
        apiKey: textOf(config.apiKey).trim(),
        effort: textOf(config.effort).trim() || null,
        summary: textOf(config.summary).trim() || null,
        retries: Math.max(0, intOf(config.retries, 2)),
        timeoutMs: Math.max(0, intOf(config.timeoutMs, 0)),
        fetchImpl: typeof config.fetchImpl === 'function' ? config.fetchImpl : null,
    };
    return {
        config: settings,
        /**
         * Send the request and answer with the parsed result.
         * @param {object} request the body of the request
         * @param {{ signal?: AbortSignal|null }} [options]
         * @returns {Promise<object>}
         */
        async request(request, options = {}) {
            let last = null;
            for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
                try {
                    return await modelRequest({
                        baseURL: settings.baseURL,
                        apiKey: settings.apiKey,
                        body: request,
                        timeoutMs: settings.timeoutMs,
                        signal: options.signal ?? null,
                        fetchImpl: settings.fetchImpl,
                    });
                } catch (error) {
                    last = error;
                    if (!error?.retriable || attempt >= settings.retries) throw error;
                    await sleep(retryDelayMs(attempt));
                }
            }
            throw last ?? new ModelError('The model did not answer.');
        },
    };
}

export { textPart, imagePart };
