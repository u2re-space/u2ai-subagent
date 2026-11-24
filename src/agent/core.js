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
 * @depends config/spec, agent/tools, openai/client, shared/utils
 * @usedBy server/interface
 * @exports runSubAgent, subAgentTurn, subAgentInstructions
 * @ai.tags subagent, agent, loop
 * @ai.hint io
 */

import { normalizeSpec, specBudget, specFiles, specGoal, specModel, specRights, specRole, specTools } from '../config/spec.js';
import { buildModelBody, createModelClient } from '../openai/client.js';
import { textPart } from '../openai/parser.js';
import { intOf, textOf } from '../shared/utils.js';

/**
 * The instructions of a sub-agent: the role it inherited, plus the goal of the work.
 *
 * The instructions of the role come from the parent: the sub-agent has no role of its own
 * and does not write one. The parent writes them down in the spec, and the sub-agent
 * speaks them as they are.
 *
 * @param {object} spec the spec of the sub-agent
 * @returns {string}
 * @exports
 * @ai.hint pure
 */
export function subAgentInstructions(spec) {
    const blocks = [];
    const inherited = textOf(spec?.role?.instructions).trim();
    if (inherited) blocks.push(inherited);
    const shared = textOf(spec?.context?.notes).trim();
    if (shared) blocks.push(shared);
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
 * @param {{ spec: object, client: object, items: object[], signal?: AbortSignal|null,
 *   onCall?: Function|null }} request
 * @returns {Promise<{ answer: object, calls: object[], results: object[] }>}
 * @exports
 * @ai.hint io
 */
export async function subAgentTurn({ spec, client, items, signal = null, onCall = null } = {}) {
    const body = buildModelBody({
        model: client?.config?.model,
        instructions: subAgentInstructions(spec),
        input: items,
        tools: specTools(spec).map((name) => ({
            type: 'function',
            name,
            description: `The tool ${name} of the project.`,
            parameters: { type: 'object', properties: {}, additionalProperties: true },
        })),
        schema: spec?.role?.schema ?? null,
        schemaName: spec?.role?.schemaName ?? 'response',
        effort: client?.config?.effort ?? null,
        summary: client?.config?.summary ?? null,
    });
    const answer = await client.request(body, { signal });
    const calls = Array.isArray(answer?.toolCalls) ? answer.toolCalls : [];
    const results = [];
    for (const call of calls) {
        const output = await onCall?.(call);
        results.push({ call, output: textOf(output) });
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
 * @param {{ spec: object, client?: object, onCall?: Function|null, onEvent?: Function|null,
 *   signal?: AbortSignal|null }} request
 * @returns {Promise<object>} the report of the sub-agent
 * @exports
 * @ai.hint io
 */
export async function runSubAgent({ spec: rawSpec, client: given = null, onCall = null, onEvent = null, signal = null } = {}) {
    const spec = normalizeSpec(rawSpec);
    const budget = specBudget(spec);
    const rights = specRights(spec);
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

    const items = [{ role: 'user', content: [textPart(subAgentGoal(spec))] }];
    const written = [];
    let turns = 0;
    let stopped = 'working';
    let answer = null;
    let error = null;

    try {
        while (turns < budget.maxTurns) {
            if (signal?.aborted) {
                stopped = 'aborted';
                break;
            }
            turns += 1;
            emit({ type: 'status', role, name: textOf(spec.name), turn: turns, status: 'working' });
            const turn = await subAgentTurn({ spec, client, items, signal, onCall });
            answer = turn.answer;
            for (const result of turn.results) {
                const call = result.call;
                const output = result.output;
                const callId = call.callId ?? call.id ?? `${call.name}-${written.length}`;
                items.push({
                    type: 'function_call',
                    call_id: callId,
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                });
                items.push({ type: 'function_call_output', call_id: callId, output });
                if (output && written.length < 200) written.push(output);
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
    };
}
