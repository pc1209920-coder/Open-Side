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
    }
  }

  /**
   * Formats and writes log entry to file and console.
   */
  log(level, message, meta = null) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}] [PID:${process.pid}]`;
    const line = meta ? `${prefix} ${message} ${JSON.stringify(meta)}` : `${prefix} ${message}`;

    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(line + '\n');
    }
    if (!this.options.silent) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    this.emit('log', { timestamp, level, message, meta });
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
      fs.writeFileSync(this.pidFile, String(process.pid), 'utf8');
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

    // Setup OS signal listeners for graceful shutdown
    this._bindSignals();

    // Spawn cluster workers
    for (let i = 0; i < this.numWorkers; i++) {
      this._forkWorker();
    }

    // Initialize coordinator ComputeSea & HTTP Gateway if enabled
    if (this.options.enableGateway) {
      this.sea = new ComputeSea({
        coordinatorId: `daemon-coord-${process.pid}`,
        enforceEscrow: true
      });
      this.gateway = new OpenSideGateway(this.sea, {
        port: this.options.gatewayPort || 8080,
        enableCluster: true
      });
      await this.gateway.listen();
      this.log('info', `Daemon Gateway listening on port ${this.gateway.port}`);
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
          this.log('warn', `Re-queueing interrupted task ${state.activeTaskId} from dead worker #${worker.id}`);
          this.taskQueue.unshift(pending.task);
          this.pendingTasks.delete(state.activeTaskId);
        }
      }
      this.workers.delete(worker.id);
      this.emit('workerDied', { id: worker.id, code, signal });

      // Auto-restart replacement worker if daemon is still running
      if (this.running && !this.stopping) {
        this.log('info', `Self-healing: restarting replacement worker for #${worker.id}...`);
        this._forkWorker();
        this._drainQueue();
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

        state.worker.send({
          type: 'EXECUTE_TASK',
          taskId: item.taskId,
          taskCode: item.taskCode,
          inputData: item.inputData,
          timeoutMs: item.timeoutMs,
          memoryLimitMb: item.memoryLimitMb
        });
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
   * Worker process initialization routine.
   */
  async _startWorker() {
    this.running = true;
    const sandbox = new StandbySandbox({
      maxExecutionMs: 15000,
      maxMemoryMb: 64,
      enableWorkerPool: true
    });

    process.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'EXECUTE_TASK') {
        const { taskId, taskCode, inputData, timeoutMs, memoryLimitMb } = msg;
        const t0 = performance.now();
        try {
          const res = await sandbox.executeIsolatedShardAsync(
            { shardId: taskId, taskCode, inputData },
            { timeoutMs: timeoutMs || 15000, memoryLimitMb: memoryLimitMb || 64 }
          );
          const executionTimeMs = performance.now() - t0;
          process.send({
            type: 'TASK_RESULT',
            taskId,
            success: true,
            output: res.output,
            executionTimeMs
          });
        } catch (err) {
          const executionTimeMs = performance.now() - t0;
          process.send({
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
    if (process.send) {
      process.send({ type: 'READY', workerId: cluster.worker ? cluster.worker.id : null, pid: process.pid });
    }

    this.emit('started', { mode: 'worker', pid: process.pid });
    return this;
  }

  /**
   * Wires graceful signal handlers.
   */
  _bindSignals() {
    const handleSignal = (sig) => {
      this.log('info', `Received signal ${sig}, initiating graceful teardown...`);
      this.stop(sig).catch((err) => {
        this.log('error', `Error during graceful shutdown: ${err.message}`);
        process.exit(1);
      });
    };

    this._exitHandler = handleSignal;
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
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
              state.worker.disconnect();
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

    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
    }

    this.running = false;
    this.emit('stopped', { reason });
    this.log('info', 'OpenSideDaemon stopped cleanly.');
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
