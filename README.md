# u2ai-subagent

The sub-agent system of the house: a **separate thread** of a parent process that runs an
inherited role over the shared project.

A sub-agent carries no role of its own. The parent writes down everything the sub-agent
is — the role it inherits, the goal of the work, the files it may touch, the tools it may
call, the budget of its turns — and the sub-agent runs exactly that. What it shares with
the parent is the project: the working directory, the skills, the memory, and the tools.
The tools are the parent's: the sub-agent asks the parent to run a tool, and the parent
runs it with its own rights and its own rules. The sub-agent never touches a file by
itself.

## The API

```js
import { runSubAgent } from '@u2ai/subagent';

const report = await runSubAgent({
    spec: {
        name: 'styler-1',
        role: {
            name: 'styler',
            instructions: 'You are the styler of a web project.',
            tools: ['read_file', 'write_file', 'patch_file'],
        },
        goal: 'The header of the page is 4px off: fix the spacing.',
        files: ['src/styles/_header.scss'],
        rights: { cwd: root, write: true },
        budget: { maxTurns: 8 },
        model: { model, baseURL, apiKey, effort },
    },
    onCall: (call) => toolset.execute(call.name, call.arguments),
    onEvent: (event) => log(event),
});
```

The report says what the sub-agent did, which turns it spent and whether it reached the
goal. The parent keeps the truth: the files of the goal are checked on the disk.

## The command

```
ai-subagent "Fix the spacing of the header." --role styler --root /path/to/project
```

The command starts a sub-agent that works on its own: it reads the project, does the work
and reports what it did. A parent that needs a sub-agent starts it through the API above.

## The shape of the package

| Path | What it is |
|---|---|
| `bin/ai-subagent.js` | The command: a goal, a role and a project. |
| `bin/ai-subagent-worker.js` | The thread of the sub-agent. |
| `src/client/interface.js` | The API of the parent: `runSubAgent`, `spawnSubAgent`. |
| `src/client/protocol.js` | The frames between the parent and the sub-agent. |
| `src/server/interface.js` | The worker: the cycle of the model, the calls to the parent. |
| `src/config/spec.js` | The spec: the role, the goal, the files, the rights, the budget. |
| `src/agent/core.js` | The cycle: the model asks, the parent executes, the model answers. |
| `src/agent/tools.js` | The tools of a sub-agent and the rights over them. |
| `src/openai/` | The client of the model and the parser of its answers. |
| `src/access/fs.js` | The files of the project. |
| `src/cli/interface.js` | The command and the tools of a sub-agent that works alone. |

## The license

BSD 3-Clause, the license of the house.
