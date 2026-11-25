/**
 * @file src/agent/core.js
 * @module agent/core
 * @purpose The cycle of a sub-agent: the model asks, the parent executes, the model answers.
 *
 *   The sub-agent runs its **own** cycle of the model: it has its own conversation, its
 *   own instructions and its own budget of turns. What it does not have is its own set of
 *   tools — the tools of the parent execute the calls of the sub-agent, so the files are
 *   written by the same code, with the same rights and the same rules, as the files of the
 *   parent.
 *
 *   The cycle is a round trip over three parties:
 *
 *   1. The sub-agent sends the request of the model: the instructions of the role it
 *      inherited, the goal of the work, and the conversation so far.
 *   2. The model answers with text and with calls of the tools. The sub-agent hands the
 *      calls to the parent and waits for their answers.
 *   3. The parent answers with the results of the tools, and the cycle goes on until the
 *      model gives the final answer or the budget of the turns is over.
 *
 *   A sub-agent that ends without the final answer says so in its report: the goal is
 *   not reached, and the parent learns it from the report and not from the silence.
 *
 * @depends config/spec, config/profiles, agent/gate, agent/tools, openai/client, shared/utils
 * @usedBy server/interface
 * @exports runSubAgent, subAgentTurn, subAgentInstructions
 * @ai.tags subagent, agent, loop
 * @ai.hint io
 */

import { normalizeSpec, specBudget, specFiles, specGoal, specModel, specOutput, specRights, specRole, specTexts, specTools } from '../config/spec.js';
import { maxOutputFor, writeBudgetFor } from '../config/profiles.js';
import { FLAG_CANCEL, readSharedBlock } from '../shared/shared.js';
import { buildModelBody, createModelClient } from '../openai/client.js';
import { textPart } from '../openai/parser.js';
import { textOf } from '../shared/utils.js';
import {
    WRITE_READY_NAME,
    WRITE_READY_TOOL,
    estimateOf,
    gateAnswer,
    gateInstruction,
    hasActionTools,
    isReadOnlyTool,
    isWriteTool,
} from './gate.js';

/**
 * The instructions of a sub-agent: the role it inherited, plus the goal of the work.
 *
 * The instructions of the role come from the parent: the sub-agent has no role of its own
 * and does not write one. The parent writes them down in the spec, and the sub-agent
 * speaks them as they are.
 *
 * The rule of the write gate is appended when the sub-agent has a tool that writes: the
 * gate is part of the contract of the work, and the sub-agent has to know it before it
 * spends its first turn.
 *
 * @param {object} spec the spec of the sub-agent
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function subAgentInstructions(spec) {
    const blocks = [];
    // The texts of the hand-over: from the shared memory, when the parent gave a buffer,
    // or from the spec itself.
    const texts = specTexts(spec);
    const inherited = texts.instructions.trim();
    if (inherited) blocks.push(inherited);
    const shared = texts.notes.trim();
    if (shared) blocks.push(shared);
    if (specOutput(spec).writeGate && hasActionTools(specTools(spec))) {
        blocks.push(gateInstruction());
    }
    return blocks.join('\n\n');
}

/**
 * The first message of the conversation: the goal of the work and its reason.
 * @param {object} spec
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function subAgentGoal(spec) {
    const goal = specGoal(spec);
    const reason = textOf(spec?.reason).trim();
    const files = specFiles(spec);
    const lines = [goal];
    if (reason) lines.push(`The reason: ${reason}`);
    if (files.length) lines.push(`The files of the work: ${files.join(', ')}.`);
    lines.push('You are a separate session: you do not see the conversation of the parent.');
    lines.push('Do the work with your tools and report what you did and what is on the disk.');
    return lines.filter(Boolean).join('\n\n');
}

/**
 * One turn of the cycle of the sub-agent.
 *
 * The turn asks the model and hands the calls of the tools to the parent. The parent
 * answers with the results, and they go into the conversation as the next turn.
 *
 * The tools of the turn depend on the gate: before the gate is open, only the read tools
 * and the gate itself are on the table. The budget of the turn depends on the same gate:
 * the inspection turn has the reduced one, the write turn has the budget the estimate
 * earned, and the answer turn has the full one — the answer is not the write.
 *
 * The schema of the answer follows the gate too: the turn of the inspection has no schema
 * on the table. A model that is offered the schema while it is still inspecting answers
 * the goal instead of doing it, and the work is never done.
 *
 * A call may be intercepted before it reaches the parent: the gate is a tool of the loop
 * and not a tool of the project, and the parent does not know it.
 *
 * @param {{ spec: object, client: object, items: object[], signal?: AbortSignal|null,
 *   onCall?: Function|null, onBytes?: Function|null, writeReady?: boolean,
 *   maxOutputTokens?: number|null, tools?: string[]|null, intercept?: Function|null,
 *   schema?: object|null }} request
 * @returns {Promise<{ answer: object, calls: object[], results: object[] }>}
 * @exports
 * @ai.hint io
 */
