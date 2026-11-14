const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');

const {
  P2PNode,
  FrameTooLargeError,
  SocketDestroyedError,
  AlreadyListeningError,
  HandshakeTimeoutError,
  SecurityError,
  STREAM_FRAME_TAG
} = require('../src/node');
const { MeshCryptoEngine } = require('../src/crypto');
const { GridRouter } = require('../src/router');
const { StandbySandbox } = require('../src/sandbox');

let ipcSeq = 0;

function makeUniqueIpcPath(tag = 'node') {
  ipcSeq += 1;
  const suffix = `${tag}-${process.pid}-${Date.now()}-${ipcSeq}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\openside-m5-${suffix}`;
  }
  return path.join(os.tmpdir(), `openside-m5-${suffix}.sock`);
}

function isTcpRestrictedError(err) {
  return Boolean(err && (err.code === 'EACCES' || err.code === 'EPERM'));
}

function createDeterministicOs(cpuLoad = 0.10, freeMem = 500_000_000, totalMem = 1_000_000_000) {
  let user = 0;
  let idle = 0;
  const getLoad = typeof cpuLoad === 'function' ? cpuLoad : () => cpuLoad;
  const getFree = typeof freeMem === 'function' ? freeMem : () => freeMem;
  const getTotal = typeof totalMem === 'function' ? totalMem : () => totalMem;

  return {
    cpus() {
      const load = Math.min(1, Math.max(0, getLoad()));
      const totalDelta = 100000;
      const busyDelta = Math.round(totalDelta * load);
      const idleDelta = totalDelta - busyDelta;
      user += busyDelta;
      idle += idleDelta;
      return [{ model: 'MockCPU', speed: 3000, times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
    },
    freemem: () => getFree(),
    totalmem: () => getTotal()
  };
}

function flipLastHexByte(hexStr) {
  assert.strictEqual(typeof hexStr, 'string');
  assert.ok(hexStr.length >= 2);
  const tail = hexStr.slice(-2).toLowerCase();
  const replacement = tail === 'ff' ? '00' : 'ff';
  return hexStr.slice(0, -2) + replacement;
}

function waitForEvent(emitter, eventName, timeoutMs = 3000) {
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for event '${eventName}'`));
    }, timeoutMs);
    function onEvent(...args) {
      cleanup();
      resolve(args.length <= 1 ? args[0] : args);
    }
    cleanup = () => {
      clearTimeout(timer);
      emitter.removeListener(eventName, onEvent);
    };
    emitter.once(eventName, onEvent);
  });
  promise.cancel = cleanup;
  return promise;
}

function waitForCondition(predicate, timeoutMs = 3000, intervalMs = 15) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function check() {
      let val;
      try {
        val = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (val) {
        resolve(val);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, intervalMs);
    }
    check();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectRawSocket(endpoint) {
  return new Promise((resolve, reject) => {
    const opts = endpoint.ipcPath
      ? { path: endpoint.ipcPath }
      : { host: endpoint.host || '127.0.0.1', port: endpoint.port };
    const sock = net.createConnection(opts);
    const onError = (err) => {
      sock.removeListener('connect', onConnect);
      sock.destroy();
      reject(err);
    };
    const onConnect = () => {
      sock.removeListener('error', onError);
      resolve(sock);
    };
    sock.once('error', onError);
    sock.once('connect', onConnect);
  });
}

async function connectRawAndAwaitAccept(server, endpoint, timeoutMs = 2000) {
  const accepted = waitForEvent(server.server, 'connection', timeoutMs);
  accepted.catch(() => {});
  try {
    const sock = await connectRawSocket(endpoint);
    await accepted;
    return sock;
  } catch (err) {
    accepted.cancel();
    throw err;
  }
}

async function listenWithFallback(node, preferIpc = false, tag = 'srv') {
  if (preferIpc) {
    const ipcPath = makeUniqueIpcPath(tag);
    return await node.listen({ ipcPath });
  }
  return await node.listen({ host: '127.0.0.1', port: 0 });
}

async function runWithServerFallback(makeServer, runFn, tag = 'srv') {
  const tcpServer = makeServer();
  let useIpcFallback = false;
  try {
    const endpoint = await tcpServer.listen({ host: '127.0.0.1', port: 0, allowIpcFallback: false });
    await runFn(tcpServer, endpoint);
  } catch (err) {
    if (!isTcpRestrictedError(err)) {
      throw err;
    }
    useIpcFallback = true;
  } finally {
    await Promise.allSettled([tcpServer.close()]);
  }

  if (useIpcFallback) {
    const ipcServer = makeServer();
    try {
      const endpoint = await ipcServer.listen({ ipcPath: makeUniqueIpcPath(tag) });
      await runFn(ipcServer, endpoint);
    } finally {
      await Promise.allSettled([ipcServer.close()]);
    }
  }
}

/**
 * Creates two live P2PNode instances connected over loopback TCP, automatically
 * falling back to local IPC pipes/sockets if the environment blocks TCP connect with EACCES.
 */
async function createConnectedPair(makeClientOpts = () => ({}), makeServerOpts = () => ({}), config = {}) {
  const { handshake = true, expectedPeerPublicKey, forceIpc = false } = config;

  async function attempt(useIpc) {
    const server = new P2PNode(makeServerOpts());
    const client = new P2PNode(makeClientOpts());
    try {
      const endpoint = await listenWithFallback(server, useIpc, 'pair');
      const socket = await client.connect(endpoint);
      let sessionKey = null;
      if (handshake) {
        const expectedKey = expectedPeerPublicKey !== undefined
          ? expectedPeerPublicKey
          : server.crypto.publicKey;
        sessionKey = await client.initiateHandshake(socket, expectedKey);
      }
      return { client, server, socket, endpoint, sessionKey, transport: endpoint.ipcPath ? 'ipc' : 'tcp' };
    } catch (err) {
      await Promise.allSettled([client.close(), server.close()]);
      throw err;
    }
  }

  if (forceIpc) {
    return await attempt(true);
  }

  try {
    return await attempt(false);
  } catch (err) {
    if (!isTcpRestrictedError(err)) {
      throw err;
    }
    return await attempt(true);
  }
}

/**
 * Starts a raw net.Server proxy forwarding bytes between client and targetEndpoint.
 * Supports byte-level fragmentation, chunk coalescing, wire frame capture, and injection.
 */
async function createWireProxy(targetEndpoint, hooks = {}) {
  const activeSockets = new Set();
  const capturedClientChunks = [];
  const capturedServerChunks = [];

  let c2sHook = hooks.onClientToServer || null;
  let s2cHook = hooks.onServerToClient || null;

  const proxyServer = net.createServer((clientSock) => {
    activeSockets.add(clientSock);
    const upstreamOpts = targetEndpoint.ipcPath
      ? { path: targetEndpoint.ipcPath }
      : { host: targetEndpoint.host || '127.0.0.1', port: targetEndpoint.port };
    const upstreamSock = net.createConnection(upstreamOpts);
    activeSockets.add(upstreamSock);

    let c2sQueue = Promise.resolve();
    const pendingBeforeConnect = [];
    let upstreamReady = false;

    const flushToUpstream = (chunk) => {
      if (c2sHook) {
        c2sQueue = c2sQueue.then(() => c2sHook(chunk, upstreamSock, clientSock)).catch(() => {});
      } else if (!upstreamSock.destroyed && upstreamSock.writable) {
        upstreamSock.write(chunk);
      }
    };

    upstreamSock.once('connect', () => {
      upstreamReady = true;
      for (const buffered of pendingBeforeConnect.splice(0)) {
        flushToUpstream(buffered);
      }
    });

    clientSock.on('data', (chunk) => {
      capturedClientChunks.push(Buffer.from(chunk));
      if (!upstreamReady) {
        pendingBeforeConnect.push(Buffer.from(chunk));
        return;
      }
      flushToUpstream(Buffer.from(chunk));
    });

    upstreamSock.on('data', (chunk) => {
      capturedServerChunks.push(Buffer.from(chunk));
      if (s2cHook) {
        Promise.resolve(s2cHook(Buffer.from(chunk), clientSock, upstreamSock)).catch(() => {});
      } else if (!clientSock.destroyed && clientSock.writable) {
        clientSock.write(chunk);
      }
    });

    const teardown = () => {
      if (!clientSock.destroyed) clientSock.destroy();
      if (!upstreamSock.destroyed) upstreamSock.destroy();
    };

    clientSock.on('error', teardown);
    upstreamSock.on('error', teardown);
    clientSock.on('close', () => {
      activeSockets.delete(clientSock);
      if (!upstreamSock.destroyed) upstreamSock.destroy();
    });
    upstreamSock.on('close', () => {
      activeSockets.delete(upstreamSock);
      if (!clientSock.destroyed) clientSock.destroy();
    });
  });

  const listenIpc = Boolean(targetEndpoint.ipcPath);
  const proxyEndpoint = await new Promise((resolve, reject) => {
    proxyServer.once('error', reject);
    if (listenIpc) {
      const ipcPath = makeUniqueIpcPath('proxy');
      proxyServer.listen(ipcPath, () => {
        proxyServer.removeListener('error', reject);
        resolve({ ipcPath });
      });
    } else {
      proxyServer.listen({ host: '127.0.0.1', port: 0 }, () => {
        proxyServer.removeListener('error', reject);
        const addr = proxyServer.address();
        resolve({ host: addr.address, port: addr.port });
      });
    }
  });

  return {
    endpoint: proxyEndpoint,
    capturedClientChunks,
    capturedServerChunks,
    setHooks(nextHooks = {}) {
      if ('onClientToServer' in nextHooks) c2sHook = nextHooks.onClientToServer;
      if ('onServerToClient' in nextHooks) s2cHook = nextHooks.onServerToClient;
    },
    async close() {
      for (const s of activeSockets) {
        if (!s.destroyed) s.destroy();
      }
      activeSockets.clear();
      await new Promise((resolve) => {
        proxyServer.close(() => resolve());
        if (typeof proxyServer.closeAllConnections === 'function') {
          proxyServer.closeAllConnections();
        }
      });
    }
  };
}

/**
 * Helper to create a server node + proxy + connected client node with IPC fallback on EACCES.
 */
async function createProxiedPair(makeClientOpts = () => ({}), makeServerOpts = () => ({}), hooks = {}, handshake = true) {
  async function attempt(useIpc) {
    const server = new P2PNode(makeServerOpts());
    const client = new P2PNode(makeClientOpts());
    let proxy = null;
    try {
      const serverEndpoint = await listenWithFallback(server, useIpc, 'proxied-srv');
      proxy = await createWireProxy(serverEndpoint, hooks);
      const socket = await client.connect(proxy.endpoint);
      let sessionKey = null;
      if (handshake) {
        sessionKey = await client.initiateHandshake(socket, server.crypto.publicKey);
      }
      return { client, server, proxy, socket, serverEndpoint, sessionKey };
    } catch (err) {
      await Promise.allSettled([
        client.close(),
        server.close(),
        proxy ? proxy.close() : Promise.resolve()
      ]);
      throw err;
    }
  }

  try {
    return await attempt(false);
  } catch (err) {
    if (!isTcpRestrictedError(err)) {
      throw err;
    }
    return await attempt(true);
  }
}

// ============================================================================
// Milestone 5: F24 & F25 — Native P2P TCP Daemon & Ephemeral / IPC Binding
// ============================================================================
describe('Milestone 5 (F24 & F25): Native P2P TCP Daemon, Ephemeral Loopback & IPC Binding', () => {
  test('F24.01 / F25.01 / F25.03 / T2.F25.03: listen() starts with port===null, binds strictly to 127.0.0.1 ephemeral port > 0 and closes cleanly', async () => {
    const node = new P2PNode();
    assert.strictEqual(node.server, null, 'P2PNode.server must be null before listen()');
    assert.strictEqual(node.port, null, 'P2PNode.port must be null before listen()');

    try {
      const info = await node.listen();
      assert.ok(node.server, 'P2PNode.server must be initialized');
      assert.strictEqual(node.server.listening, true, 'Server must enter listening state');
      assert.ok(node.crypto instanceof MeshCryptoEngine);
      assert.strictEqual(node.nodeId, node.crypto.nodeId);

      if (info.ipcPath) {
        // Explicit fallback path if host kernel denied TCP listen via EACCES
        assert.strictEqual(typeof info.ipcPath, 'string');
        assert.ok(info.ipcPath.length > 0);
      } else {
        assert.strictEqual(info.address, '127.0.0.1');
        assert.strictEqual(node.server.address().address, '127.0.0.1');
        assert.ok(Number.isInteger(info.port) && info.port > 0 && info.port <= 65535);
      }
    } finally {
      await node.close();
    }
    assert.strictEqual(node.server.listening, false);
    assert.strictEqual(node.port, null);
  });

  test('F25.02 / F25.04 / T2.F25.01: multiple concurrent nodes allocate distinct ephemeral ports, handle EADDRINUSE, and recycle cleanly', async () => {
    const nodes = Array.from({ length: 4 }, () => new P2PNode({ allowIpcFallback: false }));
    const conflictNode = new P2PNode({ allowIpcFallback: false });
    try {
      let infos;
      try {
        infos = await Promise.all(nodes.map((n) => n.listen()));
      } catch (err) {
        if (isTcpRestrictedError(err)) {
          // Verify IPC fallback across 4 concurrent nodes if TCP bind itself is restricted
          await Promise.allSettled(nodes.map((n) => n.close()));
          const ipcNodes = Array.from({ length: 4 }, () => new P2PNode());
          try {
            const ipcInfos = await Promise.all(
              ipcNodes.map((n, i) => n.listen({ ipcPath: makeUniqueIpcPath(`concurrent-${i}`) }))
            );
            assert.strictEqual(new Set(ipcInfos.map((x) => x.ipcPath)).size, 4);
            // Verify EADDRINUSE on conflicting IPC pipe path
            await assert.rejects(
              () => conflictNode.listen({ ipcPath: ipcInfos[0].ipcPath }),
              (e) => e && e.code === 'EADDRINUSE'
            );
            return;
          } finally {
            await Promise.allSettled(ipcNodes.map((n) => n.close()));
          }
        }
        throw err;
      }

      const ports = infos.map((i) => i.port);
      assert.strictEqual(new Set(ports).size, 4, 'All 4 nodes must bind distinct ephemeral ports');
      for (const info of infos) {
        assert.strictEqual(info.address, '127.0.0.1');
        assert.ok(info.port > 0 && info.port <= 65535);
      }

      // EADDRINUSE on already-bound TCP port when allowIpcFallback === false
      await assert.rejects(
        () => conflictNode.listen({ host: '127.0.0.1', port: infos[0].port, allowIpcFallback: false }),
        (e) => e && e.code === 'EADDRINUSE'
      );

      // Idempotent listen on same node returns existing binding; mismatched port throws AlreadyListeningError
      const sameInfo = await nodes[0].listen();
      assert.strictEqual(sameInfo.port, infos[0].port);
      await assert.rejects(
        () => nodes[0].listen({ port: infos[0].port === 65535 ? 65534 : infos[0].port + 1 }),
        AlreadyListeningError
      );
    } finally {
      await Promise.allSettled([...nodes.map((n) => n.close()), conflictNode.close()]);
      // Calling close() twice must be safe and idempotent
      await Promise.allSettled(nodes.map((n) => n.close()));
    }

    // Re-bind fresh node on port 0 after closing without EADDRINUSE
    const rebound = new P2PNode();
    try {
      const info2 = await rebound.listen();
      assert.strictEqual(rebound.server.listening, true);
      assert.ok(info2.port > 0 || Boolean(info2.ipcPath));
    } finally {
      await rebound.close();
    }
  });

  test('F24.05: explicit ipcPath listener accepts IPC connections and exchanges encrypted messages', async () => {
    const ipcPath = makeUniqueIpcPath('explicit');
    const server = new P2PNode({ ipcPath });
    const client = new P2PNode();

    try {
      const info = await server.listen({ ipcPath });
      assert.strictEqual(info.ipcPath, ipcPath);
      assert.strictEqual(server.server.listening, true);

      const sock = await client.connect({ ipcPath });
      assert.strictEqual(sock.destroyed, false);

      const key = await client.initiateHandshake(sock, server.crypto.publicKey);
      assert.strictEqual(Buffer.isBuffer(key), true);
      assert.strictEqual(key.length, 32);
      assert.strictEqual(client.peers.size, 1);

      const msgPromise = waitForEvent(server, 'message');
      await client.sendEncryptedMessage(server.nodeId, 'IPC_PING', { ok: true, mode: 'ipc' });
      const msg = await msgPromise;
      assert.strictEqual(msg.type, 'IPC_PING');
      assert.deepStrictEqual(msg.payload, { ok: true, mode: 'ipc' });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
    assert.strictEqual(server.server.listening, false);
  });

  test('F24.02 / F24.03 / F24.04: client connects to 3 peers, peers map tracks connections, close() cleans all sockets', async () => {
    let client = new P2PNode();
    let servers = [new P2PNode(), new P2PNode(), new P2PNode()];
    const clientSockets = [];

    try {
      let endpoints = await Promise.all(servers.map((s) => s.listen({ host: '127.0.0.1', port: 0 })));
      try {
        for (let i = 0; i < servers.length; i++) {
          const sock = await client.connect(endpoints[i]);
          clientSockets.push(sock);
          await client.initiateHandshake(sock, servers[i].crypto.publicKey);
        }
      } catch (err) {
        if (!isTcpRestrictedError(err)) throw err;
        await Promise.allSettled([client.close(), ...servers.map((s) => s.close())]);
        clientSockets.length = 0;

        client = new P2PNode();
        servers = [new P2PNode(), new P2PNode(), new P2PNode()];
        endpoints = await Promise.all(
          servers.map((s, idx) => s.listen({ ipcPath: makeUniqueIpcPath(`multi-${idx}`) }))
        );
        for (let i = 0; i < servers.length; i++) {
          const sock = await client.connect(endpoints[i]);
          clientSockets.push(sock);
          await client.initiateHandshake(sock, servers[i].crypto.publicKey);
        }
      }

      assert.strictEqual(client.peers.size, 3, 'Client peers map must track all 3 active peer connections');
      for (const srv of servers) {
        assert.strictEqual(client.peers.has(srv.nodeId), true);
        assert.strictEqual(srv.peers.has(client.nodeId), true);
        const peerInfo = client.peers.get(srv.nodeId);
        assert.strictEqual(peerInfo.state, 'ESTABLISHED');
        assert.strictEqual(peerInfo.socket.destroyed, false);
      }

      // Close client and verify all client sockets and peer entries are cleaned up
      await client.close();
      assert.strictEqual(client.peers.size, 0);
      for (const sock of clientSockets) {
        assert.strictEqual(sock.destroyed, true);
      }
      await waitForCondition(() => servers.every((s) => s.peers.size === 0));
    } finally {
      await Promise.allSettled([client.close(), ...servers.map((s) => s.close())]);
    }
  });

  test('T2.F24.01–04: unreachable endpoint, destroyed socket, abrupt half-open disconnect, and rapid connection burst', async () => {
    const client = new P2PNode();
    try {
      await assert.rejects(
        () => client.connect({ ipcPath: makeUniqueIpcPath('nonexistent') }),
        (err) => err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')
      );
      await assert.rejects(
        () => client.connect({ host: '127.0.0.1', port: 1 }),
        (err) => err && (err.code === 'ECONNREFUSED' || err.code === 'EACCES' || err.code === 'EPERM')
      );
    } finally {
      await client.close();
    }

    const pair = await createConnectedPair();
    try {
      pair.socket.destroy();
      await waitForCondition(() => pair.socket.destroyed);
      await assert.rejects(
        () => pair.client.sendEncryptedMessage(pair.server.nodeId, 'PING', { x: 1 }),
        (err) => err instanceof SocketDestroyedError || /destroyed|not established|Unknown or unconnected/i.test(err.message)
      );
    } finally {
      await Promise.allSettled([pair.client.close(), pair.server.close()]);
    }

    // Half-open disconnect prior to handshake + rapid connection burst (20 sockets) leave no leaked peers/sockets
    await runWithServerFallback(
      () => new P2PNode(),
      async (server, endpoint) => {
        const halfOpen = await connectRawAndAwaitAccept(server, endpoint);
        assert.strictEqual(server._sockets.size, 1);
        halfOpen.destroy();
        await waitForCondition(() => server._sockets.size === 0, 2000);
        assert.strictEqual(server.peers.size, 0);

        let burstSockets = [];
        try {
          if (endpoint.ipcPath && process.platform === 'win32') {
            // Windows Named Pipes pre-arm a bounded CreateNamedPipeW pool in libuv; wait for
            // each server 'connection' event so libuv re-arms the next pipe instance while all 20 stay open.
            for (let i = 0; i < 20; i++) {
              burstSockets.push(await connectRawAndAwaitAccept(server, endpoint));
            }
          } else {
            burstSockets = await Promise.all(
              Array.from({ length: 20 }, () => connectRawSocket(endpoint))
            );
          }
          await waitForCondition(() => server._sockets.size === 20, 2000);
          assert.strictEqual(server.server.listening, true);
        } finally {
          for (const s of burstSockets) {
            if (!s.destroyed) s.destroy();
          }
          await waitForCondition(() => server._sockets.size === 0, 2000);
          assert.strictEqual(server.peers.size, 0);
        }
      },
      'burst'
    );
  });

  test('Peer Churn & Flapping: Rapid connect -> disconnect -> reconnect cycles preserve replay state, event balance, and duplicate socket tie-break', async () => {
    async function runChurn(useIpc) {
      const server = new P2PNode();
      const clientCrypto = new MeshCryptoEngine();
      let serverEp;
      try {
        serverEp = await listenWithFallback(server, useIpc, 'churn-srv');
      } catch (err) {
        await server.close();
        throw err;
      }

      const connectedEvents = [];
      const disconnectedEvents = [];
      server.on('peerConnected', (ev) => connectedEvents.push(ev));
      server.on('peerDisconnected', (ev) => disconnectedEvents.push(ev));

      try {
        // First connection
        let client = new P2PNode({ crypto: clientCrypto });
        let sock = await client.connect(serverEp);
        let sessionKey = await client.initiateHandshake(sock, server.crypto.publicKey);
        assert.strictEqual(sessionKey.length, 32);
        assert.strictEqual(server.peers.size, 1);
        assert.strictEqual(connectedEvents.length, 1);

        let msg1P = waitForEvent(server, 'message');
        await client.sendEncryptedMessage(server.nodeId, 'PING_FLAP_1', { step: 1 });
        const msg1 = await msg1P;
        assert.strictEqual(msg1.type, 'PING_FLAP_1');

        // Abrupt disconnect
        sock.destroy();
        await waitForCondition(() => server.peers.size === 0, 2000);
        assert.strictEqual(disconnectedEvents.length, 1);
        assert.strictEqual(disconnectedEvents[0].peerId, client.nodeId);
        await client.close();

        // Flap reconnect: fresh P2PNode with the EXACT same clientCrypto (same nodeId & key)
        const client2 = new P2PNode({ crypto: clientCrypto });
        try {
          const sock2 = await client2.connect(serverEp);
          const sessionKey2 = await client2.initiateHandshake(sock2, server.crypto.publicKey);
          assert.strictEqual(sessionKey2.length, 32);
          assert.strictEqual(server.peers.size, 1);
          assert.strictEqual(connectedEvents.length, 2);

          // Sequence number restarts from 1 on new socket; server must accept without replay error
          const msg2P = waitForEvent(server, 'message');
          await client2.sendEncryptedMessage(server.nodeId, 'PING_FLAP_2', { step: 2 });
          const msg2 = await msg2P;
          assert.strictEqual(msg2.type, 'PING_FLAP_2');

          // Clean close
          await client2.close();
          await waitForCondition(() => server.peers.size === 0, 2000);
          assert.strictEqual(disconnectedEvents.length, 2);
        } finally {
          await client2.close();
        }

        // 2. Rapid churn loop (4 iterations): verify event balance and zero leaked sockets
        for (let i = 0; i < 4; i++) {
          const churnClient = new P2PNode();
          const churnSock = await churnClient.connect(serverEp);
          await churnClient.initiateHandshake(churnSock, server.crypto.publicKey);
          churnSock.destroy();
          await churnClient.close();
        }
        await waitForCondition(() => server.peers.size === 0, 2000);
        assert.strictEqual(connectedEvents.length, 6);
        assert.strictEqual(disconnectedEvents.length, 6);
        assert.strictEqual(server._sockets.size, 0);
      } finally {
        await server.close();
      }
    }

    try {
      await runChurn(false);
    } catch (err) {
      if (!isTcpRestrictedError(err)) throw err;
      await runChurn(true);
    }
  });
});

// ============================================================================
// Milestone 5: F26 — Length-Prefixed Wire Stream Framing Resilience
// ============================================================================
describe('Milestone 5 (F26): Length-Prefixed Wire Framing Resilience', () => {
  test('F26.01 / F26.02: 4-byte big-endian length prefix encoding and outbound maxFrameSize guard', () => {
    const msg = { type: 'PING', data: 'hello-world', seq: 1 };
    const encoded = P2PNode.encodeFrame(msg, 4096);
    const bodyLen = encoded.readUInt32BE(0);
    assert.strictEqual(bodyLen, encoded.length - 4);
    assert.deepStrictEqual(JSON.parse(encoded.subarray(4).toString('utf8')), msg);

    assert.throws(
      () => P2PNode.encodeFrame({ data: 'x'.repeat(256) }, 64),
      (err) => err instanceof FrameTooLargeError && err.code === 'ERR_FRAME_TOO_LARGE'
    );
  });

  test('F26.03 / T2.F26.05: fragmented 1-byte wire writes reassemble cleanly for handshake and encrypted frames', async () => {
    const fragment1ByteHook = async (chunk, upstreamSock) => {
      for (let i = 0; i < chunk.length; i++) {
        if (upstreamSock.destroyed || !upstreamSock.writable) break;
        upstreamSock.write(chunk.subarray(i, i + 1));
        if (i % 16 === 0) {
          await delay(1);
        }
      }
    };

    const { client, server, proxy } = await createProxiedPair(
      () => ({ handshakeTimeoutMs: 8000 }),
      () => ({ handshakeTimeoutMs: 8000 }),
      { onClientToServer: fragment1ByteHook },
      true
    );

    try {
      // Handshake itself succeeded despite every byte arriving individually!
      const keyC = client.getSessionKey(server.nodeId);
      const keyS = server.getSessionKey(client.nodeId);
      assert.strictEqual(Buffer.isBuffer(keyC), true);
      assert.strictEqual(keyC.length, 32);
      assert.strictEqual(keyC.toString('hex'), keyS.toString('hex'));

      // Also verify outgoing wire frame header invariant on captured bytes
      assert.ok(proxy.capturedClientChunks.length > 0);
      const allClientWire = Buffer.concat(proxy.capturedClientChunks);
      assert.ok(allClientWire.length >= 4);
      const firstFrameLen = allClientWire.readUInt32BE(0);
      assert.ok(firstFrameLen > 0 && allClientWire.length >= 4 + firstFrameLen);
      const firstFrameObj = JSON.parse(allClientWire.subarray(4, 4 + firstFrameLen).toString('utf8'));
      assert.strictEqual(firstFrameObj.type, 'HANDSHAKE');

      const received = waitForEvent(server, 'message', 5000);
      await client.sendEncryptedMessage(server.nodeId, 'FRAGMENTED_TEST', { text: '1-byte-chunks', n: 42 });
      const msg = await received;
      assert.strictEqual(msg.type, 'FRAGMENTED_TEST');
      assert.deepStrictEqual(msg.payload, { text: '1-byte-chunks', n: 42 });
    } finally {
      await Promise.allSettled([client.close(), server.close(), proxy.close()]);
    }
  });

  test('F26.04: coalesced multi-message frames in single chunk AND split frame boundaries emit distinct messages', async () => {
    const { client, server, proxy } = await createProxiedPair();

    try {
      const received = [];
      server.on('message', (msg) => {
        if (msg.type === 'BATCH_ITEM') {
          received.push(msg.payload);
        }
      });

      // Buffer frames from client until 3 complete length-prefixed frames arrive,
      // then flush frames 1+2+half-of-3 in ONE write, and remainder of frame 3 in second write.
      let accum = Buffer.alloc(0);
      let flushed = false;
      proxy.setHooks({
        onClientToServer(chunk, upstreamSock) {
          accum = Buffer.concat([accum, chunk]);
          if (flushed) {
            if (!upstreamSock.destroyed) upstreamSock.write(chunk);
            return;
          }

          // Check if 3 full frames are in accum
          let offset = 0;
          let frameCount = 0;
          while (offset + 4 <= accum.length) {
            const len = accum.readUInt32BE(offset);
            if (offset + 4 + len > accum.length) break;
            offset += 4 + len;
            frameCount += 1;
          }

          if (frameCount >= 3) {
            flushed = true;
            const allThree = accum.subarray(0, offset);
            const splitPoint = offset - 10; // deliberately split inside the 3rd frame!
            const firstCoalescedPacket = allThree.subarray(0, splitPoint);
            const trailingFragment = allThree.subarray(splitPoint);
            const leftover = accum.subarray(offset);
            accum = Buffer.alloc(0);

            if (!upstreamSock.destroyed) {
              upstreamSock.write(firstCoalescedPacket);
              setImmediate(() => {
                if (!upstreamSock.destroyed) {
                  upstreamSock.write(Buffer.concat([trailingFragment, leftover]));
                }
              });
            }
          }
        }
      });

      await client.sendEncryptedMessage(server.nodeId, 'BATCH_ITEM', { idx: 0 });
      await client.sendEncryptedMessage(server.nodeId, 'BATCH_ITEM', { idx: 1 });
      await client.sendEncryptedMessage(server.nodeId, 'BATCH_ITEM', { idx: 2 });

      await waitForCondition(() => received.length === 3, 3000);
      assert.deepStrictEqual(received, [{ idx: 0 }, { idx: 1 }, { idx: 2 }]);
    } finally {
      await Promise.allSettled([client.close(), server.close(), proxy.close()]);
    }
  });

  test('F26.05 / T2.F26.03: oversized frame length header (> maxFrameSize and 2GB 0x7FFFFFFF) fails closed without OOM', async () => {
    await runWithServerFallback(
      () => new P2PNode({ maxFrameSize: 1024 }),
      async (customServer, endpoint1) => {
        const wireErrorsCustom = [];
        customServer.on('wireError', (err) => wireErrorsCustom.push(err));
        const sock1 = await connectRawSocket(endpoint1);
        try {
          const closedPromise = waitForEvent(sock1, 'close', 2000);
          const oversizedHeader = Buffer.alloc(12);
          oversizedHeader.writeUInt32BE(2048, 0); // > 1024 maxFrameSize
          oversizedHeader.write('deadbeef', 4, 'utf8');
          sock1.write(oversizedHeader);
          await closedPromise;

          assert.strictEqual(sock1.destroyed, true);
          assert.ok(wireErrorsCustom.some((e) => e instanceof FrameTooLargeError && e.code === 'ERR_FRAME_TOO_LARGE'));
          assert.strictEqual(customServer.server.listening, true);
        } finally {
          if (!sock1.destroyed) sock1.destroy();
        }
      },
      'oversize-custom'
    );

    // Verify 0x7FFFFFFF (~2GB) header fails closed immediately on default P2PNode without OOM
    await runWithServerFallback(
      () => new P2PNode(),
      async (defaultServer, endpoint2) => {
        const wireErrorsDefault = [];
        defaultServer.on('wireError', (err) => wireErrorsDefault.push(err));
        const sock2 = await connectRawSocket(endpoint2);
        try {
          const closedPromise2 = waitForEvent(sock2, 'close', 2000);
          const giantHeader = Buffer.alloc(12);
          giantHeader.writeUInt32BE(0x7FFFFFFF, 0);
          giantHeader.write('deadbeef', 4, 'utf8');
          sock2.write(giantHeader);
          await closedPromise2;

          assert.strictEqual(sock2.destroyed, true);
          assert.ok(wireErrorsDefault.some((e) => e instanceof FrameTooLargeError && e.code === 'ERR_FRAME_TOO_LARGE'));
          assert.strictEqual(defaultServer.server.listening, true);
        } finally {
          if (!sock2.destroyed) sock2.destroy();
        }
      },
      'oversize-2gb'
    );
  });

  test('T2.F26.01 / T2.F26.02 / T2.F26.04: zero-length keepalive ignored, truncated header, non-object array & malformed JSON handled fail-closed', async () => {
    await runWithServerFallback(
      () => new P2PNode(),
      async (server, endpoint) => {
        const client = new P2PNode();
        const wireErrors = [];
        server.on('wireError', (err) => wireErrors.push(err));
        const rawSockets = [];

        try {
          // 1. Malformed JSON -> ERR_INVALID_WIRE_JSON
          const badSock = await connectRawSocket(endpoint);
          rawSockets.push(badSock);
          const closeBad = waitForEvent(badSock, 'close', 2000);
          const badBody = Buffer.from('{not valid json!', 'utf8');
          const badHdr = Buffer.alloc(4);
          badHdr.writeUInt32BE(badBody.length, 0);
          badSock.write(Buffer.concat([badHdr, badBody]));
          await closeBad;
          assert.strictEqual(badSock.destroyed, true);
          assert.ok(wireErrors.some((e) => e.code === 'ERR_INVALID_WIRE_JSON'));

          // 2. JSON array instead of object -> ERR_INVALID_WIRE_FRAME
          const arrSock = await connectRawSocket(endpoint);
          rawSockets.push(arrSock);
          const closeArr = waitForEvent(arrSock, 'close', 2000);
          const arrBody = Buffer.from('[1,2,3]', 'utf8');
          const arrHdr = Buffer.alloc(4);
          arrHdr.writeUInt32BE(arrBody.length, 0);
          arrSock.write(Buffer.concat([arrHdr, arrBody]));
          await closeArr;
          assert.strictEqual(arrSock.destroyed, true);
          assert.ok(wireErrors.some((e) => e.code === 'ERR_INVALID_WIRE_FRAME'));

          // 3. Truncated 2-byte header then disconnect
          const truncSock = await connectRawSocket(endpoint);
          rawSockets.push(truncSock);
          const closeTrunc = waitForEvent(truncSock, 'close', 2000);
          truncSock.end(Buffer.from([0x00, 0x01]));
          await closeTrunc;
          assert.strictEqual(server.server.listening, true);

          // 4. Zero-length keepalive header followed by valid handshake succeeds
          const validSock = await client.connect(endpoint);
          validSock.write(Buffer.from([0x00, 0x00, 0x00, 0x00]));
          const key = await client.initiateHandshake(validSock, server.crypto.publicKey);
          assert.strictEqual(key.length, 32);
        } finally {
          for (const s of rawSockets) {
            if (s && !s.destroyed) s.destroy();
          }
          await Promise.allSettled([client.close()]);
        }
      },
      'badjson'
    );
  });

  test('Binary Wire Framing: node:v8 serialization, malformed v8 payload fail-closed, and non-object array rejection', async () => {
    // 1. Static encode / decode with format = 'v8'
    const obj = { kind: 'DATA', num: 12345, buf: Buffer.from('v8-test') };
    const encodedV8 = P2PNode.encodeFrame(obj, 4096, 'v8');
    const len = encodedV8.readUInt32BE(0);
    assert.strictEqual(len, encodedV8.length - 4);
    assert.strictEqual(encodedV8[4], 0x02); // 0x02 format tag
    const decodedV8 = P2PNode.decodeWireBody(encodedV8.subarray(4));
    assert.strictEqual(decodedV8.isStream, false);
    assert.strictEqual(decodedV8.data.kind, 'DATA');
    assert.strictEqual(decodedV8.data.num, 12345);
    assert.deepStrictEqual(decodedV8.data.buf, Buffer.from('v8-test'));

    // 2. Live connected pair using useV8Serialization: true
    const { client, server } = await createConnectedPair(
      () => ({ useV8Serialization: true }),
      () => ({ useV8Serialization: true })
    );

    try {
      const pMsg = waitForEvent(server, 'message');
      await client.sendEncryptedMessage(server.nodeId, 'V8_TEST', { test: 'binary-v8-payload', count: 99 });
      const received = await pMsg;
      assert.strictEqual(received.type, 'V8_TEST');
      assert.deepStrictEqual(received.payload, { test: 'binary-v8-payload', count: 99 });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }

    // 3. Raw socket sends corrupted v8 frame (0x02 followed by garbage) -> ERR_INVALID_WIRE_JSON
    await runWithServerFallback(
      () => new P2PNode(),
      async (serverNode, ep) => {
        const wireErrors = [];
        serverNode.on('wireError', (err) => wireErrors.push(err));
        const sock = await connectRawSocket(ep);
        try {
          const closeP = waitForEvent(sock, 'close', 2000);
          const garbage = Buffer.from([0x02, 0xff, 0xff, 0xff, 0xff, 0x00, 0x12]);
          const hdr = Buffer.alloc(4);
          hdr.writeUInt32BE(garbage.length, 0);
          sock.write(Buffer.concat([hdr, garbage]));
          await closeP;
          assert.strictEqual(sock.destroyed, true);
          assert.ok(wireErrors.some((e) => e.code === 'ERR_INVALID_WIRE_JSON'));
        } finally {
          if (!sock.destroyed) sock.destroy();
        }
      },
      'v8-corrupt'
    );
  });

  test('Binary Framing Security & Boundaries: unauthenticated stream frame rejection, coalesced 0-length keepalives, and exact maxFrameSize', async () => {
    // 1. Unauthenticated stream frame (STREAM_FRAME_TAG = 0x03) before handshake fails closed with SecurityError
    await runWithServerFallback(
      () => new P2PNode(),
      async (serverNode, ep) => {
        const wireErrors = [];
        serverNode.on('wireError', (err) => wireErrors.push(err));
        const sock = await connectRawSocket(ep);
        try {
          const closeP = waitForEvent(sock, 'close', 2000);
          const streamFrame = P2PNode.encodeStreamFrame(1, Buffer.from('unauth-stream-data'));
          sock.write(streamFrame);
          await closeP;
          assert.strictEqual(sock.destroyed, true);
          assert.ok(wireErrors.some((e) => e instanceof SecurityError && e.code === 'ERR_UNAUTHENTICATED_STREAM_FRAME'));
        } finally {
          if (!sock.destroyed) sock.destroy();
        }
      },
      'stream-unauth'
    );

    // 2. Coalesced zero-length keepalives directly preceding valid handshake in single write chunk
    await runWithServerFallback(
      () => new P2PNode(),
      async (serverNode, ep) => {
        const client = new P2PNode();
        try {
          const clientSock = await client.connect(ep);
          const keepalives = Buffer.concat([
            Buffer.from([0x00, 0x00, 0x00, 0x00]),
            Buffer.from([0x00, 0x00, 0x00, 0x00]),
            Buffer.from([0x00, 0x00, 0x00, 0x00])
          ]);
          clientSock.write(keepalives);
          const key = await client.initiateHandshake(clientSock, serverNode.crypto.publicKey);
          assert.strictEqual(key.length, 32);
          assert.strictEqual(serverNode.peers.size, 1);
        } finally {
          await client.close();
        }
      },
      'coalesced-keepalives'
    );

    // 3. Exact maxFrameSize boundary condition (payload length === maxFrameSize succeeds, maxFrameSize + 1 throws)
    const exactPayload = { text: 'a'.repeat(90) };
    const sampleFrame = P2PNode.encodeFrame(exactPayload);
    const exactBodyLen = sampleFrame.length - 4;
    const okFrame = P2PNode.encodeFrame(exactPayload, exactBodyLen);
    assert.strictEqual(okFrame.readUInt32BE(0), exactBodyLen);
    assert.throws(
      () => P2PNode.encodeFrame(exactPayload, exactBodyLen - 1),
      (err) => err instanceof FrameTooLargeError
    );

    // 4. 4GB unsigned length header 0xFFFFFFFF fails closed without OOM
    await runWithServerFallback(
      () => new P2PNode(),
      async (serverNode, ep) => {
        const sock = await connectRawSocket(ep);
        try {
          const closeP = waitForEvent(sock, 'close', 2000);
          sock.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01]));
          await closeP;
          assert.strictEqual(sock.destroyed, true);
        } finally {
          if (!sock.destroyed) sock.destroy();
        }
      },
      'header-4gb'
    );
  });
});

// ============================================================================
// Milestone 5: F27 — Live 2-Way Ephemeral ECDH + HKDF-SHA512 Handshake & Rotation
// ============================================================================
describe('Milestone 5 (F27): Live 2-Way Ephemeral ECDH + HKDF-SHA512 Handshake & Key Rotation', () => {
  test('F27.01–04: live 2-way handshake derives identical 32-byte HKDF-SHA512 session keys and establishes session', async () => {
    const { client, server, sessionKey } = await createConnectedPair();
    try {
      assert.strictEqual(Buffer.isBuffer(sessionKey), true);
      assert.strictEqual(sessionKey.length, 32);

      const keyClient = client.getSessionKey(server.nodeId);
      const keyServer = server.getSessionKey(client.nodeId);
      assert.strictEqual(Buffer.isBuffer(keyClient), true);
      assert.strictEqual(Buffer.isBuffer(keyServer), true);
      assert.strictEqual(keyClient.toString('hex'), sessionKey.toString('hex'));
      assert.strictEqual(keyClient.toString('hex'), keyServer.toString('hex'));

      // Verify derived session key is HKDF-SHA512 (not legacy SHA-256 deriveSharedKey)
      const legacyKey = client.crypto.deriveSharedKey(server.crypto.publicKey);
      assert.notStrictEqual(keyClient.toString('hex'), legacyKey.toString('hex'));

      const peerOnClient = client.getPeer(server.nodeId);
      const peerOnServer = server.getPeer(client.nodeId);
      assert.strictEqual(peerOnClient.state, 'ESTABLISHED');
      assert.strictEqual(peerOnServer.state, 'ESTABLISHED');

      // Bidirectional encrypted message check
      const srvPromise = waitForEvent(server, 'message');
      await client.sendEncryptedMessage(server.nodeId, 'PING', { dir: 'c2s' });
      const c2sMsg = await srvPromise;
      assert.deepStrictEqual(c2sMsg.payload, { dir: 'c2s' });

      const cliPromise = waitForEvent(client, 'message');
      await server.sendEncryptedMessage(client.nodeId, 'PONG', { dir: 's2c' });
      const s2cMsg = await cliPromise;
      assert.deepStrictEqual(s2cMsg.payload, { dir: 's2c' });
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  test('F27 MITM Defense: mismatched expectedPeerPublicKey fails closed and destroys socket', async () => {
    const attacker = new MeshCryptoEngine();
    const { client, server, socket } = await createConnectedPair(
      () => ({}),
      () => ({}),
      { handshake: false }
    );
    client.on('wireError', () => {});
    server.on('wireError', () => {});

    try {
      await assert.rejects(
        () => client.initiateHandshake(socket, attacker.publicKey),
        /expectedPeerPublicKey|mismatch/i
      );
      await waitForCondition(() => socket.destroyed);
      assert.strictEqual(socket.destroyed, true);
      assert.strictEqual(client.peers.has(server.nodeId), false);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }

    // Also simulate active wire MITM replacing publicKey inside HANDSHAKE_ACK in transit
    let s2cAccum = Buffer.alloc(0);
    const { client: c2, server: s2, proxy, socket: sock2 } = await createProxiedPair(
      () => ({}),
      () => ({}),
      {
        onServerToClient(chunk, clientSock) {
          s2cAccum = Buffer.concat([s2cAccum, chunk]);
          while (s2cAccum.length >= 4) {
            const len = s2cAccum.readUInt32BE(0);
            if (s2cAccum.length < 4 + len) break;
            const fullFrame = s2cAccum.subarray(0, 4 + len);
            s2cAccum = s2cAccum.subarray(4 + len);
            const msg = JSON.parse(fullFrame.subarray(4).toString('utf8'));
            if (msg.type === 'HANDSHAKE_ACK') {
              msg.publicKey = attacker.publicKey;
              if (!clientSock.destroyed) clientSock.write(P2PNode.encodeFrame(msg));
            } else if (!clientSock.destroyed) {
              clientSock.write(fullFrame);
            }
          }
        }
      },
      false
    );
    c2.on('wireError', () => {});
    s2.on('wireError', () => {});

    try {
      await assert.rejects(
        () => c2.initiateHandshake(sock2, s2.crypto.publicKey),
        /expectedPeerPublicKey|mismatch/i
      );
      await waitForCondition(() => sock2.destroyed);
      assert.strictEqual(c2.peers.has(s2.nodeId), false);
    } finally {
      await Promise.allSettled([c2.close(), s2.close(), proxy.close()]);
    }
  });

  test('T1.F27.05 / T2.F27.01–04: rejects unauthenticated frames, bad keys, stale/replayed handshakes, timeout, and resolves simultaneous dial', async () => {
    // 1. Handshake timeout against silent server
    const silentServer = net.createServer(() => {});
    const silentSockets = new Set();
    silentServer.on('connection', (s) => silentSockets.add(s));
    const timeoutClient = new P2PNode({ handshakeTimeoutMs: 120 });
    timeoutClient.on('wireError', () => {});

    try {
      let silentEp;
      let sClientSock;
      try {
        silentEp = await new Promise((resolve, reject) => {
          silentServer.once('error', reject);
          silentServer.listen({ host: '127.0.0.1', port: 0 }, () => {
            silentServer.removeListener('error', reject);
            const a = silentServer.address();
            resolve({ host: a.address, port: a.port });
          });
        });
        sClientSock = await timeoutClient.connect(silentEp);
      } catch (err) {
        if (!isTcpRestrictedError(err)) throw err;
        await new Promise((r) => silentServer.close(r));
        const ipcSilent = net.createServer((s) => silentSockets.add(s));
        const ipcPath = makeUniqueIpcPath('silent');
        await new Promise((resolve) => ipcSilent.listen(ipcPath, resolve));
        try {
          sClientSock = await timeoutClient.connect({ ipcPath });
          await assert.rejects(
            () => timeoutClient.initiateHandshake(sClientSock),
            (e) => e instanceof HandshakeTimeoutError && e.code === 'ERR_HANDSHAKE_TIMEOUT'
          );
          await waitForCondition(() => sClientSock.destroyed);
        } finally {
          for (const s of silentSockets) if (!s.destroyed) s.destroy();
          await new Promise((r) => ipcSilent.close(r));
        }
        sClientSock = null;
      }

      if (sClientSock) {
        await assert.rejects(
          () => timeoutClient.initiateHandshake(sClientSock),
          (e) => e instanceof HandshakeTimeoutError && e.code === 'ERR_HANDSHAKE_TIMEOUT'
        );
        await waitForCondition(() => sClientSock.destroyed);
      }
    } finally {
      for (const s of silentSockets) if (!s.destroyed) s.destroy();
      await new Promise((r) => {
        if (!silentServer.listening) return r();
        silentServer.close(() => r());
      });
      await timeoutClient.close();
    }

    // 2. Pre-handshake ENCRYPTED frame, corrupt publicKey, stale handshake, replayed handshake fail closed
    const pair = await createConnectedPair(() => ({}), () => ({}), { handshake: false });
    const serverErrors = [];
    pair.server.on('wireError', (e) => serverErrors.push(e));
    const rawSockets = [];

    try {
      // Unauthenticated ENCRYPTED frame before handshake
      const closePreAuth = waitForEvent(pair.socket, 'close', 2000);
      pair.socket.write(P2PNode.encodeFrame({ kind: 'ENCRYPTED', senderId: pair.client.nodeId, msgType: 'PING', epoch: 1, packet: {} }));
      await closePreAuth;
      assert.strictEqual(pair.socket.destroyed, true);

      // Corrupt public key in HANDSHAKE
      const badKeySock = await connectRawSocket(pair.endpoint);
      rawSockets.push(badKeySock);
      const closeBadKey = waitForEvent(badKeySock, 'close', 2000);
      badKeySock.write(P2PNode.encodeFrame({
        type: 'HANDSHAKE',
        nodeId: 'a'.repeat(40),
        publicKey: '04' + 'z'.repeat(128),
        epoch: 1,
        timestamp: Date.now(),
        nonce: 'n-bad-key'
      }));
      await closeBadKey;
      assert.strictEqual(badKeySock.destroyed, true);

      // Stale handshake timestamp (> 60s old)
      const staleSock = await connectRawSocket(pair.endpoint);
      rawSockets.push(staleSock);
      const closeStale = waitForEvent(staleSock, 'close', 2000);
      const tempEngine = new MeshCryptoEngine();
      staleSock.write(P2PNode.encodeFrame({
        type: 'HANDSHAKE',
        nodeId: tempEngine.nodeId,
        publicKey: tempEngine.publicKey,
        epoch: 1,
        timestamp: Date.now() - 120_000,
        nonce: 'n-stale'
      }));
      await closeStale;
      assert.strictEqual(staleSock.destroyed, true);

      // Replayed HANDSHAKE frame (same nodeId + nonce)
      const hsFrame = P2PNode.encodeFrame({
        type: 'HANDSHAKE',
        nodeId: tempEngine.nodeId,
        publicKey: tempEngine.publicKey,
        epoch: 1,
        timestamp: Date.now(),
        nonce: 'n-replay-hs'
      });
      const sockFirst = await connectRawSocket(pair.endpoint);
      rawSockets.push(sockFirst);
      const ackPromise = waitForEvent(sockFirst, 'data', 2000);
      sockFirst.write(hsFrame);
      await ackPromise;

      const sockReplay = await connectRawSocket(pair.endpoint);
      rawSockets.push(sockReplay);
      const closeReplay = waitForEvent(sockReplay, 'close', 2000);
      sockReplay.write(hsFrame);
      await closeReplay;
      assert.strictEqual(sockReplay.destroyed, true);
      assert.ok(serverErrors.some((e) => /Replayed handshake|timestamp drift|invalid elliptic curve|before handshake/i.test(e.message)));
    } finally {
      for (const s of rawSockets) if (!s.destroyed) s.destroy();
      await Promise.allSettled([pair.client.close(), pair.server.close()]);
    }

    // 3. Simultaneous bidirectional handshake between two nodes
    const nodeA = new P2PNode();
    const nodeB = new P2PNode();
    try {
      let epA = await nodeA.listen({ host: '127.0.0.1', port: 0 });
      let epB = await nodeB.listen({ host: '127.0.0.1', port: 0 });
      let sockAB;
      let sockBA;
      try {
        [sockAB, sockBA] = await Promise.all([nodeA.connect(epB), nodeB.connect(epA)]);
      } catch (err) {
        if (!isTcpRestrictedError(err)) throw err;
        await Promise.allSettled([nodeA.close(), nodeB.close()]);
        const ipcA = new P2PNode();
        const ipcB = new P2PNode();
        try {
          epA = await ipcA.listen({ ipcPath: makeUniqueIpcPath('sim-a') });
          epB = await ipcB.listen({ ipcPath: makeUniqueIpcPath('sim-b') });
          const [sAB, sBA] = await Promise.all([ipcA.connect(epB), ipcB.connect(epA)]);
          const [kA, kB] = await Promise.all([
            ipcA.initiateHandshake(sAB, ipcB.crypto.publicKey),
            ipcB.initiateHandshake(sBA, ipcA.crypto.publicKey)
          ]);
          assert.strictEqual(kA.length, 32);
          assert.strictEqual(kB.length, 32);
          assert.strictEqual(ipcA.peers.size, 1);
          assert.strictEqual(ipcB.peers.size, 1);
          assert.strictEqual(ipcA.getSessionKey(ipcB.nodeId).toString('hex'), ipcB.getSessionKey(ipcA.nodeId).toString('hex'));
        } finally {
          await Promise.allSettled([ipcA.close(), ipcB.close()]);
        }
        return;
      }

      const [kA, kB] = await Promise.all([
        nodeA.initiateHandshake(sockAB, nodeB.crypto.publicKey),
        nodeB.initiateHandshake(sockBA, nodeA.crypto.publicKey)
      ]);
      assert.strictEqual(kA.length, 32);
      assert.strictEqual(kB.length, 32);
      assert.strictEqual(nodeA.peers.size, 1);
      assert.strictEqual(nodeB.peers.size, 1);
      assert.strictEqual(nodeA.getSessionKey(nodeB.nodeId).toString('hex'), nodeB.getSessionKey(nodeA.nodeId).toString('hex'));
    } finally {
      await Promise.allSettled([nodeA.close(), nodeB.close()]);
    }
  });

  test('F27 KEY_ROTATE: epoch key rotation updates session keys cleanly on both peers and rejects stale epoch frames', async () => {
    const { client, server, sessionKey: initialKey } = await createConnectedPair();
    try {
      const serverRotateEvents = [];
      const clientRotateEvents = [];
      server.on('keyRotated', (ev) => serverRotateEvents.push(ev));
      client.on('keyRotated', (ev) => clientRotateEvents.push(ev));

      const epoch1Key = Buffer.from(initialKey);
      const rotatedKey = await client.rotateSessionKey(server.nodeId);

      assert.strictEqual(Buffer.isBuffer(rotatedKey), true);
      assert.strictEqual(rotatedKey.length, 32);
      assert.notStrictEqual(rotatedKey.toString('hex'), epoch1Key.toString('hex'));

      assert.strictEqual(client.getSessionKey(server.nodeId).toString('hex'), rotatedKey.toString('hex'));
      assert.strictEqual(server.getSessionKey(client.nodeId).toString('hex'), rotatedKey.toString('hex'));
      assert.strictEqual(client.getPeer(server.nodeId).epoch, 2);
      assert.strictEqual(server.getPeer(client.nodeId).epoch, 2);
      assert.strictEqual(clientRotateEvents.length, 1);
      assert.strictEqual(serverRotateEvents.length, 1);

      // Bidirectional encrypted communication works under the rotated epoch 2 key
      const pServerMsg = waitForEvent(server, 'message');
      await client.sendEncryptedMessage(server.nodeId, 'POST_ROTATE', { epoch: 2 });
      assert.deepStrictEqual((await pServerMsg).payload, { epoch: 2 });

      const pClientMsg = waitForEvent(client, 'message');
      await server.sendEncryptedMessage(client.nodeId, 'POST_ROTATE_ACK', { ok: true });
      assert.deepStrictEqual((await pClientMsg).payload, { ok: true });

      // Old epoch 1 key can no longer decrypt rotated frames, and forged epoch 1 frames are rejected
      const srvErrors = [];
      server.on('wireError', (e) => srvErrors.push(e));
      const staleEpochPkt = client.crypto.encryptShard(
        { type: 'STALE_EPOCH', payload: { hacked: true } },
        epoch1Key,
        { aad: `${client.nodeId}:${server.nodeId}:STALE_EPOCH`, epoch: 1 }
      );
      const clientPeerSock = client.getPeer(server.nodeId).socket;
      clientPeerSock.write(P2PNode.encodeFrame({
        kind: 'ENCRYPTED',
        senderId: client.nodeId,
        msgType: 'STALE_EPOCH',
        epoch: 1,
        packet: staleEpochPkt
      }));
      await waitForCondition(() => srvErrors.some((e) => /Epoch mismatch/i.test(e.message)));

      // Rotate again to epoch 5 explicitly
      const epoch5Key = await server.rotateSessionKey(client.nodeId, 5);
      assert.strictEqual(epoch5Key.length, 32);
      assert.notStrictEqual(epoch5Key.toString('hex'), rotatedKey.toString('hex'));
      assert.strictEqual(client.getPeer(server.nodeId).epoch, 5);
      assert.strictEqual(server.getPeer(client.nodeId).epoch, 5);

      // Non-increasing epoch must reject fail-closed without mutating session key
      await assert.rejects(() => client.rotateSessionKey(server.nodeId, 5), RangeError);
      assert.strictEqual(client.getSessionKey(server.nodeId).toString('hex'), epoch5Key.toString('hex'));
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});

// ============================================================================
// Milestone 5: F28 — Encrypted Shard Streaming, PoC Delivery, Anti-Replay & Load-Shedding
// ============================================================================
describe('Milestone 5 (F28): Encrypted Shard Streaming, PoC Delivery, Anti-Replay & Load-Shedding', () => {
  test('F28.01–03: coordinator streams AES-256-GCM encrypted shards -> worker sandbox executes -> returns verified PoC results', async () => {
    const { client: coordinator, server: worker, proxy, sessionKey } = await createProxiedPair(
      () => ({}),
      () => ({ sandbox: new StandbySandbox(), enforceTelemetry: false })
    );

    try {
      const router = new GridRouter(coordinator.nodeId);
      const taskCode = 'return data.reduce((a, b) => a + b, 0);';
      const shards = router.createTaskPartitions(taskCode, [10, 20, 30, 40, 50, 60], 2);
      assert.strictEqual(shards.length, 3);

      // Dispatch shards concurrently over live encrypted socket
      const results = await Promise.all(
        shards.map((shard) => coordinator.dispatchRemoteShard(worker.nodeId, shard))
      );

      assert.strictEqual(results.length, 3);

      // Verify each PoC signature explicitly and aggregate ordered outputs
      const forAggregation = results.map((res, idx) => {
        const expectedShard = shards[idx];
        assert.strictEqual(res.shardId, expectedShard.shardId);
        assert.strictEqual(res.workerId, worker.nodeId);
        assert.strictEqual(typeof res.proofOfCompute, 'string');
        assert.strictEqual(res.proofOfCompute.length, 64);
        assert.strictEqual(
          coordinator.crypto.verifyProofOfCompute(res.shardId, res.output, res.proofOfCompute, sessionKey),
          true,
          'Coordinator must verify worker HMAC-SHA256 Proof-of-Compute signature'
        );
        return { shardId: res.shardId, index: expectedShard.index, output: res.output };
      });

      assert.deepStrictEqual(router.aggregateResults(forAggregation), [30, 70, 110]);

      // Confirm wire traffic was AES-256-GCM encrypted (no plaintext taskCode or inputData leaked on wire)
      const wireData = Buffer.concat(proxy.capturedClientChunks).toString('utf8');
      assert.strictEqual(wireData.includes('data.reduce'), false, 'Task code must NEVER appear in plaintext on wire');
      assert.strictEqual(wireData.includes('"kind":"ENCRYPTED"'), true);
    } finally {
      await Promise.allSettled([coordinator.close(), worker.close(), proxy.close()]);
    }
  });

  test('F28 Anti-Replay & Tampering: replaying captured encrypted packet or tampering ciphertext/authTag/timestamp fails closed', async () => {
    // 1. Live wire replay of captured encrypted shard frame
    {
      let sandboxCalls = 0;
      const spySandbox = {
        executeIsolatedShard(shard) {
          sandboxCalls += 1;
          return new StandbySandbox().executeIsolatedShard(shard);
        }
      };

      const { client, server, proxy } = await createProxiedPair(
        () => ({}),
        () => ({ sandbox: spySandbox, enforceTelemetry: false })
      );

      const srvReplayEvents = [];
      const srvWireErrors = [];
      server.on('replayRejected', (ev) => srvReplayEvents.push(ev));
      server.on('wireError', (err) => srvWireErrors.push(err));

      try {
        let capturedEncryptedFrame = null;
        let upstreamSocketRef = null;
        let accum = Buffer.alloc(0);

        proxy.setHooks({
          onClientToServer(chunk, upstreamSock) {
            upstreamSocketRef = upstreamSock;
            accum = Buffer.concat([accum, chunk]);
            while (accum.length >= 4) {
              const len = accum.readUInt32BE(0);
              if (accum.length < 4 + len) break;
              const fullFrame = accum.subarray(0, 4 + len);
              accum = accum.subarray(4 + len);
              const parsed = JSON.parse(fullFrame.subarray(4).toString('utf8'));
              if (parsed.kind === 'ENCRYPTED' && !capturedEncryptedFrame) {
                capturedEncryptedFrame = Buffer.from(fullFrame);
              }
              if (!upstreamSock.destroyed) upstreamSock.write(fullFrame);
            }
          }
        });

        const router = new GridRouter(client.nodeId);
        const [shard] = router.createTaskPartitions('return data[0] * 2;', [21], 1);
        const res = await client.dispatchRemoteShard(server.nodeId, shard);
        assert.strictEqual(res.output, 42);
        assert.strictEqual(sandboxCalls, 1);
        assert.ok(capturedEncryptedFrame, 'Must have captured live encrypted wire frame');

        // Replay exact captured wire packet verbatim over live socket
        const srvMessagesAfterReplay = [];
        server.on('message', (m) => srvMessagesAfterReplay.push(m));
        upstreamSocketRef.write(capturedEncryptedFrame);

        await waitForCondition(() => srvReplayEvents.length >= 1, 2000);
        assert.strictEqual(srvReplayEvents.length, 1);
        assert.ok(srvWireErrors.some((e) => /Anti-replay|Replay detected/i.test(e.message)));
        assert.strictEqual(srvMessagesAfterReplay.length, 0, 'Replayed frame must NEVER emit message');
        assert.strictEqual(sandboxCalls, 1, 'Replayed shard must NEVER re-execute in sandbox');
      } finally {
        await Promise.allSettled([client.close(), server.close(), proxy.close()]);
      }
    }

    // 2. Live wire ciphertext tampering + authTag tampering + destroyOnTamper socket teardown
    {
      let sandboxCalls = 0;
      const spySandbox = {
        executeIsolatedShard(shard) {
          sandboxCalls += 1;
          return new StandbySandbox().executeIsolatedShard(shard);
        }
      };

      const { client, server, proxy } = await createProxiedPair(
        () => ({}),
        () => ({ sandbox: spySandbox, enforceTelemetry: false, destroyOnTamper: true })
      );

      const srvWireErrors = [];
      server.on('wireError', (err) => srvWireErrors.push(err));
      const srvMessages = [];
      server.on('message', (m) => srvMessages.push(m));

      try {
        let accum = Buffer.alloc(0);
        let tampered = false;

        proxy.setHooks({
          onClientToServer(chunk, upstreamSock) {
            accum = Buffer.concat([accum, chunk]);
            while (accum.length >= 4) {
              const len = accum.readUInt32BE(0);
              if (accum.length < 4 + len) break;
              const fullFrame = accum.subarray(0, 4 + len);
              accum = accum.subarray(4 + len);
              const parsed = JSON.parse(fullFrame.subarray(4).toString('utf8'));
              if (parsed.kind === 'ENCRYPTED' && !tampered) {
                tampered = true;
                assert.strictEqual(typeof parsed.packet.ciphertext, 'string');
                parsed.packet.ciphertext = flipLastHexByte(parsed.packet.ciphertext);
                if (!upstreamSock.destroyed) upstreamSock.write(P2PNode.encodeFrame(parsed));
              } else if (!upstreamSock.destroyed) {
                upstreamSock.write(fullFrame);
              }
            }
          }
        });

        await client.sendEncryptedMessage(server.nodeId, 'SHARD_DISPATCH', {
          shardId: 'tamper-ct-1',
          taskCode: 'return 1;',
          inputData: [1]
        });

        await waitForCondition(() => srvWireErrors.length >= 1, 2000);
        assert.strictEqual(tampered, true);
        assert.ok(srvWireErrors.some((e) => /authentication tag verification failed/i.test(e.message)));
        assert.strictEqual(srvMessages.length, 0);
        assert.strictEqual(sandboxCalls, 0);
        await waitForCondition(() => server.peers.size === 0, 2000);
      } finally {
        await Promise.allSettled([client.close(), server.close(), proxy.close()]);
      }
    }

    // 3. Tampered authTag + stale timestamp (> 60s) over live socket
    {
      const { client, server, sessionKey } = await createConnectedPair();
      const srvWireErrors = [];
      const srvReplayEvents = [];
      const srvMessages = [];
      server.on('wireError', (e) => srvWireErrors.push(e));
      server.on('replayRejected', (e) => srvReplayEvents.push(e));
      server.on('message', (m) => srvMessages.push(m));

      try {
        const peerSocket = client.getPeer(server.nodeId).socket;

        // Tampered authTag frame
        const validPkt = client.crypto.encryptShard(
          { type: 'PING', payload: { x: 1 } },
          sessionKey,
          { aad: `${client.nodeId}:${server.nodeId}:PING` }
        );
        validPkt.authTag = flipLastHexByte(validPkt.authTag);
        peerSocket.write(P2PNode.encodeFrame({
          kind: 'ENCRYPTED',
          senderId: client.nodeId,
          msgType: 'PING',
          epoch: 1,
          packet: validPkt
        }));

        await waitForCondition(() => srvWireErrors.some((e) => /authentication tag verification failed/i.test(e.message)));

        // Stale timestamp frame (120s in the past)
        const stalePkt = client.crypto.encryptShard(
          { type: 'PING', payload: { stale: true } },
          sessionKey,
          { aad: `${client.nodeId}:${server.nodeId}:PING`, timestamp: Date.now() - 120_000 }
        );
        peerSocket.write(P2PNode.encodeFrame({
          kind: 'ENCRYPTED',
          senderId: client.nodeId,
          msgType: 'PING',
          epoch: 1,
          packet: stalePkt
        }));

        await waitForCondition(() => srvReplayEvents.length >= 1, 2000);
        assert.strictEqual(srvMessages.length, 0);
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    }

    // 4. Tampered Proof-of-Compute signature on SHARD_RESULT rejected by coordinator
    {
      const { client, server } = await createConnectedPair(
        () => ({}),
        () => ({ sandbox: new StandbySandbox(), enforceTelemetry: false })
      );

      try {
        const origSign = server.crypto.signProofOfCompute.bind(server.crypto);
        server.crypto.signProofOfCompute = (shardId, resultData, secret) => {
          return flipLastHexByte(origSign(shardId, resultData, secret));
        };

        const router = new GridRouter(client.nodeId);
        const [shard] = router.createTaskPartitions('return data[0] + 1;', [9], 1);
        await assert.rejects(
          () => client.dispatchRemoteShard(server.nodeId, shard),
          (err) => err.code === 'ERR_INVALID_POC'
        );
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    }
  });

  test('F28 Load-Shedding: worker refuses shard under CPU (>25%) and memory (<10%) overload without running sandbox, then recovers', async () => {
    let cpuLoad = 0.85; // > 25% ceiling -> CPU_OVERLOAD
    let freeMem = 500_000_000;
    const totalMem = 1_000_000_000;
    let sandboxCalls = 0;

    const workerCrypto = new MeshCryptoEngine();
    const overloadedRouter = new GridRouter(workerCrypto.nodeId, {
      os: createDeterministicOs(() => cpuLoad, () => freeMem, () => totalMem)
    });
    const spySandbox = {
      executeIsolatedShard(shard) {
        sandboxCalls += 1;
        return new StandbySandbox().executeIsolatedShard(shard);
      }
    };

    const { client: coordinator, server: worker } = await createConnectedPair(
      () => ({}),
      () => ({
        crypto: workerCrypto,
        router: overloadedRouter,
        sandbox: spySandbox,
        enforceTelemetry: true
      })
    );

    try {
      const coordRouter = new GridRouter(coordinator.nodeId);
      const [shard1, shard2, shard3] = coordRouter.createTaskPartitions('return data[0] * 10;', [2, 3, 4], 1);

      // 1. CPU overload (85% > 25%) -> fail-closed rejection
      await assert.rejects(
        () => coordinator.dispatchRemoteShard(worker.nodeId, shard1),
        (err) => err.code === 'ERR_SHARD_REJECTED' && err.reason === 'CPU_OVERLOAD'
      );
      assert.strictEqual(sandboxCalls, 0, 'Sandbox must NOT execute under CPU overload');

      // 2. Memory exhaustion (cpu cools to 10%, free mem drops to 5% < 10%) -> fail-closed rejection
      cpuLoad = 0.10;
      freeMem = 50_000_000;
      await assert.rejects(
        () => coordinator.dispatchRemoteShard(worker.nodeId, shard2),
        (err) => err.code === 'ERR_SHARD_REJECTED' && /MEMORY_EXHAUSTED/.test(err.reason)
      );
      assert.strictEqual(sandboxCalls, 0, 'Sandbox must NOT execute under memory exhaustion');

      // 3. Telemetry recovers (cpu 10%, free mem 50%) -> worker accepts and returns valid PoC result
      freeMem = 500_000_000;
      const res = await coordinator.dispatchRemoteShard(worker.nodeId, shard3);
      assert.strictEqual(res.output, 40);
      assert.strictEqual(sandboxCalls, 1);
      assert.strictEqual(
        coordinator.crypto.verifyProofOfCompute(
          shard3.shardId,
          res.output,
          res.proofOfCompute,
          coordinator.getSessionKey(worker.nodeId)
        ),
        true
      );
    } finally {
      await Promise.allSettled([coordinator.close(), worker.close()]);
    }
  });

  test('T1.F28.05: unexpected peer disconnect mid-shard rejects cleanly and coordinator router reschedules shard', async () => {
    let delayTimer = null;
    const delayingSandbox = {
      executeIsolatedShardAsync(shard) {
        return new Promise((resolve) => {
          delayTimer = setTimeout(() => {
            resolve(new StandbySandbox().executeIsolatedShard(shard));
          }, 250);
          if (typeof delayTimer.unref === 'function') {
            delayTimer.unref();
          }
        });
      },
      executeIsolatedShard(shard) {
        return new StandbySandbox().executeIsolatedShard(shard);
      }
    };

    const { client: coordinator, server: worker } = await createConnectedPair(
      () => ({}),
      () => ({ sandbox: delayingSandbox, enforceTelemetry: false })
    );

    try {
      const coordRouter = new GridRouter(coordinator.nodeId);
      coordRouter.registerPeer(worker.nodeId, worker.crypto.publicKey, {
        standbyReady: true,
        latencyMs: 5,
        cpuLoad: 0.05,
        freeMemRatio: 0.7
      });

      const [shard] = coordRouter.createTaskPartitions('return data[0] + 5;', [10], 1);
      const route = coordRouter.dispatchShard(shard);
      assert.strictEqual(route.status, 'DISPATCHED');

      const pendingPromise = coordinator.dispatchRemoteShard(worker.nodeId, shard);
      const rejectPromise = assert.rejects(
        pendingPromise,
        (err) => err instanceof SocketDestroyedError && (err.code === 'ERR_PEER_DISCONNECTED' || err.code === 'ERR_NODE_CLOSED')
      );
      await delay(30);
      await worker.close();

      await rejectPromise;

      const recovery = coordRouter.handlePeerDisconnect(worker.nodeId);
      assert.strictEqual(recovery.rescheduled.length, 1);
      assert.strictEqual(coordRouter.taskQueue[0].shardId, shard.shardId);
    } finally {
      if (delayTimer) clearTimeout(delayTimer);
      await Promise.allSettled([coordinator.close(), worker.close()]);
    }
  });

  test('T2.F28.02 / T2.F28.03: mismatched shardId result, shard timeout, and sandbox execution error reject fail-closed', async () => {
    // 1. Worker returns wrong shardId on SHARD_RESULT -> ERR_SHARD_MISMATCH
    {
      const { client, server } = await createConnectedPair(
        () => ({}),
        () => ({ sandbox: new StandbySandbox(), enforceTelemetry: false })
      );
      try {
        // Intercept worker sendEncryptedMessage to swap shardId inside SHARD_RESULT while preserving requestId
        const origSend = server.sendEncryptedMessage.bind(server);
        server.sendEncryptedMessage = (peerIdOrSocket, type, payload) => {
          if (type === 'SHARD_RESULT' && payload) {
            const forgedShardId = 'wrong-shard-id';
            const sessionKey = server.getSessionKey(typeof peerIdOrSocket === 'string' ? peerIdOrSocket : client.nodeId);
            const forgedPayload = {
              ...payload,
              shardId: forgedShardId,
              proofOfCompute: server.crypto.signProofOfCompute(forgedShardId, payload.output, sessionKey)
            };
            return origSend(peerIdOrSocket, type, forgedPayload);
          }
          return origSend(peerIdOrSocket, type, payload);
        };

        const router = new GridRouter(client.nodeId);
        const [shard] = router.createTaskPartitions('return data[0] * 3;', [7], 1);
        await assert.rejects(
          () => client.dispatchRemoteShard(server.nodeId, shard),
          (err) => err.code === 'ERR_SHARD_MISMATCH'
        );
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    }

    // 2. Slow worker execution exceeds timeoutMs -> ERR_SHARD_TIMEOUT; invalid task rejected -> ERR_SHARD_REJECTED
    {
      let hangTimer = null;
      const slowThenErrorSandbox = {
        executeIsolatedShardAsync(shard) {
          if (shard.shardId === 'slow-shard') {
            return new Promise((resolve) => {
              hangTimer = setTimeout(() => resolve({ shardId: shard.shardId, output: 1, executionTimeMs: 300 }), 300);
              if (typeof hangTimer.unref === 'function') hangTimer.unref();
            });
          }
          return Promise.reject(new Error('Simulated sandbox execution failure'));
        },
        executeIsolatedShard() {
          throw new Error('Simulated sandbox execution failure');
        }
      };

      const { client, server } = await createConnectedPair(
        () => ({ shardTimeoutMs: 80 }),
        () => ({ sandbox: slowThenErrorSandbox, enforceTelemetry: false })
      );

      try {
        await assert.rejects(
          () => client.dispatchRemoteShard(server.nodeId, { shardId: 'slow-shard', taskCode: 'return 1;', inputData: [] }),
          (err) => err.code === 'ERR_SHARD_TIMEOUT'
        );

        await assert.rejects(
          () => client.dispatchRemoteShard(server.nodeId, { shardId: 'bad-shard', taskCode: 'return 1;', inputData: [] }),
          (err) => err.code === 'ERR_SHARD_REJECTED' && err.reason === 'EXECUTION_FAILED'
        );
      } finally {
        if (hangTimer) clearTimeout(hangTimer);
        await Promise.allSettled([client.close(), server.close()]);
      }
    }
  });

  test('Socket Disconnection Resilience: mid-handshake abort, in-flight key rotation disconnect, and concurrent multi-shard abrupt destruction', async () => {
    // 1. Mid-handshake abort: client destroys socket while handshake is in-flight
    {
      const { client, server, socket } = await createConnectedPair(
        () => ({}),
        () => ({}),
        { handshake: false }
      );
      try {
        const hsPromise = client.initiateHandshake(socket, server.crypto.publicKey);
        socket.destroy();
        await assert.rejects(
          hsPromise,
          (err) => err instanceof SocketDestroyedError && /Socket closed before handshake completed/i.test(err.message)
        );
      } finally {
        await Promise.allSettled([client.close(), server.close()]);
      }
    }

    // 2. In-flight key rotation disconnect: socket destroyed while waiting for KEY_ROTATE_ACK
    {
      const { client, server, proxy } = await createProxiedPair();
      try {
        proxy.setHooks({
          onClientToServer(chunk, upstreamSock, clientSock) {
            clientSock.destroy();
            upstreamSock.destroy();
          }
        });

        await assert.rejects(
          () => client.rotateSessionKey(server.nodeId),
          (err) => err instanceof SocketDestroyedError && /Peer disconnected during key rotation/i.test(err.message)
        );
        assert.strictEqual(client.peers.size, 0);
      } finally {
        await Promise.allSettled([client.close(), server.close(), proxy.close()]);
      }
    }

    // 3. Concurrent multi-shard dispatch on abrupt socket destruction: all pending shards reject cleanly
    {
      let hangTimer = null;
      const delayedSandbox = {
        executeIsolatedShardAsync(shard) {
          return new Promise((resolve) => {
            hangTimer = setTimeout(() => resolve({ shardId: shard.shardId, output: 1 }), 500);
            if (typeof hangTimer.unref === 'function') hangTimer.unref();
          });
        },
        executeIsolatedShard(shard) {
          return { shardId: shard.shardId, output: 1 };
        }
      };

      const { client: coordinator, server: worker } = await createConnectedPair(
        () => ({}),
        () => ({ sandbox: delayedSandbox, enforceTelemetry: false })
      );

      try {
        const router = new GridRouter(coordinator.nodeId);
        const shards = router.createTaskPartitions('return 1;', [1, 2, 3], 1);

        const dispatches = shards.map((s) => coordinator.dispatchRemoteShard(worker.nodeId, s));
        await delay(30);

        // Abruptly destroy worker socket
        worker.getPeer(coordinator.nodeId).socket.destroy();

        const results = await Promise.allSettled(dispatches);
        assert.strictEqual(results.length, 3);
        for (const res of results) {
          assert.strictEqual(res.status, 'rejected');
          assert.ok(res.reason instanceof SocketDestroyedError);
          assert.strictEqual(res.reason.code, 'ERR_PEER_DISCONNECTED');
        }
        assert.strictEqual(coordinator._pendingShards.size, 0);
      } finally {
        if (hangTimer) clearTimeout(hangTimer);
        await Promise.allSettled([coordinator.close(), worker.close()]);
      }
    }
  });
});
