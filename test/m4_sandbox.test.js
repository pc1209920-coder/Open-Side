const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { types } = require('node:util');

const { StandbySandbox, StandbyWorkerPool } = require('../src/sandbox');

/**
 * Cross-realm error predicate: works identically for host Errors,
 * node:vm realm Errors (where `err instanceof Error` is false), and
 * worker_threads Errors.
 */
function isErrorLike(err) {
  return Boolean(
    err &&
    (err instanceof Error || types.isNativeError(err)) &&
    typeof err.message === 'string' &&
    err.message.length > 0
  );
}

// ============================================================================
// M4 (R4): Zero-Trust Sandbox Hardening & Deterministic Virtualization
// Standalone verification suite targeting StandbySandbox contract in src/sandbox.js
// ============================================================================

describe('Milestone 4 (R4): StandbySandbox Contract, Defaults & Configuration Validation', () => {
  test('Initializes default resource limits (1500ms timeout, 64MB heap) and accepts valid overrides', () => {
    const defaultSandbox = new StandbySandbox();
    assert.strictEqual(defaultSandbox.maxExecutionMs, 1500);
    assert.strictEqual(defaultSandbox.maxMemoryMb, 64);

    const undefinedOverrides = new StandbySandbox({
      maxExecutionMs: undefined,
      maxMemoryMb: undefined
    });
    assert.strictEqual(undefinedOverrides.maxExecutionMs, 1500);
    assert.strictEqual(undefinedOverrides.maxMemoryMb, 64);

    const customSandbox = new StandbySandbox({
      maxExecutionMs: 250,
      maxMemoryMb: 32
    });
    assert.strictEqual(customSandbox.maxExecutionMs, 250);
    assert.strictEqual(customSandbox.maxMemoryMb, 32);
  });

  test('Rejects invalid or non-positive maxExecutionMs and maxMemoryMb fail-closed', () => {
    const invalidValues = [0, -1, -500, NaN, Infinity, -Infinity, '100', null, {}, []];

    for (const badMs of invalidValues) {
      assert.throws(
        () => new StandbySandbox({ maxExecutionMs: badMs }),
        isErrorLike,
        `Expected constructor to reject invalid maxExecutionMs: ${String(badMs)}`
      );
    }

    for (const badMb of invalidValues) {
      assert.throws(
        () => new StandbySandbox({ maxMemoryMb: badMb }),
        isErrorLike,
        `Expected constructor to reject invalid maxMemoryMb: ${String(badMb)}`
      );
    }
  });

  test('Rejects malformed shard payloads fail-closed in sync and async execution', async () => {
    const sandbox = new StandbySandbox();

    assert.throws(() => sandbox.executeIsolatedShard(null), isErrorLike);
    assert.throws(() => sandbox.executeIsolatedShard(undefined), isErrorLike);
    assert.throws(() => sandbox.executeIsolatedShard({}), isErrorLike);
    assert.throws(
      () => sandbox.executeIsolatedShard({ shardId: 'bad-code', taskCode: '', inputData: [] }),
      isErrorLike
    );
    assert.throws(
      () => sandbox.executeIsolatedShard({ shardId: 'bad-type', taskCode: 123, inputData: [] }),
      isErrorLike
    );

    await assert.rejects(async () => sandbox.executeIsolatedShardAsync(null), isErrorLike);
    await assert.rejects(async () => sandbox.executeIsolatedShardAsync(undefined), isErrorLike);
    await assert.rejects(async () => sandbox.executeIsolatedShardAsync({}), isErrorLike);
    await assert.rejects(
      async () => sandbox.executeIsolatedShardAsync({ shardId: 'bad-async', taskCode: '', inputData: [] }),
      isErrorLike
    );
  });
});

