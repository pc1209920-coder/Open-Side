'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { OpenSideDaemon } = require('../src/daemon');

describe('Milestone 3: Headless Daemon & Multi-Process Cluster Orchestrator', () => {
  const tmpDir = path.join(os.tmpdir(), `openside-daemon-test-${Date.now()}`);
  const pidFile = path.join(tmpDir, 'test-daemon.pid');
  const logFile = path.join(tmpDir, 'test-daemon.log');

  test('Daemon writes and removes PID file atomically and formats rotating log stream', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 1,
      pidFile,
      logFile,
      silent: true
    });

    try {
      daemon.writePid();
      assert.strictEqual(fs.existsSync(pidFile), true);
      const storedPid = fs.readFileSync(pidFile, 'utf8').trim();
      assert.strictEqual(storedPid, String(process.pid));

      daemon._setupLogging();
      daemon.log('info', 'Unit test log message', { key: 'val' });

      // Allow write stream to flush
      if (daemon.logStream) {
        await new Promise((resolve) => daemon.logStream.write('', resolve));
      }

      // Check log output
      assert.strictEqual(fs.existsSync(logFile), true);
      const logContent = fs.readFileSync(logFile, 'utf8');
      assert.match(logContent, /\[INFO\]/);
      assert.match(logContent, /Unit test log message/);
      assert.match(logContent, /"key":"val"/);
    } finally {
      daemon.removePid();
      if (daemon.logStream && !daemon.logStream.destroyed) {
        daemon.logStream.end();
      }
      assert.strictEqual(fs.existsSync(pidFile), false);
    }
  });

  test('Daemon master initialization, multi-core worker fork, and status inspection', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 2,
      pidFile: path.join(os.tmpdir(), `daemon-pid-${Date.now()}.pid`),
      silent: true
    });

    try {
      await daemon.start();
      assert.strictEqual(daemon.running, true);
      assert.strictEqual(daemon.isMaster, true);
      assert.strictEqual(daemon.workers.size, 2);

      const status = daemon.getStatus();
      assert.strictEqual(status.running, true);
      assert.strictEqual(status.isMaster, true);
      assert.strictEqual(status.numWorkers, 2);
      assert.strictEqual(status.workers.length, 2);
    } finally {
      await daemon.stop('TEST_COMPLETE');
      assert.strictEqual(daemon.running, false);
      assert.strictEqual(daemon.workers.size, 0);
    }
  });

  test('Multi-core cluster task dispatching across parallel workers', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 2,
      pidFile: path.join(os.tmpdir(), `daemon-dispatch-${Date.now()}.pid`),
      silent: true
    });

    try {
      await daemon.start();

      // Wait a moment for workers to report ready
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Dispatch 4 concurrent tasks across the 2-worker cluster
      const tasks = [
        daemon.dispatchClusterTask('return data.map(x => x * 2);', [1, 2, 3]),
        daemon.dispatchClusterTask('return data.reduce((a, b) => a + b, 0);', [10, 20, 30]),
        daemon.dispatchClusterTask('return data.filter(x => x % 2 === 0);', [1, 2, 3, 4, 5, 6]),
        daemon.dispatchClusterTask('return data.toUpperCase();', 'hello open-side')
      ];

      const results = await Promise.all(tasks);
      assert.deepStrictEqual(results[0].output, [2, 4, 6]);
      assert.strictEqual(results[1].output, 60);
      assert.deepStrictEqual(results[2].output, [2, 4, 6]);
      assert.strictEqual(results[3].output, 'HELLO OPEN-SIDE');

      // Check tasks completed metric
      const status = daemon.getStatus();
      const totalCompleted = status.workers.reduce((acc, w) => acc + w.tasksCompleted, 0);
      assert.strictEqual(totalCompleted, 4);
    } finally {
      await daemon.stop('TEST_COMPLETE');
    }
  });

  test('Crash recovery: Self-healing worker replacement when a worker dies', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 2,
      pidFile: path.join(os.tmpdir(), `daemon-heal-${Date.now()}.pid`),
      silent: true
    });

    try {
      await daemon.start();
      assert.strictEqual(daemon.workers.size, 2);

      // Wait for workers to be ready
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Find first worker and terminate it
      const [firstWorkerId, firstState] = Array.from(daemon.workers.entries())[0];
      const deadPromise = new Promise((resolve) => daemon.once('workerDied', resolve));

      // Force kill worker process
      firstState.worker.kill('SIGKILL');
      const deadInfo = await deadPromise;
      assert.strictEqual(deadInfo.id, firstWorkerId);

      // Wait a moment for replacement to fork and initialize
      await new Promise((resolve) => setTimeout(resolve, 600));

      assert.strictEqual(daemon.workers.size, 2);
      // New worker must be able to execute tasks
      const res = await daemon.dispatchClusterTask('return data + 100;', 42);
      assert.strictEqual(res.output, 142);
    } finally {
      await daemon.stop('TEST_COMPLETE');
    }
  });

  test('Graceful teardown drains queue and rejects new submissions', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 1,
      pidFile: path.join(os.tmpdir(), `daemon-drain-${Date.now()}.pid`),
      silent: true
    });

    try {
      await daemon.start();
      await daemon.stop('SIGTERM');

      // Submission after stop must reject
      await assert.rejects(
        () => daemon.dispatchClusterTask('return 1;', null),
        /OpenSideDaemon is not running/
      );
    } finally {
      if (daemon.running) await daemon.stop();
    }
  });
});