export async function subAgentTurn({
    spec,
    client,
    items,
    signal = null,
    onCall = null,
    onBytes = null,
    writeReady = false,
    maxOutputTokens = null,
    tools = null,
    intercept = null,
    schema = undefined,
} = {}) {
    const body = buildModelBody({
        model: client?.config?.model,
        instructions: subAgentInstructions(spec),
        input: items,
        tools: (tools ?? specTools(spec)).map((name) => (
            // The gate has its own spec: the model has to know that it may name the
            // estimate of the write.
            name === WRITE_READY_NAME ? WRITE_READY_TOOL : {
                type: 'function',
                name,
                description: `The tool ${name} of the project.`,
                parameters: { type: 'object', properties: {}, additionalProperties: true },
            }
        )),
        schema: schema === undefined ? (spec?.role?.schema ?? null) : schema,
        schemaName: spec?.role?.schemaName ?? 'response',
        effort: client?.config?.effort ?? null,
        summary: client?.config?.summary ?? null,
        maxOutputTokens,
    });
    const answer = await client.request(body, { signal });
    const calls = Array.isArray(answer?.toolCalls) ? answer.toolCalls : [];
    const results = [];
    for (const call of calls) {
        // The gate answers for itself: it writes no file and starts no other role.
        const caught = typeof intercept === 'function' ? await intercept(call, { readyAtTurnStart: writeReady }) : null;
        if (caught && caught.handled === true) {
            results.push({ call, output: textOf(caught.output), handled: true });
            continue;
        }
        const output = await onCall?.(call);
        // The tool may answer with bytes as well as with text: a picture travels in its
        // own frame, and the text of the answer names it.
        const bytes = output?.bytes ?? null;
        if (bytes && typeof onBytes === 'function') {
            await onBytes(bytes, { name: output?.name ?? '', mime: output?.mime ?? '' });
        }
        results.push({
            call,
            output: bytes ? textOf(output?.text) : textOf(output),
            bytes: bytes ?? null,
        });
    }
    return { answer, calls, results };
}

/**
 * Run the cycle of a sub-agent to the end.
 *
 * The cycle ends in three ways: the model gives the final answer (the goal is reached
 * or the role refused it), the budget of the turns is over (the goal is not reached), or
 * the request failed (the sub-agent says why). Every way ends in a report.
 *
 * The economy of the cycle follows the gate: the inspection turn has the reduced budget,
 * the write turn has the budget the estimate of the model earned, and the answer turn
 * has the full one.
 *
 * @param {{ spec: object, client?: object, onCall?: Function|null, onBytes?: Function|null,
 *   onEvent?: Function|null, signal?: AbortSignal|null }} request
 * @returns {Promise<object>} the report of the sub-agent
 * @exports
 * @ai.hint io
 */
