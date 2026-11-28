/**
 * @file src/agent/tools.js
 * @module agent/tools
 * @purpose The tools of a sub-agent: the same tools the parent has, minus what it may not.
 *
 *   A sub-agent does not invent its tools: the parent names them in the spec, and the
 *   sub-agent calls exactly those. The executor is the same one the parent uses — the
 *   sub-agent inherits the tools, the rights and the skills of the process that started
 *   it, so the files it writes are written the same way and by the same rules.
 *
 *   The tools of the sub-agent work in the working directory of the parent, and the files
 *   it may write are the files of its goal: a file that belongs to another step of the
 *   parent is not its file.
 *
 * @depends none
 * @usedBy agent/core, client/interface
 * @exports SUBAGENT_TOOLS, toolAllowed, filterTools, toolNames
 * @ai.tags subagent, tools
 * @ai.hint pure
 */

/**
 * The tools a sub-agent knows about.
 *
 * The list is the shape of the surface, not the source of the truth: the parent decides
 * which of them the sub-agent may call, and the parent's executor runs them.
 */
export const SUBAGENT_TOOLS = Object.freeze([
    'list_files', 'read_file', 'find_line', 'search_files',
    'write_file', 'replace_text', 'patch_file', 'batch', 'delete_file', 'make_dir', 'copy_path',
    'read_skill', 'call_ai_memory',
    // Code Mode: the model writes a program, and the program runs in a sandbox of its own.
    'code_mode',
]);

/**
 * May the sub-agent call this tool?
 * @param {string[]} allowed the tools of the spec
 * @param {string} name the name of the tool
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function toolAllowed(allowed = [], name) {
    const list = Array.isArray(allowed) ? allowed.map((item) => String(item ?? '').trim()) : [];
    const tool = String(name ?? '').trim();
    if (!tool) return false;
    if (!list.length) return false;
    return list.includes(tool);
}

/**
 * The tools of the spec that the sub-agent may call.
 * @param {string[]} allowed
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function filterTools(allowed = []) {
    const list = Array.isArray(allowed) ? allowed : [];
    const out = [];
    for (const item of list) {
        const name = String(item ?? '').trim();
        if (!name || out.includes(name)) continue;
        out.push(name);
    }
    return out;
}

/**
 * The names of the tools of the spec.
 * @param {string[]} allowed
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function toolNames(allowed = []) {
    return filterTools(allowed);
}
