#!/usr/bin/env node
/**
 * @file bin/ai-subagent-worker.js
 * @module bin/ai-subagent-worker
 * @purpose The worker of a sub-agent: the thread or the process that runs the cycle.
 *
 *   As a thread of the parent, the spec comes with the thread. As a process of its own
 *   (`ai-subagent --worker`), the spec comes with the first frame of the channel. Both
 *   carry the same cycle of the model, and both send the calls of the tools back to the
 *   parent: the worker never touches a file by itself.
 *
 * @depends server/interface
 * @usedBy client/interface, bin/ai-subagent
 * @ai.tags subagent, worker
 * @ai.hint io
 */
import { parentPort } from 'node:worker_threads';
import { workerMain } from '../src/server/interface.js';

await workerMain({ port: parentPort });
