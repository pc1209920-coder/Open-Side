const vm = require('node:vm');
const os = require('node:os');

// Cache static OS metrics to optimize telemetry polling.
// os.cpus() is a costly call as it allocates object structures for all cores on every invocation.
// These values remain constant during the process lifetime.
const CPU_COUNT = os.cpus().length || 1;
const TOTAL_MEM = os.totalmem();

class StandbySandbox {
  constructor(config = {}) {
    this.maxExecutionMs = config.maxExecutionMs || 1500;
    this.maxCpuLoadThreshold = config.maxCpuLoadThreshold || 0.85;
  }

  isDeviceInStandby() {
    const normalizedLoad = (os.loadavg()[0] || 0.1) / CPU_COUNT;
    const freeMemRatio = os.freemem() / TOTAL_MEM;
    return {
      standbyReady: normalizedLoad < this.maxCpuLoadThreshold && freeMemRatio > 0.05,
      metrics: {
        cpuCount: CPU_COUNT,
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