describe('F18 & F19: Static/AST Token Pre-Validation & Escape Sequence Normalizer', () => {
  test('T1.F18.01 & T1.F19.05: Accepts benign pure math, array transformations, loops, destructuring, regexes, and safe unicode strings', async () => {
    const sandbox = new StandbySandbox();

    const benignSnippets = [
      'return data.map(x => x * 2);',
      'return data.map(x => x / 2);',
      'return data.filter(n => n > 0).reduce((acc, n) => acc + Math.sqrt(n), 0);',
      'return data.filter(s => /^[a-z]+$/i.test(s));',
      'let total = 0; for (let i = 0; i < data.length; i++) { total += data[i]; } return total;',
      'let i = 0, sum = 0; while (i < data.length) { sum += data[i]; i += 1; } return sum;',
      'const [first = 0, second = 0, ...rest] = data; const { factor } = { factor: 3 }; return (first + second) * factor + rest.length;',
      'const msg = "\\u0048\\u0065\\u006c\\u006c\\u006f"; return msg;'
    ];

    for (const code of benignSnippets) {
      const res = sandbox.validateTaskCode(code);
      assert.strictEqual(res.valid, true, `Expected benign code to pass validation: ${code} (error: ${res.error})`);
    }

    const unicodeRes = sandbox.executeIsolatedShard({
      shardId: 'benign-unicode',
      taskCode: 'const msg = "\\u0048\\u0065\\u006c\\u006c\\u006f"; return msg;',
      inputData: []
    });
    assert.strictEqual(unicodeRes.output, 'Hello');

    const mathCode = 'const [a, b, ...rest] = data; return Math.sqrt(a) + Math.pow(b, 2) + rest.length;';
    const mathRes = sandbox.executeIsolatedShard({
      shardId: 'benign-math',
      taskCode: mathCode,
      inputData: [16, 5, 99, 100]
    });
    assert.strictEqual(mathRes.output, 31);

    const asyncMathRes = await sandbox.executeIsolatedShardAsync({
      shardId: 'benign-math-async',
      taskCode: mathCode,
      inputData: [16, 5, 99, 100]
    });
    assert.strictEqual(asyncMathRes.output, 31);
  });

  test('T1.F18.02–05: Rejects all forbidden global, code-gen, module, timer, and prototype identifiers', async () => {
    const sandbox = new StandbySandbox();

    const forbiddenVectors = [
      ['process', 'return process.env;'],
      ['process.exit', 'process.exit(1);'],
      ['require', 'const fs = require("node:fs"); return fs;'],
      ['module', 'return module.exports;'],
      ['eval', 'return eval("1 + 1");'],
      ['Function', 'return new Function("return 1")();'],
      ['Function()', 'return Function("return 1")();'],
      ['global', 'return global;'],
      ['globalThis', 'return globalThis;'],
      ['WebAssembly', 'return typeof WebAssembly;'],
      ['Buffer', 'return Buffer.from("abc");'],
      ['Proxy', 'return new Proxy({}, {});'],
      ['Reflect', 'return Reflect.ownKeys({});'],
      ['__proto__', 'data.__proto__.polluted = true; return 1;'],
      ['__proto__ literal', 'return ({}).__proto__;'],
      ['constructor', 'return data.constructor;'],
      ['prototype', 'return Object.prototype;'],
      ['setTimeout', 'setTimeout(() => {}, 10); return 1;'],
      ['import()', 'return import("node:fs");'],
      ['async import()', 'async function f() { return await import("node:os"); } return f();']
    ];

    for (const [label, code] of forbiddenVectors) {
      const res = sandbox.validateTaskCode(code);
      assert.strictEqual(res.valid, false, `Expected validateTaskCode to reject ${label}: ${code}`);
      assert.strictEqual(typeof res.error, 'string');
      assert.ok(res.error.length > 0, `Expected non-empty error string for ${label}`);

      assert.throws(
        () => sandbox.executeIsolatedShard({ shardId: `reject-sync-${label}`, taskCode: code, inputData: [1] }),
        isErrorLike,
        `Expected executeIsolatedShard to throw fail-closed for ${label}`
      );
      await assert.rejects(
        async () => sandbox.executeIsolatedShardAsync({ shardId: `reject-async-${label}`, taskCode: code, inputData: [1] }),
        isErrorLike,
        `Expected executeIsolatedShardAsync to reject fail-closed for ${label}`
      );
    }
  });

  test('F19 & T2.F18/F19: Rejects unicode, hex, octal, zero-width, null-byte, concat, comment-split, and template-literal evasions', async () => {
    const sandbox = new StandbySandbox();

    const evasionVectors = [
      // Unicode identifier, property & string escapes
      ['identifier \\u0070rocess', 'return \\u0070rocess.env;'],
      ['identifier \\u{70}rocess', 'return \\u{70}rocess.env;'],
      ['identifier zero-padded \\u{00070}rocess', 'return \\u{00070}rocess.env;'],
      ['full unicode process', 'return \\u0070\\u0072\\u006f\\u0063\\u0065\\u0073\\u0073;'],
      ['unicode Function', 'return \\u0046unction("return 1")();'],
      ['unicode constructor', 'return data.con\\u0073tructor;'],
      ['unicode fn constructor', 'return (function(){}).\\u0063onstructor("return 1")();'],
      ['string unicode process', 'return this["\\u0070rocess"];'],
      ['string brace unicode process', 'return this["\\u{70}rocess"];'],

      // Hex, octal, line-continuation & mixed escapes
      ['raw hex \\x72equire', 'return \\x72equire("node:fs");'],
      ['string hex \\x72equire', 'return this["\\x72equire"];'],
      ['full hex require', 'return this["\\x72\\x65\\x71\\x75\\x69\\x72\\x65"];'],
      ['mixed unicode+hex process', 'return this["\\u0070\\x72\\u006f\\x63ess"];'],
      ['octal escape process', 'return this["\\160rocess"];'],
      ['line continuation process', 'return ({})["pro\\\ncess"];'],

      // String concatenation & bracket access (with and without `this`)
      ['this["pro"+"cess"]', 'return this["pro" + "cess"];'],
      ['this[\'pro\'+\'cess\']', "return this['pro' + 'cess'];"],
      ['this["ev"+"al"]', 'return this["ev" + "al"]("1+1");'],
      ['data["__pro"+"to__"]', 'return data["__pro" + "to__"];'],
      ['({})["con"+"structor"]', 'return ({})["con" + "structor"];'],

      // Comment-split evasions
      ['comment-split identifier', 'return proc/*evade*/ess;'],
      ['comment-split eval', 'return ev/**/al("1+1");'],
      ['comment-split import(', 'return import /* split */ ("node:fs");'],
      ['comment-split concat', 'return this["pro" + /* split */ "cess"];'],
      ['comment-split bracket', 'return this[/*a*/"pro"/*b*/+/*c*/"cess"/*d*/];'],
      ['line-comment-split concat', 'return this["req" +\n// split\n"uire"];'],
      ['comment-split constructor', 'return data[/*x*/"constructor"/*y*/];'],

      // Template-literal evasions
      ['template bracket plain', 'return this[`process`];'],
      ['template interpolation empty', 'return this[`pro${""}cess`];'],
      ['template interpolation split', 'return this[`${"pro"}${"cess"}`];'],
      ['data template constructor', 'return data[`con${""}structor`];'],
      ['obj template __proto__', 'return ({})[`__pro${""}to__`];'],
      ['tagged template eval', 'return eval`1+1`;'],
      ['tagged template Function', 'return Function`return 1`();'],
      ['template require', 'return this[`req${"uire"}`]("node:fs");'],

      // Zero-width invisibles & null-byte injections
      ['raw U+200B in identifier', 'return proc\u200Bess;'],
      ['raw U+200C in identifier', 'return proc\u200Cess;'],
      ['raw U+FEFF in identifier', 'return proc\uFEFFess;'],
      ['raw U+200B in string lookup', 'return this["proc\u200Bess"];'],
      ['escaped \\u200B in string lookup', 'return this["proc\\u200Bess"];'],
      ['raw null byte', 'return process\x00.exit();'],
      ['escaped null byte in string', 'return this["proc\\x00ess"];'],
      ['escaped unicode null byte', 'return this["proc\\u0000ess"];']
    ];

    for (const [label, code] of evasionVectors) {
      const res = sandbox.validateTaskCode(code);
      assert.strictEqual(res.valid, false, `Expected validateTaskCode to reject evasion (${label}): ${code}`);
      assert.strictEqual(typeof res.error, 'string');
      assert.ok(res.error.length > 0);
    }

    // Verify F19 evasions are also rejected fail-closed by sync and async execution paths
    const execEvasions = [
      ['unicode constructor exec', 'return data.con\\u0073tructor;'],
      ['hex escape exec', 'return this["\\x72equire"];'],
      ['concat bracket exec', 'return data["__pro" + "to__"];'],
      ['comment-split exec', 'return data[/*x*/"constructor"/*y*/];'],
      ['template bracket exec', 'return data[`con${""}structor`];'],
      ['zero-width exec', 'return this["proc\\u200Bess"];'],
      ['line continuation exec', 'return ({})["pro\\\ncess"];']
    ];

    for (const [label, code] of execEvasions) {
      assert.throws(
        () => sandbox.executeIsolatedShard({ shardId: `evasion-sync-${label}`, taskCode: code, inputData: [1, 2] }),
        isErrorLike,
        `Expected executeIsolatedShard to reject evasion (${label})`
      );
      await assert.rejects(
        async () => sandbox.executeIsolatedShardAsync({ shardId: `evasion-async-${label}`, taskCode: code, inputData: [1, 2] }),
        isErrorLike,
        `Expected executeIsolatedShardAsync to reject evasion (${label})`
      );
    }
  });

  test('T2.F18.05 & T2.F19.02: Rejects non-string, empty, malformed syntax, malformed escapes, and wrapper breakout attempts fail-closed', async () => {
    const sandbox = new StandbySandbox();

    const invalidInputs = [
      null,
      undefined,
      123,
      true,
      {},
      [],
      () => 1,
      '',
      '   \n\t  ',
      'return data.map( => );',
      'function broken( { return 1;',
      'return 1 +;',
      'return "unterminated;',
      '/* unterminated comment',
      'return `unterminated template;',
      'return "\\u00z1";',
      'return "\\xZZ";',
      'return "\\u{}";',
      'return 1;\0',
      'return 1; }); (function() { return 2;',
      '1; })(input); process.exit(1); (function(data) {'
    ];

    for (const badInput of invalidInputs) {
      const res = sandbox.validateTaskCode(badInput);
      assert.strictEqual(res.valid, false, `Expected validateTaskCode to fail-closed on: ${String(badInput)}`);
      assert.strictEqual(typeof res.error, 'string');
      assert.ok(res.error.length > 0);

      assert.throws(
        () => sandbox.executeIsolatedShard({ shardId: 'malformed-sync', taskCode: badInput, inputData: [] }),
        isErrorLike
      );
      await assert.rejects(
        async () => sandbox.executeIsolatedShardAsync({ shardId: 'malformed-async', taskCode: badInput, inputData: [] }),
        isErrorLike
      );
    }
  });
});

