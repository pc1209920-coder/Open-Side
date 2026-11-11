'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WasmEngine,
  isValidWasmHeader,
  createMinimalAddWasm,
  createInfiniteLoopWasm,
  WASM_PAGE_SIZE
} = require('../src/wasm');

test('WASM Header Validation - accepts valid \\0asm magic bytes and rejects invalid', () => {
  const valid = createMinimalAddWasm();
  assert.strictEqual(isValidWasmHeader(valid), true);

  const invalid = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  assert.strictEqual(isValidWasmHeader(invalid), false);

  assert.strictEqual(isValidWasmHeader(null), false);
  assert.strictEqual(isValidWasmHeader(Buffer.alloc(2)), false);
});

test('WasmEngine - synchronous execution of add(i32, i32) WebAssembly module', () => {
  const engine = new WasmEngine();
  const wasmBinary = createMinimalAddWasm();

  const res = engine.execute(wasmBinary, 'add', [15, 27]);
  assert.strictEqual(res.output, 42);
  assert.strictEqual(typeof res.executionTimeMs, 'number');
  assert.ok(res.executionTimeMs >= 0);
  assert.strictEqual(res.memoryBytes, WASM_PAGE_SIZE);
});

test('WasmEngine - module compilation and instantiation caching', () => {
  const engine = new WasmEngine();
  const wasmBinary = createMinimalAddWasm();

  const compiled = engine.compileModule(wasmBinary);
  assert.ok(compiled instanceof WebAssembly.Module);

  const { instance } = engine.instantiate(compiled);
  assert.ok(instance instanceof WebAssembly.Instance);
  assert.strictEqual(typeof instance.exports.add, 'function');
  assert.strictEqual(instance.exports.add(100, 200), 300);
});

test('WasmEngine - sandboxed memory limits and capacity enforcement', () => {
  const engine = new WasmEngine({ initialPages: 2, maxPages: 4 });
  const memory = engine.createSandboxedMemory();

  assert.strictEqual(memory.buffer.byteLength, 2 * WASM_PAGE_SIZE);

  // Can grow up to maxPages
  const prevPages = memory.grow(2);
  assert.strictEqual(prevPages, 2);
  assert.strictEqual(memory.buffer.byteLength, 4 * WASM_PAGE_SIZE);

  // Growing beyond maxPages throws RangeError
  assert.throws(() => memory.grow(1), RangeError);
});

test('WasmEngine - rejection of missing export and invalid binary fail-closed', () => {
  const engine = new WasmEngine();
  const wasmBinary = createMinimalAddWasm();

  assert.throws(
    () => engine.execute(wasmBinary, 'nonExistentFunc', [1, 2]),
    /not a callable function/i
  );

  assert.throws(
    () => engine.compileModule(Buffer.from([0xde, 0xad, 0xbe, 0xef])),
    /invalid magic header/i
  );
});

test('WasmEngine - async worker thread execution with executeIsolatedWasmAsync', async () => {
  const engine = new WasmEngine();
  const wasmBinary = createMinimalAddWasm();

  const shard = {
    shardId: 'wasm-shard-001',
    wasmBinary,
    exportName: 'add',
    args: [50, 75],
    timeoutMs: 1500
  };

  const result = await engine.executeIsolatedWasmAsync(shard);
  assert.strictEqual(result.shardId, 'wasm-shard-001');
  assert.strictEqual(result.output, 125);
  assert.strictEqual(typeof result.executionTimeMs, 'number');
});

test('WasmEngine - async timeout termination on infinite loop WASM module', async () => {
  const engine = new WasmEngine();
  const spinBinary = createInfiniteLoopWasm();

  const shard = {
    shardId: 'wasm-shard-spin',
    wasmBinary: spinBinary,
    exportName: 'spin',
    args: [],
    timeoutMs: 80
  };

  await assert.rejects(
    async () => engine.executeIsolatedWasmAsync(shard),
    /timeout: exceeded 80ms/i
  );
});
