/**
 * @file src/client/protocol.js
 * @module client/protocol
 * @purpose The wire contract between a parent process and a sub-agent.
 *
 *   A sub-agent is a separate thread of the parent: the parent gives it a **spec** (the
 *   role it inherits, the goal, the files it may touch, the tools it may call, the budget
 *   of turns) and the sub-agent answers with a **report** (what it did, which files are on
 *   the disk, whether the goal is reached).
 *
 *   Everything in between travels as frames: `spawn` goes down, `ready`/`status`/`log`/
 *   `file`/`error` come up, `report` closes the thread. The frames carry a protocol
 *   version, so an old parent refuses a new sub-agent instead of guessing.
 *
 *   The sub-agent carries no role of its own: the role, the rights and the tools come in
 *   the spec and belong to the parent. The sub-agent only runs them.
 *
 * @depends none
 * @usedBy client/interface, server/interface
 * @exports PROTOCOL_VERSION, FRAME, createFrame, isFrame, SPEC_VERSION
 * @ai.tags subagent, protocol, ipc
 * @ai.hint pure
 */

/** The version of the protocol between a parent and a sub-agent. */
export const PROTOCOL_VERSION = 1;

/** The version of the spec of a sub-agent. */
export const SPEC_VERSION = 1;

/** The kinds of frame of the protocol. */
export const FRAME = Object.freeze({
    spawn: 'spawn',
    ready: 'ready',
    status: 'status',
    log: 'log',
    file: 'file',
    call: 'call',
    result: 'result',
    report: 'report',
    error: 'error',
    stop: 'stop',
});

/**
 * Create one frame of the protocol.
 * @param {string} type the kind of the frame
 * @param {object} [payload] the fields of the frame
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function createFrame(type, payload = {}) {
    const kind = String(type ?? '').trim();
    if (!Object.hasOwn(FRAME, kind)) throw new Error(`Unknown subagent frame: ${kind || '(empty)'}.`);
    return { v: PROTOCOL_VERSION, type: kind, ...payload };
}

/**
 * Whether a value is a frame of this protocol version.
 * @param {unknown} value
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isFrame(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Number(value.v) === PROTOCOL_VERSION
        && typeof value.type === 'string'
        && Object.hasOwn(FRAME, value.type);
}