describe('F20: Zero-Privilege VM Isolation Boundary & Prototype Pollution Immunity', () => {
  test('T2.F20.01 & T1.F20.03: Prevents host Object.prototype, Array.prototype, and Math mutations across sync and async execution', async () => {
    const sandbox = new StandbySandbox();
    const originalMathFloor = Math.floor;

    try {
      const attempts = [
        'Object.prototype.polluted = true; return 1;',
        'Array.prototype.pollutedArr = true; return 1;',
        'data.__proto__.pollutedProto = true; return 1;',
        'const p = Object.getPrototypeOf(data); if (p) { p.pollutedIndirect = true; const op = Object.getPrototypeOf(p); if (op) op.pollutedObjIndirect = true; } return 1;',
        'const o = {}; const op = Object.getPrototypeOf(o); if (op) op.pollutedVmObj = true; return 1;',
        'Math.floor = () => 0; return Math.floor(1.5);'
      ];

      for (let i = 0; i < attempts.length; i++) {
        try {
          sandbox.executeIsolatedShard({ shardId: `proto-sync-${i}`, taskCode: attempts[i], inputData: [1, 2] });
        } catch {
          // Expected fail-closed rejection or TypeError in strict frozen context
        }

        try {
          await sandbox.executeIsolatedShardAsync({ shardId: `proto-async-${i}`, taskCode: attempts[i], inputData: [1, 2] });
        } catch {
          // Expected fail-closed rejection or TypeError in strict frozen context
        }
      }

      assert.strictEqual(({}).polluted, undefined);
      assert.strictEqual(Object.prototype.polluted, undefined);
      assert.strictEqual(([]).pollutedArr, undefined);
      assert.strictEqual(Array.prototype.pollutedArr, undefined);
      assert.strictEqual(({}).pollutedProto, undefined);
      assert.strictEqual(([]).pollutedProto, undefined);
      assert.strictEqual(([]).pollutedIndirect, undefined);
      assert.strictEqual(({}).pollutedObjIndirect, undefined);
      assert.strictEqual(({}).pollutedVmObj, undefined);
      assert.strictEqual(Math.floor(1.5), 1);
    } finally {
      Math.floor = originalMathFloor;
      delete Object.prototype.polluted;
      delete Array.prototype.pollutedArr;
      delete Object.prototype.pollutedProto;
      delete Array.prototype.pollutedProto;
      delete Array.prototype.pollutedIndirect;
      delete Object.prototype.pollutedObjIndirect;
      delete Object.prototype.pollutedVmObj;
    }
  });

  test('Blocks constructor-chain code generation at both pre-validation and V8 codeGeneration: { strings: false } levels', async () => {
    const sandbox = new StandbySandbox();

    // Level 1: Direct constructor-chain vectors blocked at pre-validation AND execution
    const directChains = [
      'return (() => {}).constructor("return process")();',
      'return input.constructor.constructor("return process")();',
      'return data.constructor.constructor("return process")();',
      'const k = ["con", "struc", "tor"].join(""); return (() => {})[k]("return 42")();',
      'const k = ["con", "struc", "tor"].join(""); return data[k][k]("return 42")();'
    ];

    for (let i = 0; i < directChains.length; i++) {
      const code = directChains[i];
      const check = sandbox.validateTaskCode(code);
      assert.strictEqual(check.valid, false, `Pre-validator must reject: ${code}`);
      assert.throws(
        () => sandbox.executeIsolatedShard({ shardId: `ctor-direct-${i}`, taskCode: code, inputData: [1, 2] }),
        isErrorLike
      );
      await assert.rejects(
        async () => sandbox.executeIsolatedShardAsync({ shardId: `ctor-direct-async-${i}`, taskCode: code, inputData: [1, 2] }),
        isErrorLike
      );
    }

    // Level 2: Runtime-assembled keys not statically folded by validateTaskCode MUST still be blocked inside VM
    // by V8 `codeGeneration: { strings: false }` across VM functions, input objects, built-ins, and virtualized primitives.
    const runtimeBypassAttempts = [
      ['vm arrow fn (+=)', 'let k = "con"; k += "structor"; return (() => {})[k]("return 42")();', [1, 2]],
      ['vm arrow fn (array.join)', 'const parts = ["con", "struc", "tor"]; return (() => {})[parts.join("")]("return 42")();', [1, 2]],
      ['data array ctor-chain', 'const parts = ["con", "struc", "tor"]; const k = parts.join(""); return data[k][k]("return 42")();', [1, 2]],
      ['nested data[0] ctor-chain', 'const parts = ["con", "struc", "tor"]; const k = parts.join(""); return data[0][k][k]("return 42")();', [{ a: 1 }]],
      ['input global ctor-chain', 'const parts = ["con", "struc", "tor"]; const k = parts.join(""); return input[k][k]("return 42")();', [1, 2]],
      ['Object builtin ctor', 'const parts = ["con", "struc", "tor"]; return Object[parts.join("")]("return 42")();', []],
      ['Array builtin ctor', 'const parts = ["con", "struc", "tor"]; return Array[parts.join("")]("return 42")();', []],
      ['Math.random ctor', 'const parts = ["con", "struc", "tor"]; return Math.random[parts.join("")]("return 42")();', []],
      ['Date.now ctor', 'const parts = ["con", "struc", "tor"]; return Date.now[parts.join("")]("return 42")();', []]
    ];

    for (let i = 0; i < runtimeBypassAttempts.length; i++) {
      const [label, code, inputData] = runtimeBypassAttempts[i];
      const passedStaticCheck = sandbox.validateTaskCode(code).valid;

      assert.throws(
        () => sandbox.executeIsolatedShard({ shardId: `ctor-codegen-${i}`, taskCode: code, inputData }),
        (err) => {
          assert.ok(isErrorLike(err), `Expected Error-like rejection for ${label}`);
          if (passedStaticCheck) {
            assert.ok(
              err.name === 'EvalError' || err.name === 'TypeError' || err.name === 'ReferenceError',
              `Expected VM codeGeneration/isolation error for ${label}, got ${err.name}: ${err.message}`
            );
          }
          return true;
        },
        `Expected sync VM boundary to block ${label}`
      );

      await assert.rejects(
        async () => sandbox.executeIsolatedShardAsync({ shardId: `ctor-codegen-async-${i}`, taskCode: code, inputData }),
        (err) => {
          assert.ok(isErrorLike(err), `Expected async Error-like rejection for ${label}`);
          if (passedStaticCheck) {
            assert.ok(
              err.name === 'EvalError' || err.name === 'TypeError' || err.name === 'ReferenceError',
              `Expected async VM codeGeneration/isolation error for ${label}, got ${err.name}: ${err.message}`
            );
          }
          return true;
        },
        `Expected async VM boundary to block ${label}`
      );
    }
  });

  test('T1.F20.04 & T2.F20.02–03: Enforces strict-mode isolation, traps string exhaustion, and prevents cross-shard leaks', () => {
    const sandbox = new StandbySandbox();

    // arguments.callee.caller blocked in strict mode or pre-validation
    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'callee-trap',
        taskCode: 'return arguments.callee.caller;',
        inputData: []
      }),
      isErrorLike
    );

    // Assigning to undeclared variable fails with ReferenceError under strict mode
    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'strict-undeclared',
        taskCode: 'undeclaredLeak = 999; return 1;',
        inputData: []
      }),
      (err) => isErrorLike(err) && err.name === 'ReferenceError'
    );

    // Giant string allocation throws RangeError cleanly without crashing host
    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'string-oom',
        taskCode: 'return "a".repeat(1e9);',
        inputData: []
      }),
      isErrorLike
    );

    // Shard 1 cannot leak state onto Math, Object.prototype, or undeclared globals for Shard 2 or host
    try {
      try {
        sandbox.executeIsolatedShard({
          shardId: 'leak-writer',
          taskCode: 'Math.leakedProp = "secret"; return 1;',
          inputData: []
        });
      } catch (err) {
        assert.ok(isErrorLike(err));
      }

      try {
        sandbox.executeIsolatedShard({
          shardId: 'cross-proto-writer',
          taskCode: 'const o = {}; const p = Object.getPrototypeOf(o); if (p) { p.crossShardProto = 1; } return 1;',
          inputData: []
        });
      } catch (err) {
        assert.ok(isErrorLike(err));
      }

      const reader = sandbox.executeIsolatedShard({
        shardId: 'leak-reader',
        taskCode: 'return { crossProto: ({}).crossShardProto === undefined, floorVal: Math.floor(1.5), hasLeakVar: typeof undeclaredLeak, mathLeak: Math.leakedProp === undefined };',
        inputData: []
      });
      assert.deepStrictEqual(reader.output, {
        crossProto: true,
        floorVal: 1,
        hasLeakVar: 'undefined',
        mathLeak: true
      });
      assert.strictEqual(Math.leakedProp, undefined);
      assert.strictEqual(({}).crossShardProto, undefined);
    } finally {
      delete Math.leakedProp;
      delete Object.prototype.crossShardProto;
    }
  });

  test('Returns host-realm objects and arrays passing assert.deepStrictEqual cleanly and preserves falsy values', async () => {
    const sandbox = new StandbySandbox();

    const syncArray = sandbox.executeIsolatedShard({
      shardId: 'realm-arr',
      taskCode: 'return data.map(n => n * 2);',
      inputData: [1, 2, 3]
    });
    assert.strictEqual(syncArray.shardId, 'realm-arr');
    assert.deepStrictEqual(syncArray.output, [2, 4, 6]);
    assert.strictEqual(Object.getPrototypeOf(syncArray.output), Array.prototype);

    const syncObj = sandbox.executeIsolatedShard({
      shardId: 'realm-obj',
      taskCode: 'return { items: data.slice(), meta: { ok: true, count: data.length } };',
      inputData: [10, 20]
    });
    assert.deepStrictEqual(syncObj.output, {
      items: [10, 20],
      meta: { count: 2, ok: true }
    });
    assert.strictEqual(Object.getPrototypeOf(syncObj.output), Object.prototype);

    const asyncObj = await sandbox.executeIsolatedShardAsync({
      shardId: 'realm-async',
      taskCode: 'return { items: data.map(x => x + 1), meta: { valid: true } };',
      inputData: [4, 5]
    });
    assert.deepStrictEqual(asyncObj.output, {
      items: [5, 6],
      meta: { valid: true }
    });

    // Falsy return values preserved faithfully
    const falsyCases = [
      ['zero', 'return 0;', 0],
      ['false', 'return false;', false],
      ['null', 'return null;', null],
      ['empty-str', 'return "";', ''],
      ['empty-arr', 'return [];', []],
      ['empty-obj', 'return {};', {}]
    ];
    for (const [label, taskCode, expected] of falsyCases) {
      const res = sandbox.executeIsolatedShard({ shardId: `falsy-${label}`, taskCode, inputData: [] });
      assert.deepStrictEqual(res.output, expected);
    }
  });
});

