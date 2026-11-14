'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { OpenSideDaemon } = require('../src/daemon');
const { GridRouter } = require('../src/router');

function makeCpuSnap(timesArray) {
  return timesArray.map((t) => ({
    model: 'Intel(R) Core(TM) i9',
    speed: 3000,
    times: {
      user: t.user !== undefined ? t.user : 0,
      nice: t.nice !== undefined ? t.nice : 0,
      sys: t.sys !== undefined ? t.sys : 0,
      idle: t.idle !== undefined ? t.idle : 0,
      irq: t.irq !== undefined ? t.irq : 0
    }
  }));
}

function createMockOs(cpuSnapshots, freeMemVal = 500, totalMemVal = 1000) {
  let callIdx = 0;
  return {
    cpus: () => {
      const snap = cpuSnapshots[Math.min(callIdx, cpuSnapshots.length - 1)];
      callIdx++;
      return snap;
    },
    freemem: () => (typeof freeMemVal === 'function' ? freeMemVal() : freeMemVal),
    totalmem: () => (typeof totalMemVal === 'function' ? totalMemVal() : totalMemVal)
  };
}

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

  test('PID file handling: does not unlink PID file if owned by another process', () => {
    const foreignPidPath = path.join(tmpDir, 'foreign.pid');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(foreignPidPath, '9999999\n', 'utf8');

    const daemon = new OpenSideDaemon({
      pidFile: foreignPidPath,
      silent: true
    });

    try {
      daemon.removePid();
      assert.strictEqual(fs.existsSync(foreignPidPath), true);
    } finally {
      try { fs.unlinkSync(foreignPidPath); } catch {}
    }
  });

  test('Daemon cluster task execution error propagation and rejection', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 1,
      pidFile: path.join(os.tmpdir(), `daemon-err-${Date.now()}.pid`),
      silent: true
    });

    try {
      await daemon.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      await assert.rejects(
        () => daemon.dispatchClusterTask('throw new Error("Simulated worker error");', {}),
        /Simulated worker error/
      );
    } finally {
      await daemon.stop('TEST_COMPLETE');
    }
  });

  test('Daemon cluster task execution timeout enforces bounded execution', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 1,
      pidFile: path.join(os.tmpdir(), `daemon-timeout-${Date.now()}.pid`),
      silent: true
    });

    try {
      await daemon.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      await assert.rejects(
        () => daemon.dispatchClusterTask('while(true) {}', {}, { timeoutMs: 300 }),
        /timed out/i
      );
    } finally {
      await daemon.stop('TEST_COMPLETE');
    }
  });

  test('Crash recovery: In-flight task is re-queued and completed when worker dies during execution', async () => {
    const daemon = new OpenSideDaemon({
      numWorkers: 1,
      pidFile: path.join(os.tmpdir(), `daemon-inflight-${Date.now()}.pid`),
      silent: true
    });

    try {
      await daemon.start();
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Dispatch a task that takes long enough to simulate death in-flight
      const taskPromise = daemon.dispatchClusterTask(
        'let s = 0; for (let i = 0; i < 2e7; i++) s += (i % 2); return data * 3;',
        14,
        { timeoutMs: 10000 }
      );

      // Wait until worker picks up the task and becomes busy before killing
      for (let i = 0; i < 50; i++) {
        let busy = false;
        for (const [id, state] of daemon.workers.entries()) {
          if (state.busy && state.worker.process) {
            busy = true;
            try {
              process.kill(state.worker.process.pid);
            } catch {}
            break;
          }
        }
        if (busy) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const res = await taskPromise;
      assert.strictEqual(res.output, 42);
    } finally {
      await daemon.stop('TEST_COMPLETE');
    }
  });

  test('Milestone 3 Telemetry: Real OS and mock multi-core CPU delta sampling, 0-delta, negative clamping, and cache TTL', () => {
    const router = new GridRouter('m3-telemetry-node');
    const realTel = router.getHardwareTelemetry();
    assert.strictEqual(typeof realTel.cpuLoad, 'number');
    assert.ok(realTel.cpuLoad >= 0.0 && realTel.cpuLoad <= 1.0);
    assert.strictEqual(realTel.cpuCount, os.cpus().length);
    assert.ok(realTel.freeMemBytes > 0 && realTel.totalMemBytes > 0);

    // Rapid successive sampling within cache TTL returns cached result
    const telCached1 = router.getHardwareTelemetry();
    const telCached2 = router.getHardwareTelemetry();
    assert.strictEqual(telCached1.timestamp, telCached2.timestamp);

    // 0-delta preserves last valid reading without division by zero NaN
    const snapA = makeCpuSnap([{ user: 1000, sys: 0, idle: 9000 }]);
    const snapB = makeCpuSnap([{ user: 1500, sys: 0, idle: 9500 }]); // 50% load: deltaBusy=500, deltaTotal=1000
    const rMock = new GridRouter('r-mock', { os: createMockOs([snapA, snapB, snapB], 500, 1000) });
    rMock.getHardwareTelemetry(); // First sample captures baseline snapA
    const telB = rMock.getHardwareTelemetry(); // Second sample computes delta against snapB (50%)
    assert.ok(Math.abs(telB.cpuLoad - 0.5) < 1e-4);
    const telZeroDelta = rMock.getHardwareTelemetry(); // Third sample tests 0-delta against snapB
    assert.ok(Math.abs(telZeroDelta.cpuLoad - 0.5) < 1e-4);

    // Negative tick delta clamped safely to 0.0
    const negSnap1 = makeCpuSnap([{ user: 2000, sys: 0, idle: 8000 }]);
    const negSnap2 = makeCpuSnap([{ user: 1000, sys: 0, idle: 5000 }]);
    const rNeg = new GridRouter('r-neg', { os: createMockOs([negSnap1, negSnap2], 500, 1000) });
    assert.strictEqual(rNeg.getHardwareTelemetry().cpuLoad, 0.0);
  });

  test('Milestone 3 Load Shedding: Strict 25% CPU ceiling, 10% memory floor, Schmitt trigger hysteresis, and fail-closed evaluation', () => {
    let currentCpu = 0.15;
    let currentFree = 500;
    const totalMem = 1000;
    let userTicks = 0;
    let idleTicks = 0;

    const mockOs = {
      cpus() {
        const delta = 10000;
        const busy = Math.round(delta * currentCpu);
        const idle = delta - busy;
        userTicks += busy;
        idleTicks += idle;
        return makeCpuSnap([{ user: userTicks, sys: 0, idle: idleTicks }]);
      },
      freemem: () => currentFree,
      totalmem: () => totalMem
    };

    const router = new GridRouter('m3-shed-node', { os: mockOs });
    const events = [];
    router.on('loadShed', (t) => events.push(['shed', t.loadShedState]));
    router.on('telemetryRecovered', (t) => events.push(['recovered', t.loadShedState]));

    // 15% CPU nominal
    const tNominal = router.getHardwareTelemetry();
    assert.strictEqual(tNominal.standbyReady, true);
    assert.strictEqual(tNominal.loadShedState, 'NOMINAL');

    // > 25% CPU triggers load shed
    currentCpu = 0.28;
    const tOverload = router.getHardwareTelemetry();
    assert.strictEqual(tOverload.standbyReady, false);
    assert.strictEqual(tOverload.loadShedState, 'CPU_OVERLOAD');

    // Hysteresis prevents thrashing: 24% load keeps load shed active until cooling below margin (22%) or 2 consecutive healthy samples
    currentCpu = 0.24;
    assert.strictEqual(router.getHardwareTelemetry().standbyReady, false);
    // 2nd consecutive sample below 25% recovers
    assert.strictEqual(router.getHardwareTelemetry().standbyReady, true);

    // Memory drops below 10% (80 / 1000 = 8%) triggers MEMORY_EXHAUSTED
    currentFree = 80;
    const tMemLow = router.getHardwareTelemetry();
    assert.strictEqual(tMemLow.standbyReady, false);
    assert.strictEqual(tMemLow.loadShedState, 'MEMORY_EXHAUSTED');

    // Recovery above 10% (250 / 1000 = 25%)
    currentFree = 250;
    const tMemRecovered = router.getHardwareTelemetry();
    assert.strictEqual(tMemRecovered.standbyReady, true);
    assert.strictEqual(tMemRecovered.loadShedState, 'NOMINAL');

    // Stateless evaluateTelemetry fails-closed on invalid metrics
    assert.strictEqual(router.evaluateTelemetry(null).standbyReady, false);
    assert.strictEqual(router.evaluateTelemetry({ cpuLoad: NaN, freeMemRatio: 0.5 }).standbyReady, false);
    assert.strictEqual(router.evaluateTelemetry({ cpuLoad: 0.20, freeMemRatio: 0.05 }).standbyReady, false);
    assert.strictEqual(router.evaluateTelemetry({ cpuLoad: 0.20, freeMemRatio: 0.50 }).standbyReady, true);
  });
});
