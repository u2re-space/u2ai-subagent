#!/usr/bin/env node
/**
 * @file bin/ai-subagent-worker.js
 * @module bin/ai-subagent-worker
 * @purpose The worker of a sub-agent: the thread that runs the cycle of the model.
 *
 *   The worker is started by the parent, not by a person: it takes the spec of the
 *   sub-agent from the data of the thread, runs the cycle of the model and sends the
 *   calls of the tools back to the parent. The parent holds the tools and the rights,
 *   and the worker holds nothing but the conversation of the sub-agent.
 *
 * @depends server/interface
 * @usedBy client/interface
 * @ai.tags subagent, worker
 * @ai.hint io
 */
import { workerMain } from '../src/server/interface.js';

await workerMain();
