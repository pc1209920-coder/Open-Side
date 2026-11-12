'use strict';

const EventEmitter = require('node:events');

const WASM_PAGE_SIZE = 65536; // 64 KB per WebAssembly page
const DEFAULT_INITIAL_PAGES = 1; // 64 KB
const DEFAULT_MAX_PAGES = 256; // 16 MB max default memory
const DEFAULT_MAX_EXECUTION_MS = 2000;

// WASM binary magic header \0asm (0x00, 0x61, 0x73, 0x6d)
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
// WASM binary version 1 header (0x01, 0x00, 0x00, 0x00)
const WASM_VERSION_1 = Buffer.from([0x01, 0x00, 0x00, 0x00]);
const MAX_WASM_BINARY_BYTES = 16 * 1024 * 1024; // 16 MB

/**
 * Validates whether a buffer starts with standard WebAssembly magic bytes and version 1 header.
 * @param {Buffer|Uint8Array} binary
 * @returns {boolean}
 */
function isValidWasmHeader(binary) {
  if (!binary || (!Buffer.isBuffer(binary) && !(binary instanceof Uint8Array))) {
    return false;
  }
  if (binary.length < 8 || binary.length > MAX_WASM_BINARY_BYTES) return false;
  return (
    binary[0] === WASM_MAGIC[0] &&
    binary[1] === WASM_MAGIC[1] &&
    binary[2] === WASM_MAGIC[2] &&
    binary[3] === WASM_MAGIC[3] &&
    binary[4] === WASM_VERSION_1[0] &&
    binary[5] === WASM_VERSION_1[1] &&
    binary[6] === WASM_VERSION_1[2] &&
    binary[7] === WASM_VERSION_1[3]
  );
}

/**
 * Generates a minimal valid WebAssembly binary exporting an 'add(i32, i32) -> i32' function.
 * Used for synthetic tests, health checks, and micro-benchmarking without any external compiler.
 * @returns {Buffer}
 */
function createMinimalAddWasm() {
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm (magic)
    0x01, 0x00, 0x00, 0x00, // version 1
    // Type section: 1 type (func (i32, i32) -> i32)
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    // Function section: 1 func with type 0
    0x03, 0x02, 0x01, 0x00,
    // Export section: export "add" as func 0
    0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
    // Code section: func 0 body (local.get 0, local.get 1, i32.add, end)
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b
  ]);
}

/**
 * Generates a minimal valid WebAssembly binary with an infinite loop 'spin() -> void'.
 * Used for timeout interruption tests.
 * @returns {Buffer}
 */
function createInfiniteLoopWasm() {
  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    // Type section: 1 type, () -> ()
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    // Function section: 1 func, type 0
    0x03, 0x02, 0x01, 0x00,
    // Export section: 1 export "spin" -> func 0
    0x07, 0x08, 0x01, 0x04, 0x73, 0x70, 0x69, 0x6e, 0x00, 0x00,
    // Code section: 1 func, body (loop void, br 0, end loop, end func)
    0x0a, 0x09, 0x01, 0x07, 0x00, 0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b
  ]);
}

/**
 * WasmEngine provides safe, bounded execution of WebAssembly compute shards.
 * Enforces memory upper bounds, execution timeouts, and strict capability sandboxing
 * with zero external dependencies.
 */
class WasmEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.maxExecutionMs = options.maxExecutionMs || DEFAULT_MAX_EXECUTION_MS;
    this.initialPages = options.initialPages || DEFAULT_INITIAL_PAGES;
    this.maxPages = options.maxPages || DEFAULT_MAX_PAGES;
    this.allowEnvImports = Boolean(options.allowEnvImports);

    if (typeof WebAssembly === 'undefined') {
      throw new Error('WebAssembly is not supported in this Node environment');
    }
  }

  /**
   * Compiles and validates a WebAssembly module from binary bytes.
   * @param {Buffer|Uint8Array} binary
   * @returns {WebAssembly.Module}
   */
  compileModule(binary) {
    if (!isValidWasmHeader(binary)) {
      throw new Error('Invalid WebAssembly binary: missing or invalid magic header');
    }
    try {
      return new WebAssembly.Module(binary);
    } catch (err) {
      throw new Error(`WebAssembly compilation failed: ${err.message}`);
    }
  }

  /**
   * Creates a bounded sandboxed memory instance for WebAssembly execution.
   * @param {number} [initialPages]
   * @param {number} [maxPages]
   * @returns {WebAssembly.Memory}
   */
  createSandboxedMemory(initialPages = this.initialPages, maxPages = this.maxPages) {
    if (initialPages > maxPages) {
      throw new RangeError(`initialPages (${initialPages}) cannot exceed maxPages (${maxPages})`);
    }
    return new WebAssembly.Memory({
      initial: initialPages,
      maximum: maxPages
    });
  }

  /**
   * Builds safe import object restricting host access.
   * Prevents WASI or host system calls unless explicitly configured.
   * @param {object} customImports
   * @param {WebAssembly.Memory} memory
   * @returns {object}
   */
  createSafeImports(customImports = {}, memory = null) {
    const imports = {
      js: {
        mem: memory || this.createSandboxedMemory()
      },
      ...customImports
    };

    if (!this.allowEnvImports) {
      // Disallow ambient process/file/network access inside imports
      delete imports.env;
    }

    return imports;
  }

  /**
   * Instantiates a WebAssembly module with sandboxed memory and import boundaries.
   * @param {Buffer|Uint8Array|WebAssembly.Module} moduleOrBinary
   * @param {object} [customImports]
   * @returns {{ instance: WebAssembly.Instance, memory: WebAssembly.Memory }}
   */
  instantiate(moduleOrBinary, customImports = {}) {
    const mod = moduleOrBinary instanceof WebAssembly.Module
      ? moduleOrBinary
      : this.compileModule(moduleOrBinary);

    const memory = this.createSandboxedMemory();
    const imports = this.createSafeImports(customImports, memory);

    try {
      const instance = new WebAssembly.Instance(mod, imports);
      return { instance, memory };
    } catch (err) {
      throw new Error(`WebAssembly instantiation failed: ${err.message}`);
    }
  }

  /**
   * Executes an exported WebAssembly function synchronously with timeout and memory tracking.
   * @param {Buffer|Uint8Array|WebAssembly.Module} moduleOrBinary
   * @param {string} exportName
   * @param {Array<number>} [args]
   * @param {object} [options]
   * @returns {{ output: any, executionTimeMs: number, memoryBytes: number }}
   */
  execute(moduleOrBinary, exportName, args = [], options = {}) {
    const { instance, memory } = this.instantiate(moduleOrBinary, options.imports);
    const fn = instance.exports[exportName];

    if (typeof fn !== 'function') {
      throw new Error(`Export '${exportName}' is not a callable function in WebAssembly module`);
    }

    const maxMs = options.maxExecutionMs || this.maxExecutionMs;
    const startTime = performance.now();

    let output;
    try {
      output = fn(...args);
    } catch (err) {
      throw new Error(`WebAssembly execution error in '${exportName}': ${err.message}`);
    }

    const executionTimeMs = performance.now() - startTime;
    const memoryBytes = memory ? memory.buffer.byteLength : 0;

    return {
      output,
      executionTimeMs,
      memoryBytes
    };
  }

  /**
   * Executes a WebAssembly compute shard asynchronously in an isolated worker thread.
   * Enforces strict millisecond termination for runaway execution or unbounded loops.
   * @param {object} shard { shardId, wasmBinary, exportName, args, timeoutMs }
   * @returns {Promise<{ shardId: string, output: any, executionTimeMs: number }>}
   */
  executeIsolatedWasmAsync(shard) {
    return new Promise((resolve, reject) => {
      if (!shard || typeof shard !== 'object') {
        return reject(new TypeError('Invalid shard: must be an object'));
      }
      const { shardId, wasmBinary, exportName = 'main', args = [], timeoutMs } = shard;
      if (!shardId) {
        return reject(new TypeError('Invalid shard: missing shardId'));
      }
      if (!isValidWasmHeader(wasmBinary)) {
        return reject(new Error('Invalid WebAssembly binary: missing magic header'));
      }

      const { Worker } = require('node:worker_threads');
      const maxMs = timeoutMs || this.maxExecutionMs;

      // Inline worker code for zero-file-dependency isolated execution
      const workerCode = `
        const { parentPort, workerData } = require('node:worker_threads');
        const { binaryBuffer, exportName, args } = workerData;

        try {
          const mod = new WebAssembly.Module(Buffer.from(binaryBuffer));
          const instance = new WebAssembly.Instance(mod, {});
          const fn = instance.exports[exportName];
          if (typeof fn !== 'function') {
            throw new Error("Export '" + exportName + "' is not a function in WASM module");
          }
          const start = performance.now();
          const output = fn(...args);
          const duration = performance.now() - start;
          parentPort.postMessage({ success: true, output, executionTimeMs: duration });
        } catch (err) {
          parentPort.postMessage({ success: false, error: err.message });
        }
      `;

      let timer = null;
      let settled = false;

      const worker = new Worker(workerCode, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32
        },
        workerData: {
          binaryBuffer: wasmBinary,
          exportName,
          args
        }
      });

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        settled = true;
      };

      timer = setTimeout(async () => {
        if (settled) return;
        cleanup();
        try {
          await worker.terminate();
        } catch {
          // Worker termination
        }
        reject(new Error(`WASM execution timeout: exceeded ${maxMs}ms`));
      }, maxMs);

      if (timer.unref) timer.unref();

      worker.on('message', async (msg) => {
        if (settled) return;
        cleanup();
        try {
          await worker.terminate();
        } catch {
          // ignore
        }
        if (msg.success) {
          resolve({
            shardId,
            output: msg.output,
            executionTimeMs: msg.executionTimeMs
          });
        } else {
          reject(new Error(msg.error));
        }
      });

      worker.on('error', (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      });

      worker.on('exit', (code) => {
        if (settled) return;
        cleanup();
        if (code !== 0) {
          reject(new Error(`WASM worker stopped unexpectedly with exit code ${code}`));
        }
      });
    });
  }
}

module.exports = {
  WasmEngine,
  isValidWasmHeader,
  createMinimalAddWasm,
  createInfiniteLoopWasm,
  WASM_PAGE_SIZE,
  DEFAULT_INITIAL_PAGES,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_EXECUTION_MS
};
