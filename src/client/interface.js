/**
 * @file src/client/interface.js
 * @module client/interface
 * @purpose The API of the sub-agent system: how a parent starts a sub-agent.
 *
 *   A parent (a process like `ai-webdev`) starts a sub-agent with one call:
 *
 *   ```js
 *   const report = await runSubAgent({
 *       spec: { role: { name: 'styler', instructions, tools }, goal, files },
 *       onCall: (call) => toolset.execute(call.name, call.arguments),
 *   });
 *   ```
 *
 *   The sub-agent is **separate** from the parent: it has its own conversation and its own
 *   budget of turns, and it does not share the memory of the model with the parent. Two
 *   transports carry that separation:
 *
 *   - `'thread'` (default) — a worker thread of the parent process. The project, the env
 *     and the tools are shared by nature; the conversation is not.
 *   - `'process'` — a child process of the parent. The sub-agent lives in its own process
 *     (`node bin/ai-subagent-worker.js`), the spec and the calls of the tools travel over
 *     IPC. A parent that wants its runs apart — different env, its own crash domain —
 *     names this transport.
 *
 *   In both, the tools of the sub-agent are the tools of the parent: the sub-agent asks,
 *   the parent runs. The sub-agent never touches a file by itself.
 *
 * @depends node:worker_threads, node:child_process, node:url, node:path, config/spec,
 *          agent/core, client/protocol, shared/utils
 * @usedBy ai-webdev, bin/ai-subagent
 * @exports runSubAgent, spawnSubAgent, createSubAgent, SUBAGENT_ENTRY, DEFAULT_TRANSPORT
 * @ai.tags subagent, client, api
 * @ai.hint io
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, parentPort } from 'node:worker_threads';
import { fork } from 'node:child_process';
import { normalizeSpec, specFiles, specRole, specTools } from '../config/spec.js';
import { createFrame, isFrame } from './protocol.js';
import { textOf } from '../shared/utils.js';

/** The entry of the worker of a sub-agent. */
export const SUBAGENT_ENTRY = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'bin',
    'ai-subagent-worker.js',
);

/** The transport a sub-agent runs in, when the parent names none. */
export const DEFAULT_TRANSPORT = 'thread';

/**
 * Start the worker in the transport the parent named, and give back one channel.
 *
 * The channel speaks the words of an EventEmitter — `on(kind, listener)`, `off`,
 * `post`, `stop` — whatever the transport is: a thread and a process are both
 * EventEmitters, and the cycle of the sub-agent does not know which one carries it.
 * The kinds are `message`, `error` and `exit`.
 *
 * @param {object} spec the spec of the sub-agent
 * @param {{ transport?: 'thread'|'process', entry?: string, env?: object, cwd?: string,
 *   signal?: AbortSignal|null }} [options]
 * @returns {{ post: Function, on: Function, off: Function, stop: Function, alive: Function,
 *   pid: number|null }}
 * @exports
 * @ai.hint io
 */
export function startWorker(spec, options = {}) {
    const transport = String(options.transport ?? DEFAULT_TRANSPORT).trim().toLowerCase() === 'process'
        ? 'process'
        : 'thread';
    const entry = options.entry ?? SUBAGENT_ENTRY;
    if (transport === 'process') {
        const child = fork(entry, [], {
            cwd: options.cwd ?? process.cwd(),
            env: { ...process.env, ...(options.env ?? {}) },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            windowsHide: true,
        });
        // The spec comes with the first frame: the process has no `workerData`, and the
        // worker waits for it. Without this frame the worker waits forever.
        try { child.send(createFrame('spawn', { spec })); } catch { /* The child is gone. */ }
        return {
            post: (frame) => {
                if (!child.connected) return;
                try { child.send(frame); } catch { /* The worker is gone. */ }
            },
            postBytes: (frame) => {
                if (!child.connected) return;
                try { child.send(frame); } catch { /* The worker is gone. */ }
            },
            on: (kind, fn) => child.on(kind, fn),
            off: (kind, fn) => child.off?.(kind, fn),
            stop: () => {
                if (child.connected) {
                    try { child.disconnect(); } catch { /* Already gone. */ }
                }
                if (child.exitCode === null && !child.signalCode) child.kill();
            },
            alive: () => child.exitCode === null && !child.signalCode,
            pid: child.pid ?? null,
        };
    }
    const worker = new Worker(entry, {
        workerData: { spec },
        env: process.env,
        stdout: false,
        stderr: false,
    });
    return {
        post: (frame) => worker.postMessage(frame),
        postBytes: (frame, transfer = []) => worker.postMessage(frame, transfer),
        on: (kind, fn) => worker.on(kind, fn),
        off: (kind, fn) => worker.off?.(kind, fn),
        stop: () => { worker.terminate?.(); },
        alive: () => true,
        pid: worker.threadId ?? null,
    };
}

