/**
 * @file src/config/profiles.js
 * @module config/profiles
 * @purpose The cap of the output of a model: the table of the house, the cap of a request
 *          and the budget of the write turn.
 *
 *   A sub-agent talks to the API on its own thread, so the economy of the run travels with
 *   it: the cap of the output of the model, the reduced cap of the inspection and the
 *   budget of the write — the one the estimate of the model earns at the gate.
 *
 *   The table is the table of the house (`ai-webdev` keeps the same one): the text models
 *   are tuned by the live answers of the gateway (RouterAI, November 2026):
 *
 *   - MiniMax M3.1 Flash — 1M tokens of context (4 MiB of text) and 512K of output.
 *   - Gemini 4 Hydrogen — 1M tokens of context (4 MiB of text) and 64K of output.
 *   - Kimi K3.1 Pro — 1M tokens of context (4 MiB of text) and 944K of output.
 *   - The GPT family of the house — 1M tokens of context and 128K of output.
 *
 *   A model that is not in the table gets **no cap of its own**: the parent of a sub-agent
 *   may ask for one, and a cap the table does not know is not guessed at — a model with a
 *   smaller limit than the table would refuse the request, and a refused request is a
 *   broken run. The parent may also override the cap of any model it knows better
 *   (`models` of the spec).
 *
 * @depends none
 * @usedBy agent/core, config/spec
 * @exports MODEL_PROFILES, getModelProfile, maxOutputFor, writeBudgetFor
 * @ai.tags subagent, model, profiles, budget
 * @ai.hint pure
 */

const GPT_MAX_OUTPUT = 128 * 1000;
const GPT_WINDOW = 1024 * 1024;

/**
 * The built-in model profiles: the window of the context in bytes and the cap of the output
 * in tokens.
 * @type {Readonly<Record<string, { window: number, maxOutput: number }>>}
 * @exports
 */
export const MODEL_PROFILES = Object.freeze({
    'minimax/minimax-m3.1-flash': { window: 1024 * 1024 * 4, maxOutput: 512 * 1024 },
    'google/gemini-4-hydrogen': { window: 1024 * 1024 * 4, maxOutput: 64 * 1024 },
    'moonshotai/kimi-k3.1-pro': { window: 1024 * 1024 * 4, maxOutput: 944_000 },
    'openai/gpt-6.2-sol': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'openai/gpt-6.1-sol': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'openai/gpt-6.1-terra': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'openai/gpt-6-luna': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'gpt-6.2-sol': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'gpt-6.1-sol': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'gpt-6.1-terra': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'gpt-6-luna': { window: GPT_WINDOW * 4, maxOutput: GPT_MAX_OUTPUT },
    'openai/gpt-image-2.6-sunburst': { window: 0, maxOutput: 0 },
    'gpt-image-2.6-sunburst': { window: 0, maxOutput: 0 },
});

/** The profile of a model that is not in the table: no cap of its own. */
const DEFAULT_PROFILE = Object.freeze({
    window: 256 * 1024,
    maxOutput: 0,
});

/**
 * The profile of a model, with the overrides of the parent applied on top.
 *
 * The parent of a sub-agent knows the caps of its models better than the table of the
 * package does: the overrides of the spec win over the table.
 *
 * @param {string|null} model the model of the request
 * @param {object|null} [config] the config of the run: `{ models: { '<id>': { maxOutput } } }`
 * @returns {{ window: number, maxOutput: number }}
 * @exports
 * @ai.hint pure
 */
export function getModelProfile(model, config = null) {
    const id = typeof model === 'string' ? model : '';
    const base = Object.hasOwn(MODEL_PROFILES, id) ? MODEL_PROFILES[id] : DEFAULT_PROFILE;
    const override = config?.models?.[id];
    if (!override || typeof override !== 'object') return base;
    return {
        window: Number.isSafeInteger(override.window) ? override.window : base.window,
        maxOutput: Number.isSafeInteger(override.maxOutput) ? override.maxOutput : base.maxOutput,
    };
}

/**
 * The output cap of a model for a request.
 *
 * The cap of the parent wins over the table of the package, and the table wins over the
 * cap of the model: the model knows its own limit better than anybody.
 *
 * A read-only turn (the inspection of the project) gets an eighth of the cap: the turn
 * reads and reports, it does not write the files of the goal.
 *
 * @param {string|null} model the model of the request
 * @param {object|null} [config] the config of the run
 * @param {number|null} [requested] the cap the parent asks for
 * @param {{ readOnly?: boolean }} [options]
 * @returns {number|null} the cap of the turn, `null` when the model has no limit
 * @exports
 * @ai.hint pure
 */
export function maxOutputFor(model, config = null, requested = null, { readOnly = false } = {}) {
    const profile = getModelProfile(model, config);
    const cap = Number.isSafeInteger(requested) && requested > 0
        ? (profile.maxOutput > 0 ? Math.min(requested, profile.maxOutput) : requested)
        : (profile.maxOutput > 0 ? profile.maxOutput : null);
    if (readOnly && cap !== null) return Math.max(4, Math.floor(cap / 8));
    return cap;
}

/** The lower bound of the estimate of the write: a quarter of the write cap. */
const WRITE_ESTIMATE_FLOOR = 0.25;

/**
 * The output budget of the write turn, from the estimate the model gave at the gate.
 *
 * The gate may say how big the write of the goal is expected to be, in output tokens. The
 * estimate is a wish, not a fact: the budget it earns is clamped into the band between a
 * quarter of the write cap and the write cap itself — the write must always be able to
 * finish, and a model that asked for the whole budget gets it.
 *
 * The estimate is a wish about the size of the work, so it is read as a fraction of the
 * cap and turned into a budget: a wish of a third of the cap earns a budget of about
 * three quarters of it (the square root of the fraction), and the band keeps the answer
 * safe on both sides.
 *
 * A missing estimate, an estimate that is not a number, and an estimate that is not positive
 * all mean the same thing: the model did not say how big the work is, so the write turn gets
 * the whole cap. A model that says "0" or "-5" is saying "I do not know", not "write nothing".
 *
 * @param {string|null} model the model of the turn
 * @param {object|null} [config] the config of the run
 * @param {number|null} [requested] the cap the parent asks for
 * @param {unknown} [estimate] the estimate the model gave at the gate
 * @returns {number|null} the budget of the write turn
 * @exports
 * @ai.hint pure
 */
export function writeBudgetFor(model, config = null, requested = null, estimate = null) {
    const cap = maxOutputFor(model, config, requested);
    if (cap === null) return null;
    // A fraction is rounded up: the estimate is a wish, and the round must not cut it.
    const wanted = Math.ceil(Math.sqrt(Number(estimate) / cap) * cap);
    // No estimate, a broken one, or one that is not positive: the whole cap.
    if (!Number.isFinite(wanted) || wanted <= 0) return cap;
    // The estimate is clamped into the band: a quarter of the cap at the bottom, the cap at
    // the top.
    const floor = Math.ceil(cap * WRITE_ESTIMATE_FLOOR);
    return Math.min(Math.max(wanted, floor), cap);
}
