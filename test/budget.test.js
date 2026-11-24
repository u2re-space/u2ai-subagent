/**
 * @file test/budget.test.js
 * @module test/budget
 * @purpose The tests of the regulation of the output of a sub-agent: the cap of the model,
 *          the reduced cap of the inspection and the budget of the write turn.
 * @depends node:test, config/profiles, agent/gate, agent/core, openai/parser
 * @ai.tags test, subagent, budget, tokens
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MODEL_PROFILES, getModelProfile, maxOutputFor, writeBudgetFor } from '../src/config/profiles.js';
import { normalizeSpec, specOutput } from '../src/config/spec.js';
import { WRITE_READY_NAME, WRITE_READY_TOOL, estimateOf, hasActionTools, hasWriteTools, isReadOnlyTool, isWriteTool } from '../src/agent/gate.js';
import { runSubAgent, subAgentInstructions } from '../src/agent/core.js';
import { parseModelAnswer } from '../src/openai/parser.js';

test('the table of the house knows the cap of the output of the text models', () => {
    assert.equal(MODEL_PROFILES['google/gemini-4-hydrogen'].maxOutput, 65_536);
    assert.equal(MODEL_PROFILES['minimax/minimax-m3.1-flash'].maxOutput, 524_288);
    assert.equal(MODEL_PROFILES['moonshotai/kimi-k3.1-pro'].maxOutput, 944_000);
    // A model of the table: its own cap.
    assert.equal(getModelProfile('google/gemini-4-hydrogen').maxOutput, 65_536);
    // The parent knows a model better than the table: its cap wins.
    const overridden = getModelProfile('google/gemini-4-hydrogen', {
        models: { 'google/gemini-4-hydrogen': { maxOutput: 32_768 } },
    });
    assert.equal(overridden.maxOutput, 32_768);
    // A model of the table that the parent does not know keeps the cap of the table.
    assert.equal(getModelProfile('openai/gpt-6.1-terra').maxOutput, 128_000);
});

test('the cap of a request is the cap of the model, and the parent may lower it', () => {
    const model = 'google/gemini-4-hydrogen';
    // No cap asked: the cap of the model.
    assert.equal(maxOutputFor(model), 65_536);
    // A cap asked: it wins, and the model still wins over it.
    assert.equal(maxOutputFor(model, null, 48_000), 48_000);
    assert.equal(maxOutputFor(model, null, 1_000_000), 65_536);
    // A cap of the parent over the cap of the model.
    assert.equal(maxOutputFor(model, { models: { [model]: { maxOutput: 16_384 } } }), 16_384);
    // A model the table does not know has no cap of its own.
    assert.equal(maxOutputFor('some/unknown-model'), null);
    assert.equal(maxOutputFor('some/unknown-model', null, 4_000), 4_000);
});

test('the inspection turn has an eighth of the cap', () => {
    const model = 'google/gemini-4-hydrogen';
    assert.equal(maxOutputFor(model, null, null, { readOnly: true }), 8_192);
    assert.equal(maxOutputFor(model, null, 32_000, { readOnly: true }), 4_000);
    assert.equal(maxOutputFor(model), 65_536, 'the write-ups keep the full cap');
    // The floor of the reduced cap: a tiny cap still leaves something to say.
    assert.equal(maxOutputFor(model, null, 16, { readOnly: true }), 4);
});

test('the estimate of the write sizes the budget of the write turn', () => {
    const model = 'google/gemini-4-hydrogen';
    const cap = 65_536;
    // No estimate at all: the whole cap.
    assert.equal(writeBudgetFor(model, null, null, null), cap);
    assert.equal(writeBudgetFor(model, null, null, undefined), cap);
    // An estimate inside the band is taken as it is.
    assert.equal(writeBudgetFor(model, null, null, 40_000), 51_200);
    // An estimate above the cap is pulled down to the cap.
    assert.equal(writeBudgetFor(model, null, null, 10_000_000), cap);
    // A broken estimate is no estimate.
    assert.equal(writeBudgetFor(model, null, null, 'a lot'), cap);
    assert.equal(writeBudgetFor(model, null, null, Number.NaN), cap);
    assert.equal(writeBudgetFor(model, null, null, Infinity), cap);
    // A zero or a negative estimate means "I do not know", not "write nothing".
    assert.equal(writeBudgetFor(model, null, null, 0), cap);
    assert.equal(writeBudgetFor(model, null, null, -5), cap);
    // A fraction is rounded up before the clamp.
    assert.equal(writeBudgetFor(model, null, null, 40_000.5), 51_201);
    // The cap of the config wins over the cap of the model.
    assert.equal(writeBudgetFor(model, null, 32_000, 40_000), 32_000);
    // A model without a cap of its own: no budget to speak of.
    assert.equal(writeBudgetFor('some/unknown-model'), null);
});

test('the estimate of the gate is read the way the model gives it', () => {
    assert.equal(estimateOf({ outputTokens: 40_000 }), 40_000);
    assert.equal(estimateOf({ outputTokens: '40000' }), 40_000);
    // A broken estimate is no estimate.
    assert.equal(estimateOf({ outputTokens: 'a lot' }), null);
    assert.equal(estimateOf({ outputTokens: 0 }), null);
    assert.equal(estimateOf({ outputTokens: -5 }), null);
    assert.equal(estimateOf({}), null);
    assert.equal(estimateOf(null), null);
});

test('the tools of a sub-agent are split into the reading ones and the writing ones', () => {
    assert.equal(isReadOnlyTool('read_file'), true);
    assert.equal(isReadOnlyTool('write_file'), false);
    assert.equal(isWriteTool('write_file'), true);
    assert.equal(isWriteTool('read_file'), false);
    assert.equal(hasWriteTools(['read_file']), false);
    assert.equal(hasWriteTools(['read_file', 'write_file']), true);
    // A tool that acts is not in the list of the writing tools, and it still opens a gate:
    // the gate is for everything that changes something.
    assert.equal(hasActionTools(['read_file']), false);
    assert.equal(hasActionTools(['read_file', 'run_command']), true);
    // The gate is a tool of the loop, not a tool of the project.
    assert.equal(isWriteTool(WRITE_READY_NAME), false);
    assert.equal(WRITE_READY_TOOL.name, WRITE_READY_NAME);
    assert.ok(WRITE_READY_TOOL.parameters.properties.outputTokens, 'the gate takes the estimate');
});

test('the spec carries the economy of the turns', () => {
    const spec = normalizeSpec({
        role: { name: 'styler' },
        goal: 'Fix the spacing.',
        output: {
            maxOutputTokens: 32_000,
            models: { 'google/gemini-4-hydrogen': { maxOutput: 16_384 } },
        },
    });
    const economy = specOutput(spec);
    assert.equal(economy.maxOutputTokens, 32_000);
    assert.equal(economy.models['google/gemini-4-hydrogen'].maxOutput, 16_384);
    assert.equal(economy.writeGate, true, 'the gate is on by default');
    // The defaults of a spec that names no economy.
    const plain = specOutput(normalizeSpec({ goal: 'Do something.' }));
    assert.equal(plain.maxOutputTokens, null);
    assert.deepEqual(plain.models, {});
    assert.equal(plain.writeGate, true);
    // The parent may close the gate.
    assert.equal(specOutput(normalizeSpec({ goal: 'x', output: { writeGate: false } })).writeGate, false);
});

test('the rule of the gate is in the instructions of a sub-agent that writes', () => {
    const readOnly = subAgentInstructions(normalizeSpec({
        role: { name: 'reviewer', instructions: 'You are the reviewer.', tools: ['read_file'] },
        goal: 'Read the project.',
    }));
    assert.doesNotMatch(readOnly, /write_ready/, 'a read-only sub-agent has nothing to unlock');

    const gated = subAgentInstructions(normalizeSpec({
        role: { name: 'styler', instructions: 'You are the styler.', tools: ['read_file', 'write_file'] },
        goal: 'Fix the spacing.',
    }));
    assert.match(gated, /write_ready/);
    assert.match(gated, /outputTokens/);

    // The default set of the tools of a sub-agent writes: the gate belongs to it.
    const defaulted = subAgentInstructions(normalizeSpec({
        role: { name: 'styler', instructions: 'You are the styler.' },
        goal: 'Fix the spacing.',
    }));
    assert.match(defaulted, /write_ready/);
});

/**
 * A client that answers the turns of a test one after another.
 * @param {Array<object>} turns the answers of the model
 * @returns {{ config: object, request: Function, bodies: object[] }}
 */