/**
 * Run one sub-agent to its report.
 *
 * The cycle of the model runs in the worker; every call of a tool travels back to the
 * parent, and `onCall` runs it. A call that the parent refuses is answered as the failure
 * of the tool, and the model reads that answer — a refusal is a fact of the work, not the
 * end of the cycle.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   onCancel?: Function|null, signal?: AbortSignal|null, transport?: 'thread'|'process',
 *   entry?: string, env?: object, cwd?: string, worker?: object|null }} request
 * @returns {Promise<object>} the report of the sub-agent
 * @exports
 * @ai.hint io
 */
export async function runSubAgent({ spec: rawSpec, onCall = null, onEvent = null, onCancel = null, signal = null, transport = null, entry = null, env = null, cwd = null, worker: given = null } = {}) {
    const spec = normalizeSpec(rawSpec);
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const role = specRole(spec);
    const name = textOf(spec.name) || role || 'subagent';

    const worker = given ?? startWorker(spec, { transport, entry, env, cwd, signal });

    return await new Promise((resolve) => {
        let settled = false;
        let keepAlive = null;
        const finish = (report) => {
            if (settled) return;
            settled = true;
            if (keepAlive) clearInterval(keepAlive);
            resolve(report);
        };
        const onAbort = () => {
            // The flag of cancellation goes into the shared memory first: the thread sees
            // it between its turns, without a message round trip.
            try { onCancel?.(); } catch { /* The buffer is gone with the thread. */ }
            emit({ type: 'status', role, name, status: 'aborted' });
            worker.stop();
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
        // The heart of a sub-agent that is not the parent: a parent that dies leaves the
        // orphan no sign of it. The beat is cheap, and the child checks it.
        keepAlive = setInterval(() => {
            if (!worker.alive?.()) finish({
                ok: false,
                role,
                name,
                turns: 0,
                files: [],
                report: 'The sub-agent ended without a report.',
                error: 'no-report',
                stopped: 'failed',
            });
        }, 2000);
        keepAlive.unref?.();
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
                worker.post(createFrame('result', { id: frame.id, output }));
                return;
            }
            if (frame.type === 'status') {
                emit(frame.event ?? {});
                return;
            }
            if (frame.type === 'report') {
                signal?.removeEventListener('abort', onAbort);
                finish(frame.report ?? { ok: false, role, name, turns: 0, files: [], report: 'No report.', error: 'no-report', stopped: 'failed' });
                worker.stop();
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
 * The parent gets the handle of the worker right away and listens to its events. The
 * report comes with the `report` event of the handle.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   onCancel?: Function|null, signal?: AbortSignal|null, transport?: 'thread'|'process',
 *   entry?: string, env?: object, cwd?: string }} request
 * @returns {{ handle: object, done: Promise<object> }}
 * @exports
 * @ai.hint io
 */
export function spawnSubAgent({ spec: rawSpec, onCall = null, onEvent = null, onCancel = null, signal = null, transport = null, entry = null, env = null, cwd = null } = {}) {
    const spec = normalizeSpec(rawSpec);
    const worker = startWorker(spec, { transport, entry, env, cwd, signal });
    const handle = {
        role: specRole(spec),
        name: textOf(spec.name) || specRole(spec) || 'subagent',
        files: specFiles(spec),
        tools: specTools(spec),
        worker,
        /**
         * Is the worker still alive?
         * @returns {boolean}
         */
        alive() {
            if (typeof worker.alive === 'function') return worker.alive();
            return true;
        },
        /**
         * Stop the sub-agent.
         * @returns {void}
         */
        stop() {
            worker.stop();
        },
    };
    const done = runSubAgent({ spec, onCall, onEvent, onCancel, signal, worker });
    return { handle, done };
}

/**
 * The sub-agent of one goal: the same call as `runSubAgent`, with the shape of the
 * answer of the parent in mind.
 *
 * @param {{ spec: object, onCall?: Function|null, onEvent?: Function|null,
 *   signal?: AbortSignal|null, transport?: 'thread'|'process' }} request
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
        turns: Number(report?.turns ?? 0),
        files: Array.isArray(report?.files) ? report.files : [],
        report: textOf(report?.report),
        error: report?.error ?? null,
        stopped: textOf(report?.stopped) || 'failed',
    };
}

export { parentPort };

// --- Code Mode: the sandbox of the model, and the tool that runs its programs -----------
export {
    CODE_MODE_VERSION,
    CODE_MODE_LIMITS,
    CodeModeError,
    createCodeModeSpec,
    normalizeCodeMode,
    runCodeMode,
    runCodeModeWorker,
    codeModeMain,
    startCodeModeWorker,
    codeModeEntry,
} from '../shared/code-mode.js';

export {
    CODE_MODE_TOOL,
    codeModeToolSpec,
    codeModeInstruction,
    createCodeModeRunner,
    codeModeBudgetFor,
} from '../agent/code-mode.js';
