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

## The economy of the turns

A sub-agent spends the tokens of the model, and a write is the expensive part of the work:
a turn that writes a big file costs as much as a turn that writes a small one. The
sub-agent regulates its own budget with the **write gate**, the same way `ai-webdev` does.

| Turn | Budget | Tools |
|---|---|---|
| The inspection | An eighth of the cap | The read tools and `write_ready` |
| The write | What the estimate earns | The write tools |
| The answer | The full cap | The answer, not the write |

The gate is a tool of the loop, not a tool of the project: the parent never runs it, and it
writes no file. The model calls it after the inspection, and it may name `outputTokens` —
its own estimate of how many output tokens the write of the goal will take. The estimate
sizes the budget of the write turn, and the run clamps it into a band between a quarter of
the cap and the cap itself. A missing estimate, an estimate that is not a number, and an
estimate that is not positive all mean the same thing: the model did not say how big the
work is, so the write turn gets the whole cap. A model that says `0` or `-5` is saying
"I do not know", not "write nothing".

The estimate is a wish, not a fact, and the clamp is what makes it safe to take: a model
that underestimates cannot starve its own write, and a model that overestimates cannot buy
more than the cap.

The parent writes the economy of the sub-agent down in the spec:

```js
{
    output: {
        maxOutputTokens: 32_000,                       // the cap of the parent
        models: { 'google/gemini-4-hydrogen': { maxOutput: 16_384 } },  // the caps it knows
        writeGate: false,                               // close the gate of the write
    },
}
```

The cap of the model wins over the cap of the parent, and the table of the package
(`src/config/profiles.js`) knows the text models of the house. The report carries the
estimate and the budget it earned, and the event `write_ready` says them to the parent as
they happen.

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

## The bytes

A tool of a sub-agent may answer with bytes as well as with text: a picture does not have
to touch the disk to reach the worker. The bytes travel in their own frame — a buffer that
moves without a copy — or as base64, for the transport that cannot move a buffer.

```js
import { bytesFrame, base64Frame, bytesOfFrame } from '@u2ai/subagent/protocol';

const { frame, transfer } = bytesFrame(picture, { name: 'hero.png', mime: 'image/png' });
worker.postMessage(frame, transfer);   // the thread: the buffer moves
worker.send(base64Frame(picture));     // the process: the bytes go as text
```

A `Buffer` of the pool of Node.js may not be transferred: the bytes get their own buffer
first.

## The ramdisk

The tmp cache of the house: a file system in the memory and a cache of bytes that the
parent and the worker share.

```js
import { createRamdisk, createRamdiskFileSystem, allocateMemory } from '@u2ai/subagent/ramdisk';

const ramdisk = createRamdisk({ cacheBytes: 256 * 1024 * 1024 });
ramdisk.cache.write(picture);          // the parent writes, the worker reads the same bytes

const block = allocateMemory({ bytes: 4 * 1024 * 1024 * 1024 });  // 4 GB of address space
```

The block is virtual memory: the pages are taken when the bytes are written, not when the
block is made, so a big ceiling costs nothing until it is used.

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
| `--max-output-tokens` | The cap of the output of the turn, in tokens. |
| `--no-gate` | Close the write gate: the sub-agent writes without the turn of the inspection. |
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
| `src/config/profiles.js` | The table of the models: the cap of the output and the budget of the write. |
| `src/agent/gate.js` | The write gate: the turn of the inspection and the estimate of the write. |
| `src/shared/shared.js` | The shared memory: the texts and the flag of cancellation. |
| `src/shared/protocol.js` | The frames and the bytes: the buffer that moves, the base64 that does not. |
| `src/shared/worker.js` | The runtime of the worker: the transports, the channel, the cycle. |
| `src/access/ramdisk.js` | The tmp cache of the house: the file system in the memory, the block of the memory. |
| `src/agent/core.js` | The cycle: the model asks, the parent executes, the model answers. |
| `src/agent/tools.js` | The tools of a sub-agent and the rights over them. |
| `src/openai/` | The client of the model and the parser of its answers. |
| `src/access/fs.js` | The files of the project. |
| `src/cli/interface.js` | The command and the tools of a sub-agent that works alone. |

## The license

BSD 3-Clause, the license of the house.
