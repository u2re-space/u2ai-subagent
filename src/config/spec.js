/**
 * @file src/config/spec.js
 * @module config/spec
 * @purpose The spec of a sub-agent: what the parent hands to the thread it starts.
 *
 *   A sub-agent has no role of its own. The parent writes down everything the sub-agent
 *   is: the **role** it inherits (its name, its instructions, the tools it may call and
 *   the budget of its turns), the **goal** it works on, the **files** it may touch, and
 *   the **rights** it has inside the project (the working directory it lives in, the
 *   files it owns).
 *
 *   The spec is the whole inheritance: what the parent writes here is what the sub-agent
 *   is allowed to do. A sub-agent that was given no role has no role.
 *
 * @depends shared/utils
 * @usedBy client/interface, server/interface, config/parser
 * @exports normalizeSpec, specRole, specGoal, specFiles, specTools, specRights, specBudget
 * @ai.tags subagent, spec, contract
 * @ai.hint pure
 */

import { boolOf, intOf, listOf, recordOf, textOf, unique } from '../shared/utils.js';
import { SPEC_VERSION } from '../client/protocol.js';

/**
 * The tools a sub-agent may call when the parent names none.
 *
 * A sub-agent works on files: it reads the project, writes the files of its goal and
 * patches what it has written. The wide tools of the parent (the browser, the shell, the
 * pictures) belong to the parent that owns the stage.
 */
export const DEFAULT_TOOLS = Object.freeze([
    'list_files', 'read_file', 'find_line', 'search_files',
    'write_file', 'replace_text', 'patch_file', 'batch',
]);

/**
 * The budget of turns a sub-agent gets when the parent names none.
 */
export const DEFAULT_TURNS = 8;

/**
 * The model of a sub-agent: the model, the backend, the key and the effort.
 *
 * The sub-agent talks to the API on its own thread, so it needs the address of the API
 * and the key of it. The parent writes them down in the spec: the sub-agent inherits the
 * API of the parent instead of looking for one of its own.
 *
 * @param {unknown} value the model of the spec
 * @returns {{ model: string, baseURL: string, apiKey: string, effort: string|null,
 *   summary: string|null, retries: number, timeoutMs: number }}
 * @exports
 * @ai.hint pure
 */
export function normalizeModel(value) {
    const source = recordOf(value);
    return {
        model: textOf(source.model).trim(),
        baseURL: textOf(source.baseURL).trim(),
        apiKey: textOf(source.apiKey).trim(),
        effort: textOf(source.effort).trim() || null,
        summary: textOf(source.summary).trim() || null,
        retries: Math.max(0, intOf(source.retries, 2)),
        timeoutMs: Math.max(0, intOf(source.timeoutMs, 0)),
    };
}

/**
 * Normalize the spec of a sub-agent.
 *
 * Every field has a default, and the wrong type never throws: a spec that names nothing
 * is a spec of nothing, and the caller finds out by the report.
 *
 * @param {object} raw the spec as the parent wrote it
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function normalizeSpec(raw = {}) {
    const source = recordOf(raw);
    const role = recordOf(source.role);
    const rights = recordOf(source.rights);
    const budget = recordOf(source.budget);
    return {
        version: intOf(source.version, SPEC_VERSION),
        // The role the sub-agent inherits: its name, its instructions and its tools.
        role: {
            name: textOf(role.name).trim(),
            instructions: textOf(role.instructions),
            tools: unique(listOf(role.tools)),
            schema: recordOf(role.schema) && Object.keys(recordOf(role.schema)).length
                ? recordOf(role.schema)
                : null,
            schemaName: textOf(role.schemaName).trim() || 'response',
        },
        // The goal of the work and why it goes to this sub-agent.
        goal: textOf(source.goal).trim(),
        reason: textOf(source.reason).trim(),
        // The files the sub-agent owns: it may write them and nothing else.
        files: unique(listOf(source.files)),
        // The rights inside the project.
        rights: {
            cwd: textOf(rights.cwd).trim(),
            write: boolOf(rights.write, true),
            readOnly: boolOf(rights.readOnly, false),
        },
        // The budget of the thread.
        budget: {
            maxTurns: Math.max(1, intOf(budget.maxTurns, DEFAULT_TURNS)),
            timeoutMs: intOf(budget.timeoutMs, 0),
        },
        // The name the parent gives the sub-agent, so the logs of the parent and the
        // report of the sub-agent speak about the same thread.
        name: textOf(source.name).trim(),
        // The model of the sub-agent: the same model, the same backend and the same key
        // the parent uses. The sub-agent talks to the API on its own, but it talks to the
        // same API, and the key of the parent travels with the spec.
        model: normalizeModel(source.model),
        // The context the parent shares with the sub-agent: the picture of the reference,
        // the notes of the memory, the skills it may read.
        context: {
            reference: Array.isArray(source.context?.reference) ? source.context.reference : [],
            memory: textOf(source.context?.memory),
            skills: listOf(source.context?.skills),
            notes: textOf(source.context?.notes),
        },
    };
}

/**
 * The name of the role the sub-agent inherits.
 * @param {object} spec
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function specRole(spec) {
    return textOf(spec?.role?.name).trim();
}

/**
 * The goal of the work.
 * @param {object} spec
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function specGoal(spec) {
    return textOf(spec?.goal).trim();
}

/**
 * The files the sub-agent owns.
 * @param {object} spec
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function specFiles(spec) {
    return listOf(spec?.files);
}

/**
 * The tools the sub-agent may call.
 * @param {object} spec
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function specTools(spec) {
    const named = unique(listOf(spec?.role?.tools));
    return named.length ? named : [...DEFAULT_TOOLS];
}

/**
 * The rights of the sub-agent inside the project.
 * @param {object} spec
 * @returns {{ cwd: string, write: boolean, readOnly: boolean }}
 * @exports
 * @ai.hint pure
 */
export function specRights(spec) {
    const rights = recordOf(spec?.rights);
    return {
        cwd: textOf(rights.cwd).trim(),
        write: boolOf(rights.write, true),
        readOnly: boolOf(rights.readOnly, false),
    };
}

/**
 * The budget of the thread.
 * @param {object} spec
 * @returns {{ maxTurns: number, timeoutMs: number }}
 * @exports
 * @ai.hint pure
 */
export function specBudget(spec) {
    const budget = recordOf(spec?.budget);
    return {
        maxTurns: Math.max(1, intOf(budget.maxTurns, DEFAULT_TURNS)),
        timeoutMs: intOf(budget.timeoutMs, 0),
    };
}

/**
 * The model of the sub-agent: the API it talks to.
 * @param {object} spec
 * @returns {{ model: string, baseURL: string, apiKey: string, effort: string|null,
 *   summary: string|null, retries: number, timeoutMs: number }}
 * @exports
 * @ai.hint pure
 */
export function specModel(spec) {
    return normalizeModel(spec?.model);
}
