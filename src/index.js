const { MeshCryptoEngine } = require('./crypto');
const { StandbySandbox } = require('./sandbox');
const { GridRouter } = require('./router');

function runProtocolSimulation() {
  console.log('🌐 OPEN-SIDE v0.4.2 — DECENTRALIZED STANDBY COMPUTE GRID');
  const coordinator = new MeshCryptoEngine();
  const workerNode = new MeshCryptoEngine();
  const sandbox = new StandbySandbox();
  const router = new GridRouter(coordinator.nodeId);

  const telemetry = sandbox.isDeviceInStandby();
  router.registerPeer(workerNode.nodeId, workerNode.publicKey, { standbyReady: true, latencyMs: 12 });
  const tasks = router.createTaskPartitions('return data.map(n => (n * n) + 42);', [10, 20, 30, 40], 2);

  const coordKey = coordinator.deriveSharedKey(workerNode.publicKey);
  const workerKey = workerNode.deriveSharedKey(coordinator.publicKey);

  for (const task of tasks) {
    const packet = coordinator.encryptShard(task, coordKey);
    const decrypted = workerNode.decryptShard(packet, workerKey);
    const res = sandbox.executeIsolatedShard(decrypted);
    const sig = workerNode.signProofOfCompute(task.shardId, res.output);
    console.log(`[OK] Task Partition ${task.shardId.slice(0, 8)} -> Output: ${JSON.stringify(res.output)} | Proof: ${sig.slice(0, 12)}...`);
  }
}

if (require.main === module) runProtocolSimulation();
module.exports = { runProtocolSimulation };