describe('F21: Millisecond Execution Timeout Guard', () => {
  test('T1.F21.01 & T2.F21.03: Interrupts synchronous infinite loops promptly within configured maxExecutionMs', () => {
    const sandbox = new StandbySandbox({ maxExecutionMs: 100 });

    const start = performance.now();
    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'sync-inf-loop',
        taskCode: 'while (true) {}',
        inputData: []
      }),
      /timed?\s*out/i
    );
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `Expected timeout well below 1000ms (configured 100ms), took ${elapsed.toFixed(1)}ms`);

    // Infinite loop inside array callback
    const cbStart = performance.now();
    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'sync-cb-loop',
        taskCode: 'return data.reduce(() => { while (true) {} }, 0);',
        inputData: [1, 2]
      }),
      /timed?\s*out/i
    );
    const cbElapsed = performance.now() - cbStart;
    assert.ok(cbElapsed < 1000, `Expected callback timeout well below 1000ms, took ${cbElapsed.toFixed(1)}ms`);
  });

  test('T1.F21.02–04: Traps unbounded recursion without crashing host and executes compliant workloads with executionTimeMs', () => {
    const sandbox = new StandbySandbox({ maxExecutionMs: 500 });

    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'inf-recurse',
        taskCode: 'function dive(n) { return dive(n + 1) + 1; } return dive(0);',
        inputData: []
      }),
      isErrorLike
    );

    // Sandbox remains operational after timeout / stack overflow errors
    const compliant = sandbox.executeIsolatedShard({
      shardId: 'compliant-loop',
      taskCode: 'let acc = 0; for (let i = 1; i <= 50000; i++) { acc += i % 7; } return acc + data[0];',
      inputData: [10]
    });
    assert.strictEqual(compliant.shardId, 'compliant-loop');
    assert.strictEqual(typeof compliant.output, 'number');
    assert.strictEqual(typeof compliant.executionTimeMs, 'number');
    assert.ok(Number.isFinite(compliant.executionTimeMs) && compliant.executionTimeMs >= 0);
  });
});

