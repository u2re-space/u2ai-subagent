/**
 * @file src/access/fs.js
 * @module access/fs
 * @purpose The files of the project: reading them, writing them, looking inside them.
 *
 *   The sub-agent never touches a file by itself: the parent runs the tools. But a
 *   sub-agent that is started from the command line has no parent, so the primitives
 *   live here — and the parent's tools are built on the same rules: a path is resolved
 *   inside the project and never outside it, and a file is written whole.
 *
 * @depends node:path, node:fs/promises
 * @usedBy cli/interface, agent/tools
 * @exports resolvePath, listFiles, readText, writeText, replaceIn, patchFile, findLines,
 *          searchFiles, makeDirectory, copyPath
 * @ai.tags subagent, files, access
 * @ai.hint io
 */

import path from 'node:path';
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises';

/** The directories that never hold the files of a project. */
const SKIP_DIRS = /^(?:\.git|node_modules|\.hg|\.svn|dist|build|coverage|\.next|\.nuxt|\.cache|\.venv|venv|__pycache__|target|\.backup|\.tmp|\.ai)$/i;

/**
 * Resolve a path inside the project.
 *
 * A path that leaves the project is refused: the tools of a sub-agent work in the
 * directory of the parent and nowhere else.
 *
 * @param {string} root the root of the project
 * @param {string} rel the path of the file
 * @param {{ forWrite?: boolean }} [options]
 * @returns {{ abs: string, rel: string }}
 * @exports
 * @ai.hint pure
 */
export function resolvePath(root, rel, { forWrite = false } = {}) {
    const base = path.resolve(root || process.cwd());
    const target = path.resolve(base, String(rel ?? '').trim() || '.');
    const inside = target === base || target.startsWith(base + path.sep);
    if (!inside) throw new Error(`The path ${rel} is outside the project.`);
    if (forWrite && target === base) throw new Error('The path is the project itself.');
    return { abs: target, rel: path.relative(base, target).split(path.sep).join('/') || '.' };
}

/**
 * The files of a directory.
 * @param {string} root
 * @param {{ path?: string, depth?: number }} [options]
 * @returns {Promise<string[]>}
 * @exports
 * @ai.hint io
 */
export async function listFiles(root, { path: rel = '.', depth = 3 } = {}) {
    const { abs } = resolvePath(root, rel);
    const found = [];
    const walk = async (dir, level) => {
        if (level > depth) return;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.name.startsWith('.') && entry.name !== '.env') continue;
            if (entry.isDirectory()) {
                if (SKIP_DIRS.test(entry.name)) continue;
                await walk(path.join(dir, entry.name), level + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            found.push(path.relative(path.resolve(root), path.join(dir, entry.name)).split(path.sep).join('/'));
        }
    };
    await walk(abs, 0);
    return found.sort();
}

/**
 * The text of a file.
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string>}
 * @exports
 * @ai.hint io
 */
export async function readText(root, rel) {
    const { abs } = resolvePath(root, rel);
    return await readFile(abs, 'utf8');
}

/**
 * Write a file whole.
 * @param {string} root
 * @param {string} rel
 * @param {string} content
 * @returns {Promise<string>} the path of the file
 * @exports
 * @ai.hint io
 */
export async function writeText(root, rel, content) {
    const { abs, rel: safe } = resolvePath(root, rel, { forWrite: true });
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, String(content ?? ''), 'utf8');
    return safe;
}

/**
 * Replace a piece of text in a file.
 * @param {string} root
 * @param {string} rel
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{ path: string, replaced: number }>}
 * @exports
 * @ai.hint io
 */
export async function replaceIn(root, rel, from, to) {
    const text = await readText(root, rel);
    const needle = String(from ?? '');
    if (!needle) throw new Error('The text to replace is empty.');
    const parts = text.split(needle);
    const replaced = parts.length - 1;
    if (!replaced) throw new Error('The text to replace was not found in the file.');
    const safe = await writeText(root, rel, parts.join(String(to ?? '')));
    return { path: safe, replaced };
}

/**
 * Patch a file: replace the first occurrence of a piece of text.
 * @param {string} root
 * @param {string} rel
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{ path: string, patched: boolean }>}
 * @exports
 * @ai.hint io
 */
export async function patchFile(root, rel, from, to) {
    const text = await readText(root, rel);
    const needle = String(from ?? '');
    if (!needle) throw new Error('The text to patch is empty.');
    const at = text.indexOf(needle);
    if (at < 0) throw new Error('The text to patch was not found in the file.');
    const patched = text.slice(0, at) + String(to ?? '') + text.slice(at + needle.length);
    const safe = await writeText(root, rel, patched);
    return { path: safe, patched: true };
}

/**
 * The lines of a file that hold a piece of text.
 * @param {string} root
 * @param {string} rel
 * @param {string} needle
 * @returns {Promise<Array<{ line: number, text: string }>>}
 * @exports
 * @ai.hint io
 */
export async function findLines(root, rel, needle) {
    const text = await readText(root, rel);
    const want = String(needle ?? '');
    const out = [];
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
        if (!want || line.includes(want)) out.push({ line: index + 1, text: line });
    }
    return out;
}

/**
 * The files of the project that hold a piece of text.
 * @param {string} root
 * @param {string} needle
 * @param {{ path?: string, limit?: number }} [options]
 * @returns {Promise<Array<{ path: string, line: number, text: string }>>}
 * @exports
 * @ai.hint io
 */
export async function searchFiles(root, needle, { path: rel = '.', limit = 200 } = {}) {
    const files = await listFiles(root, { path: rel, depth: 5 });
    const want = String(needle ?? '');
    const out = [];
    for (const file of files) {
        if (out.length >= limit) break;
        if (!/\.(?:js|mjs|cjs|jsx|ts|tsx|json|md|css|scss|sass|less|html|htm|vue|svelte|yml|yaml|txt)$/i.test(file)) continue;
        const text = await readText(root, file).catch(() => null);
        if (text === null) continue;
        const lines = text.split('\n');
        for (const [index, line] of lines.entries()) {
            if (!want || line.includes(want)) {
                out.push({ path: file, line: index + 1, text: line.trim().slice(0, 200) });
                if (out.length >= limit) break;
            }
        }
    }
    return out;
}

/**
 * Make a directory of the project.
 * @param {string} root
 * @param {string} rel
 * @returns {Promise<string>}
 * @exports
 * @ai.hint io
 */
export async function makeDirectory(root, rel) {
    const { abs, rel: safe } = resolvePath(root, rel, { forWrite: true });
    await mkdir(abs, { recursive: true });
    return safe;
}

/**
 * Copy a file of the project.
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @returns {Promise<string>}
 * @exports
 * @ai.hint io
 */
export async function copyPath(root, from, to) {
    const source = resolvePath(root, from);
    const target = resolvePath(root, to, { forWrite: true });
    const info = await stat(source.abs).catch(() => null);
    if (!info?.isFile()) throw new Error(`The file ${from} is not there.`);
    await mkdir(path.dirname(target.abs), { recursive: true });
    await copyFile(source.abs, target.abs);
    return target.rel;
}
