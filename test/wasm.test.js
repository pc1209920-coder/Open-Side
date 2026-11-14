'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WasmEngine,
  isValidWasmHeader,
  createMinimalAddWasm,
  createInfiniteLoopWasm,
  WASM_PAGE_SIZE,
  DEFAULT_INITIAL_PAGES,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_EXECUTION_MS
} = require('../src/wasm');

/**
 * Generates a minimal valid WebAssembly binary with an 'unreachable' trap instruction.
 * Used for testing runtime error handling and isolation boundary traps.
 */
function createTrapWasm() {
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    // Type section: 1 type, () -> ()
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    // Function section: 1 func, type 0
    0x03, 0x02, 0x01, 0x00,
    // Export section: 1 export "trap" -> func 0
    0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00,
    // Code section: 1 func, body (unreachable 0x00, end 0x0b)
    0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b
  ]);
}

test('WASM Constants - verifies memory pages and execution limits', () => {
  assert.strictEqual(WASM_PAGE_SIZE, 65536);
  assert.strictEqual(DEFAULT_INITIAL_PAGES, 1);
  assert.strictEqual(DEFAULT_MAX_PAGES, 256);
  assert.strictEqual(DEFAULT_MAX_EXECUTION_MS, 2000);
});

test('WASM Header Validation - accepts valid \\0asm magic bytes and rejects invalid', () => {
  const valid = createMinimalAddWasm();
  assert.strictEqual(isValidWasmHeader(valid), true);

  // Uint8Array support
  const u8Array = new Uint8Array(valid);
  assert.strictEqual(isValidWasmHeader(u8Array), true);

  // Bad magic bytes
  const invalid = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  assert.strictEqual(isValidWasmHeader(invalid), false);

  // Null, undefined, primitives, objects
  assert.strictEqual(isValidWasmHeader(null), false);
  assert.strictEqual(isValidWasmHeader(undefined), false);
  assert.strictEqual(isValidWasmHeader('0x0061736d01000000'), false);
  assert.strictEqual(isValidWasmHeader(12345), false);
  assert.strictEqual(isValidWasmHeader({ length: 8 }), false);

  // Short / truncated buffers
  assert.strictEqual(isValidWasmHeader(Buffer.alloc(0)), false);
  assert.strictEqual(isValidWasmHeader(Buffer.alloc(2)), false);
  assert.strictEqual(isValidWasmHeader(Buffer.alloc(7)), false);

  // Valid magic but invalid version (e.g. version 2)
  const invalidVersion = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]);
  assert.strictEqual(isValidWasmHeader(invalidVersion), false);

  // Oversized binary exceeding 16 MB limit
  const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
  oversized[0] = 0x00; oversized[1] = 0x61; oversized[2] = 0x73; oversized[3] = 0x6d;
  oversized[4] = 0x01; oversized[5] = 0x00; oversized[6] = 0x00; oversized[7] = 0x00;
  assert.strictEqual(isValidWasmHeader(oversized), false);
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

test('WasmEngine - memory bounds validation rejects initialPages exceeding maxPages', () => {
  const engine = new WasmEngine({ initialPages: 5, maxPages: 4 });
  assert.throws(
    () => engine.createSandboxedMemory(),
    /cannot exceed maxPages/i
  );

  const defaultEngine = new WasmEngine();
  assert.strictEqual(defaultEngine.initialPages, DEFAULT_INITIAL_PAGES);
  assert.strictEqual(defaultEngine.maxPages, DEFAULT_MAX_PAGES);
  assert.throws(
    () => defaultEngine.createSandboxedMemory(300, 256),
    /cannot exceed maxPages/i
  );
});