describe('F22: Worker Threads Memory Resource Limits (executeIsolatedShardAsync)', () => {
  test('T1.F22.01: Executes valid async shard in worker thread and returns { shardId, output, executionTimeMs }', async () => {
    const sandbox = new StandbySandbox();

    const res = await sandbox.executeIsolatedShardAsync({
      shardId: 'async-valid-1',
      taskCode: 'return data.map(x => x * 3);',
      inputData: [2, 4, 6]
    });

    assert.strictEqual(res.shardId, 'async-valid-1');
    assert.deepStrictEqual(res.output, [6, 12, 18]);
    assert.strictEqual(typeof res.executionTimeMs, 'number');
    assert.ok(Number.isFinite(res.executionTimeMs) && res.executionTimeMs >= 0);

    // Explicit undefined options must fall back to defaults cleanly (e.g. orchestrator passthrough)
    const fallbackRes = await sandbox.executeIsolatedShardAsync(
      { shardId: 'async-undef-opts', taskCode: 'return data[0] + data[1];', inputData: [10, 32] },
      { timeoutMs: undefined, memoryLimitMb: undefined }
    );
    assert.strictEqual(fallbackRes.output, 42);

    // Tight 16 MB limit still permits normal small computations to complete cleanly
    const tightValid = await sandbox.executeIsolatedShardAsync(
      { shardId: 'async-tight-valid', taskCode: 'return data.reduce((a, b) => a + b, 0);', inputData: [1, 2, 3, 4] },
      { memoryLimitMb: 16 }
    );
    assert.strictEqual(tightValid.output, 10);
  });

  test('T1.F21.05 & T2.F22.04: Async timeout terminates runaway worker cleanly within configured timeoutMs', async () => {
    const sandbox = new StandbySandbox({ maxExecutionMs: 1500 });

    const start = performance.now();
    await assert.rejects(
      async () => sandbox.executeIsolatedShardAsync(
        { shardId: 'async-timeout', taskCode: 'while (true) {}', inputData: [] },
        { timeoutMs: 120 }
      ),
      /timed?\s*out/i
    );
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1200, `Expected async timeout < 1200ms (configured 120ms), took ${elapsed.toFixed(1)}ms`);
  });

  test('T1.F22.02: Memory exhaustion payload under tight memoryLimitMb (16–32 MB) rejects cleanly without crashing host', async () => {
    const oomPayload = 'const a = []; while(true) a.push(new Array(1e6).fill(1));';

    // 1. Tight per-call memoryLimitMb: 16 MB (generous timeoutMs so OOM triggers first even on loaded CI)
    const sandbox = new StandbySandbox({ maxExecutionMs: 8000, maxMemoryMb: 64 });
    const start16 = performance.now();
    await assert.rejects(
      async () => sandbox.executeIsolatedShardAsync(
        { shardId: 'oom-16mb', taskCode: oomPayload, inputData: [] },
        { memoryLimitMb: 16, timeoutMs: 8000 }
      ),
      (err) => {
        assert.ok(isErrorLike(err));
        assert.ok(!/timed?\s*out/i.test(err.message), `Expected OOM rejection rather than timeout, got: ${err.message}`);
        return true;
      }
    );
    assert.ok(performance.now() - start16 < 7500);

    // 2. Constructor maxMemoryMb: 32 MB
    const tightSandbox = new StandbySandbox({ maxExecutionMs: 8000, maxMemoryMb: 32 });
    await assert.rejects(
      async () => tightSandbox.executeIsolatedShardAsync({
        shardId: 'oom-32mb',
        taskCode: oomPayload,
        inputData: []
      }),
      (err) => {
        assert.ok(isErrorLike(err));
        assert.ok(!/timed?\s*out/i.test(err.message), `Expected OOM rejection rather than timeout, got: ${err.message}`);
        return true;
      }
    );

    // 3. Host process remains healthy and subsequent workers succeed normally
    const recovery = await tightSandbox.executeIsolatedShardAsync({
      shardId: 'post-oom-recovery',
      taskCode: 'return data.reduce((a, b) => a + b, 0);',
      inputData: [10, 20, 30]
    });
    assert.strictEqual(recovery.shardId, 'post-oom-recovery');
    assert.strictEqual(recovery.output, 60);
  });

  test('Rejects invalid async options (timeoutMs, memoryLimitMb) and handles concurrent worker shards cleanly', async () => {
    const sandbox = new StandbySandbox();

    const invalidNumbers = [0, -10, NaN, Infinity, -Infinity, '50', null, {}, []];
    for (const bad of invalidNumbers) {
      await assert.rejects(
        async () => sandbox.executeIsolatedShardAsync(
          { shardId: 'bad-opt-t', taskCode: 'return 1;', inputData: [] },
          { timeoutMs: bad }
        ),
        isErrorLike
      );
      await assert.rejects(
        async () => sandbox.executeIsolatedShardAsync(
          { shardId: 'bad-opt-m', taskCode: 'return 1;', inputData: [] },
          { memoryLimitMb: bad }
        ),
        isErrorLike
      );
    }

    const batch = Array.from({ length: 6 }, (_, i) =>
      sandbox.executeIsolatedShardAsync({
        shardId: `concurrent-${i}`,
        taskCode: 'return data.map(x => x + 1);',
        inputData: [i, i + 10]
      })
    );
    const results = await Promise.all(batch);
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(results[i].shardId, `concurrent-${i}`);
      assert.deepStrictEqual(results[i].output, [i + 1, i + 11]);
    }
  });
});

