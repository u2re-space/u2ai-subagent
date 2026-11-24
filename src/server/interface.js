/**
 * @file src/server/interface.js
 * @module server/interface
 * @purpose The worker of a sub-agent: the thread or the process that runs the cycle.
 *
 *   The worker takes the spec of the sub-agent, runs the cycle of the model and sends
 *   every call of a tool back to the parent. It never runs a tool itself: the tools of
 *   the parent are the tools of the sub-agent, and the parent is the one that holds
 *   them.
 *
 *   The worker speaks over one protocol and two transports: as a **thread** of the parent
 *   (the spec comes with the thread) and as a **process** of its own (the spec comes with
 *   the first frame of the channel). The cycle is the same in both.
 *
 *   The answer of the parent comes back as the result of the call, and the cycle goes on
 *   until the model gives the final answer. The report closes the worker.
 *
 * @depends node:worker_threads, agent/core, client/protocol, shared/utils
 * @usedBy bin/ai-subagent-worker, client/interface
 * @exports runWorker, workerMain, channelOf
 * @ai.tags subagent, worker, server
 * @ai.hint io
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runSubAgent } from '../agent/core.js';
import { createFrame } from '../client/protocol.js';
import { textOf } from '../shared/utils.js';

/**
 * One channel to the parent, whatever the transport is.
 *
 * A thread speaks `postMessage`; a process speaks `send`. Both hear `on('message')`. The
 * cycle of the sub-agent does not know the difference.
 *
 * @param {object|null} port a MessagePort-like, a process-like, or null for this process
 * @returns {{ post: Function, on: Function, off: Function, close: Function }|null}
 * @exports
 * @ai.hint pure
 */
export function channelOf(port = null) {
    const raw = port ?? (typeof process?.send === 'function' ? process : null);
    if (!raw) return null;
    if (typeof raw.postMessage === 'function') {
        // A thread: the port speaks postMessage, and it does not close by hand.
        return {
            post: (frame) => raw.postMessage(frame),
            on: (fn) => raw.on('message', fn),
            off: (fn) => raw.off?.('message', fn),
            close: () => {},
        };
    }
    // A process: the channel speaks send, and it closes with the process.
    return {
        post: (frame) => {
            if (typeof raw.send !== 'function' || !raw.connected) return;
            try { raw.send(frame); } catch { /* The parent is gone. */ }
        },
        on: (fn) => raw.on('message', fn),
        off: (fn) => raw.off?.('message', fn),
        close: () => {
            try { raw.disconnect?.(); } catch { /* Already closed. */ }
        },
    };
}

/**
 * Run the worker of a sub-agent.
 *
 * The worker sends the calls of the tools to the parent and waits for their answers: a
 * call without an answer would break the cycle, so a call that nobody answers is
 * answered with the failure of the tool.
 *
 * @param {{ spec: object, port?: object|null, client?: object|null, signal?: AbortSignal|null }} request
 * @returns {Promise<object>} the report of the sub-agent
 * @exports
 * @ai.hint io
 */
export async function runWorker({ spec, port = null, client = null, signal = null } = {}) {
    const channel = channelOf(port);
    if (!channel) throw new Error('The worker of a sub-agent has no channel to the parent.');
    const pending = new Map();
    let counter = 0;
    let closed = false;

    const send = (frame) => {
        if (closed) return;
        channel.post(frame);
    };

    const onCall = async (call) => {
        counter += 1;
        const id = `c-${counter}`;
        const answer = new Promise((resolve) => pending.set(id, resolve));
        send(createFrame('call', { id, name: call?.name, arguments: call?.arguments ?? {} }));
        return await answer;
    };

    const onMessage = (frame) => {
        if (!frame || frame.type !== 'result') return;
        const resolve = pending.get(textOf(frame.id));
        if (!resolve) return;
        pending.delete(textOf(frame.id));
        resolve(textOf(frame.output));
    };
    channel.on(onMessage);

    const onEvent = (event) => {
        send(createFrame('status', { event }));
    };

    let report;
    try {
        report = await runSubAgent({ spec, client, onCall, onEvent, signal });
    } catch (error) {
        report = {
            ok: false,
            role: textOf(spec?.role?.name),
            name: textOf(spec?.name),
            turns: 0,
            files: [],
            report: `The sub-agent died: ${error?.message ?? String(error)}`,
            error: error?.message ?? String(error),
            stopped: 'failed',
        };
    }
    channel.off(onMessage);
    send(createFrame('report', { report }));
    closed = true;
    channel.close();
    return report;
}

/**
 * The entry of the worker.
 *
 * As a thread, the spec comes with the thread (`workerData`). As a process, the spec
 * comes with the first frame of the channel (`spawn`). The cycle is the same.
 *
 * @param {{ data?: object|null, port?: object|null, argv?: string[]|null }} [request]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function workerMain({ data = null, port = null } = {}) {
    const payload = data ?? workerData ?? null;
    if (payload && typeof payload === 'object' && payload.spec) {
        // The thread of the parent: the spec came with the thread.
        return await runWorker({ spec: payload.spec, port: port ?? parentPort });
    }
    // The process of its own: the spec comes with the first frame of the channel.
    const channel = port ?? (typeof process?.send === 'function' ? process : null);
    if (!channel) throw new Error('The worker of a sub-agent was started with no channel and no spec.');
    const adapter = channelOf(channel);
    const spec = await new Promise((resolve) => {
        const onMessage = (frame) => {
            if (!frame || frame.type !== 'spawn') return;
            adapter.off(onMessage);
            resolve(frame.spec ?? {});
        };
        adapter.on(onMessage);
    });
    return await runWorker({ spec, port: channel });
}
