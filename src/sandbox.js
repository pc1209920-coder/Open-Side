const vm = require('node:vm');
const os = require('node:os');

class StandbySandbox {
  constructor(config = {}) {
    this.maxExecutionMs = config.maxExecutionMs || 1500;
    this.maxCpuLoadThreshold = config.maxCpuLoadThreshold || 0.85;
  }

  isDeviceInStandby() {
    const normalizedLoad = (os.loadavg()[0] || 0.1) / (os.cpus().length || 1);
    const freeMemRatio = os.freemem() / os.totalmem();
    return {
      standbyReady: normalizedLoad < this.maxCpuLoadThreshold && freeMemRatio > 0.05,
      metrics: {
        cpuCount: os.cpus().length || 1,
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

    const context = vm.createContext({ ...sandboxContext }, { codeGeneration: { strings: false, wasm: false } });
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