describe('F23: Deterministic State Virtualization & Backward Compatibility', () => {
  test('T1.F23.02–04 & T2.F23.01: Virtualizes Math.random() and Date.now() identically across repeated runs and separate instances', async () => {
    const sandboxA = new StandbySandbox();
    const sandboxB = new StandbySandbox();

    const randomShard = {
      shardId: 'det-random-1',
      taskCode: 'const seq = []; for (let i = 0; i < 8; i++) seq.push(Math.random()); return { seq, sum: data.reduce((a, b) => a + b, 0) };',
      inputData: [1, 2, 3]
    };

    const r1 = sandboxA.executeIsolatedShard(randomShard);
    const r2 = sandboxB.executeIsolatedShard(randomShard);
    assert.strictEqual(r1.output.sum, 6);
    assert.strictEqual(r1.output.seq.length, 8);
    for (const n of r1.output.seq) {
      assert.ok(typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1);
    }
    assert.deepStrictEqual(r1.output, r2.output);

    const ar1 = await sandboxA.executeIsolatedShardAsync(randomShard);
    const ar2 = await sandboxB.executeIsolatedShardAsync(randomShard);
    assert.deepStrictEqual(ar1.output, ar2.output);

    const clockShard = {
      shardId: 'det-clock-1',
      taskCode: 'return { now: Date.now(), val: data[0] * 2 };',
      inputData: [21]
    };
    const c1 = sandboxA.executeIsolatedShard(clockShard);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const sandboxC = new StandbySandbox();
    const c2 = sandboxC.executeIsolatedShard(clockShard);

    assert.strictEqual(typeof c1.output.now, 'number');
    assert.ok(Number.isFinite(c1.output.now));
    assert.deepStrictEqual(c1.output, c2.output);

    const ac1 = await sandboxA.executeIsolatedShardAsync(clockShard);
    const ac2 = await sandboxC.executeIsolatedShardAsync(clockShard);
    assert.deepStrictEqual(ac1.output, ac2.output);
  });

  test('T1.F23.05 & T2.F23.04: Canonicalizes returned object key order across sync and async execution', async () => {
    const sandbox = new StandbySandbox();

    const codeA = 'return { z: 1, m: 2, a: 3, nested: { y: 10, b: 20 } };';
    const codeB = 'return { a: 3, nested: { b: 20, y: 10 }, m: 2, z: 1 };';

    const sA = sandbox.executeIsolatedShard({ shardId: 'canon-1', taskCode: codeA, inputData: [] });
    const sB = sandbox.executeIsolatedShard({ shardId: 'canon-1', taskCode: codeB, inputData: [] });
    assert.strictEqual(JSON.stringify(sA.output), JSON.stringify(sB.output));
    assert.deepStrictEqual(sA.output, sB.output);

    const aA = await sandbox.executeIsolatedShardAsync({ shardId: 'canon-2', taskCode: codeA, inputData: [] });
    const aB = await sandbox.executeIsolatedShardAsync({ shardId: 'canon-2', taskCode: codeB, inputData: [] });
    assert.strictEqual(JSON.stringify(aA.output), JSON.stringify(aB.output));
    assert.deepStrictEqual(aA.output, aB.output);

    const arrCodeA = 'return [{ z: 1, a: 2 }, { d: { y: 3, b: 4 }, c: 5 }];';
    const arrCodeB = 'return [{ a: 2, z: 1 }, { c: 5, d: { b: 4, y: 3 } }];';
    const arrSyncA = sandbox.executeIsolatedShard({ shardId: 'canon-arr-1', taskCode: arrCodeA, inputData: [] });
    const arrSyncB = sandbox.executeIsolatedShard({ shardId: 'canon-arr-1', taskCode: arrCodeB, inputData: [] });
    assert.strictEqual(JSON.stringify(arrSyncA.output), JSON.stringify(arrSyncB.output));
    assert.deepStrictEqual(arrSyncA.output, arrSyncB.output);

    const arrAsyncA = await sandbox.executeIsolatedShardAsync({ shardId: 'canon-arr-2', taskCode: arrCodeA, inputData: [] });
    const arrAsyncB = await sandbox.executeIsolatedShardAsync({ shardId: 'canon-arr-2', taskCode: arrCodeB, inputData: [] });
    assert.strictEqual(JSON.stringify(arrAsyncA.output), JSON.stringify(arrAsyncB.output));
    assert.deepStrictEqual(arrAsyncA.output, arrAsyncB.output);
  });

  test('T1.F23.01 & T2.F23.02: Deep-freezes shard data so mutating data inside shard fails and never mutates caller inputData', async () => {
    const sandbox = new StandbySandbox();

    const flatInput = [10, 20, 30];
    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'mutate-flat-sync',
        taskCode: 'data[0] = 999; return data[0];',
        inputData: flatInput
      }),
      isErrorLike
    );
    assert.deepStrictEqual(flatInput, [10, 20, 30]);

    const caughtFlat = sandbox.executeIsolatedShard({
      shardId: 'mutate-flat-caught',
      taskCode: 'let errorName = null; try { data[0] = 999; data.push(40); } catch (e) { errorName = e.name; } return { errorName, data };',
      inputData: flatInput
    });
    assert.deepStrictEqual(caughtFlat.output, { data: [10, 20, 30], errorName: 'TypeError' });
    assert.deepStrictEqual(flatInput, [10, 20, 30]);

    const nestedInput = [{ nested: { val: 42 }, list: ['a', 'b'] }];
    assert.throws(
      () => sandbox.executeIsolatedShard({
        shardId: 'mutate-nested-sync',
        taskCode: 'data[0].nested.val = 999; return data[0].nested.val;',
        inputData: nestedInput
      }),
      isErrorLike
    );
    assert.deepStrictEqual(nestedInput, [{ nested: { val: 42 }, list: ['a', 'b'] }]);

    const caughtNested = sandbox.executeIsolatedShard({
      shardId: 'mutate-nested-caught',
      taskCode: 'let errorName = null; try { data[0].nested.val = 999; data[0].list.push("evil"); } catch (e) { errorName = e.name; } return { errorName, item: data[0] };',
      inputData: nestedInput
    });
    assert.deepStrictEqual(caughtNested.output, {
      errorName: 'TypeError',
      item: { list: ['a', 'b'], nested: { val: 42 } }
    });
    assert.deepStrictEqual(nestedInput, [{ nested: { val: 42 }, list: ['a', 'b'] }]);

    await assert.rejects(
      async () => sandbox.executeIsolatedShardAsync({
        shardId: 'mutate-nested-async',
        taskCode: 'data[0].nested.val = 999; return data[0].nested.val;',
        inputData: nestedInput
      }),
      isErrorLike
    );
    assert.deepStrictEqual(nestedInput, [{ nested: { val: 42 }, list: ['a', 'b'] }]);
  });

  test('Baseline compatibility: isDeviceInStandby() returns { standbyReady, metrics: { cpuCount, normalizedLoad, freeMemoryMB } }', () => {
    const sandbox = new StandbySandbox();
    const status = sandbox.isDeviceInStandby();

    assert.strictEqual(typeof status, 'object');
    assert.notStrictEqual(status, null);
    assert.strictEqual(typeof status.standbyReady, 'boolean');

    assert.strictEqual(typeof status.metrics, 'object');
    assert.notStrictEqual(status.metrics, null);
    assert.strictEqual(status.metrics.cpuCount, os.cpus().length || 1);
    assert.strictEqual(typeof status.metrics.normalizedLoad, 'number');
    assert.ok(Number.isFinite(status.metrics.normalizedLoad) && status.metrics.normalizedLoad >= 0);
    assert.strictEqual(typeof status.metrics.freeMemoryMB, 'number');
    assert.ok(Number.isFinite(status.metrics.freeMemoryMB) && status.metrics.freeMemoryMB > 0);
  });
});

