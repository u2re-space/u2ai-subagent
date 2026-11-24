/**
 * @file src/agent/gate.js
 * @module agent/gate
 * @purpose The write gate of a sub-agent: the turn of the inspection, the estimate of the
 *          write and the budget the estimate earns.
 *
 *   A sub-agent writes files in a separate thread, and the write is the expensive part of
 *   the work: a turn that writes a big file spends the whole cap of the model, whether the
 *   file is big or not. The model knows the size of its own write better than the run does,
 *   so the gate asks it.
 *
 *   The cycle of a sub-agent with the gate:
 *
 *   1. The **inspection** turn: the read tools and the gate itself, with a reduced budget
 *      (an eighth of the cap). The model reads the project and calls `write_ready`.
 *   2. The **write** turn: the write tools and the budget the estimate earned — clamped
 *      into the band between a quarter of the cap and the cap itself.
 *   3. The **answer** turn: the report, with the full cap. The answer is not the write.
 *
 *   The gate is a tool of the loop, not a tool of the project: it writes no file, and the
 *   parent never runs it.
 *
 * @depends none
 * @usedBy agent/core
 * @exports WRITE_READY_TOOL, WRITE_READY_NAME, READ_ONLY_TOOLS, WRITE_TOOLS, isReadOnlyTool,
 *          isWriteTool, hasWriteTools, hasActionTools, gateInstruction, gateAnswer, estimateOf
 * @ai.tags subagent, gate, budget
 * @ai.hint pure
 */

/** The name of the tool of the gate. */
export const WRITE_READY_NAME = 'write_ready';

/**
 * The tool of the write gate.
 *
 * The model may name `outputTokens`: how many output tokens the write of the goal is
 * expected to take. It sizes the budget of the write turn — the run clamps it, so an
 * honest guess costs nothing and a wild one buys nothing.
 * @type {Readonly<{ type: string, name: string, description: string, parameters: object }>}
 * @exports
 */
export const WRITE_READY_TOOL = Object.freeze({
    type: 'function',
    name: WRITE_READY_NAME,
    description: 'INTERNAL WRITE GATE — not delegation. Call this exact tool name after the inspection '
        + 'to unlock your own file-writing tools on the next turn. It writes no files and starts no other '
        + 'role. Then write the files of the goal with write_file — every file of the goal may be written '
        + 'in that one turn, several write_file calls together. You may name `outputTokens`: how many output '
        + 'tokens the write of the goal is expected to take. It sizes the budget of the write turn — the '
        + 'run clamps it into a band, so an honest guess costs you nothing and a wild one buys you nothing.',
    parameters: {
        type: 'object',
        properties: {
            outputTokens: {
                type: 'integer',
                description: 'Your estimate of the size of the write of this goal, in output tokens. How many '
                    + 'tokens the files of the goal will take to write. Leave it out if you do not know: the '
                    + 'write turn then gets the whole budget.',
            },
        },
        required: [],
        additionalProperties: false,
    },
});

/** The tools that only read. */
export const READ_ONLY_TOOLS = Object.freeze([
    'list_files', 'read_file', 'find_line', 'search_files',
    'read_skill', 'call_ai_memory',
]);

/** The tools that write. */
export const WRITE_TOOLS = Object.freeze([
    'write_file', 'replace_text', 'patch_file', 'copy_path', 'delete_file', 'make_dir', 'batch',
]);

/**
 * Is this tool one that only reads?
 * @param {string} name the name of the tool
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isReadOnlyTool(name) {
    return READ_ONLY_TOOLS.includes(String(name ?? '').trim());
}

/**
 * Is this tool one that writes?
 * @param {string} name the name of the tool
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isWriteTool(name) {
    return WRITE_TOOLS.includes(String(name ?? '').trim());
}

/**
 * Does the sub-agent have a tool that writes?
 *
 * A sub-agent that only reads has no gate: there is nothing to unlock, and the reduced
 * budget of the inspection would be a punishment for a read-only work.
 * @param {string[]} names the tools of the sub-agent
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function hasWriteTools(names = []) {
    const list = Array.isArray(names) ? names : [];
    return list.some((name) => isWriteTool(name));
}

/**
 * Does the sub-agent have a tool that acts?
 *
 * The gate is for the tools that change something: a sub-agent with a read tool and a
 * command tool has a gate, even though the command is not in the list of the writing
 * tools. A sub-agent with only the read tools has nothing to unlock.
 * @param {string[]} names the tools of the sub-agent
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function hasActionTools(names = []) {
    const list = Array.isArray(names) ? names : [];
    return list.some((name) => !isReadOnlyTool(name));
}

/**
 * The rule of the gate, in the instructions of the sub-agent.
 *
 * The rule says what the gate is for and what the estimate buys: an honest guess costs
 * nothing, and the run does not punish a wrong one.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function gateInstruction() {
    return [
        'Before writing files or using any action-capable tool, call `write_ready` first. Until then, '
        + 'only the read tools are available, and your turn has a reduced output budget.',
        'After `write_ready`, the next turn has the writing tools and the output budget for the write: '
        + 'write every file of the goal there — several `write_file` calls in one turn are allowed and are '
        + 'the cheapest way.',
        'In `write_ready` you may name `outputTokens`: your estimate of how many output tokens the write '
        + 'of the goal will take. It sizes the budget of the write turn — the run clamps it into a band, '
        + 'so an honest guess costs you nothing. If you do not know the size, leave the field out: the '
        + 'write turn then gets the whole budget.',
    ].join('\n\n');
}

/**
 * The answer of the gate: what the write turn is going to get.
 * @param {number|null} budget the budget the write turn earned
 * @param {number|null} estimate the estimate the model gave
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function gateAnswer(budget = null, estimate = null) {
    if (estimate === null || budget === null) {
        return 'Write-ready. The next turn has the full output budget and the remaining tools: write every '
            + 'file of the goal there, several calls in one turn.';
    }
    return `Write-ready. The next turn has the output budget of ${budget} tokens for the write, and the `
        + 'remaining tools: write every file of the goal there, several calls in one turn.';
}

/**
 * The estimate of the write out of the call of the gate.
 *
 * A broken estimate and an estimate that is not positive are no estimate: the write turn
 * then gets the whole budget. A model that says "0" or "-5" is saying "I do not know", not
 * "write nothing".
 *
 * @param {unknown} arguments the arguments of the call
 * @returns {number|null}
 * @exports
 * @ai.hint pure
 */
export function estimateOf(arguments_ = null) {
    const raw = arguments_?.outputTokens;
    const estimate = Number(raw);
    return Number.isFinite(estimate) && estimate > 0 ? estimate : null;
}