test('WasmEngine - sandboxing restricts ambient environment imports', () => {
  const sandboxEngine = new WasmEngine({ allowEnvImports: false });
  const safeImports = sandboxEngine.createSafeImports({
    env: { hostApiKey: 'sensitive-secret', process: {} },
    custom: { helper: () => 42 }
  });

  // Host env imports are stripped by default for zero-trust sandboxing
  assert.strictEqual(safeImports.env, undefined);
  assert.ok(safeImports.js && safeImports.js.mem instanceof WebAssembly.Memory);
  assert.strictEqual(safeImports.custom.helper(), 42);

  // When explicitly enabled, env imports are retained
  const allowedEngine = new WasmEngine({ allowEnvImports: true });
  const allowedImports = allowedEngine.createSafeImports({
    env: { hostApiKey: 'allowed-secret' }
  });
  assert.strictEqual(allowedImports.env.hostApiKey, 'allowed-secret');
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

test('WasmEngine - rejection of valid header with malformed WebAssembly bytecode', () => {
  const engine = new WasmEngine();
  // Valid 8-byte header followed by corrupt bytecode section
  const malformedWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0xff, 0xff]);

  assert.throws(
    () => engine.compileModule(malformedWasm),
    /WebAssembly compilation failed/i
  );
});

test('WasmEngine - synchronous execution traps on runtime WebAssembly errors fail-closed', () => {
  const engine = new WasmEngine();
  const trapBinary = createTrapWasm();

  assert.throws(
    () => engine.execute(trapBinary, 'trap', []),
    /WebAssembly execution error in 'trap'/i
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

test('WasmEngine - async execution rejects invalid shard inputs fail-closed', async () => {
  const engine = new WasmEngine();

  // Null or non-object shard
  await assert.rejects(
    async () => engine.executeIsolatedWasmAsync(null),
    /Invalid shard: must be an object/i
  );
  await assert.rejects(
    async () => engine.executeIsolatedWasmAsync('not-an-object'),
    /Invalid shard: must be an object/i
  );

  // Missing shardId
  await assert.rejects(
    async () => engine.executeIsolatedWasmAsync({ wasmBinary: createMinimalAddWasm() }),
    /Invalid shard: missing shardId/i
  );

  // Invalid binary header
  await assert.rejects(
    async () => engine.executeIsolatedWasmAsync({
      shardId: 'shard-bad-bin',
      wasmBinary: Buffer.from([0x01, 0x02, 0x03, 0x04])
    }),
    /missing magic header/i
  );

  // Missing exported function in worker
  await assert.rejects(
    async () => engine.executeIsolatedWasmAsync({
      shardId: 'shard-missing-export',
      wasmBinary: createMinimalAddWasm(),
      exportName: 'nonExistent'
    }),
    /not a function in WASM module/i
  );

  // Runtime trap in worker execution
  const trapBinary = createTrapWasm();
  await assert.rejects(
    async () => engine.executeIsolatedWasmAsync({
      shardId: 'shard-trap',
      wasmBinary: trapBinary,
      exportName: 'trap'
    }),
    /unreachable/i
  );
});

test('WasmEngine - synchronous infinite loop timeout interruption', () => {
  const engine = new WasmEngine({ maxExecutionMs: 80 });
  const spinBinary = createInfiniteLoopWasm();

  assert.throws(
    () => engine.execute(spinBinary, 'spin'),
    /timeout: exceeded 80ms/i
  );

  // Can override with options.maxExecutionMs
  assert.throws(
    () => engine.execute(spinBinary, 'spin', [], { maxExecutionMs: 50 }),
    /timeout: exceeded 50ms/i
  );
});

test('WasmEngine - module compilation LRU caching and cache clearing', () => {
  const engine = new WasmEngine({ maxCacheEntries: 2 });
  const addBinary = createMinimalAddWasm();
  const spinBinary = createInfiniteLoopWasm();

  const mod1 = engine.compileModule(addBinary);
  const mod2 = engine.compileModule(addBinary);
  assert.strictEqual(mod1, mod2); // Cache hit returns same compiled module
  assert.strictEqual(engine.getCacheStats().size, 1);

  const spinMod = engine.compileModule(spinBinary);
  assert.strictEqual(engine.getCacheStats().size, 2);

  engine.clearCache();
  assert.strictEqual(engine.getCacheStats().size, 0);
});

test('WASM Header Validation - accepts ArrayBuffer and DataView BufferSource inputs', () => {
  const addBinary = createMinimalAddWasm();
  const ab = addBinary.buffer.slice(addBinary.byteOffset, addBinary.byteOffset + addBinary.byteLength);
  assert.strictEqual(isValidWasmHeader(ab), true);

  const dv = new DataView(ab);
  assert.strictEqual(isValidWasmHeader(dv), true);
});
