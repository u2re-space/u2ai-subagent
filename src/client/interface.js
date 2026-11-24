/**
 * @file src/client/interface.js
 * @module client/interface
 * @purpose The API of the sub-agent system: how a parent starts a sub-agent.
 *
 *   A parent (a process like `ai-webdev`) starts a sub-agent with one call:
 *
 *   ```js
 *   const sub = await runSubAgent({
 *       spec: { role: { name: 'styler', instructions, tools }, goal, files },
 *       root: '/path/to/project',
 *       onCall: (call) => toolset.execute(call.name, call.arguments),
 *   });
 *   ```
 *
 *   The sub-agent is a **separate thread** of the parent: it has its own conversation and
 *   its own budget of turns, and it does not share the memory of the model with the
 *   parent. What it shares is the project: the working directory, the skills, the memory
 *   and the tools are the ones of the parent, and the calls of the tools are executed by
 *   the parent — the sub-agent never touches a file by itself.
 *
 *   The parent keeps the truth: the files of the goal are checked on the disk, and the
 *   report says what is there.
 *
 * @depends node:worker_threads, config/spec, agent/core, client/protocol, shared/utils
 * @usedBy ai-webdev
 * @exports runSubAgent, spawnSubAgent, createSubAgent, SUBAGENT_ENTRY
 * @ai.tags subagent, client, api
 * @ai.hint io
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { normalizeSpec, specFiles, specRole, specTools } from '../config/spec.js';
import { createFrame, isFrame } from './protocol.js';
import { intOf, textOf } from '../shared/utils.js';

/** The entry of the worker of a sub-agent. */
export const SUBAGENT_ENTRY = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'bin',
    'ai-subagent-worker.js',
);

/**
 * Start a sub-agent and wait for its report.
 *
 * The thread of the sub-agent runs the cycle of the model and hands every call of a tool
 * back to the parent: `onCall` executes it and answers with the result of the tool. The
 * sub-agent never runs a tool itself — it asks, and the parent does.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   signal?: AbortSignal|null, entry?: string, worker?: object|null }} request
 * @returns {Promise<object>} the report of the sub-agent
 * @exports
 * @ai.hint io
 */
export async function runSubAgent({ spec: rawSpec, onCall = null, onEvent = null, signal = null, entry = null, worker: given = null } = {}) {
    const spec = normalizeSpec(rawSpec);
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const role = specRole(spec);
    const name = textOf(spec.name) || role || 'subagent';

    const worker = given ?? new Worker(entry ?? SUBAGENT_ENTRY, {
        workerData: { spec },
        env: process.env,
        stdout: false,
        stderr: false,
    });

    return await new Promise((resolve) => {
        let settled = false;
        const finish = (report) => {
            if (settled) return;
            settled = true;
            resolve(report);
        };
        const onAbort = () => {
            emit({ type: 'status', role, name, status: 'aborted' });
            worker.terminate?.();
            finish({
                ok: false,
                role,
                name,
                turns: 0,
                files: [],
                report: 'The sub-agent was stopped before it answered.',
                error: 'aborted',
                stopped: 'aborted',
            });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        worker.on('message', async (frame) => {
            if (!isFrame(frame)) return;
            if (frame.type === 'call') {
                // The call of a tool of the sub-agent: the parent runs it.
                let output = '';
                try {
                    output = textOf(await onCall?.({
                        name: textOf(frame.name),
                        arguments: frame.arguments ?? {},
                    }));
                } catch (error) {
                    output = `The tool failed: ${error?.message ?? String(error)}`;
                }
                worker.postMessage(createFrame('result', { id: frame.id, output }));
                return;
            }
            if (frame.type === 'status') {
                emit(frame.event ?? {});
                return;
            }
            if (frame.type === 'report') {
                signal?.removeEventListener('abort', onAbort);
                finish(frame.report ?? { ok: false, role, name, turns: 0, files: [], report: 'No report.', error: 'no-report', stopped: 'failed' });
                worker.terminate?.();
            }
        });
        worker.on('error', (error) => {
            signal?.removeEventListener('abort', onAbort);
            finish({
                ok: false,
                role,
                name,
                turns: 0,
                files: [],
                report: `The sub-agent died: ${error?.message ?? String(error)}`,
                error: error?.message ?? String(error),
                stopped: 'failed',
            });
        });
        worker.on('exit', () => {
            signal?.removeEventListener('abort', onAbort);
            if (!settled) {
                finish({
                    ok: false,
                    role,
                    name,
                    turns: 0,
                    files: [],
                    report: 'The sub-agent ended without a report.',
                    error: 'no-report',
                    stopped: 'failed',
                });
            }
        });
    });
}

/**
 * Start a sub-agent without waiting for it.
 *
 * The parent gets the handle of the thread right away and listens to its events. The
 * report comes with the `report` event of the handle.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   signal?: AbortSignal|null, entry?: string }} request
 * @returns {{ handle: object, done: Promise<object> }}
 * @exports
 * @ai.hint io
 */
export function spawnSubAgent({ spec: rawSpec, onCall = null, onEvent = null, signal = null, entry = null } = {}) {
    const spec = normalizeSpec(rawSpec);
    const worker = new Worker(entry ?? SUBAGENT_ENTRY, {
        workerData: { spec },
        env: process.env,
        stdout: false,
        stderr: false,
    });
    const handle = {
        role: specRole(spec),
        name: textOf(spec.name) || specRole(spec) || 'subagent',
        files: specFiles(spec),
        tools: specTools(spec),
        worker,
        /**
         * Stop the sub-agent.
         * @returns {void}
         */
        stop() {
            worker.terminate?.();
        },
    };
    const done = runSubAgent({ spec, onCall, onEvent, signal, worker });
    return { handle, done };
}

/**
 * The sub-agent of one goal: the same call as `runSubAgent`, with the shape of the
 * answer of the parent in mind.
 *
 * The parent gets the report and the files of the goal. The files are checked on the
 * disk by the parent — the sub-agent only says what it believes it did.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   signal?: AbortSignal|null }} request
 * @returns {Promise<{ ok: boolean, role: string, name: string, turns: number,
 *   files: string[], report: string, error: string|null, stopped: string }>}
 * @exports
 * @ai.hint io
 */
export async function createSubAgent(request = {}) {
    const report = await runSubAgent(request);
    return {
        ok: report?.ok === true,
        role: textOf(report?.role),
        name: textOf(report?.name),
        turns: intOf(report?.turns, 0),
        files: Array.isArray(report?.files) ? report.files : [],
        report: textOf(report?.report),
        error: report?.error ?? null,
        stopped: textOf(report?.stopped) || 'failed',
    };
}
