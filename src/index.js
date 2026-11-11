const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const os = require('node:os');
const path = require('node:path');

const { MeshCryptoEngine } = require('./crypto');
const { GridRouter, QueueFullError } = require('./router');
const { StandbySandbox } = require('./sandbox');

const DEFAULT_QUEUE_TIMEOUT_MS = 5000;
const DEFAULT_SHARD_TIMEOUT_MS = 10000;
const DEFAULT_TELEMETRY_POLL_MS = 25;
const DEFAULT_CHUNK_SIZE = 2;

const RECOVERABLE_TRANSPORT_CODES = new Set([
  'ERR_SOCKET_DESTROYED',
  'ERR_PEER_DISCONNECTED',
  'ERR_SHARD_TIMEOUT',
  'ERR_HANDSHAKE_TIMEOUT',
  'PEER_DISCONNECTED',
  'PEER_TIMEOUT',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTCONN',
  'ENOENT',
  'ENOTSOCK',
  'EACCES',
  'EPERM'
]);

function isTcpRestrictedError(err) {
  return Boolean(err && (err.code === 'EACCES' || err.code === 'EPERM'));
}

function isRecoverableTransportError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code && RECOVERABLE_TRANSPORT_CODES.has(err.code)) return true;
  if (typeof err.message === 'string' && /destroyed|disconnected|timed out|socket closed/i.test(err.message)) {
    return true;
  }
  return false;
}

function tryRequireOptional(relativePath, exportName) {
  let resolved;
  try {
    resolved = require.resolve(relativePath);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      return null;
    }
    throw err;
  }
  const mod = require(resolved);
  if (!exportName) {
    return mod;
  }
  return mod && typeof mod[exportName] === 'function' ? mod[exportName] : null;
}

function extractIncomingMessage(arg1, arg2, arg3) {
  if (arg1 && typeof arg1 === 'object' && typeof arg1.type === 'string') {
    return {
      type: arg1.type,
      payload: arg1.payload !== undefined ? arg1.payload : arg1.data,
      peerId: arg1.peerId || arg1.senderId || arg1.from || (typeof arg2 === 'string' ? arg2 : undefined)
    };
  }
  if (typeof arg1 === 'string') {
    return {
      type: arg1,
      payload: arg2,
      peerId: typeof arg3 === 'string' ? arg3 : undefined
    };
  }
  return null;
}

class ComputeSea extends EventEmitter {
  /**
   * Unified Single Compute Sea orchestrator integrating cryptography, routing/telemetry,
   * zero-trust sandboxing, live P2P transport, and Proof-of-Compute ledger settlement.
   * @param {object} [options]
   */
  constructor(options = {}) {
    super();

    this._P2PNodeClass = options.P2PNode || null;
    this._LedgerClass = options.ProofOfComputeLedger || null;

    this.enableP2P = options.enableP2P !== undefined ? Boolean(options.enableP2P) : true;
    this.failClosed = Boolean(options.failClosed);
    this.strictTransport = Boolean(options.strictTransport);
    this.allowLocalLoopback = options.allowLocalLoopback !== undefined ? Boolean(options.allowLocalLoopback) : true;
    this.defaultChunkSize = options.chunkSize !== undefined ? options.chunkSize : DEFAULT_CHUNK_SIZE;
    this.defaultQueueTimeoutMs = options.queueTimeoutMs !== undefined
      ? options.queueTimeoutMs
      : (options.queueWaitTimeoutMs !== undefined
        ? options.queueWaitTimeoutMs
        : (options.deadlineMs !== undefined ? options.deadlineMs : DEFAULT_QUEUE_TIMEOUT_MS));
    this.defaultShardTimeoutMs = options.shardTimeoutMs !== undefined ? options.shardTimeoutMs : DEFAULT_SHARD_TIMEOUT_MS;
    this.telemetryPollIntervalMs = options.telemetryPollIntervalMs !== undefined
      ? options.telemetryPollIntervalMs
      : DEFAULT_TELEMETRY_POLL_MS;
    this.sessionEpoch = options.sessionEpoch !== undefined ? options.sessionEpoch : 1;
    this.rotateAfterShards = options.rotateAfterShards || 0;

    if (!Number.isFinite(this.defaultQueueTimeoutMs) || this.defaultQueueTimeoutMs <= 0) {
      throw new RangeError('Invalid queueTimeoutMs/deadlineMs: must be a positive finite number');
    }
    if (!Number.isFinite(this.defaultShardTimeoutMs) || this.defaultShardTimeoutMs <= 0) {
      throw new RangeError('Invalid shardTimeoutMs: must be a positive finite number');
    }

    this.crypto = options.crypto || new MeshCryptoEngine(options.cryptoOptions);
    this.p2pNode = options.p2pNode || null;

    if (!this.p2pNode && this.enableP2P) {
      const P2PNodeClass = this._resolveP2PNodeClass();
      if (P2PNodeClass) {
        this.p2pNode = new P2PNodeClass({ crypto: this.crypto, ...(options.p2pOptions || {}) });
      }
    }

    if (this.p2pNode && this.p2pNode.crypto && !options.crypto) {
      this.crypto = this.p2pNode.crypto;
    }

    this.nodeId = (this.p2pNode && this.p2pNode.nodeId) ? this.p2pNode.nodeId : this.crypto.nodeId;
    this.router = options.router || new GridRouter(this.nodeId, options.routerOptions);
    this.sandbox = options.sandbox || new StandbySandbox(options.sandboxOptions);

    this.ledger = null;
    if (options.ledger !== undefined) {
      this.ledger = options.ledger;
    } else if (options.enableLedger === true) {
      const LedgerClass = this._resolveLedgerClass();
      if (LedgerClass) {
        this.ledger = new LedgerClass(options.ledgerOptions || {});
      }
    }
    if (this.ledger && typeof options.initialBalance === 'number' && options.initialBalance > 0) {
      this.fundAccount(this.nodeId, options.initialBalance);
    }

    this._peerRegistry = new Map();
    this._localWorkers = new Map();
    this._sessionKeys = new Map();
    this._connectedPeers = new Map();
    this._pendingConnections = new Map();
    this._pendingKeyRotations = new Map();
    this._pendingP2PShards = new Map();
    this._handledP2PMessages = new Set();

    this._workloads = new Map();
    this._shardTrackers = new Map();
    this._activeShardIds = new Set();
    this._activeRawPartitionIds = new Set();
    this._dispatchedInEpoch = 0;
    this._preferIpcForLocalWorkers = Boolean(options.preferIpc);
    this._loopbackFallbackCrypto = null;
    this._closed = false;
    this._closing = false;
    this._peerEpochMutexes = new Map();

    this._bindRouterEvents();
    if (this.p2pNode && typeof this.p2pNode.on === 'function') {
      this.p2pNode.on('peerDisconnected', (peerId) => {
        this._failPendingP2PShardsForPeer(peerId, `Peer ${peerId} disconnected`);
      });
    }
    if (this.p2pNode && typeof this.p2pNode.dispatchRemoteShard !== 'function') {
      this._bindCoordinatorP2P(this.p2pNode);
    }
  }

  static getCapabilities() {
    const P2PNodeClass = tryRequireOptional('./node', 'P2PNode');
    const LedgerClass = tryRequireOptional('./ledger', 'ProofOfComputeLedger');
    const sandboxProto = StandbySandbox && StandbySandbox.prototype;
    return {
      crypto: typeof MeshCryptoEngine === 'function',
      router: typeof GridRouter === 'function',
      sandbox: typeof StandbySandbox === 'function',
      sandboxHardened: Boolean(
        sandboxProto &&
        typeof sandboxProto.validateTaskCode === 'function' &&
        typeof sandboxProto.executeIsolatedShardAsync === 'function'
      ),
      p2p: Boolean(P2PNodeClass),
      ledger: Boolean(LedgerClass)
    };
  }

  _resolveP2PNodeClass() {
    if (!this._P2PNodeClass) {
      this._P2PNodeClass = tryRequireOptional('./node', 'P2PNode');
    }
    return this._P2PNodeClass;
  }

  _resolveLedgerClass() {
    if (!this._LedgerClass) {
      this._LedgerClass = tryRequireOptional('./ledger', 'ProofOfComputeLedger');
    }
    return this._LedgerClass;
  }

  _bindRouterEvents() {
    this._onShardDispatched = ({ shard, peer }) => {
      const tracker = this._shardTrackers.get(shard.shardId);
      if (!tracker || tracker.workload.settled) {
        return;
      }
      tracker.currentPeerId = peer.nodeId;
      // Defer execution by one microtask so synchronous multi-shard dispatch loops finish queuing first
      Promise.resolve().then(() => this._executeDispatchedShard(shard, peer, tracker));
    };

    this._onShardFailed = (failure) => {
      if (!failure || !failure.shard) return;
      const tracker = this._shardTrackers.get(failure.shard.shardId);
      if (!tracker || tracker.workload.settled) return;
      this._failWorkload(
        tracker.workload,
        'FAILED',
        failure.reason || 'SHARD_FAILED',
        `Shard ${failure.shard.shardId} failed after ${failure.attempts || 0} attempts (${failure.reason || 'UNKNOWN'})`
      );
    };

    this._onShardExpired = (record) => {
      if (!record || !record.shard) return;
      const tracker = this._shardTrackers.get(record.shard.shardId);
      if (!tracker || tracker.workload.settled) return;
      this._failWorkload(
        tracker.workload,
        'TIMEOUT',
        record.reason || 'QUEUE_TTL_EXPIRED',
        `Shard ${record.shard.shardId} expired in queue after ${record.ageMs || 0}ms`
      );
    };

    this.router.on('shardDispatched', this._onShardDispatched);
    this.router.on('shardFailed', this._onShardFailed);
    this.router.on('shardExpired', this._onShardExpired);
  }

