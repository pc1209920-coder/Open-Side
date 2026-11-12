'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

test('A1/A2 Security: Microtasks cannot escape vm timeout or hang process', () => {
  const code = `
    const { StandbySandbox } = require('./src/sandbox');
    const s = new StandbySandbox({ maxExecutionMs: 100 });
    try {
      s.executeIsolatedShard({
        shardId: 'repro-a1',
        taskCode: "Promise.resolve().then(() => { while (true) {} }); return 'x';",
        inputData: null
      });
      console.log('UNEXPECTED_SUCCESS');
    } catch (err) {
      if (/timed out|timeout/i.test(err.message)) {
        console.log('TIMED_OUT_SAFELY');
      } else {
        console.log('OTHER_ERROR:' + err.message);
      }
    }
  `;

  const child = spawnSync(process.execPath, ['-e', code], {
    timeout: 5000,
    encoding: 'utf8'
  });

  assert.strictEqual(child.status, 0, 'Child process should exit cleanly');
  assert.ok(
    child.stdout.includes('TIMED_OUT_SAFELY'),
    `Expected TIMED_OUT_SAFELY, got: ${child.stdout} (stderr: ${child.stderr})`
  );
});
