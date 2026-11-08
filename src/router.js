const crypto = require('node:crypto');

class GridRouter {
  constructor(localNodeId) {
    this.localNodeId = localNodeId;
    this.peerTable = new Map();
  }

  registerPeer(peerNodeId, publicKey, telemetry) {
    this.peerTable.set(peerNodeId, {
      nodeId: peerNodeId,
      publicKey,
      standbyReady: telemetry.standbyReady,
      latencyMs: telemetry.latencyMs || 20,
      capacityScore: 100
    });
  }

  selectOptimalNodes(taskHash, count = 1) {
    const activeNodes = Array.from(this.peerTable.values()).filter(p => p.standbyReady);
    activeNodes.sort((a, b) => a.latencyMs - b.latencyMs);
    return activeNodes.slice(0, count);
  }

  createTaskPartitions(taskCode, datasetArray, chunkSize = 2) {
    const partitions = [];
    for (let i = 0; i < datasetArray.length; i += chunkSize) {
      const chunk = datasetArray.slice(i, i + chunkSize);
      const partitionId = crypto.createHash('sha256').update(`${taskCode}:${JSON.stringify(chunk)}:${i}`).digest('hex').slice(0, 40);
      partitions.push({
        shardId: partitionId,
        index: Math.floor(i / chunkSize),
        taskCode,
        inputData: chunk
      });
    }
    return partitions;
  }
}

module.exports = { GridRouter };
