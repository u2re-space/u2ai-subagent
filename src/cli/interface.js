/**
 * @file src/cli/interface.js
 * @module cli/interface
 * @purpose The command line of a sub-agent: a goal, a role and a project.
 *
 *   The sub-agent can be started by a person, without a parent: the command takes the
 *   goal of the work, the name of the role and the directory of the project, and the
 *   sub-agent works there on its own. The tools are the ones of the project — the same
 *   rules, the same paths, the same files.
 *
 * @depends agent/core, access/fs, config/spec, openai/client, shared/utils
 * @usedBy bin/ai-subagent
 * @exports parseArgs, toolExecutor, main
 * @ai.tags subagent, cli
 * @ai.hint io
 */

import { runSubAgent } from '../agent/core.js';
import { copyPath, findLines, listFiles, makeDirectory, patchFile, readText, replaceIn, searchFiles, writeText } from '../access/fs.js';
import { normalizeSpec } from '../config/spec.js';
import { createModelClient } from '../openai/client.js';
import { textOf } from '../shared/utils.js';

/**
 * The tools of a sub-agent that works alone: the files of the project.
 *
 * @param {string} root the root of the project
 * @returns {(name: string, args: object) => Promise<string>}
 * @exports
 * @ai.hint io
 */
export function toolExecutor(root) {
    return async (name, args = {}) => {
        const path = textOf(args.path);
        switch (name) {
            case 'list_files':
                return (await listFiles(root, { path: path || '.', depth: intArg(args.depth, 3) })).join('\n');
            case 'read_file':
                return await readText(root, path);
            case 'find_line':
                return JSON.stringify(await findLines(root, path, textOf(args.text)));
            case 'search_files':
                return JSON.stringify(await searchFiles(root, textOf(args.text), { path: path || '.' }));
            case 'write_file':
                return `Written: ${await writeText(root, path, textOf(args.content))}`;
            case 'replace_text':
                return JSON.stringify(await replaceIn(root, path, textOf(args.oldText ?? args.from), textOf(args.newText ?? args.to)));
            case 'patch_file':
                return JSON.stringify(await patchFile(root, path, textOf(args.oldText ?? args.from), textOf(args.newText ?? args.to)));
            case 'make_dir':
                return `Created: ${await makeDirectory(root, path)}`;
            case 'copy_path':
                return `Copied: ${await copyPath(root, textOf(args.source), textOf(args.destination ?? args.to))}`;
            default:
                return `The tool ${name} is not known.`;
        }
    };
}

/**
 * An integer out of a value.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 * @ai.hint pure
 */
function intArg(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
}

/**
 * Parse the arguments of the command.
 * @param {string[]} argv
 * @returns {{ goal: string, role: string, root: string, files: string[], turns: number,
 *   model: string, baseURL: string, env: string }}
 * @exports
 * @ai.hint pure
 */
export function parseArgs(argv = []) {
    const list = Array.isArray(argv) ? argv.map(String) : [];
    const out = {
        goal: '',
        role: '',
        root: process.cwd(),
        files: [],
        turns: 8,
        model: '',
        baseURL: '',
        env: '',
    };
    for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        if (item === '--role') {
            out.role = textOf(list[++index]);
        } else if (item === '--root') {
            out.root = textOf(list[++index]);
        } else if (item === '--files') {
            out.files = textOf(list[++index]).split(',').map((entry) => entry.trim()).filter(Boolean);
        } else if (item === '--turns') {
            out.turns = intArg(list[++index], 8);
        } else if (item === '--model') {
            out.model = textOf(list[++index]);
        } else if (item === '--base-url') {
            out.baseURL = textOf(list[++index]);
        } else if (item === '--env') {
            out.env = textOf(list[++index]);
        } else if (!out.goal) {
            out.goal = item;
        }
    }
    return out;
}

/**
 * Run the command of a sub-agent.
 * @param {string[]} argv
 * @param {{ stdout?: Function|null, stderr?: Function|null, env?: object }} [options]
 * @returns {Promise<number>} the exit code
 * @exports
 * @ai.hint io
 */
export async function main(argv = [], options = {}) {
    const args = parseArgs(argv);
    const out = typeof options.stdout === 'function' ? options.stdout : (text) => process.stdout.write(`${text}\n`);
    const env = options.env ?? process.env;
    if (!args.goal) {
        out('The sub-agent needs a goal: ai-subagent "<what to do>" --role <role> [--root <dir>].');
        return 2;
    }
    const apiKey = textOf(env[args.env || 'ROUTERAI_API_KEY']) || textOf(env.OPENAI_API_KEY);
    if (!apiKey) {
        out('The sub-agent has no key of the API: set ROUTERAI_API_KEY or OPENAI_API_KEY.');
        return 2;
    }
    const spec = normalizeSpec({
        role: {
            name: args.role || 'subagent',
            instructions: `You are the ${args.role || 'subagent'} of a web project. Work on the goal in the directory of the project: read what you need, write the files of the goal, and report what you did.`,
            tools: ['list_files', 'read_file', 'find_line', 'search_files', 'write_file', 'replace_text', 'patch_file', 'batch'],
        },
        goal: args.goal,
        files: args.files,
        rights: { cwd: args.root, write: true },
        budget: { maxTurns: args.turns },
    });
    const client = createModelClient({
        model: args.model || textOf(env.AI_WEBDEV_MODEL) || 'openai/gpt-6.1-terra',
        baseURL: args.baseURL || textOf(env.AI_WEBDEV_BASE_URL) || 'https://routerai.ru/api/v1',
        apiKey,
        effort: textOf(env.AI_WEBDEV_EFFORT) || 'high',
    });
    const report = await runSubAgent({
        spec,
        client,
        onCall: async (call) => await toolExecutor(args.root)(call.name, call.arguments),
        onEvent: (event) => {
            if (event?.type === 'status') out(`[${event.role}] ${event.status}${event.turn ? ` (turn ${event.turn})` : ''}`);
        },
    });
    out(report.report || 'The sub-agent said nothing.');
    return report.ok ? 0 : 1;
}