  _bindCoordinatorP2P(p2pNode) {
    if (!p2pNode || p2pNode._computeSeaCoordBound) return;
    p2pNode._computeSeaCoordBound = true;

    const handleMsg = (arg1, arg2, arg3) => {
      const msg = extractIncomingMessage(arg1, arg2, arg3);
      if (!msg) return;
      if (msg.type === 'SHARD_RESULT' || msg.type === 'SHARD_ERROR' || msg.type === 'SHARD_REJECTED') {
        const payload = msg.payload || {};
        const dedupToken = payload.dispatchId || `${payload.shardId || ''}:${payload.attempt || ''}`;
        const key = `${msg.type}:${dedupToken}`;
        if (payload.shardId && this._handledP2PMessages.has(key)) {
          return;
        }
        if (payload.shardId) {
          this._handledP2PMessages.add(key);
          if (this._handledP2PMessages.size > 2000) {
            const first = this._handledP2PMessages.values().next().value;
            this._handledP2PMessages.delete(first);
          }
        }
        let pending = null;
        if (payload.dispatchId && this._pendingP2PShards.has(payload.dispatchId)) {
          pending = this._pendingP2PShards.get(payload.dispatchId);
          this._pendingP2PShards.delete(payload.dispatchId);
        } else if (payload.shardId && this._pendingP2PShards.has(payload.shardId)) {
          pending = this._pendingP2PShards.get(payload.shardId);
          this._pendingP2PShards.delete(payload.shardId);
        }
        if (pending && (!pending.dispatchId || !payload.dispatchId || pending.dispatchId === payload.dispatchId)) {
          clearTimeout(pending.timer);
          pending.resolve({ type: msg.type, payload, fromPeerId: msg.peerId });
        }
      }
    };

    p2pNode.on('message', handleMsg);
    p2pNode.on('SHARD_RESULT', (payload, peerId) => handleMsg('SHARD_RESULT', payload, peerId));
    p2pNode.on('SHARD_ERROR', (payload, peerId) => handleMsg('SHARD_ERROR', payload, peerId));
    p2pNode.on('SHARD_REJECTED', (payload, peerId) => handleMsg('SHARD_REJECTED', payload, peerId));
    p2pNode.on('peerDisconnected', (data) => {
      const peerId = typeof data === 'string' ? data : (data?.peerId || data?.nodeId);
      if (peerId) {
        this._connectedPeers.delete(peerId);
        this._failPendingP2PShardsForPeer(peerId, `Peer ${peerId} disconnected`);
        this.router.handlePeerDisconnect(peerId, { remove: false });
      }
    });
  }

  /**
   * Attaches a ProofOfComputeLedger instance and optionally seeds initial balance.
   */
  attachLedger(ledger, options = {}) {
    this.ledger = ledger || null;
    if (this.ledger && typeof options.initialBalance === 'number' && options.initialBalance > 0) {
      this.fundAccount(this.nodeId, options.initialBalance);
    }
    return this.ledger;
  }

  /**
   * Seeds or credits an account balance on the attached ledger safely.
   */
  fundAccount(nodeId, amount) {
    if (!this.ledger) {
      throw new Error('Cannot fund account: no ProofOfComputeLedger attached');
    }
    if (typeof nodeId !== 'string' || !nodeId) {
      throw new TypeError('Invalid nodeId: must be a non-empty string');
    }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new RangeError('Invalid amount: must be a non-negative finite number');
    }

    const before = typeof this.ledger.getBalance === 'function' ? this.ledger.getBalance(nodeId) : 0;
    const methods = ['creditAccount', 'credit', 'deposit', 'fundAccount', 'fund', 'createAccount'];
    for (const m of methods) {
      if (typeof this.ledger[m] === 'function') {
        const res = this.ledger[m](nodeId, amount);
        const after = typeof this.ledger.getBalance === 'function'
          ? this.ledger.getBalance(nodeId)
          : (res && typeof res.balance === 'number' ? res.balance : before + amount);
        return after;
      }
    }

    if (this.ledger.accounts instanceof Map) {
      const existing = this.ledger.accounts.get(nodeId);
      if (existing) {
        existing.balance = (existing.balance || 0) + amount;
      } else {
        this.ledger.accounts.set(nodeId, {
          nodeId,
          balance: amount,
          totalEarned: 0,
          totalSpent: 0
        });
      }
      return this.ledger.accounts.get(nodeId).balance;
    }

