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
 *   The command also runs the worker of a parent: `ai-subagent --worker` waits for the
 *   spec on the channel and runs the cycle there. A parent that starts the worker as a
 *   process starts exactly that.
 *
 * @depends agent/core, client/interface, access/fs, config/spec, openai/client, shared/utils
 * @usedBy bin/ai-subagent
 * @exports parseArgs, toolExecutor, main, mainWorker
 * @ai.tags subagent, cli
 * @ai.hint io
 */

import { runSubAgent } from '../agent/core.js';
import { spawnSubAgent } from '../client/interface.js';
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
        const file = textOf(args.path);
        switch (name) {
            case 'list_files':
                return (await listFiles(root, { path: file || '.', depth: intArg(args.depth, 3) })).join('\n');
            case 'read_file':
                return await readText(root, file);
            case 'find_line':
                return JSON.stringify(await findLines(root, file, textOf(args.text)));
            case 'search_files':
                return JSON.stringify(await searchFiles(root, textOf(args.text), { path: file || '.' }));
            case 'write_file':
                return `Written: ${await writeText(root, file, textOf(args.content))}`;
            case 'replace_text':
                return JSON.stringify(await replaceIn(root, file, textOf(args.oldText ?? args.from), textOf(args.newText ?? args.to)));
            case 'patch_file':
                return JSON.stringify(await patchFile(root, file, textOf(args.oldText ?? args.from), textOf(args.newText ?? args.to)));
            case 'make_dir':
                return `Created: ${await makeDirectory(root, file)}`;
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
 *   model: string, baseURL: string, env: string, worker: boolean, transport: string,
 *   instructions: string, quiet: boolean }}
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
        worker: false,
        transport: 'thread',
        instructions: '',
        quiet: false,
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
        } else if (item === '--instructions') {
            out.instructions = textOf(list[++index]);
        } else if (item === '--transport') {
            const value = textOf(list[++index]).trim().toLowerCase();
            out.transport = value === 'process' ? 'process' : 'thread';
        } else if (item === '--quiet' || item === '-q') {
            out.quiet = true;
        } else if (item === '--worker') {
            out.worker = true;
        } else if (!out.goal) {
            out.goal = item;
        }
    }
    return out;
}

/**
 * Run the command of a sub-agent: the sub-agent works alone, the command prints its life.
 *
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
        out('The sub-agent needs a goal: ai-subagent "<what to do>" --role <role> [--root <dir>] '
            + '[--files a.js,b.js] [--turns 8] [--model <model>] [--transport thread|process].');
        return 2;
    }
    const apiKey = textOf(env[args.env || 'ROUTERAI_API_KEY']) || textOf(env.OPENAI_API_KEY);
    if (!apiKey) {
        out('The sub-agent has no key of the API: set ROUTERAI_API_KEY or OPENAI_API_KEY.');
        return 2;
    }
    const spec = normalizeSpec({
        name: `${args.role || 'subagent'}-cli`,
        role: {
            name: args.role || 'subagent',
            instructions: args.instructions
                || `You are the ${args.role || 'subagent'} of a web project. Work on the goal in the directory `
                    + 'of the project: read what you need, write the files of the goal, and report what you did.',
            tools: ['list_files', 'read_file', 'find_line', 'search_files', 'write_file', 'replace_text', 'patch_file', 'batch'],
        },
        goal: args.goal,
        files: args.files,
        rights: { cwd: args.root, write: true },
        budget: { maxTurns: args.turns },
        model: {
            model: args.model || textOf(env.AI_WEBDEV_MODEL) || 'openai/gpt-6.1-terra',
            baseURL: args.baseURL || textOf(env.AI_WEBDEV_BASE_URL) || 'https://routerai.ru/api/v1',
            apiKey,
            effort: textOf(env.AI_WEBDEV_EFFORT) || 'high',
        },
    });
    const run = (transport) => {
        const onEvent = (event) => {
            if (args.quiet) return;
            if (event?.type !== 'status') return;
            const turn = event.turn ? ` (ход ${event.turn})` : '';
            const tools = Array.isArray(event.tools) && event.tools.length ? `: ${event.tools.join(', ')}` : '';
            out(`[${event.role}] ${event.status}${turn}${tools}`);
        };
        if (transport === 'thread') {
            // The thread is the cheap default: the cycle runs here, and the tools run here.
            return runSubAgent({
                spec,
                onCall: async (call) => await toolExecutor(args.root)(call.name, call.arguments),
                onEvent,
            });
        }
        // The process is the isolated one: the worker lives in its own process, and the
        // calls of the tools travel over IPC back to the command.
        return spawnSubAgent({
            spec,
            transport: 'process',
            cwd: args.root,
            onCall: async (call) => await toolExecutor(args.root)(call.name, call.arguments),
            onEvent,
        }).then(({ done }) => done);
    };
    const report = await run(args.transport);
    out(report.report || 'The sub-agent said nothing.');
    return report.ok ? 0 : 1;
}

/**
 * The entry of the worker over the process channel: the spec comes with the first frame.
 *
 * A parent that starts `ai-subagent --worker` as a process speaks to it over IPC: the
 * parent sends `spawn` with the spec, the worker runs the cycle of the model and sends
 * the calls of the tools back. The report closes the process.
 *
 * @param {{ port?: object|null }} [options]
 * @returns {Promise<number>} the exit code
 * @exports
 * @ai.hint io
 */
export async function mainWorker(options = {}) {
    const { workerMain } = await import('../server/interface.js');
    const report = await workerMain({ port: options.port ?? null });
    return report.ok ? 0 : 1;
}
