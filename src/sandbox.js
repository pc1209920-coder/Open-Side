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
    // Create a pristine context detached from host object prototypes
    const context = vm.createContext(Object.create(null));

    // Serialize input safely so it can be parsed natively inside the sandbox
    const safeInput = JSON.stringify(shard.inputData);

    const scriptCode = `
      "use strict";
      // Expose safe built-ins from the VM realm and construct our pristine environment
      var Math = globalThis.Math;
      var JSON = globalThis.JSON;
      var Array = globalThis.Array;
      var Object = globalThis.Object;
      var Number = globalThis.Number;
      var String = globalThis.String;

      var input = JSON.parse(${JSON.stringify(safeInput)});
      var result = (function(data) { ${shard.taskCode} })(input);
      result;
    `;

    const script = new vm.Script(scriptCode);
    const start = performance.now();

    // Execute within the isolated context
    const result = script.runInContext(context, { timeout: this.maxExecutionMs, displayErrors: false });
    return {
      shardId: shard.shardId,
      output: result,
      executionTimeMs: Number((performance.now() - start).toFixed(2))
    };
  }
}

module.exports = { StandbySandbox };
