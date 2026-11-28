/**
 * @file test/code-mode.test.js
 * @module test/code-mode
 * @purpose Tests of Code Mode: the sandbox, the bridge of the tools and the memory of the house.
 * @depends node:test, node:assert, shared/code-mode
 * @ai.tags test, code-mode, sandbox, worker
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedByteCache } from '../src/access/ramdisk.js';
import {
    CODE_MODE_LIMITS,
    CODE_MODE_VERSION,
    CodeModeError,
    createCodeModeSpec,
    normalizeCodeMode,
    runCodeMode,
    runCodeModeWorker,
} from '../src/shared/code-mode.js';

test('the spec of Code Mode has every field', () => {
    const spec = createCodeModeSpec({
        code: 'return 1;',
        tools: ['read_file', { name: 'write_file', description: 'writes a file' }],
        timeoutMs: 1000,
    });
    assert.equal(spec.version, CODE_MODE_VERSION);
    assert.equal(spec.code, 'return 1;');
    assert.equal(spec.timeoutMs, 1000);
    assert.equal(spec.shared, null);
    // The tools are a catalogue: the name of every one of them, and what it does.
    assert.equal(spec.tools.length, 2);
    assert.equal(spec.tools[0].name, 'read_file');
    assert.equal(spec.tools[1].description, 'writes a file');
    // A spec that names nothing is a spec of nothing, and it never throws.
    const bare = normalizeCodeMode({});
    assert.equal(bare.code, '');
    assert.deepEqual(bare.tools, []);
    assert.equal(bare.timeoutMs, CODE_MODE_LIMITS.timeoutMs);
});

test('a program runs in the sandbox and calls the tools of the parent', async () => {
    const calls = [];
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const listing = await tools.list_files({ path: '.' });
                const answer = await tools.read_file({ path: 'note.txt' });
                return { listing, answer };
            `,
            tools: [
                { name: 'list_files', description: 'lists the files' },
                { name: 'read_file', description: 'reads a file' },
            ],
        },
        onCall: async (call) => {
            calls.push({ name: call.name, arguments: call.arguments });
            return call.name === 'list_files' ? 'a.txt' : 'the note';
        },
    });
    assert.equal(report.ok, true);
    assert.equal(report.reason, 'completed');
    assert.deepEqual(report.value, { listing: 'a.txt', answer: 'the note' });
    // The parent ran the tools: the sandbox never touched a file by itself.
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].arguments, { path: '.' });
    assert.deepEqual(calls[1].arguments, { path: 'note.txt' });
});

test('a tool the parent did not name is not reachable from the program', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: 'return { hidden: typeof tools.write_file, names: catalogue.names };',
            tools: [{ name: 'read_file' }],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.value.hidden, 'undefined');
    assert.deepEqual(report.value.names, ['read_file']);
});

test('a tool that failed is caught by the program', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                let caught = null;
                try {
                    await tools.boom({});
                } catch (error) {
                    caught = error.message;
                }
                const after = await tools.read_file({ path: 'a.txt' });
                return { caught, after };
            `,
            tools: [{ name: 'boom' }, { name: 'read_file' }],
        },
        onCall: async (call) => {
            if (call.name === 'boom') throw new Error('the tool is broken');
            return 'the file';
        },
    });
    assert.equal(report.ok, true);
    assert.match(report.value.caught, /the tool is broken/);
    // The program went on after the failure.
    assert.equal(report.value.after, 'the file');
});

test('the program of the model has no process, no require and no fetch', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: 'return { process: typeof process, require: typeof require, fetch: typeof fetch, buffer: typeof Buffer };',
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.deepEqual(report.value, {
        process: 'undefined',
        require: 'undefined',
        fetch: 'undefined',
        buffer: 'undefined',
    });
});

test('the program may not walk out of the sandbox', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const probe = (fn) => {
                    try { return String(fn()); } catch (error) { return 'BLOCKED'; }
                };
                return {
                    viaTool: probe(() => tools.read_file.constructor('return typeof process')()),
                    viaCatalogue: probe(() => catalogue.describe.constructor('return typeof process')()),
                    viaFunction: probe(() => (function () {}).constructor('return typeof process')()),
                    viaGlobal: probe(() => globalThis.constructor.constructor('return typeof process')()),
                    viaShared: probe(() => shared.view.constructor.constructor('return typeof process')()),
                    viaBuffer: probe(() => shared.view.buffer?.constructor?.constructor?.('return typeof process')()),
                    viaFs: probe(() => fs.readFile.constructor('return typeof process')()),
                    viaAllocate: probe(() => allocate.constructor('return typeof process')()),
                };
            `,
            tools: [{ name: 'read_file' }],
        },
        onCall: async () => 'ok',
    });
    for (const [name, value] of Object.entries(report.value)) {
        // The door is closed: either the probe throws, or it reaches nothing.
        assert.ok(
            value === 'BLOCKED' || value === 'undefined',
            `the program walked out through ${name}: ${value}`,
        );
        assert.notEqual(value, 'object', `the program walked out through ${name}`);
    }
});

test('a program that never ends is stopped and the parent lives', async () => {
    const report = await runCodeModeWorker({
        spec: { code: 'while (true) {}', timeoutMs: 1200 },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, false);
    assert.equal(report.reason, 'timeout');
    assert.match(report.error, /did not finish/);
});

test('a program that is not valid says so', async () => {
    const report = await runCodeModeWorker({
        spec: { code: 'const = ;' },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, false);
    assert.equal(report.reason, 'syntax');
});

test('a program that throws says so', async () => {
    const report = await runCodeModeWorker({
        spec: { code: 'throw new Error("boom");' },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, false);
    assert.equal(report.reason, 'failed');
    assert.match(report.error, /boom/);
});

test('an empty program is refused', async () => {
    const report = await runCodeModeWorker({
        spec: { code: '   ' },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, false);
    assert.equal(report.reason, 'no-code');
});

test('the output of the program comes back to the parent, and the errors apart', async () => {
    const logs = [];
    const report = await runCodeModeWorker({
        spec: {
            code: 'console.log("a line"); console.error("a problem"); return "done";',
            tools: [],
        },
        onCall: async () => 'ok',
        onEvent: (event) => {
            if (event.type === 'code.log') logs.push(event);
        },
    });
    assert.equal(report.value, 'done');
    assert.equal(report.output, 'a line');
    assert.equal(report.error, 'a problem');
    // The parent hears the streams apart.
    assert.equal(logs.length, 2);
    assert.equal(logs[0].stream, 'stdout');
    assert.equal(logs[1].stream, 'stderr');
});

test('the memory of the house is reachable from the program', async () => {
    const { buffer } = createSharedByteCache({ capacityBytes: 1024 });
    const report = await runCodeModeWorker({
        spec: {
            code: `
                // The file system in the memory.
                await fs.writeFile('mem/a.txt', new TextEncoder().encode('in memory'));
                const mem = await fs.readFile('mem/a.txt');
                // The shared block: the bytes are the bytes of the parent.
                shared.view[0] = 42;
                const atom = Atomics.load(shared.ints, 0);
                // A block of memory of the house.
                const block = allocate(1024 * 1024);
                block.bytes[0] = 9;
                return {
                    mem: new TextDecoder().decode(mem),
                    atom,
                    capacity: shared.capacity(),
                    blockCap: block.capacityBytes,
                    blockByte: block.bytes[0],
                };
            `,
            shared: buffer,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    assert.equal(report.value.mem, 'in memory');
    // The shared block is one memory: the program wrote into it, and the parent sees it.
    assert.equal(report.value.atom, 42);
    // The capacity of the block is the size of its data region.
    assert.equal(report.value.capacity, 1024 - 4);
    assert.equal(report.value.blockCap, 1024 * 1024);
    assert.equal(report.value.blockByte, 9);
});

test('the parent and the program share the bytes of the block without a copy', async () => {
    const cache = createSharedByteCache({ capacityBytes: 1024 });
    const report = await runCodeModeWorker({
        spec: {
            code: 'shared.view[0] = 7; shared.view[1] = 8; return shared.capacity();',
            shared: cache.buffer,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    // The parent reads the very same bytes: the block was never copied.
    assert.equal(cache.view()[0], 7);
    assert.equal(cache.view()[1], 8);
});

test('the shared block of the house crosses the thread of the sandbox', async () => {
    const cache = createSharedByteCache({ capacityBytes: 1024 });
    // The parent writes into the block before the program runs.
    cache.view()[0] = 5;
    cache.view()[1] = 9;
    const report = await runCodeModeWorker({
        spec: {
            code: `
                const first = shared.view[0];
                const second = shared.view[1];
                shared.view[2] = 77;
                return { first, second };
            `,
            shared: cache.buffer,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.equal(report.ok, true);
    // The program saw the bytes of the parent, and the parent sees the bytes of the
    // program: one memory, two sides.
    assert.equal(report.value.first, 5);
    assert.equal(report.value.second, 9);
    assert.equal(cache.view()[2], 77);
});

test('the program may not allocate more than the ceiling of the house', async () => {
    const report = await runCodeModeWorker({
        spec: {
            code: `
                let refused = null;
                try { allocate(9 * 1024 * 1024 * 1024); } catch (error) { refused = error.message; }
                return refused;
            `,
            tools: [],
        },
        onCall: async () => 'ok',
    });
    assert.match(String(report.value), /over the ceiling/);
});

test('the error of Code Mode carries the reason of the failure', () => {
    const error = new CodeModeError('the program is empty.', { reason: 'no-code' });
    assert.equal(error.name, 'CodeModeError');
    assert.equal(error.reason, 'no-code');
    assert.match(error.message, /empty/);
});

test('the sandbox runs in its own thread and the parent may stop it', async () => {
    const controller = new AbortController();
    const promise = runCodeModeWorker({
        spec: { code: 'while (true) {}', timeoutMs: 30000 },
        onCall: async () => 'ok',
        signal: controller.signal,
    });
    // The run is stopped by the parent: the worker is terminated, and the report says so.
    setTimeout(() => controller.abort(), 150);
    const report = await promise;
    assert.equal(report.ok, false);
    assert.equal(report.reason, 'aborted');
});