export async function runSubAgent({ spec: rawSpec, client: given = null, onCall = null, onBytes = null, onEvent = null, signal = null } = {}) {
    const spec = normalizeSpec(rawSpec);
    const budget = specBudget(spec);
    const rights = specRights(spec);
    const output = specOutput(spec);
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const role = specRole(spec);
    const goal = specGoal(spec);

    if (!goal) {
        return {
            ok: false,
            role,
            name: textOf(spec.name),
            turns: 0,
            files: [],
            report: 'The sub-agent was given no goal.',
            error: 'no-goal',
            stopped: 'failed',
        };
    }
    if (!role) {
        return {
            ok: false,
            role,
            name: textOf(spec.name),
            turns: 0,
            files: [],
            report: 'The sub-agent was given no role to inherit.',
            error: 'no-role',
            stopped: 'failed',
        };
    }

    const client = given ?? createModelClient({
        model: specModel(spec).model,
        baseURL: specModel(spec).baseURL,
        apiKey: specModel(spec).apiKey,
        effort: specModel(spec).effort,
        summary: specModel(spec).summary,
        retries: specModel(spec).retries,
        timeoutMs: specModel(spec).timeoutMs,
    });

    // The model of the turn: the model of the sub-agent. The cap of the turn is computed
    // from it, so the model is read once and kept.
    const model = client?.config?.model ?? specModel(spec).model;
    // The caps the parent knows: they win over the table of the package.
    const caps = output.models;
    // The gate: the sub-agent has one when it has a tool that acts and the parent did
    // not close it.
    const tools = specTools(spec);
    const gated = output.writeGate && hasActionTools(tools);
    // The estimate of the size of the write that the model gave at the gate: it sizes the
    // budget of the write turn, and it is null when the model said nothing.
    let writeEstimate = null;
    // The budget of the write turn that the estimate earned.
    let writeBudget = null;
    // The gate is open when the model called it.
    let writeReady = false;
    // The phase of the work: `work` while the files of the goal are still to be written,
    // `answer` after the write. The answer is not the write: the turn of the answer keeps
    // the full cap, whatever the budget of the write was.
    let phase = 'work';

    /**
     * The gate catches the calls of the loop before they reach the parent.
     *
     * The gate itself is a tool of the loop: it writes no file, and the parent does not
     * know it. A write that comes in the turn of the inspection is refused here, and the
     * model reads the refusal as the answer of the tool.
     *
     * The gate opens the **next** turn, not the current one: the turn of the gate is the
     * turn of the inspection, and its budget is the reduced one. A model that calls the
     * gate together with a write is told to write in the next turn.
     * @param {object} call the call of the model
     * @param {{ readyAtTurnStart: boolean }} state the state of the turn
     * @returns {{ handled: boolean, output: string }}
     */
    const intercept = (call, { readyAtTurnStart } = {}) => {
        if (!gated) return { handled: false, output: '' };
        if (call?.name === WRITE_READY_NAME) {
            if (!writeReady) {
                writeReady = true;
                // The estimate of the size of the write: the model may say how many output
                // tokens the write of the goal will take. A broken estimate and an estimate
                // that is not positive are no estimate: the write turn then gets the whole
                // budget.
                writeEstimate = estimateOf(call.arguments);
                writeBudget = writeBudgetFor(model, caps, output.maxOutputTokens, writeEstimate);
                emit({
                    type: 'status',
                    role,
                    name: textOf(spec.name),
                    turn: turns,
                    status: 'write_ready',
                    outputTokens: writeEstimate,
                    maxOutputTokens: writeBudget,
                });
            }
            return { handled: true, output: gateAnswer(writeBudget, writeEstimate) };
        }
        // A write in the turn of the inspection is refused: the gate opens the next turn.
        if (!readyAtTurnStart && isWriteTool(call?.name)) {
            return {
                handled: true,
                output: writeReady
                    ? 'The write gate is open, but this turn was the turn of the inspection and its budget '
                        + 'is the reduced one. Write the file in the next turn: every file of the goal may be '
                        + 'written there, several calls in one turn.'
                    : 'The tool was not run: the write gate is closed. Call `write_ready` first — alone '
                        + 'or together with your reads — and write the files in the next turn, where the '
                        + 'writing budget is.',
            };
        }
        return { handled: false, output: '' };
    };

    const items = [{ role: 'user', content: [textPart(subAgentGoal(spec)), ...(spec?.context?.parts ?? [])] }];
    const written = [];
    let turns = 0;
    let stopped = 'working';
    let answer = null;
    let error = null;

    try {
        // The flag of cancellation lives in the shared memory, when the parent gave a
        // buffer: the parent sets it with an atomic store, and the thread sees it here
        // without a message round trip.
        const shared = spec?.shared instanceof SharedArrayBuffer ? readSharedBlock(spec.shared) : null;
        while (turns < budget.maxTurns) {
            if (signal?.aborted) {
                stopped = 'aborted';
                break;
            }
            if (shared?.cancelled()) {
                // The parent asked the sub-agent to stop: it winds down and still reports
                // what it did.
                stopped = 'aborted';
                break;
            }
            turns += 1;
            emit({ type: 'status', role, name: textOf(spec.name), turn: turns, status: 'working' });
            // The budget of the turn. The inspection turn (the gate is closed) has the
            // reduced one; the write turn (the gate is open, the work is not done) has the
            // budget the estimate earned; the answer turn has the full one.
            const writing = writeReady && gated && phase === 'work';
            const maxOutputTokens = writing
                ? writeBudgetFor(model, caps, output.maxOutputTokens, writeEstimate)
                : maxOutputFor(model, caps, output.maxOutputTokens, { readOnly: gated && !writeReady });
            // The tools of the turn: the read tools and the gate before it is open, the
            // whole set of the tools after.
            const turnTools = gated && !writeReady
                ? [...tools.filter((name) => isReadOnlyTool(name)), WRITE_READY_NAME]
                : tools;
            const turn = await subAgentTurn({
                spec,
                client,
                items,
                signal,
                onCall,
                onBytes,
                writeReady,
                maxOutputTokens,
                tools: turnTools,
                intercept,
                // The schema of the answer waits for the work: the turn of the inspection
                // has no schema on the table, so the model inspects instead of answering.
                schema: gated && !writeReady ? null : (spec?.role?.schema ?? null),
            });
            answer = turn.answer;
            for (const result of turn.results) {
                const call = result.call;
                const answerOfTool = textOf(result.output);
                const callId = call.callId ?? call.id ?? `${call.name}-${written.length}`;
                items.push({
                    type: 'function_call',
                    call_id: callId,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                });
                items.push({ type: 'function_call_output', call_id: callId, output: answerOfTool });
                // The answer of a tool of the project goes into the log of the work; the
                // answer of the gate is the budget, and the report carries it.
                if (!result.handled && answerOfTool && written.length < 200) written.push(answerOfTool);
                // A write is done: the turns after it are the turns of the answer, and the
                // answer keeps the full cap.
                if (!result.handled && isWriteTool(call.name)) phase = 'answer';
            }
            if (turn.calls.length) {
                emit({
                    type: 'status',
                    role,
                    name: textOf(spec.name),
                    turn: turns,
                    status: 'tools',
                    tools: turn.calls.map((call) => call.name),
                });
                continue;
            }
            // The model answered with text and without a call of a tool: the turn is over.
            stopped = 'completed';
            break;
        }
    } catch (cause) {
        error = cause?.message ?? String(cause);
        stopped = 'failed';
    }

    if (turns >= budget.maxTurns && stopped === 'working') stopped = 'out-of-turns';
    const report = textOf(answer?.text).trim()
        || (stopped === 'failed' ? `The sub-agent stopped: ${error}` : 'The sub-agent gave no answer.');
    const files = specFiles(spec);
    const ok = stopped === 'completed' && !error;
    emit({
        type: 'status',
        role,
        name: textOf(spec.name),
        turn: turns,
        status: stopped,
        files,
    });

    return {
        ok,
        role,
        name: textOf(spec.name),
        turns,
        files,
        report,
        error,
        stopped,
        rights: { cwd: rights.cwd, write: rights.write },
        // The economy of the work: the estimate the model gave at the gate and the budget
        // it earned. The parent reads them to see what the sub-agent spent and why.
        output: {
            estimate: writeEstimate,
            budget: writeBudget,
            cap: maxOutputFor(model, caps, output.maxOutputTokens),
        },
    };
}