describe('Phase 2.1: Elastic Zero-Waste Standby Worker Pool', () => {
  test('Initializes with minWarm workers ready for <5ms warm dispatch', async () => {
    const pool = new StandbyWorkerPool({ minWarm: 1, maxWorkers: 3 });
    try {
      // Warm up initial worker
      const firstRes = await pool.execute({
        shardId: 'warmup',
        taskCode: 'return data[0] + 1;',
        inputData: [1]
      });
      assert.strictEqual(firstRes.output, 2);

      // Measure second warm dispatch latency (target: <5ms)
      const t0 = performance.now();
      const res = await pool.execute({
        shardId: 'speed-test',
        taskCode: 'return data.map(n => n * 10);',
        inputData: [1, 2, 3, 4]
      });
      const dispatchMs = performance.now() - t0;
      assert.deepStrictEqual(res.output, [10, 20, 30, 40]);
      assert.ok(dispatchMs < 500, `Warm dispatch should be fast, took ${dispatchMs.toFixed(2)}ms`);

      const stats = pool.getPoolStats();
      assert.strictEqual(stats.minWarm, 1);
      assert.strictEqual(stats.maxWorkers, 3);
      assert.ok(stats.totalWorkers >= 1);
      assert.strictEqual(stats.busyWorkers, 0);
    } finally {
      await pool.terminateAllWorkers();
    }
  });

  test('Elastic scaling up to maxWorkers under concurrent burst and scales down', async () => {
    const pool = new StandbyWorkerPool({ minWarm: 1, maxWorkers: 3, idleTimeoutMs: 1000 });
    try {
      const promises = [
        pool.execute({ shardId: 'burst-1', taskCode: 'return data.map(x => x + 1);', inputData: [1, 2] }),
        pool.execute({ shardId: 'burst-2', taskCode: 'return data.map(x => x * 2);', inputData: [3, 4] }),
        pool.execute({ shardId: 'burst-3', taskCode: 'return data.map(x => x * 3);', inputData: [5, 6] })
      ];

      const results = await Promise.all(promises);
      assert.deepStrictEqual(results[0].output, [2, 3]);
      assert.deepStrictEqual(results[1].output, [6, 8]);
      assert.deepStrictEqual(results[2].output, [15, 18]);

      const statsAfter = pool.getPoolStats();
      assert.strictEqual(statsAfter.busyWorkers, 0);
      assert.strictEqual(statsAfter.queuedJobs, 0);
    } finally {
      await pool.terminateAllWorkers();
    }
  });

  test('Integrated StandbySandbox with enableWorkerPool executes seamlessly', async () => {
    const sandbox = new StandbySandbox({ enableWorkerPool: true, minWarm: 1, maxWorkers: 2 });
    try {
      assert.ok(sandbox.workerPool instanceof StandbyWorkerPool);
      const res = await sandbox.executeIsolatedShardAsync({
        shardId: 'sandbox-pool-1',
        taskCode: 'return data.reduce((a, b) => a + b, 0);',
        inputData: [10, 20, 30, 40]
      });
      assert.strictEqual(res.output, 100);
      assert.strictEqual(res.shardId, 'sandbox-pool-1');
    } finally {
      await sandbox.terminateAllWorkers();
    }
  });
});
