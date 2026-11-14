'use strict';

const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const vm = require('node:vm');

const WASM_PAGE_SIZE = 65536; // 64 KB per WebAssembly page
const DEFAULT_INITIAL_PAGES = 1; // 64 KB
const DEFAULT_MAX_PAGES = 256; // 16 MB max default memory
const MAX_ALLOWED_PAGES = 65536; // 4 GB spec ceiling for 32-bit WebAssembly
const DEFAULT_MAX_EXECUTION_MS = 2000;
const DEFAULT_MAX_CACHE_ENTRIES = 100;

// WASM binary magic header \0asm (0x00, 0x61, 0x73, 0x6d)
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
// WASM binary version 1 header (0x01, 0x00, 0x00, 0x00)
const WASM_VERSION_1 = Buffer.from([0x01, 0x00, 0x00, 0x00]);
const MAX_WASM_BINARY_BYTES = 16 * 1024 * 1024; // 16 MB

/**
 * Validates whether a buffer starts with standard WebAssembly magic bytes and version 1 header.
 * Accepts Buffer, Uint8Array, ArrayBuffer, and ArrayBufferViews (DataView).
 * Defensively copies SharedArrayBuffer views to prevent TOCTOU race tampering.
 * @param {Buffer|Uint8Array|ArrayBuffer|ArrayBufferView} binary
 * @returns {boolean}
 */