    throw new Error('Attached ledger does not expose a supported account funding method');
  }

  getTelemetry() {
    return this.router.getHardwareTelemetry();
  }

  /**
   * Rotates the active HKDF-SHA512 session epoch and invalidates cached session keys.
   */
  rotateSessionKeys(nextEpoch) {
    if (nextEpoch !== undefined) {
      if (!Number.isSafeInteger(nextEpoch) || nextEpoch < 0) {
        throw new RangeError('Invalid epoch: must be a non-negative safe integer');
      }
      this.sessionEpoch = nextEpoch;
    } else {
      this.sessionEpoch += 1;
    }
    this._sessionKeys.clear();
    this._dispatchedInEpoch = 0;
    this.emit('sessionRotated', { epoch: this.sessionEpoch });
    return this.sessionEpoch;
  }

  /**
   * Derives or retrieves the cached 32-byte HKDF-SHA512 session key for a peer.
   */
  getSessionKey(peerId, peerPublicKey, epoch = this.sessionEpoch) {
    if (this.p2pNode && typeof this.p2pNode.getSessionKey === 'function') {
      const p2pKey = this.p2pNode.getSessionKey(peerId, epoch);
      if (p2pKey) {
        return p2pKey;
      }
    }
    let pubKey = peerPublicKey;
    if (!pubKey) {
      const reg = this._peerRegistry.get(peerId) || this.router.peerTable.get(peerId);
      pubKey = reg ? reg.publicKey : null;
    }
    if (!pubKey) {
      throw new Error(`Unknown peer public key for ${peerId}`);
    }
    const cacheKey = `${this.nodeId}:${peerId}:${epoch}`;
    let key = this._sessionKeys.get(cacheKey);
    if (!key) {
      key = this.crypto.deriveSessionKey(pubKey, { epoch });
      this._sessionKeys.set(cacheKey, key);
    }
    return key;
  }

  _getPairwiseSessionKey(engine, localId, remoteId, remotePublicKey, epoch = this.sessionEpoch) {
    const cacheKey = `${localId}:${remoteId}:${epoch}`;
    let key = this._sessionKeys.get(cacheKey);
    if (!key) {
      key = engine.deriveSessionKey(remotePublicKey, { epoch });
      this._sessionKeys.set(cacheKey, key);
    }
    return key;
  }

  _makeLocalIpcPath(workerId) {
    const suffix = `${String(workerId).slice(0, 12)}-${process.pid}-${crypto.randomUUID()}`;
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\openside-sea-${suffix}`;
    }
    return path.join(os.tmpdir(), `openside-sea-${suffix}.sock`);
  }

  /**
   * Registers a compute peer and optional transport/execution descriptors.
   */
  registerPeer(peerNodeId, publicKey, telemetryOrOptions = {}) {
    const opts = telemetryOrOptions && typeof telemetryOrOptions === 'object' ? telemetryOrOptions : {};
    const endpoint = opts.endpoint || ((opts.port !== undefined || opts.ipcPath !== undefined)
      ? { host: opts.host || '127.0.0.1', port: opts.port, ipcPath: opts.ipcPath }
      : null);

    this._peerRegistry.set(peerNodeId, {
      nodeId: peerNodeId,
      publicKey,
      endpoint,
      p2pNode: opts.p2pNode || null,
      crypto: opts.crypto || null,
      sandbox: opts.sandbox || null,
      router: opts.router || null,
      executor: typeof opts.executor === 'function' ? opts.executor : null,
      checkHostTelemetry: Boolean(opts.checkHostTelemetry || opts.os),
      isLocalWorker: Boolean(opts.isLocalWorker),
      localEndpointAuto: Boolean(opts.localEndpointAuto),
      localWorkerHandle: opts.localWorkerHandle || null,
      p2pOptions: opts.p2pOptions || null
    });

    // Populate registry BEFORE router.registerPeer because router may autoFlush queued shards immediately
    this.router.registerPeer(peerNodeId, publicKey, telemetryOrOptions);
  }

  updatePeerTelemetry(peerNodeId, telemetry = {}) {
    return this.router.updatePeerTelemetry(peerNodeId, telemetry);
  }

  unregisterPeer(peerNodeId, options = { remove: true }) {
    this._failPendingP2PShardsForPeer(peerNodeId, `Peer ${peerNodeId} unregistered`);
    const outcome = this.router.handlePeerDisconnect(peerNodeId, options);
    this._connectedPeers.delete(peerNodeId);
    this._pendingConnections.delete(peerNodeId);
    this._pendingKeyRotations.delete(peerNodeId);
    if (options && options.remove) {
      this._peerRegistry.delete(peerNodeId);
    }
    for (const key of this._sessionKeys.keys()) {
      if (key.includes(`:${peerNodeId}:`) || key.startsWith(`${peerNodeId}:`)) {
        this._sessionKeys.delete(key);
      }
    }
    return outcome;
  }

  /**
   * Creates, binds (over P2P loopback TCP/IPC when available), and registers a local standby worker node.
   */
  async addLocalWorker(options = {}) {
    if (this._closed) {
      throw new Error('Cannot add worker: ComputeSea is closed');
    }

    let workerCrypto = options.crypto || new MeshCryptoEngine(options.cryptoOptions);
    const workerSandbox = options.sandbox || new StandbySandbox(options.sandboxOptions);
    const workerRouter = options.router || new GridRouter(workerCrypto.nodeId, {
      ...(options.routerOptions || {}),
      os: options.os || (options.routerOptions && options.routerOptions.os)
    });
    const checkHostTelemetry = Boolean(options.checkHostTelemetry || options.os);
    const localEndpointAuto = Boolean(
      !options.endpoint &&
      !options.p2pNode &&
      options.port === undefined &&
      options.host === undefined &&
      options.ipcPath === undefined &&
      !options.preferTcpOnly
    );

    let workerP2P = options.p2pNode || null;
    let endpoint = options.endpoint || null;

    const useP2P = options.useP2P !== undefined ? Boolean(options.useP2P) : this.enableP2P;
    if (!workerP2P && useP2P) {
      const P2PNodeClass = this._resolveP2PNodeClass();
      if (P2PNodeClass) {
        workerP2P = new P2PNodeClass({
          crypto: workerCrypto,
          router: workerRouter,
          sandbox: workerSandbox,
          enforceTelemetry: checkHostTelemetry,
          ...(options.p2pOptions || {})
        });
        if (workerP2P.crypto && !options.crypto) {
          workerCrypto = workerP2P.crypto;
        }
      }
    }

    const workerId = (workerP2P && workerP2P.nodeId) ? workerP2P.nodeId : workerCrypto.nodeId;
    if (workerRouter.localNodeId !== workerId) {
      workerRouter.localNodeId = workerId;
    }

    if (workerP2P) {
      if (typeof workerP2P._handleShardDispatch !== 'function') {
        this._bindWorkerP2P(workerP2P, workerCrypto, workerSandbox, workerRouter, {
          checkHostTelemetry
        });
      }
      if (!endpoint && typeof workerP2P.listen === 'function') {
        let listenOpts;
        if (options.ipcPath) {
          listenOpts = { ipcPath: options.ipcPath };
        } else if (options.port !== undefined || options.host !== undefined) {
          listenOpts = {
            host: options.host || '127.0.0.1',
            port: options.port !== undefined ? options.port : 0,
            allowIpcFallback: !options.preferTcpOnly
          };
        } else if (this._preferIpcForLocalWorkers || options.preferIpc) {
          listenOpts = { ipcPath: this._makeLocalIpcPath(workerId) };
        }
        const addr = listenOpts ? await workerP2P.listen(listenOpts) : await workerP2P.listen();
        endpoint = {
          host: (addr && addr.address) || '127.0.0.1',
          port: addr && addr.port,
          ipcPath: addr && addr.ipcPath
        };
      }
    }

    let initialTelemetry = {
      standbyReady: options.standbyReady !== undefined ? options.standbyReady : true,
      latencyMs: options.latencyMs !== undefined ? options.latencyMs : 10,
      capacityScore: options.capacityScore !== undefined ? options.capacityScore : 100,
      cpuLoad: options.cpuLoad !== undefined ? options.cpuLoad : 0.10,
      freeMemRatio: options.freeMemRatio !== undefined ? options.freeMemRatio : 0.65,
      maxConcurrentShards: options.maxConcurrentShards
    };

    if (options.os || options.checkHostTelemetry) {
      const live = workerRouter.getHardwareTelemetry();
      initialTelemetry = {
        ...initialTelemetry,
        standbyReady: live.standbyReady,
        cpuLoad: live.cpuLoad,
        freeMemRatio: live.freeMemRatio,
        freeMemBytes: live.freeMemBytes
      };
    }

    const handle = {
      workerId,
      nodeId: workerId,
      publicKey: workerCrypto.publicKey,
      crypto: workerCrypto,
      sandbox: workerSandbox,
      router: workerRouter,
      p2pNode: workerP2P,
      endpoint,
      setTelemetry: (telem) => this.updatePeerTelemetry(workerId, telem),
      close: async () => {
        this.unregisterPeer(workerId, { remove: true });
        this._localWorkers.delete(workerId);
        const activeP2P = handle.p2pNode;
        if (activeP2P && typeof activeP2P.close === 'function') {
          await activeP2P.close();
        }
      }
    };

    this._localWorkers.set(workerId, handle);
    this.registerPeer(workerId, workerCrypto.publicKey, {
      ...initialTelemetry,
      endpoint,
      p2pNode: workerP2P,
      crypto: workerCrypto,
      sandbox: workerSandbox,
      router: workerRouter,
      checkHostTelemetry,
      isLocalWorker: true,
      localEndpointAuto,
      localWorkerHandle: handle,
      p2pOptions: options.p2pOptions || null
    });

    return handle;
  }

  _bindWorkerP2P(workerP2P, workerCrypto, workerSandbox, workerRouter, opts = {}) {
    if (!workerP2P || workerP2P._computeSeaWorkerBound) return;
    workerP2P._computeSeaWorkerBound = true;
    const workerId = workerP2P.nodeId || workerCrypto.nodeId;
    const processed = new Set();

    const onDispatch = async (arg1, arg2, arg3) => {
      const msg = extractIncomingMessage(arg1, arg2, arg3);
      if (!msg || msg.type !== 'SHARD_DISPATCH') return;

      const payload = msg.payload || {};
      const shard = payload.shard;
      const requesterId = payload.requesterId || msg.peerId;
      if (!shard || !shard.shardId || !requesterId) return;

      const dedupKey = payload.dispatchId || `${shard.shardId}:${shard.attempts || 1}`;
      if (processed.has(dedupKey)) return;
      processed.add(dedupKey);
      if (processed.size > 2000) {
        const first = processed.values().next().value;
        processed.delete(first);
      }

      try {
        if (opts.checkHostTelemetry) {
          const gate = workerRouter.canAcceptShard();
          if (!gate.accepted) {
            await workerP2P.sendEncryptedMessage(requesterId, 'SHARD_REJECTED', {
              dispatchId: payload.dispatchId,
              shardId: shard.shardId,
              attempt: shard.attempts || 1,
              reason: gate.loadShedState,
              telemetry: gate.telemetry
            });
            return;
          }
        }

        const execResult = await this._runSandboxExecution(workerSandbox, shard, payload.execOptions || {});
        const proofOfCompute = workerCrypto.signProofOfCompute(shard.shardId, execResult.output);

        await workerP2P.sendEncryptedMessage(requesterId, 'SHARD_RESULT', {
          dispatchId: payload.dispatchId,
          shardId: shard.shardId,
          index: shard.index,
          attempt: shard.attempts || 1,
          output: execResult.output,
          executionTimeMs: execResult.executionTimeMs,
          proofOfCompute,
          workerId,
          workerPublicKey: workerCrypto.publicKey
        });
      } catch (err) {
        try {
          await workerP2P.sendEncryptedMessage(requesterId, 'SHARD_ERROR', {
            dispatchId: payload.dispatchId,
            shardId: shard.shardId,
            attempt: shard.attempts || 1,
            reason: err && err.code ? err.code : 'SANDBOX_EXECUTION_ERROR',
            error: err && err.message ? err.message : String(err)
          });
        } catch {
          // Ignore send failure if requester socket already closed
        }
      }
    };

    workerP2P.on('message', onDispatch);
    workerP2P.on('SHARD_DISPATCH', (payload, peerId) => onDispatch('SHARD_DISPATCH', payload, peerId));
  }

  async start() {
    if (this.p2pNode && typeof this.p2pNode.listen === 'function' && !this.p2pNode.server?.listening) {
      return this.p2pNode.listen();
    }
    return null;
  }

  async listen() {
    return this.start();
  }

  _failPendingP2PShardsForPeer(peerId, reasonMessage) {
    for (const [shardId, pending] of this._pendingP2PShards.entries()) {
      if (pending.peerId === peerId) {
        this._pendingP2PShards.delete(shardId);
        clearTimeout(pending.timer);
        pending.reject(Object.assign(new Error(reasonMessage), {
          code: 'PEER_DISCONNECTED',
          recoverable: true
        }));
      }
    }
  }

  async _ensureP2PSession(peerId, descriptor) {
    if (!this.p2pNode) {
      throw new Error('P2PNode not available on coordinator');
    }

    if (typeof this.p2pNode.getPeer === 'function') {
      const livePeer = this.p2pNode.getPeer(peerId);
      if (livePeer && livePeer.state === 'ESTABLISHED' && livePeer.socket && !livePeer.socket.destroyed && livePeer.socket.writable) {
        const entry = {
          socket: livePeer.socket,
          sessionKey: livePeer.sessionKey,
          p2pPeerId: peerId
        };
        this._connectedPeers.set(peerId, entry);
        return entry;
      }
    }

    const existing = this._connectedPeers.get(peerId);
    if (existing && existing.socket && !existing.socket.destroyed && existing.socket.writable !== false) {
      return existing;
    }

    if (this._pendingConnections.has(peerId)) {
      return this._pendingConnections.get(peerId);
    }

    const connectPromise = (async () => {
      try {
        let socket;
        try {
          socket = await this.p2pNode.connect(descriptor.endpoint);
        } catch (connErr) {
          const canFallbackToIpc = Boolean(
            isTcpRestrictedError(connErr) &&
            descriptor.isLocalWorker &&
            descriptor.localEndpointAuto &&
            descriptor.endpoint &&
            !descriptor.endpoint.ipcPath &&
            descriptor.p2pNode &&
            descriptor.crypto
          );
          if (!canFallbackToIpc) {
            throw connErr;
          }

          const P2PNodeClass = this._resolveP2PNodeClass();
          if (!P2PNodeClass) {
            throw connErr;
          }

          this._preferIpcForLocalWorkers = true;
          const oldP2P = descriptor.p2pNode;
          if (oldP2P && typeof oldP2P.close === 'function') {
            await oldP2P.close().catch(() => {});
          }

          const replacementP2P = new P2PNodeClass({
            crypto: descriptor.crypto,
            router: descriptor.router,
            sandbox: descriptor.sandbox,
            enforceTelemetry: Boolean(descriptor.checkHostTelemetry),
            ...(descriptor.p2pOptions || {})
          });

          if (typeof replacementP2P._handleShardDispatch !== 'function') {
            this._bindWorkerP2P(replacementP2P, descriptor.crypto, descriptor.sandbox, descriptor.router, {
              checkHostTelemetry: Boolean(descriptor.checkHostTelemetry)
            });
          }

          const ipcPath = this._makeLocalIpcPath(peerId);
          const addr = await replacementP2P.listen({ ipcPath });
          const nextEndpoint = {
            host: 'ipc',
            port: 0,
            ipcPath: addr && addr.ipcPath ? addr.ipcPath : ipcPath
          };

          descriptor.p2pNode = replacementP2P;
          descriptor.endpoint = nextEndpoint;
          if (descriptor.localWorkerHandle) {
            descriptor.localWorkerHandle.p2pNode = replacementP2P;
            descriptor.localWorkerHandle.endpoint = nextEndpoint;
          }

          socket = await this.p2pNode.connect(descriptor.endpoint);
        }

        let sessionKey = null;
        if (typeof this.p2pNode.initiateHandshake === 'function') {
          sessionKey = await this.p2pNode.initiateHandshake(socket, descriptor.publicKey, {
            epoch: this.sessionEpoch
          });
        }

        let p2pPeerId = peerId;
        if (typeof this.p2pNode.getPeer === 'function' && !this.p2pNode.getPeer(peerId) && this.p2pNode.peers instanceof Map) {
          for (const [id, p] of this.p2pNode.peers.entries()) {
            if (p && p.socket === socket) {
              p2pPeerId = id;
              break;
            }
          }
        }

        const entry = { socket, sessionKey, p2pPeerId };
        this._connectedPeers.set(peerId, entry);

        if (socket && typeof socket.once === 'function') {
          socket.once('close', () => {
            if (this._connectedPeers.get(peerId) === entry) {
              this._connectedPeers.delete(peerId);
            }
            this._failPendingP2PShardsForPeer(peerId, `Peer ${peerId} socket closed mid-shard`);
          });
          socket.once('error', (err) => {
            if (this._connectedPeers.get(peerId) === entry) {
              this._connectedPeers.delete(peerId);
            }
            this._failPendingP2PShardsForPeer(peerId, `Peer ${peerId} socket error: ${err && err.message ? err.message : 'UNKNOWN'}`);
          });
        }

        return entry;
      } finally {
        this._pendingConnections.delete(peerId);
      }
    })();

    this._pendingConnections.set(peerId, connectPromise);
    return connectPromise;
  }

  async _syncPeerP2PEpoch(targetPeerId, targetEpoch, sessionEntry) {
    if (!this.p2pNode || typeof this.p2pNode.getPeer !== 'function') {
      return sessionEntry ? sessionEntry.sessionKey : null;
    }

    if (!this._peerEpochMutexes) {
      this._peerEpochMutexes = new Map();
    }
    const currentMutex = this._peerEpochMutexes.get(targetPeerId) || Promise.resolve();
    let releaseMutex;
    const nextMutex = new Promise((resolve) => { releaseMutex = resolve; });
    this._peerEpochMutexes.set(targetPeerId, nextMutex);

    await currentMutex;
    try {
      const livePeer = this.p2pNode.getPeer(targetPeerId);
      if (!livePeer || typeof this.p2pNode.rotateSessionKey !== 'function') {
        return sessionEntry ? sessionEntry.sessionKey : null;
      }

      if (livePeer.epoch >= targetEpoch) {
        if (sessionEntry) {
          sessionEntry.sessionKey = livePeer.sessionKey;
        }
        return livePeer.sessionKey;
      }

      const rotatedKey = await this.p2pNode.rotateSessionKey(targetPeerId, targetEpoch);
      if (sessionEntry) {
        sessionEntry.sessionKey = rotatedKey;
      }
      return rotatedKey;
    } finally {
      releaseMutex();
      if (this._peerEpochMutexes.get(targetPeerId) === nextMutex) {
        this._peerEpochMutexes.delete(targetPeerId);
      }
    }
  }

  async _runSandboxExecution(sandbox, shard, options = {}) {
    if (typeof sandbox.validateTaskCode === 'function') {
      const validation = sandbox.validateTaskCode(shard.taskCode);
      if (!validation || validation.valid !== true) {
        const err = new Error(validation && validation.error ? validation.error : 'Task code failed static AST validation');
        err.code = 'SANDBOX_VALIDATION_FAILED';
        throw err;
      }
    }

    if (typeof sandbox.executeIsolatedShardAsync === 'function' && options.syncSandbox !== true) {
      return sandbox.executeIsolatedShardAsync(shard, {
        timeoutMs: options.timeoutMs,
        memoryLimitMb: options.memoryLimitMb
      });
    }

    return sandbox.executeIsolatedShard(shard);
  }

  _checkRequesterCredit(requesterId, partitions, options = {}) {
    if (!this.ledger) {
      return { ok: true, estimatedCost: 0 };
    }

    let estimatedCost;
    if (typeof options.estimatedCost === 'number' && Number.isFinite(options.estimatedCost)) {
      estimatedCost = Math.max(0, options.estimatedCost);
    } else if (typeof this.ledger.calculateCredit === 'function') {
      const estMs = options.estimatedExecutionMs !== undefined ? options.estimatedExecutionMs : 1;
      estimatedCost = partitions.reduce((acc, part) => {
        const size = Array.isArray(part.inputData) ? Math.max(1, part.inputData.length) : 1;
        const unit = this.ledger.calculateCredit(estMs, size);
        return acc + (typeof unit === 'number' && Number.isFinite(unit) && unit > 0 ? unit : 0);
      }, 0);
    } else {
      estimatedCost = partitions.length;
    }

    const readAvailableBalance = () => {
      if (typeof this.ledger.getAccount === 'function') {
        const acct = this.ledger.getAccount(requesterId);
        if (!acct) return { exists: false, balance: 0 };
        const bal = typeof acct.availableBalance === 'number' ? acct.availableBalance : acct.balance;
        return { exists: true, balance: typeof bal === 'number' ? bal : 0 };
      }
      const bal = typeof this.ledger.getBalance === 'function' ? this.ledger.getBalance(requesterId) : 0;
      return { exists: true, balance: bal };
    };

    if (typeof this.ledger.checkCreditAvailable === 'function') {
      try {
        const available = this.ledger.checkCreditAvailable(requesterId, estimatedCost);
        if (available === false) {
          return {
            ok: false,
            estimatedCost,
            balance: readAvailableBalance().balance,
            error: `Insufficient credit balance for requester ${requesterId}: required >= ${estimatedCost}`
          };
        }
      } catch (err) {
        return {
          ok: false,
          estimatedCost,
          balance: readAvailableBalance().balance,
          error: err && err.message ? err.message : String(err)
        };
      }
    }

    const acctInfo = readAvailableBalance();
    if (!acctInfo.exists) {
      return {
        ok: false,
        estimatedCost,
        balance: 0,
        error: `Unknown requester account: ${requesterId}`
      };
    }
    const balance = acctInfo.balance;
    if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < estimatedCost) {
      return {
        ok: false,
        estimatedCost,
        balance,
        error: `Insufficient credit balance for requester ${requesterId}: balance=${balance}, required=${estimatedCost}`
      };
    }

    return { ok: true, estimatedCost, balance };
  }

  /**
   * Orchestrates deterministic "Single Compute Sea" workload execution across
   * available P2P / local loopback nodes with fail-closed policy enforcement.
   * @param {string} taskCode
   * @param {any[]} datasetArray
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async submitWorkload(taskCode, datasetArray, options = {}) {
    if (this._closed || this._closing) {
      return {
        status: 'REJECTED',
        reason: 'COMPUTE_SEA_CLOSED',
        error: 'ComputeSea instance is closed',
        workloadId: null
      };
    }

    if (options.shardTimeoutMs !== undefined && (!Number.isFinite(options.shardTimeoutMs) || options.shardTimeoutMs <= 0)) {
      throw new RangeError('Invalid shardTimeoutMs: must be a positive finite number');
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new RangeError('Invalid timeoutMs: must be a positive finite number');
    }

    const chunkSize = options.chunkSize !== undefined ? options.chunkSize : this.defaultChunkSize;
    const requesterId = options.requesterId || this.nodeId;
    const failClosed = options.failClosed !== undefined ? Boolean(options.failClosed) : this.failClosed;
    const deadlineMs = options.deadlineMs !== undefined
      ? options.deadlineMs
      : (options.queueTimeoutMs !== undefined
        ? options.queueTimeoutMs
        : (options.queueWaitTimeoutMs !== undefined ? options.queueWaitTimeoutMs : this.defaultQueueTimeoutMs));

    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      throw new RangeError('Invalid deadlineMs/queueTimeoutMs: must be a positive finite number');
    }

    // 1. Partition deterministically via GridRouter (validates taskCode, datasetArray, chunkSize)
    const rawPartitions = this.router.createTaskPartitions(taskCode, datasetArray, chunkSize);
    const workloadId = crypto.randomUUID();
    const startTime = performance.now();

    // 2. Fail-closed static AST pre-validation before any dispatch/credit spend when hardened sandbox exists
    if (typeof this.sandbox.validateTaskCode === 'function') {
      const validation = this.sandbox.validateTaskCode(taskCode);
      if (!validation || validation.valid !== true) {
        const res = {
          status: 'REJECTED',
          reason: 'SANDBOX_VALIDATION_FAILED',
          error: validation && validation.error ? validation.error : 'Task code rejected by sandbox pre-validator',
          workloadId,
          shardCount: rawPartitions.length,
          results: []
        };
        if (options.throwOnError) throw Object.assign(new Error(res.error), { reason: res.reason });
        return res;
      }
    }

    if (rawPartitions.length === 0) {
      return {
        status: 'COMPLETED',
        workloadId,
        output: [],
        shardCount: 0,
        shards: [],
        proofs: [],
        settlements: [],
        totalCost: 0,
        durationMs: Number((performance.now() - startTime).toFixed(2))
      };
    }

    // 3. Fail-closed pre-dispatch credit check via ProofOfComputeLedger when attached
    const creditCheck = this._checkRequesterCredit(requesterId, rawPartitions, options);
    if (!creditCheck.ok) {
      const res = {
        status: 'REJECTED',
        reason: 'INSUFFICIENT_CREDIT_BALANCE',
        error: creditCheck.error,
        workloadId,
        requesterId,
        requiredCredit: creditCheck.estimatedCost,
        availableCredit: creditCheck.balance,
        shardCount: rawPartitions.length,
        results: []
      };
      if (options.throwOnError) throw Object.assign(new Error(res.error), { reason: res.reason });
      return res;
    }

    // 4. Refresh any OS-monitored local workers before selecting peers
    this._refreshLocalWorkerTelemetry();

    // 5. Evaluate node availability & policy
    const peerCount = this.router.peerTable.size;
    const readyNodes = this.router.selectOptimalNodes(rawPartitions[0].shardId, 1);

    if (peerCount === 0 && failClosed) {
      const res = {
        status: 'REJECTED',
        reason: 'FAIL_CLOSED_NO_NODES',
        error: 'Fail-closed: no compute nodes available in peerTable',
        workloadId,
        shardCount: rawPartitions.length,
        results: []
      };
      if (options.throwOnError) throw Object.assign(new Error(res.error), { reason: res.reason });
      return res;
    }

    if (peerCount > 0 && readyNodes.length === 0 && failClosed) {
      const res = {
        status: 'REJECTED',
        reason: 'ALL_PEERS_BUSY_OR_SHEDDING',
        error: 'Fail-closed: all compute nodes are busy or load-shedding (CPU > 25% or memory low)',
        workloadId,
        shardCount: rawPartitions.length,
        results: []
      };
      if (options.throwOnError) throw Object.assign(new Error(res.error), { reason: res.reason });
      return res;
    }

    // Avoid shardId collision in GridRouter.inFlightShards if an identical task/dataset shard is currently active
    for (const part of rawPartitions) {
      if (this._activeRawPartitionIds.has(part.shardId)) {
        const res = {
          status: 'REJECTED',
          reason: 'DUPLICATE_INFLIGHT_SHARD',
          error: `Shard ${part.shardId} is already active in another in-flight workload`,
          workloadId,
          shardCount: rawPartitions.length,
          results: []
        };
        if (options.throwOnError) throw Object.assign(new Error(res.error), { reason: res.reason });
        return res;
      }
    }

    // Salt shardId per workload to prevent cross-workload collisions
    const partitions = rawPartitions.map((rawShard) => {
      const saltedShardId = crypto.createHash('sha256')
        .update(`${workloadId}:${rawShard.shardId}:${rawShard.index}`)
        .digest('hex');
      return {
        ...rawShard,
        shardId: saltedShardId,
        rawShardId: rawShard.shardId
      };
    });

    // Real escrow reservation per partition in ProofOfComputeLedger when available
    const reservedEscrowShardIds = [];
    if (this.ledger && typeof this.ledger.reserveEscrow === 'function') {
      const estMs = options.estimatedExecutionMs !== undefined ? options.estimatedExecutionMs : 1;
      try {
        for (const part of partitions) {
          const shardSize = Array.isArray(part.inputData) ? Math.max(1, part.inputData.length) : 1;
          const shardCost = typeof this.ledger.calculateCredit === 'function'
            ? this.ledger.calculateCredit(estMs, shardSize)
            : 1;
          if (shardCost > 0) {
            this.ledger.reserveEscrow(requesterId, shardCost, part.shardId);
            reservedEscrowShardIds.push(part.shardId);
          }
        }
      } catch (escrowErr) {
        for (const sId of reservedEscrowShardIds) {
          try {
            this.ledger.releaseEscrow(requesterId, undefined, sId);
          } catch {}
        }
        const res = {
          status: 'REJECTED',
          reason: 'ESCROW_RESERVATION_FAILED',
          error: escrowErr.message,
          workloadId,
          shardCount: partitions.length,
          results: []
        };
        if (options.throwOnError) throw Object.assign(new Error(res.error), { reason: res.reason });
        return res;
      }
    }

    // 6. Initialize workload orchestration state
    let resolveCompletion;
    const completionPromise = new Promise((resolve) => {
      resolveCompletion = resolve;
    });

    const workload = {
      id: workloadId,
      requesterId,
      partitions,
      rawShardIds: new Set(rawPartitions.map((p) => p.shardId)),
      shardIds: new Set(partitions.map((p) => p.shardId)),
      reservedEscrowShardIds: new Set(reservedEscrowShardIds),
      options,
      startTime,
      results: new Map(),
      settlements: [],
      totalCost: 0,
      settled: false,
      deadlineTimer: null,
      pollTimer: null,
      resolve: (outcome) => {
        if (workload.settled) return;
        workload.settled = true;
        this._cleanupWorkloadResources(workload);
        resolveCompletion(outcome);
      }
    };

    this._workloads.set(workloadId, workload);
    if (this._workloads.size > 1000) {
      for (const [oldId, oldWl] of this._workloads.entries()) {
        if (this._workloads.size <= 1000) break;
        if (oldWl.settled && oldId !== workloadId) {
          this._workloads.delete(oldId);
        }
      }
    }

    for (const rawPart of rawPartitions) {
      this._activeRawPartitionIds.add(rawPart.shardId);
    }
    for (const part of partitions) {
      this._activeShardIds.add(part.shardId);
      this._shardTrackers.set(part.shardId, {
        workload,
        shard: part,
        currentPeerId: null
      });
    }

    // Bound total queue wait & drive automatic draining as peers recover or register
    workload.deadlineTimer = setTimeout(() => {
      if (workload.settled) return;
      const reason = this.router.peerTable.size === 0 ? 'QUEUE_TIMEOUT_NO_NODES' : 'QUEUE_TIMEOUT_PEERS_UNAVAILABLE';
      this._failWorkload(
        workload,
        'TIMEOUT',
        reason,
        `Workload ${workloadId} exceeded deadline (${deadlineMs}ms) with ${workload.results.size}/${partitions.length} shards completed`
      );
    }, deadlineMs);
    if (typeof workload.deadlineTimer.unref === 'function') {
      workload.deadlineTimer.unref();
    }
    if (typeof workload.deadlineTimer.unref === 'function') {
      workload.deadlineTimer.unref();
    }

    workload.pollTimer = setInterval(() => {
      if (workload.settled) return;
      try {
        this._refreshLocalWorkerTelemetry();
        this.router.pruneExpiredQueue();
        if (this.router.taskQueue.length > 0) {
          this.router.flushQueue();
        }
      } catch {
        // Ignore transient poll tick errors; per-shard error paths handle failures cleanly
      }
    }, this.telemetryPollIntervalMs);
    if (typeof workload.pollTimer.unref === 'function') {
      workload.pollTimer.unref();
    }

    // 7. Atomic bounded queue capacity pre-check when queuing will occur
    this.router.pruneExpiredQueue();
    if (readyNodes.length === 0 && (this.router.taskQueue.length + partitions.length > this.router.maxQueueSize)) {
      this._failWorkload(
        workload,
        'REJECTED',
        'QUEUE_FULL',
        `Task queue capacity (${this.router.maxQueueSize}) exceeded`
      );
      const outcome = await completionPromise;
      if (options.throwOnError) throw new QueueFullError(outcome.error);
      return outcome;
    }

    // 8. Dispatch/queue all partitions atomically via GridRouter
    let queuedCount = 0;
    let lastQueueReason = peerCount === 0 ? 'FAIL_CLOSED_NO_NODES' : 'ALL_PEERS_BUSY_OR_SHEDDING';

    try {
      for (const part of partitions) {
        const dispatchOutcome = this.router.dispatchShard(part, { failClosed: false });
        if (dispatchOutcome.status === 'QUEUED') {
          queuedCount += 1;
          lastQueueReason = dispatchOutcome.reason || lastQueueReason;
        }
      }
    } catch (err) {
      const reason = err instanceof QueueFullError || err?.code === 'ERR_QUEUE_FULL'
        ? 'QUEUE_FULL'
        : 'DISPATCH_ERROR';
      this._failWorkload(workload, 'REJECTED', reason, err && err.message ? err.message : String(err));
      const outcome = await completionPromise;
      if (options.throwOnError) throw err;
      return outcome;
    }

    // 9. Policy handling when queued with no immediate dispatch or returnOnQueue requested:
    //    - No compute nodes available (peerCount === 0) and waitForDrain !== true -> immediate { status: 'QUEUED' } with timeout/auto-drain
    //    - Caller explicitly requested waitForDrain: false / returnOnQueue: true when queued -> immediate { status: 'QUEUED' } with timeout/auto-drain
    const shouldReturnQueuedImmediately = queuedCount > 0 && (
      options.returnOnQueue === true ||
      options.waitForDrain === false ||
      (peerCount === 0 && options.waitForDrain !== true)
    );

    if (shouldReturnQueuedImmediately) {
      return {
        status: 'QUEUED',
        reason: lastQueueReason,
        workloadId,
        shardCount: partitions.length,
        queuedCount,
        queueLength: this.router.taskQueue.length,
        queuedShards: partitions.map((p) => p.shardId),
        completion: completionPromise
      };
    }

    const finalOutcome = await completionPromise;
    if (options.throwOnError && finalOutcome.status !== 'COMPLETED') {
      const err = new Error(finalOutcome.error || finalOutcome.reason);
      err.reason = finalOutcome.reason;
      err.status = finalOutcome.status;
      throw err;
    }
    return finalOutcome;
  }

  _refreshLocalWorkerTelemetry() {
    for (const [peerId, descriptor] of this._peerRegistry.entries()) {
      if (descriptor && descriptor.router && descriptor.checkHostTelemetry) {
        const live = descriptor.router.getHardwareTelemetry();
        try {
          this.router.updatePeerTelemetry(peerId, {
            standbyReady: live.standbyReady,
            cpuLoad: live.cpuLoad,
            freeMemRatio: live.freeMemRatio,
            freeMemBytes: live.freeMemBytes
          });
        } catch {
          // Peer might have been unregistered concurrently
        }
      }
    }
  }

  _isLoadShedRejectionReason(reason) {
    return (
      reason === 'CPU_OVERLOAD' ||
      reason === 'MEMORY_EXHAUSTED' ||
      reason === 'CPU_AND_MEMORY_EXHAUSTED' ||
      reason === 'LOAD_SHEDDING' ||
      reason === 'TELEMETRY_INVALID'
    );
  }

  async _executeDispatchedShard(shard, peer, tracker) {
    const workload = tracker.workload;
    const isOwnAttempt = () => {
      if (workload.settled || this._closed) return false;
      const entry = this.router.inFlightShards.get(shard.shardId);
      return Boolean(entry && entry.peerId === peer.nodeId && entry.attempts === shard.attempts);
    };

    if (!isOwnAttempt()) {
      return;
    }

    const descriptor = this._peerRegistry.get(peer.nodeId);
    const execOptions = workload.options || {};

    try {
      let resultOutput;
      let executionTimeMs;
      let proofOfCompute;
      const workerPublicKey = peer.publicKey;
      let pocSecret = workerPublicKey;

      // Validate peer EC public key & establish HKDF-SHA512 session key
      if (this.rotateAfterShards > 0 && this._dispatchedInEpoch >= this.rotateAfterShards) {
        this.rotateSessionKeys();
      }
      this._dispatchedInEpoch += 1;

      const useP2P = Boolean(
        this.p2pNode &&
        descriptor &&
        descriptor.endpoint &&
        (descriptor.endpoint.port || descriptor.endpoint.ipcPath)
      );

      if (useP2P) {
        // Live P2P socket path (ECDH handshake + HKDF-SHA512 + AES-256-GCM wire stream)
        let sessionEntry;
        try {
          sessionEntry = await this._ensureP2PSession(peer.nodeId, descriptor);
        } catch (connErr) {
          if (!isOwnAttempt()) return;
          connErr.recoverable = isRecoverableTransportError(connErr);
          throw connErr;
        }
        if (!isOwnAttempt()) return;

        const targetPeerId = (typeof this.p2pNode.getPeer === 'function' && this.p2pNode.getPeer(peer.nodeId))
          ? peer.nodeId
          : (sessionEntry.p2pPeerId || peer.nodeId);
        const shardTimeoutMs = execOptions.shardTimeoutMs || this.defaultShardTimeoutMs;

        if (typeof this.p2pNode.dispatchRemoteShard === 'function') {
          let activeSessionKey;
          try {
            activeSessionKey = await this._syncPeerP2PEpoch(targetPeerId, this.sessionEpoch, sessionEntry);
          } catch (rotErr) {
            if (!isOwnAttempt()) return;
            rotErr.recoverable = isRecoverableTransportError(rotErr);
            throw rotErr;
          }
          if (!isOwnAttempt()) return;

          let res;
          try {
            const dispatchOpts = { timeoutMs: shardTimeoutMs };
            if (execOptions.timeoutMs !== undefined) dispatchOpts.executionTimeoutMs = execOptions.timeoutMs;
            if (execOptions.memoryLimitMb !== undefined) dispatchOpts.memoryLimitMb = execOptions.memoryLimitMb;
            if (execOptions.syncSandbox !== undefined) dispatchOpts.sync = Boolean(execOptions.syncSandbox);

            const target = (typeof this.p2pNode.getPeer === 'function' && this.p2pNode.getPeer(targetPeerId))
              ? targetPeerId
              : sessionEntry.socket;
            res = await this.p2pNode.dispatchRemoteShard(target, shard, dispatchOpts);
          } catch (p2pErr) {
            if (!isOwnAttempt()) return;

            if (p2pErr && p2pErr.code === 'ERR_SHARD_REJECTED') {
              const rejReason = p2pErr.reason || 'LOAD_SHEDDING';
              if (this._isLoadShedRejectionReason(rejReason)) {
                const p = this.router.peerTable.get(peer.nodeId);
                if (p) p.standbyReady = false;
                const resched = this.router.rescheduleShard(shard.shardId, { preserveAttempts: true });
                if (resched.status === 'RESCHEDULED' && this.router.autoFlush) {
                  this.router.flushQueue();
                }
                return;
              }
              const fatalErr = new Error(p2pErr.message || `Shard rejected by worker (${rejReason})`);
              fatalErr.code = rejReason;
              fatalErr.recoverable = false;
              throw fatalErr;
            }

            p2pErr.recoverable = isRecoverableTransportError(p2pErr);
            throw p2pErr;
          }

          if (!isOwnAttempt()) return;

          const postKey = typeof this.p2pNode.getSessionKey === 'function'
            ? this.p2pNode.getSessionKey(targetPeerId, res?.epoch ?? this.sessionEpoch)
            : null;
          pocSecret = postKey || activeSessionKey || sessionEntry.sessionKey;
          if (!pocSecret) {
            const keyErr = new Error(`Missing HKDF session key for PoC verification on peer ${peer.nodeId}`);
            keyErr.code = 'POC_VERIFICATION_FAILED';
            keyErr.recoverable = false;
            throw keyErr;
          }

          resultOutput = res.output;
          executionTimeMs = res.executionTimeMs;
          proofOfCompute = res.proofOfCompute;
        } else {
          // Mock/legacy P2PNode fallback path (sendEncryptedMessage + event listener)
          const dispatchId = crypto.randomUUID();
          const p2pReply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              this._pendingP2PShards.delete(dispatchId);
              reject(Object.assign(new Error(`P2P shard ${shard.shardId} timed out after ${shardTimeoutMs}ms`), {
                code: 'PEER_TIMEOUT',
                recoverable: true
              }));
            }, shardTimeoutMs);
            if (typeof timer.unref === 'function') timer.unref();

            this._pendingP2PShards.set(dispatchId, {
              resolve,
              reject,
              timer,
              peerId: peer.nodeId,
              shardId: shard.shardId,
              dispatchId
            });

            this.p2pNode.sendEncryptedMessage(peer.nodeId, 'SHARD_DISPATCH', {
              dispatchId,
              shard,
              requesterId: this.nodeId,
              requesterPublicKey: this.crypto.publicKey,
              epoch: this.sessionEpoch,
              execOptions: {
                timeoutMs: execOptions.timeoutMs,
                memoryLimitMb: execOptions.memoryLimitMb,
                syncSandbox: execOptions.syncSandbox
              }
            }).catch((err) => {
              if (this._pendingP2PShards.has(dispatchId)) {
                this._pendingP2PShards.delete(dispatchId);
                clearTimeout(timer);
                err.recoverable = true;
                reject(err);
              }
            });
          });

          if (!isOwnAttempt()) return;

          if (p2pReply.type === 'SHARD_REJECTED') {
            const rejPayload = p2pReply.payload || {};
            const rejReason = rejPayload.reason || 'LOAD_SHEDDING';
            if (!this._isLoadShedRejectionReason(rejReason)) {
              const fatalErr = new Error(rejPayload.error || `Shard rejected by worker (${rejReason})`);
              fatalErr.code = rejReason;
              fatalErr.recoverable = false;
              throw fatalErr;
            }
            if (rejPayload.telemetry) {
              try {
                this.router.updatePeerTelemetry(peer.nodeId, { ...rejPayload.telemetry, standbyReady: false });
              } catch {
                // Ignore if peer removed
              }
            } else {
              const p = this.router.peerTable.get(peer.nodeId);
              if (p) p.standbyReady = false;
            }
            const resched = this.router.rescheduleShard(shard.shardId, { preserveAttempts: true });
            if (resched.status === 'RESCHEDULED' && this.router.autoFlush) {
              this.router.flushQueue();
            }
            return;
          }

          if (p2pReply.type === 'SHARD_ERROR') {
            const errPayload = p2pReply.payload || {};
            const err = new Error(errPayload.error || 'Worker shard execution failed');
            err.code = errPayload.reason || 'SANDBOX_EXECUTION_ERROR';
            err.recoverable = false;
            throw err;
          }

          const resPayload = p2pReply.payload || {};
          resultOutput = resPayload.output;
          executionTimeMs = resPayload.executionTimeMs;
          proofOfCompute = resPayload.proofOfCompute;
        }
      } else {
        // In-process cryptographic loopback worker path (ECDH + HKDF-SHA512 + AES-256-GCM + AAD + Anti-Replay)
        if (this.strictTransport && (!descriptor || (!descriptor.crypto && !descriptor.executor))) {
          throw Object.assign(new Error(`Strict transport enabled: peer ${peer.nodeId} has no live P2P endpoint or worker`), {
            code: 'PEER_TRANSPORT_UNAVAILABLE',
            recoverable: false
          });
        }

        // Check worker-side load-shedding telemetry before running
        if (descriptor && descriptor.router && descriptor.checkHostTelemetry) {
          const gate = descriptor.router.canAcceptShard();
          if (!gate.accepted) {
            this.router.updatePeerTelemetry(peer.nodeId, {
              standbyReady: false,
              cpuLoad: gate.telemetry.cpuLoad,
              freeMemRatio: gate.telemetry.freeMemRatio,
              freeMemBytes: gate.telemetry.freeMemBytes
            });
            const resched = this.router.rescheduleShard(shard.shardId);
            if (resched.status === 'RESCHEDULED' && this.router.autoFlush) {
              this.router.flushQueue();
            }
            return;
          }
        }

        if (descriptor && descriptor.executor) {
          // Custom executor with HKDF-SHA512 key validation & encrypted envelope
          const coordSessKey = this.getSessionKey(peer.nodeId, peer.publicKey, this.sessionEpoch);
          const aad = `${this.nodeId}:${shard.shardId}`;
          const encryptedPacket = this.crypto.encryptShard(shard, coordSessKey, { epoch: this.sessionEpoch, aad });
          const execOut = await descriptor.executor({
            shard,
            encryptedPacket,
            sessionKey: coordSessKey,
            aad,
            peer
          });
          if (!isOwnAttempt()) return;
          resultOutput = execOut.output;
          executionTimeMs = execOut.executionTimeMs || 1;
          proofOfCompute = execOut.proofOfCompute;
          if (execOut.hmacSecret !== undefined) {
            pocSecret = execOut.hmacSecret;
          }
        } else if (descriptor && descriptor.crypto) {
          const workerCrypto = descriptor.crypto;
          const workerSandbox = descriptor.sandbox || this.sandbox;
          const coordSessKey = this._getPairwiseSessionKey(this.crypto, this.nodeId, peer.nodeId, workerCrypto.publicKey, this.sessionEpoch);
          const workerSessKey = this._getPairwiseSessionKey(workerCrypto, peer.nodeId, this.nodeId, this.crypto.publicKey, this.sessionEpoch);

          const reqAad = `${this.nodeId}:${shard.shardId}`;
          const encryptedPacket = this.crypto.encryptShard(shard, coordSessKey, {
            epoch: this.sessionEpoch,
            aad: reqAad
          });
          const decryptedShard = workerCrypto.decryptShard(encryptedPacket, workerSessKey, {
            validateReplay: true,
            senderId: this.nodeId,
            aad: reqAad
          });

          const execRes = await this._runSandboxExecution(workerSandbox, decryptedShard, execOptions);
          if (!isOwnAttempt()) return;
          const rawPoc = workerCrypto.signProofOfCompute(decryptedShard.shardId, execRes.output, workerSessKey);

          const resAad = `${peer.nodeId}:${decryptedShard.shardId}:result`;
          const encResPacket = workerCrypto.encryptShard({
            shardId: decryptedShard.shardId,
            index: decryptedShard.index,
            output: execRes.output,
            executionTimeMs: execRes.executionTimeMs,
            proofOfCompute: rawPoc
          }, workerSessKey, {
            epoch: this.sessionEpoch,
            aad: resAad
          });
          const decResPacket = this.crypto.decryptShard(encResPacket, coordSessKey, {
            validateReplay: true,
            senderId: peer.nodeId,
            aad: resAad
          });

          resultOutput = decResPacket.output;
          executionTimeMs = decResPacket.executionTimeMs;
          proofOfCompute = decResPacket.proofOfCompute;
          pocSecret = coordSessKey;
        } else {
          // Bare peer metadata (only peerNodeId + publicKey registered): validate EC key via HKDF-SHA512
          // and run through internal loopback worker engine
          if (!this.allowLocalLoopback) {
            throw Object.assign(new Error(`Peer ${peer.nodeId} has no live transport or local loopback enabled`), {
              code: 'PEER_TRANSPORT_UNAVAILABLE',
              recoverable: false
            });
          }
          // Still validates peer.publicKey on prime256v1 fail-closed!
          this.getSessionKey(peer.nodeId, peer.publicKey, this.sessionEpoch);

          if (!this._loopbackFallbackCrypto) {
            this._loopbackFallbackCrypto = new MeshCryptoEngine();
          }
          const lbCrypto = this._loopbackFallbackCrypto;
          const coordSessKey = this._getPairwiseSessionKey(this.crypto, this.nodeId, lbCrypto.nodeId, lbCrypto.publicKey, this.sessionEpoch);
          const lbSessKey = this._getPairwiseSessionKey(lbCrypto, lbCrypto.nodeId, this.nodeId, this.crypto.publicKey, this.sessionEpoch);

          const reqAad = `${this.nodeId}:${shard.shardId}`;
          const encryptedPacket = this.crypto.encryptShard(shard, coordSessKey, {
            epoch: this.sessionEpoch,
            aad: reqAad
          });
          const decryptedShard = lbCrypto.decryptShard(encryptedPacket, lbSessKey, {
            validateReplay: true,
            senderId: this.nodeId,
            aad: reqAad
          });

          const execRes = await this._runSandboxExecution(this.sandbox, decryptedShard, execOptions);
          if (!isOwnAttempt()) return;
          resultOutput = execRes.output;
          executionTimeMs = execRes.executionTimeMs;
          proofOfCompute = lbCrypto.signProofOfCompute(decryptedShard.shardId, resultOutput, peer.publicKey);
        }
      }

      if (!isOwnAttempt()) {
        return;
      }

      // Verify HMAC-SHA256 Proof-of-Compute constant-time
      const pocValid = this.crypto.verifyProofOfCompute(
        shard.shardId,
        resultOutput,
        proofOfCompute,
        pocSecret
      );
      if (!pocValid) {
        const err = new Error(`Proof-of-Compute signature verification failed for shard ${shard.shardId}`);
        err.code = 'POC_VERIFICATION_FAILED';
        err.recoverable = false;
        throw err;
      }

      // Settle credits on ProofOfComputeLedger if attached
      let settlement = null;
      if (this.ledger) {
        const execMs = typeof executionTimeMs === 'number' && Number.isFinite(executionTimeMs) && executionTimeMs > 0
          ? executionTimeMs
          : 1;
        const inputSize = Array.isArray(shard.inputData) ? shard.inputData.length : 1;

        try {
          const settleParams = {
            requesterId: workload.requesterId,
            workerId: peer.nodeId,
            shardId: shard.shardId,
            resultData: resultOutput,
            proofOfCompute,
            executionMetrics: {
              executionTimeMs: execMs,
              inputSize
            },
            attestationNonce: `${workload.id}:${shard.index}:${shard.attempts || 1}`,
            workerPublicKey,
            inputData: shard.inputData
          };
          if (pocSecret && pocSecret !== workerPublicKey) {
            settleParams.hmacSecret = pocSecret;
          }
          settlement = this.ledger.verifyAndSettle(settleParams);
        } catch (ledgerErr) {
          if (ledgerErr && !ledgerErr.code) {
            ledgerErr.code = 'LEDGER_SETTLEMENT_FAILED';
          }
          if (ledgerErr && typeof ledgerErr === 'object') {
            ledgerErr.recoverable = false;
          }
          throw ledgerErr;
        }

        if (!settlement || settlement.settled !== true) {
          const detail = settlement && (settlement.error || settlement.reason) ? `: ${settlement.error || settlement.reason}` : '';
          const err = new Error(`Ledger settlement rejected for shard ${shard.shardId}${detail}`);
          err.code = (settlement && settlement.reason) || 'LEDGER_SETTLEMENT_FAILED';
          err.recoverable = false;
          throw err;
        }
        workload.settlements.push({ shardId: shard.shardId, workerId: peer.nodeId, ...settlement });
        workload.totalCost += typeof settlement.cost === 'number' ? settlement.cost : 0;
      }

      const shardRecord = {
        shardId: shard.shardId,
        index: shard.index,
        output: resultOutput,
        executionTimeMs: executionTimeMs || 0,
        proofOfCompute,
        workerId: peer.nodeId,
        settlement
      };

      workload.results.set(shard.shardId, shardRecord);
      this._activeShardIds.delete(shard.shardId);
      this._shardTrackers.delete(shard.shardId);
      this.router.completeShard(shard.shardId);

      if (workload.results.size === workload.partitions.length && !workload.settled) {
        const collected = Array.from(workload.results.values());
        const orderedShards = collected.slice().sort((a, b) => a.index - b.index);
        const aggregatedOutput = this.router.aggregateResults(collected, workload.partitions.length);

        workload.resolve({
          status: 'COMPLETED',
          workloadId: workload.id,
          output: aggregatedOutput,
          shardCount: workload.partitions.length,
          shards: orderedShards,
          proofs: orderedShards.map((s) => ({
            shardId: s.shardId,
            workerId: s.workerId,
            proofOfCompute: s.proofOfCompute
          })),
          settlements: workload.settlements,
          totalCost: workload.totalCost,
          durationMs: Number((performance.now() - workload.startTime).toFixed(2))
        });
      }
    } catch (err) {
      if (!isOwnAttempt()) {
        return;
      }

      if (err && err.recoverable) {
        // Recoverable peer/socket failure: disconnect peer and reschedule shard to queue head
        const outcome = this.router.handlePeerDisconnect(peer.nodeId, { remove: false });
        this._connectedPeers.delete(peer.nodeId);
        if (outcome && outcome.failed && outcome.failed.length > 0) {
          const myFail = outcome.failed.find((f) => f.shard && f.shard.shardId === shard.shardId);
          if (myFail) {
            this._failWorkload(workload, 'FAILED', myFail.reason || 'MAX_RETRIES_EXCEEDED', err.message);
          }
        }
        return;
      }

      const reason = (err && err.code) ? err.code : 'SHARD_EXECUTION_FAILED';
      this._failWorkload(workload, 'FAILED', reason, err && err.message ? err.message : String(err));
    }
  }

  _failWorkload(workload, status, reason, errorMessage) {
    if (workload.settled) return;
    const partialResults = Array.from(workload.results.values()).sort((a, b) => a.index - b.index);
    workload.resolve({
      status,
      reason,
      error: errorMessage,
      workloadId: workload.id,
      completedShards: partialResults.length,
      shardCount: workload.partitions.length,
      results: partialResults,
      settlements: workload.settlements,
      totalCost: workload.totalCost,
      durationMs: Number((performance.now() - workload.startTime).toFixed(2))
    });
  }

  _cleanupWorkloadResources(workload) {
    if (workload.deadlineTimer) {
      clearTimeout(workload.deadlineTimer);
      workload.deadlineTimer = null;
    }
    if (workload.pollTimer) {
      clearInterval(workload.pollTimer);
      workload.pollTimer = null;
    }

    if (workload.rawShardIds) {
      for (const id of workload.rawShardIds) {
        this._activeRawPartitionIds.delete(id);
      }
    }

    if (this.ledger && typeof this.ledger.releaseEscrow === 'function') {
      for (const shardId of workload.shardIds) {
        if (!workload.results.has(shardId)) {
          try {
            this.ledger.releaseEscrow(workload.requesterId, undefined, shardId);
          } catch {}
        }
      }
    }

    // Purge any remaining queued shards belonging solely to this workload first
    if (this.router && Array.isArray(this.router.taskQueue) && this.router.taskQueue.length > 0) {
      this.router.taskQueue = this.router.taskQueue.filter((s) => !workload.shardIds.has(s.shardId));
    }

    const inFlightToRelease = [];
    for (const shardId of workload.shardIds) {
      this._shardTrackers.delete(shardId);
      this._activeShardIds.delete(shardId);
      if (this.router && this.router.inFlightShards && this.router.inFlightShards.has(shardId)) {
        inFlightToRelease.push(shardId);
      }
    }

    for (const [key, pending] of this._pendingP2PShards.entries()) {
      if (pending && (workload.shardIds.has(pending.shardId) || workload.shardIds.has(key))) {
        clearTimeout(pending.timer);
        this._pendingP2PShards.delete(key);
      }
    }

    for (const shardId of inFlightToRelease) {
      this.router.completeShard(shardId);
    }
  }

  getWorkloadStatus(workloadId) {
    const workload = this._workloads.get(workloadId);
    if (!workload) return null;
    return {
      workloadId: workload.id,
      settled: workload.settled,
      completedShards: workload.results.size,
      totalShards: workload.partitions.length,
      totalCost: workload.totalCost
    };
  }

  cancelWorkload(workloadId, reason = 'WORKLOAD_CANCELLED') {
    const workload = this._workloads.get(workloadId);
    if (!workload || workload.settled) return false;
    if (this.sandbox && typeof this.sandbox.terminateAllWorkers === 'function') {
      try {
        this.sandbox.terminateAllWorkers();
      } catch {}
    }
    this._failWorkload(workload, 'CANCELLED', reason, `Workload ${workloadId} cancelled (${reason})`);
    return true;
  }

  async close() {
    this._closed = true;
    this._closing = true;

    if (this.sandbox && typeof this.sandbox.terminateAllWorkers === 'function') {
      try {
        this.sandbox.terminateAllWorkers();
      } catch {}
    }
    for (const worker of this._localWorkers.values()) {
      if (worker.sandbox && typeof worker.sandbox.terminateAllWorkers === 'function') {
        try {
          worker.sandbox.terminateAllWorkers();
        } catch {}
      }
    }

    for (const workload of this._workloads.values()) {
      if (!workload.settled) {
        this._failWorkload(workload, 'CANCELLED', 'COMPUTE_SEA_CLOSED', 'ComputeSea closed before workload completed');
      } else {
        this._cleanupWorkloadResources(workload);
      }
    }
    this._workloads.clear();

    for (const pending of this._pendingP2PShards.values()) {
      clearTimeout(pending.timer);
    }
    this._pendingP2PShards.clear();

    this.router.removeListener('shardDispatched', this._onShardDispatched);
    this.router.removeListener('shardFailed', this._onShardFailed);
    this.router.removeListener('shardExpired', this._onShardExpired);

    const closePromises = [];
    for (const worker of this._localWorkers.values()) {
      if (worker.p2pNode && typeof worker.p2pNode.close === 'function') {
        closePromises.push(worker.p2pNode.close());
      }
    }
    this._localWorkers.clear();

    if (this.p2pNode && typeof this.p2pNode.close === 'function') {
      closePromises.push(this.p2pNode.close());
    }

    await Promise.allSettled(closePromises);
    this._connectedPeers.clear();
    this._pendingConnections.clear();
    this._pendingKeyRotations.clear();
    this._sessionKeys.clear();
  }
}

const OpenSideProtocol = ComputeSea;

/**
 * Backward-compatible synchronous v0.4.2 baseline protocol simulation.
 */
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
  return { ok: true, telemetry, shardCount: tasks.length };
}

/**
 * Full "Single Compute Sea" end-to-end simulation exercising:
 * - Fail-closed zero-node rejection
 * - Bounded queuing + automatic drain on worker join
 * - Load-shedding (CPU > 25%) + recovery
 * - HKDF-SHA512 + AES-256-GCM + Sandbox + PoC + Ledger settlement + Aggregation
 */
async function runFullSeaSimulation(options = {}) {
  const silent = Boolean(options.silent);
  const log = silent ? () => {} : (...args) => console.log(...args);

  const caps = ComputeSea.getCapabilities();
  const sea = new ComputeSea({
    enableLedger: caps.ledger,
    initialBalance: 1000,
    queueTimeoutMs: options.queueTimeoutMs || 3000
  });

  try {
    await sea.start();
    log(`🌊 SINGLE COMPUTE SEA ORCHESTRATOR | P2P=${caps.p2p ? 'LIVE_NET' : 'LOOPBACK'} | LEDGER=${caps.ledger ? 'ACTIVE' : 'OPTIONAL'}`);

    // 1. No compute nodes available (failClosed: true)
    const failClosedRes = await sea.submitWorkload('return data;', [1, 2], { failClosed: true });
    if (failClosedRes.status !== 'REJECTED' || failClosedRes.reason !== 'FAIL_CLOSED_NO_NODES') {
      throw new Error(`Expected FAIL_CLOSED_NO_NODES rejection, got ${JSON.stringify(failClosedRes)}`);
    }
    log(`[SEA] Fail-closed empty grid verified -> ${failClosedRes.status} (${failClosedRes.reason})`);

    // 2. Queued mode when no nodes available, followed by automatic drain on worker join
    const queuedHandle = await sea.submitWorkload('return data.map(n => n * 2);', [5, 10], { failClosed: false });
    if (queuedHandle.status !== 'QUEUED') {
      throw new Error(`Expected QUEUED status, got ${JSON.stringify(queuedHandle)}`);
    }
    const workerA = await sea.addLocalWorker({ latencyMs: 10, capacityScore: 200, maxConcurrentShards: 2 });
    const workerB = await sea.addLocalWorker({ latencyMs: 20, capacityScore: 150, maxConcurrentShards: 2 });

    const drainedRes = await queuedHandle.completion;
    if (drainedRes.status !== 'COMPLETED' || JSON.stringify(drainedRes.output) !== JSON.stringify([10, 20])) {
      throw new Error(`Auto-drain failed: ${JSON.stringify(drainedRes)}`);
    }
    const transportTag = workerA.endpoint && workerA.endpoint.ipcPath ? 'LIVE_IPC' : (caps.p2p ? 'LIVE_TCP' : 'LOOPBACK');
    log(`[SEA] Queued auto-drain completed [${transportTag}] -> Output: ${JSON.stringify(drainedRes.output)}`);

    // 3. Load-shedding (CPU > 25%) -> bounded wait -> automatic recovery
    workerA.setTelemetry({ cpuLoad: 0.42, freeMemRatio: 0.60 });
    workerB.setTelemetry({ cpuLoad: 0.38, freeMemRatio: 0.60 });
    const shedWorkloadPromise = sea.submitWorkload('return data.map(n => n + 1);', [1, 2, 3, 4], {
      chunkSize: 2,
      deadlineMs: 3000
    });
    const recoverTimer = setTimeout(() => {
      workerA.setTelemetry({ cpuLoad: 0.12, freeMemRatio: 0.65 });
      workerB.setTelemetry({ cpuLoad: 0.15, freeMemRatio: 0.65 });
    }, 20);
    if (typeof recoverTimer.unref === 'function') recoverTimer.unref();

    const recoveredRes = await shedWorkloadPromise;
    if (recoveredRes.status !== 'COMPLETED' || JSON.stringify(recoveredRes.output) !== JSON.stringify([2, 3, 4, 5])) {
      throw new Error(`Load-shed recovery failed: ${JSON.stringify(recoveredRes)}`);
    }
    log(`[SEA] Load-shed recovery completed -> Output: ${JSON.stringify(recoveredRes.output)}`);

    // 4. Full healthy compute sea workload with HKDF rotation, PoC, ledger settlement & aggregation
    sea.rotateSessionKeys();
    const fullRes = await sea.submitWorkload(
      'return data.map(n => (n * n) + 42);',
      [10, 20, 30, 40, 50, 60],
      { chunkSize: 2 }
    );
    if (fullRes.status !== 'COMPLETED') {
      throw new Error(`Full Sea workload failed: ${JSON.stringify(fullRes)}`);
    }
    if (JSON.stringify(fullRes.output) !== JSON.stringify([142, 442, 942, 1642, 2542, 3642])) {
      throw new Error(`Unexpected aggregated output: ${JSON.stringify(fullRes.output)}`);
    }
    if (sea.ledger) {
      if (!(fullRes.totalCost > 0)) {
        throw new Error(`Expected positive ledger settlement cost, got ${fullRes.totalCost}`);
      }
      if (typeof sea.ledger.verifyAuditLog === 'function') {
        const audit = sea.ledger.verifyAuditLog();
        if (!audit.valid) {
          throw new Error(`Ledger audit log invalid: ${audit.error}`);
        }
      }
      if (typeof sea.ledger.getTotalBalance === 'function' && sea.ledger.getTotalBalance() !== 1000) {
        throw new Error(`Ledger credit conservation violated: total=${sea.ledger.getTotalBalance()}`);
      }
    }
    log(`[SEA] Full Compute Sea completed (${fullRes.shardCount} shards, epoch=${sea.sessionEpoch}, cost=${fullRes.totalCost}) -> Output: ${JSON.stringify(fullRes.output)}`);

    return {
      ok: true,
      capabilities: caps,
      failClosedRes,
      drainedRes,
      recoveredRes,
      fullRes
    };
  } finally {
    await sea.close();
  }
}

if (require.main === module) {
  runProtocolSimulation();
  runFullSeaSimulation().catch((err) => {
    console.error('[SEA] Simulation error:', err);
    process.exitCode = 1;
  });
}

const { OpenSideGateway } = require('./gateway');

module.exports = {
  ComputeSea,
  OpenSideProtocol,
  OpenSideGateway,
  runProtocolSimulation,
  runFullSeaSimulation
};
