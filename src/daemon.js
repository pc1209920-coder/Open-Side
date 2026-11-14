'use strict';

const cluster = require('node:cluster');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { ComputeSea } = require('./index');
const { StandbySandbox } = require('./sandbox');
const { OpenSideGateway } = require('./gateway');

/**
 * OpenSideDaemon - Headless service & multi-process cluster orchestrator
 */
class OpenSideDaemon extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.isMaster = cluster.isPrimary !== undefined ? cluster.isPrimary : cluster.isMaster;
    this.numWorkers = options.numWorkers || Math.max(1, os.cpus().length);
    this.pidFile = options.pidFile || path.resolve(process.cwd(), 'open-side-daemon.pid');
    this.logFile = options.logFile || null;
    this.logStream = null;

    this.workers = new Map(); // workerId -> { worker, busy, activeTasks }
    this.taskQueue = [];
    this.pendingTasks = new Map(); // taskId -> { resolve, reject, timeoutTimer }
    this.taskSeq = 0;

    this.running = false;
    this.stopping = false;
    this.sea = null;
    this.gateway = null;
    this._exitHandler = null;
    this._processExitHook = null;
    this._crashTimestamps = [];

    // Configure cluster entry point to point directly to daemon.js
    if (this.isMaster) {
      const setup = cluster.setupPrimary || cluster.setupMaster;
      if (typeof setup === 'function') {
        setup({
          exec: path.resolve(__dirname, 'daemon.js')
        });
      }
    }
  }

  /**
   * Initializes logging stream if configured.
   */
  _setupLogging() {
    if (this.logFile) {
      const logDir = path.dirname(this.logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
      this.logStream.on('error', (err) => {
        if (!this.options.silent) {
          console.error(`[LOG_STREAM_ERROR] ${err.message}`);
        }
      });
    }
  }

  /**
   * Formats and writes log entry to file and console.
   */
  log(level, message, meta = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [PID:${process.pid}]`;
    let metaStr = '';
    if (meta !== null && meta !== undefined) {
      try {
        metaStr = ' ' + JSON.stringify(meta);
      } catch (err) {
        metaStr = ` [SerializationError: ${err.message}]`;
      }
    }
    const line = `${prefix} ${message}${metaStr}`;

    if (this.logStream && !this.logStream.destroyed && !this.logStream.writableEnded) {
      try {
        this.logStream.write(line + '\n');
      } catch {}
    }
    if (!this.options.silent) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    try {
      this.emit('log', { timestamp, level, message, meta });
    } catch {}
  }

  /**
   * Writes the PID file atomically.
   */
  writePid() {
    try {
      const pidDir = path.dirname(this.pidFile);
      if (!fs.existsSync(pidDir)) {
        fs.mkdirSync(pidDir, { recursive: true });
      }

      // Check if existing daemon is alive
      if (fs.existsSync(this.pidFile)) {
        try {
          const stored = fs.readFileSync(this.pidFile, 'utf8').trim();
          const existingPid = parseInt(stored, 10);
          if (!isNaN(existingPid) && existingPid !== process.pid) {
            let isAlive = false;
            try {
              process.kill(existingPid, 0);
              isAlive = true;
            } catch (kErr) {
              if (kErr.code === 'EPERM') {
                isAlive = true;
              }
            }
            if (isAlive) {
              throw new Error(`OpenSideDaemon already running with PID ${existingPid}`);
            } else {
              this.log('warn', `Removing stale PID file (${this.pidFile}) for dead PID ${existingPid}`);
            }
          }
        } catch (readErr) {
          if (readErr.message && readErr.message.includes('already running')) {
            throw readErr;
          }
        }
      }

      // Write atomically via temporary file and rename
      const tempPidFile = `${this.pidFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPidFile, String(process.pid), 'utf8');
      try {
        fs.renameSync(tempPidFile, this.pidFile);
      } catch {
        fs.writeFileSync(this.pidFile, String(process.pid), 'utf8');
        try { fs.unlinkSync(tempPidFile); } catch {}
      }

      this.log('info', `PID ${process.pid} written to ${this.pidFile}`);
    } catch (err) {
      this.log('error', `Failed to write PID file: ${err.message}`);
      throw err;
    }
  }

  /**
   * Removes the PID file on shutdown.
   */
  removePid() {
    try {
      if (fs.existsSync(this.pidFile)) {
        const storedPid = fs.readFileSync(this.pidFile, 'utf8').trim();
        if (storedPid === String(process.pid)) {
          fs.unlinkSync(this.pidFile);
          this.log('info', `Removed PID file ${this.pidFile}`);
        }
      }
    } catch (err) {
      this.log('warn', `Could not remove PID file: ${err.message}`);
    }
  }

  /**
   * Starts the daemon in master or worker cluster mode.
   */
  async start() {
    if (this.running) {
      return this;
    }
    this._setupLogging();

    if (this.isMaster) {
      return this._startMaster();
    } else {
      return this._startWorker();
    }
  }

  /**
   * Master cluster orchestrator routine.
   */
  async _startMaster() {
    this.running = true;
    this.writePid();
    this.log('info', `Starting OpenSideDaemon Master across ${this.numWorkers} CPU core workers...`);

    // Ensure PID file is removed on unexpected process exit
    this._processExitHook = () => {
      this.removePid();
    };
    process.on('exit', this._processExitHook);

    // Setup OS signal listeners for graceful shutdown
    this._bindSignals();

    // Spawn cluster workers
    for (let i = 0; i < this.numWorkers; i++) {
      this._forkWorker();
    }

    try {
      // Initialize coordinator ComputeSea & HTTP Gateway if enabled
      if (this.options.enableGateway) {
        this.sea = new ComputeSea({
          coordinatorId: `daemon-coord-${process.pid}`,
          enforceEscrow: true
        });
        this.gateway = new OpenSideGateway({
          sea: this.sea,
          port: this.options.gatewayPort || 8080,
          enableCluster: true
        });
        await this.gateway.listen();
        this.log('info', `Daemon Gateway listening on port ${this.gateway.port}`);
      }
    } catch (err) {
      this.log('error', `Failed to initialize daemon gateway: ${err.message}`);
      await this.stop('STARTUP_ERROR');
      throw err;
    }

    this.emit('started', { mode: 'master', pid: process.pid, workers: this.workers.size });
    return this;
  }

  /**
   * Spawns a single cluster worker and wires IPC communication.
   */
  _forkWorker() {
    if (this.stopping) return null;

    const worker = cluster.fork({
      OPEN_SIDE_DAEMON_WORKER: 'true',
      OPEN_SIDE_MASTER_PID: String(process.pid)
    });

    const workerState = {
      worker,
      id: worker.id,
      pid: worker.process ? worker.process.pid : null,
      busy: false,
      activeTaskId: null,
      tasksCompleted: 0
    };

    this.workers.set(worker.id, workerState);
    this.log('info', `Spawned cluster worker #${worker.id} (PID:${workerState.pid})`);

    worker.on('error', (err) => {
      this.log('error', `Worker #${worker.id} process error: ${err.message}`);
    });

    worker.on('message', (msg) => {
      this._handleWorkerMessage(worker.id, msg);
    });

    worker.on('exit', (code, signal) => {
      this.log('warn', `Worker #${worker.id} died (code: ${code}, signal: ${signal})`);
      const state = this.workers.get(worker.id);
      if (state && state.activeTaskId) {
        // Re-queue or fail in-flight task
        const pending = this.pendingTasks.get(state.activeTaskId);
        if (pending) {
          const retries = (pending.task.retries || 0) + 1;
          pending.task.retries = retries;
          const maxRetries = this.options.maxTaskRetries !== undefined ? this.options.maxTaskRetries : 2;
          if (retries <= maxRetries) {
            this.log('warn', `Re-queueing interrupted task ${state.activeTaskId} from dead worker #${worker.id} (attempt ${retries}/${maxRetries})`);
            this.taskQueue.unshift(pending.task);
          } else {
            this.log('error', `Task ${state.activeTaskId} exceeded max retries (${maxRetries}) after worker #${worker.id} died`);
            clearTimeout(pending.timeoutTimer);
            this.pendingTasks.delete(state.activeTaskId);
            pending.reject(new Error(`Task ${state.activeTaskId} aborted: worker died repeatedly (${retries} attempts)`));
          }
        }
      }
      this.workers.delete(worker.id);
      this.emit('workerDied', { id: worker.id, code, signal });

      // Auto-restart replacement worker if daemon is still running
      if (this.running && !this.stopping) {
        const now = Date.now();
        this._crashTimestamps = (this._crashTimestamps || []).filter(t => now - t < 10000);
        this._crashTimestamps.push(now);
        const maxCrashesInWindow = Math.max(10, this.numWorkers * 3);

        if (this._crashTimestamps.length > maxCrashesInWindow) {
          this.log('error', `Worker crash storm detected (${this._crashTimestamps.length} crashes in 10s). Suspending auto-restart to prevent resource exhaustion.`);
          this.emit('crashStorm', { crashes: this._crashTimestamps.length });
        } else {
          this.log('info', `Self-healing: restarting replacement worker for #${worker.id}...`);
          this._forkWorker();
          this._drainQueue();
        }
      }
    });

    return worker;
  }

  /**
   * Handles incoming IPC messages from cluster workers.
   */
  _handleWorkerMessage(workerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    const state = this.workers.get(workerId);
    if (!state) return;

    if (msg.type === 'READY') {
      state.busy = false;
      this._drainQueue();
      return;
    }

    if (msg.type === 'TASK_RESULT') {
      const { taskId, success, output, error, executionTimeMs } = msg;
      state.busy = false;
      state.activeTaskId = null;
      state.tasksCompleted += 1;

      const pending = this.pendingTasks.get(taskId);
      if (pending) {
        clearTimeout(pending.timeoutTimer);
        this.pendingTasks.delete(taskId);
        if (success) {
          pending.resolve({ output, executionTimeMs, workerId });
        } else {
          pending.reject(new Error(error || 'Worker execution failed'));
        }
      }

      this._drainQueue();
    }
  }

  /**
   * Dispatches tasks to available idle cluster workers.
   */
  _drainQueue() {
    if (this.taskQueue.length === 0) return;

    for (const [workerId, state] of this.workers.entries()) {
      if (this.taskQueue.length === 0) break;
      if (!state.busy && state.worker.isConnected()) {
        const item = this.taskQueue.shift();
        state.busy = true;
        state.activeTaskId = item.taskId;
        this.emit('taskDispatched', { workerId, taskId: item.taskId });

        try {
          state.worker.send({
            type: 'EXECUTE_TASK',
            taskId: item.taskId,
            taskCode: item.taskCode,
            inputData: item.inputData,
            timeoutMs: item.timeoutMs,
            memoryLimitMb: item.memoryLimitMb
          }, (err) => {
            if (err) {
              this.log('error', `Failed to deliver task ${item.taskId} to worker #${workerId}: ${err.message}`);
              state.busy = false;
              state.activeTaskId = null;
              if (this.pendingTasks.has(item.taskId)) {
                this.taskQueue.unshift(item);
                this._drainQueue();
              }
            }
          });
        } catch (sendErr) {
          this.log('error', `Exception sending task ${item.taskId} to worker #${workerId}: ${sendErr.message}`);
          state.busy = false;
          state.activeTaskId = null;
          this.taskQueue.unshift(item);
        }
      }
    }
  }

  /**
   * Submits a compute task across the multi-core cluster.
   */
  dispatchClusterTask(taskCode, inputData, options = {}) {
    if (!this.running || this.stopping) {
      return Promise.reject(new Error('OpenSideDaemon is not running'));
    }
    if (!this.isMaster) {
      return Promise.reject(new Error('dispatchClusterTask can only be executed on daemon master'));
    }
    if (typeof taskCode !== 'string' || taskCode.trim().length === 0) {
      return Promise.reject(new TypeError('taskCode must be a non-empty string'));
    }
    if (this.options.maxQueueSize && this.taskQueue.length >= this.options.maxQueueSize) {
      return Promise.reject(new Error(`Daemon task queue full (${this.taskQueue.length} items)`));
    }

    this.taskSeq += 1;
    const taskId = `task-${process.pid}-${Date.now()}-${this.taskSeq}`;
    const timeoutMs = options.timeoutMs || 15000;

    return new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        reject(new Error(`Cluster task ${taskId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timeoutTimer.unref) timeoutTimer.unref();

      const taskItem = {
        taskId,
        taskCode,
        inputData,
        timeoutMs,
        memoryLimitMb: options.memoryLimitMb || 64
      };

      this.pendingTasks.set(taskId, {
        task: taskItem,
        resolve,
        reject,
        timeoutTimer
      });

      this.taskQueue.push(taskItem);
      this._drainQueue();
    });
  }

  /**
   * Safely transmits IPC payload from worker to master.
   */
  _safeWorkerSend(payload) {
    if (process.send && process.connected !== false) {
      try {
        process.send(payload);
      } catch (err) {
        if (payload && payload.type === 'TASK_RESULT' && payload.success) {
          try {
            process.send({
              type: 'TASK_RESULT',
              taskId: payload.taskId,
              success: false,
              error: `IPC serialization error: ${err.message}`,
              executionTimeMs: payload.executionTimeMs
            });
          } catch {}
        }
      }
    }
  }

  /**
   * Worker process initialization routine.
   */
  async _startWorker() {
    this.running = true;
    const sandbox = new StandbySandbox({
      maxExecutionMs: 15000,
      maxMemoryMb: 64,
      enableWorkerPool: true
    });

    let cleanedUp = false;
    const cleanupWorker = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        if (sandbox && typeof sandbox.terminateAllWorkers === 'function') {
          await sandbox.terminateAllWorkers();
        }
      } catch {}
      process.exit(0);
    };

    // Clean up worker threads and prevent orphan processes if master disconnects
    process.on('disconnect', cleanupWorker);
    process.on('SIGTERM', cleanupWorker);
    process.on('SIGINT', cleanupWorker);

    process.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'SHUTDOWN') {
        await cleanupWorker();
        return;
      }

      if (msg.type === 'EXECUTE_TASK') {
        const { taskId, taskCode, inputData, timeoutMs, memoryLimitMb } = msg;
        const t0 = performance.now();
        try {
          const res = await sandbox.executeIsolatedShardAsync(
            { shardId: taskId, taskCode, inputData },
            { timeoutMs: timeoutMs || 15000, memoryLimitMb: memoryLimitMb || 64 }
          );
          const executionTimeMs = performance.now() - t0;
          this._safeWorkerSend({
            type: 'TASK_RESULT',
            taskId,
            success: true,
            output: res.output,
            executionTimeMs
          });
        } catch (err) {
          const executionTimeMs = performance.now() - t0;
          this._safeWorkerSend({
            type: 'TASK_RESULT',
            taskId,
            success: false,
            error: err.message,
            executionTimeMs
          });
        }
      }
    });

    // Notify master that this worker is ready for computation
    this._safeWorkerSend({
      type: 'READY',
      workerId: cluster.worker ? cluster.worker.id : null,
      pid: process.pid
    });

    this.emit('started', { mode: 'worker', pid: process.pid });
    return this;
  }

  /**
   * Wires graceful signal handlers.
   */
  _bindSignals() {
    let teardownInitiated = false;
    const handleSignal = (sig) => {
      if (teardownInitiated) {
        this.log('warn', `Received secondary signal ${sig}, forcing immediate exit`);
        process.exit(1);
      }
      teardownInitiated = true;
      this.log('info', `Received signal ${sig}, initiating graceful teardown...`);

      this.stop(sig).then(() => {
        if (require.main === module || this.options.exitOnSignal) {
          process.exit(0);
        }
      }).catch((err) => {
        this.log('error', `Error during graceful shutdown: ${err.message}`);
        process.exit(1);
      });
    };

    this._exitHandler = handleSignal;
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    if (process.platform === 'win32') {
      process.once('SIGBREAK', handleSignal);
    } else {
      process.once('SIGHUP', handleSignal);
    }
  }

  /**
   * Shuts down the daemon, stops workers, drains queues, and removes PID.
   */
  async stop(reason = 'NORMAL') {
    if (this.stopping) return;
    this.stopping = true;
    this.log('info', `Stopping OpenSideDaemon (${reason})...`);

    // Clean signal listeners
    if (this._exitHandler) {
      process.removeListener('SIGINT', this._exitHandler);
      process.removeListener('SIGTERM', this._exitHandler);
      if (process.platform === 'win32') {
        process.removeListener('SIGBREAK', this._exitHandler);
      } else {
        process.removeListener('SIGHUP', this._exitHandler);
      }
      this._exitHandler = null;
    }

    // Clean process exit hook
    if (this._processExitHook) {
      process.removeListener('exit', this._processExitHook);
      this._processExitHook = null;
    }

    // Close HTTP gateway if running
    if (this.gateway) {
      try {
        await this.gateway.close();
      } catch (err) {
        this.log('warn', `Error closing gateway: ${err.message}`);
      }
    }

    // Close ComputeSea if running
    if (this.sea) {
      try {
        await this.sea.close();
      } catch (err) {
        this.log('warn', `Error closing sea: ${err.message}`);
      }
    }

    // Reject remaining pending tasks
    for (const [taskId, pending] of this.pendingTasks.entries()) {
      clearTimeout(pending.timeoutTimer);
      pending.reject(new Error(`Daemon stopping (${reason})`));
    }
    this.pendingTasks.clear();
    this.taskQueue.length = 0;

    // Terminate all cluster workers gracefully
    if (this.isMaster) {
      const workerPromises = [];
      for (const [id, state] of this.workers.entries()) {
        workerPromises.push(new Promise((resolve) => {
          if (!state.worker.isDead()) {
            state.worker.once('disconnect', () => resolve());
            state.worker.once('exit', () => resolve());
            try {
              if (state.worker.isConnected()) {
                state.worker.send({ type: 'SHUTDOWN' });
                state.worker.disconnect();
              } else {
                state.worker.kill('SIGTERM');
              }
            } catch {
              try { state.worker.kill(); } catch {}
              resolve();
            }
          } else {
            resolve();
          }
        }));
      }

      await Promise.race([
        Promise.all(workerPromises),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);

      // Force kill any stubborn workers
      for (const [id, state] of this.workers.entries()) {
        try {
          if (!state.worker.isDead()) state.worker.kill('SIGKILL');
        } catch {}
      }
      this.workers.clear();

      this.removePid();
    }

    this.running = false;
    this.emit('stopped', { reason });
    this.log('info', 'OpenSideDaemon stopped cleanly.');

    if (this.logStream && !this.logStream.destroyed && !this.logStream.writableEnded) {
      this.logStream.end();
    }
  }

  /**
   * Retrieves status summary of daemon and cluster.
   */
  getStatus() {
    let activeTasks = 0;
    const workerStats = [];
    for (const [id, state] of this.workers.entries()) {
      if (state.busy) activeTasks += 1;
      workerStats.push({
        id,
        pid: state.pid,
        busy: state.busy,
        tasksCompleted: state.tasksCompleted
      });
    }

    return {
      running: this.running,
      pid: process.pid,
      isMaster: this.isMaster,
      numWorkers: this.workers.size,
      queuedTasks: this.taskQueue.length,
      activeTasks,
      workers: workerStats
    };
  }
}

// Cluster worker entrypoint logic when spawned via cluster.fork
if (cluster.isWorker) {
  const daemon = new OpenSideDaemon();
  daemon.start().catch((err) => {
    console.error(`Worker ${process.pid} startup failed:`, err);
    process.exit(1);
  });
} else if (require.main === module) {
  // Standalone CLI execution
  const daemon = new OpenSideDaemon({
    enableGateway: true,
    gatewayPort: process.env.PORT ? parseInt(process.env.PORT, 10) : 8080,
    logFile: path.resolve(process.cwd(), 'daemon.log')
  });

  daemon.start().catch((err) => {
    console.error('Fatal daemon startup error:', err);
    process.exit(1);
  });
}

module.exports = { OpenSideDaemon };
