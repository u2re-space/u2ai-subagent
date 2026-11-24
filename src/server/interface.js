/**
 * @file src/server/interface.js
 * @module server/interface
 * @purpose The worker of a sub-agent: the thread that runs the cycle of the model.
 *
 *   The worker takes the spec of the sub-agent, runs the cycle of the model and sends
 *   every call of a tool back to the parent. It never runs a tool itself: the tools of
 *   the parent are the tools of the sub-agent, and the parent is the one that holds
 *   them.
 *
 *   The answer of the parent comes back as the result of the call, and the cycle goes on
 *   until the model gives the final answer. The report closes the thread.
 *
 * @depends agent/core, client/protocol, shared/utils
 * @usedBy bin/ai-subagent-worker
 * @exports runWorker, workerMain
 * @ai.tags subagent, worker, server
 * @ai.hint io
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runSubAgent } from '../agent/core.js';
import { createFrame } from '../client/protocol.js';
import { intOf, textOf } from '../shared/utils.js';

/**
 * Run the worker of a sub-agent.
 *
 * The worker sends the calls of the tools to the parent and waits for their answers: a
 * call without an answer would break the cycle, so a call that nobody answers is
 * answered with the failure of the tool.
 *
 * @param {{ spec: object, port?: object|null, client?: object|null }} request
 * @returns {Promise<object>} the report of the sub-agent
 * @exports
 * @ai.hint io
 */
export async function runWorker({ spec, port = null, client = null } = {}) {
    const channel = port ?? parentPort;
    if (!channel) throw new Error('The worker of a sub-agent has no channel to the parent.');
    const pending = new Map();
    let counter = 0;

    const send = (frame) => {
        try {
            channel.postMessage(frame);
        } catch {
            // The parent is gone: the report goes nowhere, and the thread ends.
        }
    };

    const onCall = async (call) => {
        counter += 1;
        const id = `c-${counter}`;
        const answer = new Promise((resolve) => pending.set(id, resolve));
        send(createFrame('call', { id, name: call?.name, arguments: call?.arguments ?? {} }));
        const output = await answer;
        return output;
    };

    const onMessage = (frame) => {
        if (!frame || frame.type !== 'result') return;
        const resolve = pending.get(textOf(frame.id));
        if (!resolve) return;
        pending.delete(textOf(frame.id));
        resolve(textOf(frame.output));
    };
    channel.on('message', onMessage);

    const onEvent = (event) => {
        send(createFrame('status', { event }));
    };

    let report;
    try {
        report = await runSubAgent({ spec, client, onCall, onEvent });
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
    channel.off?.('message', onMessage);
    send(createFrame('report', { report }));
    return report;
}

/**
 * The entry of the worker: the spec comes with the thread.
 * @param {{ data?: object, port?: object|null }} [request]
 * @returns {Promise<object>}
 * @exports
 * @ai.hint io
 */
export async function workerMain({ data = null, port = null } = {}) {
    const payload = data ?? workerData ?? {};
    const spec = payload?.spec ?? {};
    const report = await runWorker({ spec, port });
    return report;
}

export { intOf };
