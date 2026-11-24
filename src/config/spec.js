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
 * @exports normalizeSpec, specRole, specGoal, specFiles, specTools, specRights, specBudget,
 *          specModel, specTexts, specOutput
 * @ai.tags subagent, spec, contract
 * @ai.hint pure
 */

import { boolOf, intOf, listOf, recordOf, textOf, unique } from '../shared/utils.js';
import { SPEC_VERSION } from '../client/protocol.js';
import { readSharedBlock } from '../shared/shared.js';

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
 * The economy of the turns of a sub-agent.
 *
 * The parent writes down how much output the sub-agent may spend:
 *
 *   - `maxOutputTokens` — the cap of the turn, in output tokens. The cap of the model wins
 *     over it, and the cap of the parent wins over the cap of the model.
 *   - `models` — the caps the parent knows better than the table of the package:
 *     `{ '<id>': { maxOutput: 65536 } }`.
 *   - `writeGate` — whether the sub-agent has to open the write gate before it writes.
 *     The gate is the turn of the inspection: it reads the project with a reduced budget,
 *     says how big the write is expected to be, and the write turn gets the budget that
 *     estimate earns.
 */
export const DEFAULT_OUTPUT = Object.freeze({
    maxOutputTokens: null,
    models: {},
    writeGate: true,
});

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
        // The economy of the turns: the cap of the output and the gate of the write.
        output: normalizeOutput(source.output),
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
            // The parts of the request of the parent: the picture of the reference travels
            // with the work, so the sub-agent looks at the same target.
            parts: Array.isArray(source.context?.parts) ? source.context.parts : [],
        },
        // The shared memory of the hand-over: the big texts of the spec (the instructions
        // of the role, the notes of the context) live in one buffer the parent wrote, and
        // the thread reads them from there instead of a copy. A spec that carries no
        // buffer carries its texts inside itself, the way it always did.
        shared: source.shared instanceof SharedArrayBuffer ? source.shared : null,
    };
}

/**
 * The economy of the turns of a sub-agent: the cap of the output and the gate of the write.
 *
 * Every field has a default, and the wrong type never throws: a parent that names no cap
 * gets the cap of the model, and a parent that names a cap the model cannot take gets the
 * cap of the model instead (the cap is clamped, never refused).
 *
 * @param {unknown} value the economy of the spec
 * @returns {{ maxOutputTokens: number|null, models: object, writeGate: boolean }}
 * @exports
 * @ai.hint pure
 */
export function normalizeOutput(value) {
    const source = recordOf(value);
    const models = recordOf(source.models);
    const caps = {};
    for (const [id, profile] of Object.entries(models)) {
        const key = textOf(id).trim();
        if (!key) continue;
        const entry = recordOf(profile);
        const cap = intOf(entry.maxOutput, 0);
        const window = intOf(entry.window, 0);
        if (cap <= 0 && window <= 0) continue;
        caps[key] = {
            ...(cap > 0 ? { maxOutput: cap } : {}),
            ...(window > 0 ? { window } : {}),
        };
    }
    return {
        maxOutputTokens: intOf(source.maxOutputTokens, 0) > 0 ? intOf(source.maxOutputTokens, 0) : null,
        models: caps,
        writeGate: boolOf(source.writeGate, DEFAULT_OUTPUT.writeGate),
    };
}

/**
 * The economy of the turns of a sub-agent.
 * @param {object} spec
 * @returns {{ maxOutputTokens: number|null, models: object, writeGate: boolean }}
 * @exports
 * @ai.hint pure
 */
export function specOutput(spec) {
    return normalizeOutput(spec?.output);
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
 * The texts of the spec: from the shared memory, when the parent gave a buffer, or from
 * the spec itself.
 *
 * The shared buffer holds the big texts of a hand-over — the instructions of the role and
 * the notes of the context. A thread reads them from there instead of a copy: one buffer,
 * one copy in the memory.
 *
 * @param {object} spec the spec of the sub-agent
 * @returns {{ instructions: string, notes: string }}
 * @exports
 * @ai.hint pure
 */
export function specTexts(spec) {
    const shared = spec?.shared instanceof SharedArrayBuffer ? readSharedBlock(spec.shared) : null;
    if (shared) {
        return {
            instructions: shared.text('instructions') || textOf(spec?.role?.instructions),
            notes: shared.text('notes') || textOf(spec?.context?.notes),
        };
    }
    return {
        instructions: textOf(spec?.role?.instructions),
        notes: textOf(spec?.context?.notes),
    };
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