function fakeClient(turns = []) {
    const bodies = [];
    let index = 0;
    return {
        config: { model: 'google/gemini-4-hydrogen', effort: 'low' },
        bodies,
        async request(body) {
            bodies.push(body);
            const turn = turns[Math.min(index, turns.length - 1)] ?? { text: 'done' };
            index += 1;
            if (turn.type === 'function_call') {
                return parseModelAnswer({
                    status: 'completed',
                    output: [{
                        type: 'function_call',
                        id: `fc-${index}`,
                        call_id: `c-${index}`,
                        name: turn.name,
                        arguments: JSON.stringify(turn.arguments ?? {}),
                    }],
                });
            }
            return parseModelAnswer({ status: 'completed', output_text: turn.text ?? 'done' });
        },
    };
}

test('the inspection turn is reduced and the write turn takes the budget of the estimate', async () => {
    const client = fakeClient([
        { type: 'function_call', name: WRITE_READY_NAME, arguments: { outputTokens: 40_000 } },
        { type: 'function_call', name: 'write_file', arguments: { path: 'main.scss', content: 'body{}' } },
        { text: 'The stylesheet is written.' },
    ]);
    const events = [];
    const report = await runSubAgent({
        spec: {
            role: { name: 'styler', instructions: 'You are the styler.', tools: ['read_file', 'write_file'] },
            goal: 'Write the stylesheet.',
            files: ['main.scss'],
        },
        client,
        onCall: async () => 'Written: main.scss',
        onEvent: (event) => events.push(event),
    });
    assert.equal(report.ok, true);
    // The inspection turn has the reduced cap: an eighth of the cap of the model.
    assert.equal(client.bodies[0].max_output_tokens, 8_192);
    // The write turn takes the budget the estimate earned.
    assert.equal(client.bodies[1].max_output_tokens, 51_200);
    // The answer turn keeps the full cap: the answer is not the write.
    assert.equal(client.bodies[2].max_output_tokens, 65_536);
    // The gate is on the table of the inspection, the write tools are not.
    const inspection = client.bodies[0].tools.map((tool) => tool.name);
    assert.ok(inspection.includes(WRITE_READY_NAME));
    assert.ok(!inspection.includes('write_file'));
    // The gate has its own spec: the model has to know that it may name the estimate.
    const gateSpec = client.bodies[0].tools.find((tool) => tool.name === WRITE_READY_NAME);
    assert.ok(gateSpec.parameters.properties.outputTokens, 'the gate takes the estimate');
    assert.equal(gateSpec.parameters.additionalProperties, false);
    // The write turn has the write tools and no gate.
    const write = client.bodies[1].tools.map((tool) => tool.name);
    assert.ok(write.includes('write_file'));
    assert.ok(!write.includes(WRITE_READY_NAME));
    // The gate says what the budget of the next turn is.
    const ready = events.find((event) => event?.status === 'write_ready');
    assert.equal(ready.outputTokens, 40_000);
    assert.equal(ready.maxOutputTokens, 51_200);
    // The report carries the economy of the work.
    assert.equal(report.output.estimate, 40_000);
    assert.equal(report.output.budget, 51_200);
    assert.equal(report.output.cap, 65_536);
});

