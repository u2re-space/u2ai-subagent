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
 *   The contract itself lives in `shared/protocol` — the same file in every package of the
 *   house. This module is the public path of it.
 *
 * @depends shared/protocol
 * @usedBy client/interface, server/interface
 * @exports PROTOCOL_VERSION, SPEC_VERSION, FRAME, createFrame, isFrame, bytesFrame,
 *          base64Frame, bytesOfFrame, base64Of, bytesOf
 * @ai.tags house, protocol, ipc
 * @ai.hint pure
 */

export {
    PROTOCOL_VERSION,
    SPEC_VERSION,
    FRAME,
    createFrame,
    isFrame,
    bytesFrame,
    base64Frame,
    bytesOfFrame,
    base64Of,
    bytesOf,
} from '../shared/protocol.js';
