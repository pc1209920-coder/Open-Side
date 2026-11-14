'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { OpenSideDaemon } = require('../src/daemon');

describe('Daemon Audit: Edge Cases, IPC, Signal & PID Handling', () => {
  const tmpDir = path.join(os.tmpdir(), `openside-daemon-audit-${Date.now()}`);

  test('PID file handling: detects active daemon and rejects duplicate start', async () => {
    const pidFile = path.join(tmpDir, `dup-${Date.now()}.pid`);
    // Write current process PID as simulating an already running daemon
    const pidDir = path.dirname(pidFile);
    if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true });

    // Write a dummy PID file pointing to current process (alive)
    const daemon1 = new OpenSideDaemon({ pidFile, silent: true, numWorkers: 1 });
    daemon1.writePid();
    assert.strictEqual(fs.existsSync(pidFile), true);

    // Another daemon instance with another PID shouldn't overwrite if alive
    // But since writePid checks process.kill(existingPid, 0)
    // and existingPid is process.pid, it skips throw on itself unless another PID.
    // If we write an alive PID different from process.pid (e.g. process.ppid):
    fs.writeFileSync(pidFile, String(process.ppid), 'utf8');
    const daemon2 = new OpenSideDaemon({ pidFile, silent: true, numWorkers: 1 });
    assert.throws(
      () => daemon2.writePid(),
      /OpenSideDaemon already running with PID/
    );

    // Stale PID test: write a nonexistent PID (e.g. 999999)
    fs.writeFileSync(pidFile, '999999', 'utf8');
    daemon2.writePid(); // should succeed and overwrite stale PID
    assert.strictEqual(fs.readFileSync(pidFile, 'utf8').trim(), String(process.pid));

    daemon2.removePid();
    assert.strictEqual(fs.existsSync(pidFile), false);
  });

  test('Logging safety: circular metadata and stream writing after end do not throw', async () => {
    const logFile = path.join(tmpDir, `log-test-${Date.now()}.log`);
    const daemon = new OpenSideDaemon({ logFile, silent: true, numWorkers: 1 });
    daemon._setupLogging();

    // Circular object in metadata
    const circular = { a: 1 };
    circular.self = circular;

    assert.doesNotThrow(() => {
      daemon.log('info', 'Circular meta log test', circular);
    });

    // Close log stream
    daemon.logStream.end();
    // Logging after stream end should not throw ERR_STREAM_WRITE_AFTER_END
    assert.doesNotThrow(() => {
      daemon.log('info', 'Post-end log message', { done: true });
    });
  });

  test('IPC task re-queuing: caller promise resolves when worker dies during execution', async () => {
    const pidFile = path.join(tmpDir, `requeue-${Date.now()}.pid`);
    const daemon = new OpenSideDaemon({
      numWorkers: 2,
      pidFile,
      silent: true,
      maxTaskRetries: 2
    });

    try {
      await daemon.start();
      await new Promise((r) => setTimeout(r, 400));

      // Dispatch a task that computes numbers
      const taskPromise = daemon.dispatchClusterTask(
        'let s = 0; for (let i = 0; i < 2e7; i++) s += (i % 2); return s;',
        null,
        { timeoutMs: 10000 }
      );

      // Kill the worker executing the task as soon as it becomes busy
      for (let i = 0; i < 50; i++) {
        let busyWorker = null;
        for (const [id, state] of daemon.workers.entries()) {
          if (state.busy && state.worker.process) {
            busyWorker = state.worker;
            break;
          }
        }
        if (busyWorker) {
          busyWorker.kill('SIGKILL');
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }

      // The task must be re-queued and completed by a replacement worker
      const result = await taskPromise;
      assert.strictEqual(typeof result.output, 'number');
      assert.strictEqual(result.output > 0, true);
    } finally {
      await daemon.stop('TEST_COMPLETE');
    }
  });

  test('Poisoned task abort: task exceeding maxTaskRetries rejects cleanly', async () => {
    const pidFile = path.join(tmpDir, `poison-${Date.now()}.pid`);
    const daemon = new OpenSideDaemon({
      numWorkers: 1,
      pidFile,
      silent: true,
      maxTaskRetries: 0 // abort immediately on first worker crash during task
    });

    try {
      await daemon.start();
      await new Promise((r) => setTimeout(r, 400));

      const taskPromise = daemon.dispatchClusterTask(
        'let s = 0; for (let i = 0; i < 2e8; i++) s += i; return s;',
        null,
        { timeoutMs: 25000 }
      );

      // Wait for worker to become busy with this task and kill it
      for (let i = 0; i < 100; i++) {
        let busyWorker = null;
        for (const [id, state] of daemon.workers.entries()) {
          if (state.busy && state.worker.process) {
            busyWorker = state.worker;
            break;
          }
        }
        if (busyWorker) {
          busyWorker.kill('SIGKILL');
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      await assert.rejects(
        () => taskPromise,
        /Task task-.* aborted: worker died repeatedly/
      );
    } finally {
      await daemon.stop('TEST_COMPLETE');
    }
  });

  test('Input validation on dispatchClusterTask', async () => {
    const daemon = new OpenSideDaemon({ silent: true, numWorkers: 1 });
    // Not running
    await assert.rejects(
      () => daemon.dispatchClusterTask('return 1;', null),
      /OpenSideDaemon is not running/
    );

    await daemon.start();
    try {
      // Invalid taskCode
      await assert.rejects(
        () => daemon.dispatchClusterTask('', null),
        /taskCode must be a non-empty string/
      );
      await assert.rejects(
        () => daemon.dispatchClusterTask(123, null),
        /taskCode must be a non-empty string/
      );
    } finally {
      await daemon.stop();
    }
  });
});
