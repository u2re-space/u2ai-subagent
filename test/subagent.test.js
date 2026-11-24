import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';

import { normalizeSpec, specTools, specRights, specBudget } from '../src/config/spec.js';
import { runSubAgent } from '../src/agent/core.js';
import { runSubAgent as runSubAgentThread } from '../src/client/interface.js';
import { createModelClient, buildModelBody } from '../src/openai/client.js';
import { parseModelAnswer } from '../src/openai/parser.js';
import { createFrame, isFrame, FRAME } from '../src/client/protocol.js';
import { toolExecutor, parseArgs } from '../src/cli/interface.js';

/** The requests the fake API of the test received. */
const requests = [];

/** The calls of the tools the parent ran for the sub-agent. */
const calls = [];

test('the spec of a sub-agent has every field', () => {
    const spec = normalizeSpec({
        role: { name: 'styler', instructions: 'You are the styler.', tools: ['read_file', 'write_file'] },
        goal: 'Fix the spacing of the header.',
        files: ['src/styles/main.scss'],
        rights: { cwd: '/project', write: true },
        budget: { maxTurns: 4 },
    });
    assert.equal(spec.role.name, 'styler');
    assert.equal(spec.goal, 'Fix the spacing of the header.');
    assert.deepEqual(spec.files, ['src/styles/main.scss']);
    assert.deepEqual(specTools(spec), ['read_file', 'write_file']);
    assert.equal(specRights(spec).cwd, '/project');
    assert.equal(specBudget(spec).maxTurns, 4);
});

test('a sub-agent without a role has no tools and no rights', () => {
    const spec = normalizeSpec({ goal: 'Do something.' });
    assert.equal(spec.role.name, '');
    assert.deepEqual(specTools(spec).length > 0, true);
    assert.equal(specRights(spec).write, true);
});

test('the frames of the protocol carry the version', () => {
    const frame = createFrame(FRAME.ready, { pid: 1 });
    assert.equal(frame.v, 1);
    assert.equal(frame.type, 'ready');
    assert.equal(isFrame(frame), true);
    assert.equal(isFrame({ v: 99, type: 'ready' }), false);
});

test('the body of a request carries the model and the tools', () => {
    const body = buildModelBody({
        model: 'openai/gpt-6.1-terra',
        instructions: 'You are the styler.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Fix it.' }] }],
        tools: [{ type: 'function', name: 'read_file', parameters: {} }],
        effort: 'high',
    });
    assert.equal(body.model, 'openai/gpt-6.1-terra');
    assert.equal(body.instructions, 'You are the styler.');
    assert.equal(body.tools.length, 1);
    assert.equal(body.reasoning.effort, 'high');
});

test('the answer of the model is read as text and as calls', () => {
    const answer = parseModelAnswer({
        id: 'resp-1',
        status: 'completed',
        output: [
            { type: 'function_call', id: 'fc-1', call_id: 'c-1', name: 'read_file', arguments: '{"path":"a.scss"}' },
        ],
    });
    assert.equal(answer.toolCalls.length, 1);
    assert.equal(answer.toolCalls[0].name, 'read_file');
    assert.equal(answer.toolCalls[0].arguments.path, 'a.scss');
});

test('the sub-agent does the work with the tools of the parent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-'));
    try {
        await writeFile(path.join(root, 'note.txt'), 'the old text\n', 'utf8');
        const calls = [];
        // The model asks for the file, then answers with the final answer.
        let turn = 0;
        const client = {
            config: { model: 'test-model', effort: 'low' },
            async request() {
                turn += 1;
                if (turn === 1) {
                    return parseModelAnswer({
                        status: 'completed',
                        output: [{
                            type: 'function_call',
                            id: 'fc-1',
                            call_id: 'c-1',
                            name: 'read_file',
                            arguments: '{"path":"note.txt"}',
                        }],
                    });
                }
                return parseModelAnswer({
                    status: 'completed',
                    output_text: 'The note was read.',
                });
            },
        };
        const report = await runSubAgent({
            spec: {
                role: { name: 'styler', instructions: 'You are the styler.', tools: ['read_file'] },
                goal: 'Read the note.',
                files: ['note.txt'],
                rights: { cwd: root },
            },
            client,
            onCall: async (call) => {
                calls.push(call.name);
                return await toolExecutor(root)(call.name, call.arguments);
            },
        });
        assert.equal(report.ok, true);
        assert.equal(report.turns, 2);
        assert.deepEqual(calls, ['read_file']);
        assert.match(report.report, /read/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a sub-agent without a goal says so and does nothing', async () => {
    const report = await runSubAgent({ spec: { role: { name: 'coder' } } });
    assert.equal(report.ok, false);
    assert.equal(report.error, 'no-goal');
    assert.equal(report.turns, 0);
});

