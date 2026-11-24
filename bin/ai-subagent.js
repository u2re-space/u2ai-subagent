#!/usr/bin/env node
/**
 * @file bin/ai-subagent.js
 * @module bin/ai-subagent
 * @purpose The entry of the command of a sub-agent: a goal, a role and a project.
 *
 *   The command starts a sub-agent that works on its own: it reads the project, does the
 *   work and reports what it did. A parent that needs a sub-agent starts it through the
 *   API of the package instead — the command is the same work for a person.
 *
 * @depends cli/interface
 * @usedBy package bin
 * @ai.tags subagent, cli, entry
 * @ai.hint io
 */
import { main } from '../src/cli/interface.js';

process.exitCode = (await main(process.argv.slice(2))) || process.exitCode || 0;
