/**
 * @file src/shared/utils.js
 * @module shared/utils
 * @purpose The small helpers every part of the sub-agent system uses.
 *
 *   The sub-agent is a separate thread of the parent, and everything it gets travels as
 *   plain data: a string, a number, a list. These helpers turn the loose values of that
 *   data into the strict shapes the loop expects, and never throw on a missing field —
 *   a spec that names nothing is a spec of nothing, and the caller says so.
 *
 * @depends none
 * @usedBy client/interface, server/interface, agent/core, config/parser
 * @exports textOf, listOf, intOf, boolOf, recordOf, unique, clamp, nowIso, sleep
 * @ai.tags subagent, utils
 * @ai.hint pure
 */

/**
 * The text of a value: a string is itself, everything else is an empty string.
 * @param {unknown} value
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function textOf(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * A list of strings out of a value: a list is taken as it is, a string is split by lines.
 * @param {unknown} value
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function listOf(value) {
    if (Array.isArray(value)) return value.map((item) => textOf(item).trim()).filter(Boolean);
    const text = textOf(value).trim();
    if (!text) return [];
    return text.split('\n').map((item) => item.trim()).filter(Boolean);
}

/**
 * An integer out of a value: a number is rounded, a string is parsed, the rest is zero.
 * @param {unknown} value
 * @param {number} [fallback] the value of a missing number
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function intOf(value, fallback = 0) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : fallback;
    const text = textOf(value).trim();
    if (!text) return fallback;
    const number = Number(text);
    if (!Number.isFinite(number)) return fallback;
    return Math.round(number);
}

/**
 * A boolean out of a value: a boolean is itself, a string is read, the rest is false.
 * @param {unknown} value
 * @param {boolean} [fallback]
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function boolOf(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    const text = textOf(value).trim().toLowerCase();
    if (!text) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return fallback;
}

/**
 * A plain object out of a value: an object is itself, everything else is an empty object.
 * @param {unknown} value
 * @returns {object}
 * @exports
 * @ai.hint pure
 */
export function recordOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * A list without repeats: the order of the first appearance is kept.
 * @param {string[]} list
 * @returns {string[]}
 * @exports
 * @ai.hint pure
 */
export function unique(list) {
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
        const value = textOf(item).trim();
        if (!value || out.includes(value)) continue;
        out.push(value);
    }
    return out;
}

/**
 * A number inside the bounds.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 * @exports
 * @ai.hint pure
 */
export function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    if (number < min) return min;
    if (number > max) return max;
    return number;
}

/**
 * The current time as an ISO string.
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function nowIso() {
    return new Date().toISOString();
}

/**
 * Wait for the given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 * @exports
 * @ai.hint io
 */
export async function sleep(ms) {
    const delay = Math.max(0, intOf(ms, 0));
    if (!delay) return;
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
    });
}