test('a gate without an estimate keeps the whole cap of the write turn', async () => {
    const client = fakeClient([
        { type: 'function_call', name: WRITE_READY_NAME, arguments: {} },
        { type: 'function_call', name: 'write_file', arguments: { path: 'main.scss', content: 'body{}' } },
        { text: 'The stylesheet is written.' },
    ]);
    await runSubAgent({
        spec: {
            role: { name: 'styler', tools: ['read_file', 'write_file'] },
            goal: 'Write the stylesheet.',
        },
        client,
        onCall: async () => 'Written: main.scss',
    });
    // No estimate, no guess: the whole cap of the write turn.
    assert.equal(client.bodies[1].max_output_tokens, 65_536);
});

test('a write before the gate is closed is refused', async () => {
    const client = fakeClient([
        { type: 'function_call', name: 'write_file', arguments: { path: 'main.scss', content: 'body{}' } },
        { type: 'function_call', name: WRITE_READY_NAME, arguments: {} },
        { type: 'function_call', name: 'write_file', arguments: { path: 'main.scss', content: 'body{}' } },
        { text: 'The stylesheet is written.' },
    ]);
    const calls = [];
    await runSubAgent({
        spec: {
            role: { name: 'styler', tools: ['read_file', 'write_file'] },
            goal: 'Write the stylesheet.',
        },
        client,
        onCall: async (call) => {
            calls.push(call.name);
            return 'Written: main.scss';
        },
    });
    // The write of the inspection turn never reached the parent.
    assert.deepEqual(calls, ['write_file']);
    // The refusal is in the log of the conversation.
    const refusal = client.bodies[1].input.find((item) => item.type === 'function_call_output');
    assert.match(refusal.output, /write gate is closed/);
});