function isValidWasmHeader(binary) {
  if (!binary) {
    return false;
  }
  let bytes;
  if (Buffer.isBuffer(binary) || binary instanceof Uint8Array) {
    // If backed by SharedArrayBuffer, defensive copy first 8 bytes to prevent concurrent mutation
    if (typeof SharedArrayBuffer !== 'undefined' && binary.buffer instanceof SharedArrayBuffer) {
      bytes = new Uint8Array(binary.slice(0, 8));
    } else {
      bytes = binary;
    }
  } else if (binary instanceof ArrayBuffer) {
    bytes = new Uint8Array(binary);
  } else if (ArrayBuffer.isView(binary)) {
    bytes = new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
  } else {
    return false;
  }

  const len = bytes.length !== undefined ? bytes.length : bytes.byteLength;
  if (len < 8 || len > MAX_WASM_BINARY_BYTES) return false;

  return (
    bytes[0] === WASM_MAGIC[0] &&
    bytes[1] === WASM_MAGIC[1] &&
    bytes[2] === WASM_MAGIC[2] &&
    bytes[3] === WASM_MAGIC[3] &&
    bytes[4] === WASM_VERSION_1[0] &&
    bytes[5] === WASM_VERSION_1[1] &&
    bytes[6] === WASM_VERSION_1[2] &&
    bytes[7] === WASM_VERSION_1[3]
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
 * Enforces memory upper bounds, execution timeouts, LRU module compilation caching,
 * and strict capability sandboxing with zero external dependencies.
 */
class WasmEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.maxExecutionMs =
      typeof options.maxExecutionMs === 'number' && options.maxExecutionMs > 0
        ? options.maxExecutionMs
        : DEFAULT_MAX_EXECUTION_MS;

    this.initialPages =
      Number.isInteger(options.initialPages) && options.initialPages >= 0
        ? options.initialPages
        : DEFAULT_INITIAL_PAGES;

    this.maxPages =
      Number.isInteger(options.maxPages) && options.maxPages >= 0
        ? options.maxPages
        : DEFAULT_MAX_PAGES;

    this.allowEnvImports = Boolean(options.allowEnvImports);

    this.maxCacheEntries =
      Number.isInteger(options.maxCacheEntries) && options.maxCacheEntries > 0
        ? options.maxCacheEntries
        : DEFAULT_MAX_CACHE_ENTRIES;

    // Cryptographically keyed LRU cache for compiled WebAssembly.Module instances
    this._moduleCache = new Map();

    if (typeof WebAssembly === 'undefined') {
      throw new Error('WebAssembly is not supported in this Node environment');
    }
  }

  /**
   * Compiles and validates a WebAssembly module from binary bytes.
   * Utilizes a SHA-256 keyed bounded LRU cache to prevent repeated compilation
   * overhead while guarding against cache poisoning and unbounded memory growth.
   * @param {Buffer|Uint8Array|ArrayBuffer} binary
   * @returns {WebAssembly.Module}
   */
  compileModule(binary) {
    if (!isValidWasmHeader(binary)) {
      throw new Error('Invalid WebAssembly binary: missing or invalid magic header');
    }

    const hash = crypto.createHash('sha256').update(binary).digest('hex');
    if (this._moduleCache.has(hash)) {
      const cached = this._moduleCache.get(hash);
      // Refresh LRU ordering
      this._moduleCache.delete(hash);
      this._moduleCache.set(hash, cached);
      return cached;
    }

    try {
      const mod = new WebAssembly.Module(binary);
      // Bounded LRU eviction
      if (this._moduleCache.size >= this.maxCacheEntries) {
        const oldestKey = this._moduleCache.keys().next().value;
        this._moduleCache.delete(oldestKey);
      }
      this._moduleCache.set(hash, mod);
      return mod;
    } catch (err) {
      throw new Error(`WebAssembly compilation failed: ${err.message}`);
    }
  }

  /**
   * Clears the compiled module cache.
   */
  clearCache() {
    this._moduleCache.clear();
  }

  /**
   * Returns current cache statistics.
   * @returns {{ size: number, maxCacheEntries: number }}
   */
  getCacheStats() {
    return {
      size: this._moduleCache.size,
      maxCacheEntries: this.maxCacheEntries
    };
  }

  /**
   * Creates a bounded sandboxed memory instance for WebAssembly execution.
   * @param {number} [initialPages]
   * @param {number} [maxPages]
   * @returns {WebAssembly.Memory}
   */
  createSandboxedMemory(initialPages = this.initialPages, maxPages = this.maxPages) {
    if (!Number.isInteger(initialPages) || initialPages < 0) {
      throw new RangeError(`initialPages (${initialPages}) must be a non-negative integer`);
    }
    if (!Number.isInteger(maxPages) || maxPages < 0) {
      throw new RangeError(`maxPages (${maxPages}) must be a non-negative integer`);
    }
    if (initialPages > maxPages) {
      throw new RangeError(`initialPages (${initialPages}) cannot exceed maxPages (${maxPages})`);
    }
    if (maxPages > MAX_ALLOWED_PAGES) {
      throw new RangeError(`maxPages (${maxPages}) cannot exceed specification ceiling (${MAX_ALLOWED_PAGES})`);
    }

    return new WebAssembly.Memory({
      initial: initialPages,
      maximum: maxPages
    });
  }

  /**
   * Builds safe import object restricting host access.
   * Deeply merges `js` imports to preserve `js.mem` and strips ambient `env`.
   * @param {object} customImports
   * @param {WebAssembly.Memory} memory
   * @returns {object}
   */
  createSafeImports(customImports = {}, memory = null) {
    const sandboxedMem = memory || this.createSandboxedMemory();
    const customJs =
      customImports && typeof customImports.js === 'object' && customImports.js !== null
        ? customImports.js
        : {};

    const imports = {
      ...customImports,
      js: {
        mem: sandboxedMem,
        ...customJs
      }
    };

    // Ensure sandboxed memory is preserved unless customImports explicitly provided mem
    if (!customJs.mem) {
      imports.js.mem = sandboxedMem;
    }

    if (!this.allowEnvImports) {
      // Disallow ambient process/file/network access inside imports
      delete imports.env;
    }

    return imports;
  }

  /**
   * Instantiates a WebAssembly module with sandboxed memory and import boundaries.
   * Validates internal module memory declarations against maxPages upper limits.
   * @param {Buffer|Uint8Array|WebAssembly.Module} moduleOrBinary
   * @param {object} [customImports]
   * @returns {{ instance: WebAssembly.Instance, memory: WebAssembly.Memory }}
   */
  instantiate(moduleOrBinary, customImports = {}) {
    const mod =
      moduleOrBinary instanceof WebAssembly.Module
        ? moduleOrBinary
        : this.compileModule(moduleOrBinary);

    const memory = this.createSandboxedMemory();
    const imports = this.createSafeImports(customImports, memory);

    try {
      const instance = new WebAssembly.Instance(mod, imports);

      // Verify and capture internal module memory if declared
      let activeMemory = memory;
      if (instance.exports.memory && instance.exports.memory instanceof WebAssembly.Memory) {
        activeMemory = instance.exports.memory;
        if (activeMemory.buffer.byteLength > this.maxPages * WASM_PAGE_SIZE) {
          throw new RangeError(
            `Module internal memory (${activeMemory.buffer.byteLength} bytes) exceeds maxPages limit (${this.maxPages * WASM_PAGE_SIZE} bytes)`
          );
        }
      }

      return { instance, memory: activeMemory };
    } catch (err) {
      throw new Error(`WebAssembly instantiation failed: ${err.message}`);
    }
  }

  /**
   * Executes an exported WebAssembly function synchronously with timeout and memory tracking.
   * Traps synchronous runaway infinite loops fail-closed using isolated V8 VM watchdog timeouts.
   * @param {Buffer|Uint8Array|WebAssembly.Module} moduleOrBinary
   * @param {string} exportName
   * @param {Array<number>} [args]
   * @param {object} [options]
   * @returns {{ output: any, executionTimeMs: number, memoryBytes: number }}
   */
  execute(moduleOrBinary, exportName, args = [], options = {}) {
    if (typeof exportName !== 'string' || !exportName.trim()) {
      throw new TypeError("Invalid exportName: must be a non-empty string");
    }
    if (!Array.isArray(args)) {
      throw new TypeError("Invalid args: must be an array");
    }

    const { instance, memory } = this.instantiate(moduleOrBinary, options.imports);
    const fn = instance.exports[exportName];

    if (typeof fn !== 'function') {
      throw new Error(`Export '${exportName}' is not a callable function in WebAssembly module`);
    }

    const maxMs =
      options && typeof options.maxExecutionMs === 'number' && options.maxExecutionMs > 0
        ? options.maxExecutionMs
        : this.maxExecutionMs;

    const startTime = performance.now();
    let output;

    // Execute within a VM context to enforce strict synchronous timeout interrupts on loops
    const sandbox = { fn, args, output: undefined };
    const context = vm.createContext(sandbox);

    try {
      vm.runInContext('output = fn(...args);', context, { timeout: maxMs });
      output = sandbox.output;
    } catch (err) {
      if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out/i.test(err.message)) {
        throw new Error(`WebAssembly execution timeout: exceeded ${maxMs}ms`);
      }
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
      if (!shardId || typeof shardId !== 'string') {
        return reject(new TypeError('Invalid shard: missing shardId'));
      }
      if (typeof exportName !== 'string' || !exportName.trim()) {
        return reject(new TypeError('Invalid shard: exportName must be a non-empty string'));
      }
      if (!Array.isArray(args)) {
        return reject(new TypeError('Invalid shard: args must be an array'));
      }
      if (
        timeoutMs !== undefined &&
        (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs <= 0)
      ) {
        return reject(new TypeError('Invalid shard: timeoutMs must be a positive number'));
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
        reject(new Error(`WASM worker stopped unexpectedly with exit code ${code}`));
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
  MAX_ALLOWED_PAGES,
  DEFAULT_MAX_EXECUTION_MS,
  DEFAULT_MAX_CACHE_ENTRIES
};
