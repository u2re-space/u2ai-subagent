# u2ai-subagent

The sub-agent system of the house: a **separate worker** — a thread or a process of a
parent — that runs an inherited role over the shared project.

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

## The transports

| Transport | What it is | What crosses the border |
|---|---|---|
| `'thread'` (default) | A worker thread of the parent process. | The spec, the frames of the tools — and the **shared memory**. |
| `'process'` | A child process of its own (`bin/ai-subagent-worker.js`), the spec and the calls over IPC. Its own crash domain, its own env. | The spec and the frames of the tools only. |

```js
await runSubAgent({ spec, onCall, transport: 'process' });
```

## The shared memory

The big texts of a hand-over — the instructions of the role, the notes of the context —
do not travel as copies: the parent writes them into one `SharedArrayBuffer`, and the
thread reads them from there. The strings go as UTF-8 bytes (`TextEncoder` writes,
`TextDecoder` reads), and the buffer also carries the **flag of cancellation**: the
parent sets it with `Atomics`, and the thread sees it between its turns — without a
message round trip. Shared memory crosses threads, not processes: a process gets the
texts inside the spec.

```js
import { createSharedBlock, readSharedBlock, sharedAvailable } from '@u2ai/subagent/shared';

const shared = createSharedBlock({ instructions, notes });
await runSubAgent({
    spec: { role: { name: 'styler' }, goal, shared: shared.buffer },
    onCall,
    onCancel: () => shared.cancel(),
});
```

## The command

```
ai-subagent "Fix the spacing of the header." --role styler --root /path/to/project
```

The command starts a sub-agent that works on its own: it reads the project, does the work
and reports what it did. A parent that needs a sub-agent starts it through the API above.
The command also runs the worker of a parent: `ai-subagent --worker` waits for the spec
on the channel — that is what the transport `process` starts.

| Flag | What it does |
|---|---|
| `--role`, `--root`, `--files`, `--turns` | The role, the project, the expected files, the budget. |
| `--model`, `--base-url`, `--env` | The model of the API, the endpoint, the name of the variable of the key. |
| `--instructions` | Extra instructions of the hand-over. |
| `--transport thread\|process` | Where the sub-agent runs. |
| `--worker` | Wait for the spec on the channel (the mode of a parent). |
| `--quiet` | Only the report, without the events. |

## The shape of the package

| Path | What it is |
|---|---|
| `bin/ai-subagent.js` | The command: a goal, a role and a project. |
| `bin/ai-subagent-worker.js` | The worker: the thread or the process of the sub-agent. |
| `src/client/interface.js` | The API of the parent: `runSubAgent`, `spawnSubAgent`, the transports. |
| `src/client/protocol.js` | The frames between the parent and the sub-agent. |
| `src/server/interface.js` | The worker: the cycle of the model, the calls to the parent. |
| `src/config/spec.js` | The spec: the role, the goal, the files, the rights, the budget. |
| `src/shared/shared.js` | The shared memory: the texts and the flag of cancellation. |
| `src/agent/core.js` | The cycle: the model asks, the parent executes, the model answers. |
| `src/agent/tools.js` | The tools of a sub-agent and the rights over them. |
| `src/openai/` | The client of the model and the parser of its answers. |
| `src/access/fs.js` | The files of the project. |
| `src/cli/interface.js` | The command and the tools of a sub-agent that works alone. |

## The license

BSD 3-Clause, the license of the house.