test('a sub-agent that only reads has no gate and the full cap', async () => {
    const client = fakeClient([
        { type: 'function_call', name: 'read_file', arguments: { path: 'note.txt' } },
        { text: 'The note was read.' },
    ]);
    await runSubAgent({
        spec: {
            role: { name: 'reviewer', tools: ['read_file'] },
            goal: 'Read the note.',
        },
        client,
        onCall: async () => 'the note',
    });
    // The read of the project is not an inspection of a write: there is no gate, and the
    // answer is not a write-up either — the full cap.
    assert.equal(client.bodies[0].max_output_tokens, 65_536);
    const tools = client.bodies[0].tools.map((tool) => tool.name);
    assert.ok(!tools.includes(WRITE_READY_NAME));
});

test('the parent closes the gate when it wants to', async () => {
    const client = fakeClient([
        { type: 'function_call', name: 'write_file', arguments: { path: 'main.scss', content: 'body{}' } },
        { text: 'The stylesheet is written.' },
    ]);
    const calls = [];
    await runSubAgent({
        spec: {
            role: { name: 'styler', tools: ['read_file', 'write_file'] },
            goal: 'Write the stylesheet.',
            output: { writeGate: false },
        },
        client,
        onCall: async (call) => {
            calls.push(call.name);
            return 'Written: main.scss';
        },
    });
    // The write went straight through, and the turn kept the full cap.
    assert.deepEqual(calls, ['write_file']);
    assert.equal(client.bodies[0].max_output_tokens, 65_536);
});

test('the cap of the parent wins over the cap of the model', async () => {
    const client = fakeClient([
        { type: 'function_call', name: WRITE_READY_NAME, arguments: { outputTokens: 40_000 } },
        { type: 'function_call', name: 'write_file', arguments: { path: 'main.scss', content: 'body{}' } },
    ]);
    await runSubAgent({
        spec: {
            role: { name: 'styler', tools: ['read_file', 'write_file'] },
            goal: 'Write the stylesheet.',
            output: { maxOutputTokens: 16_384 },
        },
        client,
        onCall: async () => 'Written: main.scss',
    });
    // The cap of the parent is the cap of every turn.
    assert.equal(client.bodies[0].max_output_tokens, 2_048);
    assert.equal(client.bodies[1].max_output_tokens, 16_384);
});