test('a sub-agent without a role is refused', async () => {
    const report = await runSubAgent({ spec: { goal: 'Do something.' } });
    assert.equal(report.ok, false);
    assert.equal(report.error, 'no-role');
});

test('the budget of the turns is the limit of the work', async () => {
    let turn = 0;
    const client = {
        config: { model: 'test-model' },
        async request() {
            turn += 1;
            return parseModelAnswer({
                status: 'completed',
                output: [{ type: 'function_call', id: 'fc-1', call_id: `c-${turn}`, name: 'read_file', arguments: '{}' }],
            });
        },
    };
    const report = await runSubAgent({
        spec: {
            role: { name: 'coder', tools: ['read_file'] },
            goal: 'Keep reading.',
            budget: { maxTurns: 3 },
        },
        client,
        onCall: async () => 'nothing',
    });
    assert.equal(report.turns, 3);
    assert.equal(report.ok, false);
});

test('the tools of the project write the files of the goal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-'));
    try {
        const tools = toolExecutor(root);
        await tools('write_file', { path: 'src/styles/main.scss', content: 'body { color: #fff; }\n' });
        const text = await readFile(path.join(root, 'src', 'styles', 'main.scss'), 'utf8');
        assert.match(text, /color: #fff/);
        const found = await tools('search_files', { text: 'color' });
        assert.match(found, /main\.scss/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('the sub-agent runs in a thread of the parent and calls its tools', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ai-subagent-thread-'));
    // The API of the test: the thread of the sub-agent talks to it over the network,
    // exactly as it talks to the API of the house.
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            requests.push(JSON.parse(body));
            // The first turn reads the file, the second writes the stylesheet, the third
            // gives the final answer.
            const answer = requests.length === 1
                ? {
                    status: 'completed',
                    output: [{ type: 'function_call', id: 'fc-1', call_id: 'c-1', name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) }],
                }
                : (requests.length === 2
                    ? {
                        status: 'completed',
                        output: [{ type: 'function_call', id: 'fc-2', call_id: 'c-2', name: 'write_file', arguments: JSON.stringify({ path: 'styles.scss', content: 'body { color: #111; }\n' }) }],
                    }
                    : { status: 'completed', output_text: 'The stylesheet is written.' });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(answer));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
        await writeFile(path.join(root, 'note.txt'), 'hello from the parent\n', 'utf8');
        const events = [];
        const report = await runSubAgentThread({
            spec: {
                name: 'styler-1',
                role: {
                    name: 'styler',
                    instructions: 'You are the styler of a web project.',
                    tools: ['read_file', 'write_file'],
                },
                goal: 'Read the note and write a stylesheet.',
                files: ['styles.scss'],
                rights: { cwd: root, write: true },
                budget: { maxTurns: 6 },
                model: {
                    model: 'test-model',
                    baseURL: `http://127.0.0.1:${port}/v1`,
                    apiKey: 'test-key',
                    effort: 'low',
                },
            },
            onCall: async (call) => {
                calls.push(call.name);
                const { readText, writeText } = await import('../src/access/fs.js');
                if (call.name === 'read_file') return await readText(root, call.arguments.path);
                if (call.name === 'write_file') return `Written: ${await writeText(root, call.arguments.path, call.arguments.content)}`;
                return 'unknown tool';
            },
            onEvent: (event) => events.push(event),
        });
        assert.equal(report.ok, true);
        assert.equal(report.turns, 3);
        assert.deepEqual(calls, ['read_file', 'write_file']);
        assert.ok(events.some((event) => event?.status === 'working'));
        // The file of the goal is on the disk: the parent wrote it with its own tools.
        const written = await readFile(path.join(root, 'styles.scss'), 'utf8');
        assert.match(written, /color: #111/);
        // The thread asked the API of the house with its own model.
        assert.equal(requests[0].model, 'test-model');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    }
});

test('the arguments of the command are read', () => {
    const args = parseArgs(['Fix the header.', '--role', 'styler', '--root', '/project', '--files', 'a.scss,b.scss', '--turns', '3']);
    assert.equal(args.goal, 'Fix the header.');
    assert.equal(args.role, 'styler');
    assert.equal(args.root, '/project');
    assert.deepEqual(args.files, ['a.scss', 'b.scss']);
    assert.equal(args.turns, 3);
});
