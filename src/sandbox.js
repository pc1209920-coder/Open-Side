const vm = require('node:vm');
const os = require('node:os');

class StandbySandbox {
  constructor(config = {}) {
    this.maxExecutionMs = config.maxExecutionMs || 1500;
    this.maxCpuLoadThreshold = config.maxCpuLoadThreshold || 0.85;

    // ⚡ Bolt: Cache static hardware info to avoid expensive OS calls on every poll
    this._cpuCount = os.cpus().length || 1;
    this._totalMem = os.totalmem();
  }

  isDeviceInStandby() {
    const normalizedLoad = (os.loadavg()[0] || 0.1) / this._cpuCount;
    const freeMemRatio = os.freemem() / this._totalMem;
    return {
      standbyReady: normalizedLoad < this.maxCpuLoadThreshold && freeMemRatio > 0.05,
      metrics: {
        cpuCount: this._cpuCount,
        normalizedLoad: Number(normalizedLoad.toFixed(3)),
        freeMemoryMB: Math.round(os.freemem() / 1048576)
      }
    };
  }

  executeIsolatedShard(shard) {
    const sandboxContext = Object.freeze({
      input: Object.freeze(shard.inputData),
      Math,
      JSON,
      Array,
      Object,
      Number,
      String,
      result: null
    });

    const context = vm.createContext({ ...sandboxContext });
    const script = new vm.Script(`"use strict"; result = (function(data) { ${shard.taskCode} })(input);`);
    const start = performance.now();
    script.runInContext(context, { timeout: this.maxExecutionMs, displayErrors: false });
    return {
      shardId: shard.shardId,
      output: context.result,
      executionTimeMs: Number((performance.now() - start).toFixed(2))
    };
  }
}

module.exports = { StandbySandbox };
