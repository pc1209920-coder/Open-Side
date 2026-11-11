const net = require('node:net');
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { Duplex } = require('node:stream');

const { MeshCryptoEngine } = require('./crypto');
const { StandbySandbox } = require('./sandbox');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
const DEFAULT_SHARD_TIMEOUT_MS = 10000;
const DEFAULT_TIME_DRIFT_MS = 60000;
const MAX_SEEN_HANDSHAKE_NONCES = 10000;

// Multiplex stream frame flags & constants
const STREAM_FRAME_TAG = 0x03;
const STREAM_FLAG_DATA = 0x00;
const STREAM_FLAG_FIN  = 0x01;
const STREAM_FLAG_RST  = 0x02;
const STREAM_FLAG_MSG  = 0x04;

class FrameTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameTooLargeError';
    this.code = 'ERR_FRAME_TOO_LARGE';
  }
}

class SocketDestroyedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SocketDestroyedError';
    this.code = 'ERR_SOCKET_DESTROYED';
  }
}

class AlreadyListeningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AlreadyListeningError';
    this.code = 'ERR_ALREADY_LISTENING';
  }
}

class HandshakeTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HandshakeTimeoutError';
    this.code = 'ERR_HANDSHAKE_TIMEOUT';
  }
}

class MultiplexError extends Error {
  constructor(message, code = 'ERR_MULTIPLEX') {
    super(message);
    this.name = 'MultiplexError';
    this.code = code;
  }
}

/**
 * Duplex stream representing a multiplexed logical stream over a physical P2P socket.
 */
class P2PStream extends Duplex {
  /**
   * @param {object} options
   * @param {number} options.streamId
   * @param {P2PNode} options.node
   * @param {net.Socket} options.socket
   */
  constructor(options = {}) {
    super({ allowHalfOpen: true, ...(options.streamOptions || {}) });
    this.streamId = options.streamId;
    this.node = options.node;
    this.socket = options.socket;
    this.peerId = options.peerId || null;
    this._remoteClosed = false;
    this._reset = false;
  }

  _read(size) {
    // Backpressure handled automatically by push()
  }

  _write(chunk, encoding, callback) {
    if (this._reset || this.destroyed || !this.socket || this.socket.destroyed || !this.socket.writable) {
      callback(new SocketDestroyedError(`Cannot write to stream ${this.streamId}: socket or stream closed`));
      return;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    try {
      const frame = P2PNode.encodeStreamFrame(this.streamId, buf, STREAM_FLAG_DATA, this.node.maxFrameSize);
      this.socket.write(frame, callback);
    } catch (err) {
      callback(err);
    }
  }

  _final(callback) {
    if (this._reset || this.destroyed || !this.socket || this.socket.destroyed || !this.socket.writable) {
      callback();
      return;
    }
    try {
      const frame = P2PNode.encodeStreamFrame(this.streamId, Buffer.allocUnsafe(0), STREAM_FLAG_FIN, this.node.maxFrameSize);
      this.socket.write(frame, callback);
    } catch (err) {
      callback(err);
    }
  }

  /**
   * Sends an immediate structured message or payload over this multiplexed stream.
   * @param {any} message
   * @returns {Promise<void>}
   */
  async sendMessage(message) {
    if (this._reset || this.destroyed || !this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new SocketDestroyedError(`Cannot send message on stream ${this.streamId}: stream closed`);
    }
    const format = this.node && this.node.useV8Serialization ? 'v8' : 'json';
    const frame = P2PNode.encodeStreamFrame(this.streamId, message, STREAM_FLAG_MSG, this.node.maxFrameSize, format);
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Sends an RST frame and tears down the stream immediately.
   * @param {Error} [err]
   */
  reset(err) {
    if (this._reset) return;
    this._reset = true;
    if (this.socket && !this.socket.destroyed && this.socket.writable) {
      try {
        const frame = P2PNode.encodeStreamFrame(this.streamId, Buffer.allocUnsafe(0), STREAM_FLAG_RST, this.node.maxFrameSize);
        this.socket.write(frame);
      } catch {
        // Ignore write error on reset
      }
    }
    this.destroy(err || new MultiplexError(`Stream ${this.streamId} reset`, 'ERR_STREAM_RESET'));
  }
}

class P2PNode extends EventEmitter {
  /**
   * Native zero-dependency P2P transport daemon using length-prefixed JSON framing,
   * 2-way ephemeral ECDH + HKDF-SHA512 handshakes, AES-256-GCM encrypted messaging,
   * anti-replay nonce validation, and isolated shard dispatch/execution.
   * @param {object} [options]
   */
  constructor(options = {}) {
    super();

    this.host = options.host !== undefined ? options.host : DEFAULT_HOST;
    this._configuredPort = options.port !== undefined ? options.port : DEFAULT_PORT;
    this._configuredIpcPath = options.ipcPath !== undefined ? options.ipcPath : null;

    if (typeof this.host !== 'string' || !this.host) {
      throw new TypeError('Invalid host: must be a non-empty string');
    }
    if (!Number.isSafeInteger(this._configuredPort) || this._configuredPort < 0 || this._configuredPort > 65535) {
      throw new RangeError('Invalid port: must be an integer between 0 and 65535');
    }
    if (this._configuredIpcPath !== null && (typeof this._configuredIpcPath !== 'string' || !this._configuredIpcPath)) {
      throw new TypeError('Invalid ipcPath: must be a non-empty string or null');
    }

    this.maxFrameSize = options.maxFrameSize !== undefined ? options.maxFrameSize : DEFAULT_MAX_FRAME_SIZE;
    if (!Number.isSafeInteger(this.maxFrameSize) || this.maxFrameSize <= 0) {
      throw new RangeError('Invalid maxFrameSize: must be a positive safe integer');
    }

    this.handshakeTimeoutMs = options.handshakeTimeoutMs !== undefined
      ? options.handshakeTimeoutMs
      : DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (typeof this.handshakeTimeoutMs !== 'number' || !Number.isFinite(this.handshakeTimeoutMs) || this.handshakeTimeoutMs <= 0) {
      throw new RangeError('Invalid handshakeTimeoutMs: must be a positive finite number');
    }

    this.shardTimeoutMs = options.shardTimeoutMs !== undefined ? options.shardTimeoutMs : DEFAULT_SHARD_TIMEOUT_MS;
    if (typeof this.shardTimeoutMs !== 'number' || !Number.isFinite(this.shardTimeoutMs) || this.shardTimeoutMs <= 0) {
      throw new RangeError('Invalid shardTimeoutMs: must be a positive finite number');
    }

    this.allowIpcFallback = options.allowIpcFallback !== undefined ? Boolean(options.allowIpcFallback) : true;
    this.destroyOnTamper = Boolean(options.destroyOnTamper);
    this.useV8Serialization = Boolean(options.useV8Serialization);

    this.crypto = options.crypto || new MeshCryptoEngine(options.cryptoOptions);
    this.nodeId = this.crypto.nodeId;

    this._sandboxOptions = options.sandboxOptions || {};
    this.sandbox = options.sandbox || null;
    this.router = options.router || null;

    if (options.enforceTelemetry !== undefined) {
      this.enforceTelemetry = Boolean(options.enforceTelemetry);
    } else if (options.checkTelemetry !== undefined) {
      this.enforceTelemetry = Boolean(options.checkTelemetry);
    } else if (options.loadShedding !== undefined) {
      this.enforceTelemetry = Boolean(options.loadShedding);
    } else {
      this.enforceTelemetry = Boolean(this.router);
    }

    this._net = options.net || net;
    this._os = options.os || os;

    this.peers = new Map();
    this.server = null;
    this.address = null;
    this.port = null;
    this.ipcPath = null;

    this._sockets = new Set();
    this._socketMeta = new WeakMap();
    this._pendingShards = new Map();
    this._seenHandshakeNonces = new Set();
    this._listeningPromise = null;
    this._closePromise = null;
    this._closing = false;
    this._nextStreamId = 1;
  }

  _now() {
    return typeof this.crypto._now === 'function' ? this.crypto._now() : Date.now();
  }

  _maxDriftMs() {
    return typeof this.crypto.maxTimeDriftMs === 'number' && Number.isFinite(this.crypto.maxTimeDriftMs)
      ? this.crypto.maxTimeDriftMs
      : DEFAULT_TIME_DRIFT_MS;
  }

  _getSandbox() {
    if (!this.sandbox) {
      this.sandbox = new StandbySandbox(this._sandboxOptions);
    }
    return this.sandbox;
  }

  _emitWireError(err, context) {
    this.emit('wireError', err, context);
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Encodes an object into a 4-byte big-endian length-prefixed wire frame (JSON or native node:v8).
   * @param {any} payload
   * @param {number} [maxFrameSize]
   * @param {string} [format] 'json' | 'v8'
   * @returns {Buffer}
   */
  static encodeFrame(payload, maxFrameSize = DEFAULT_MAX_FRAME_SIZE, format = 'json') {
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('Invalid wire frame payload: must be a non-null plain object');
    }
    let body;
    if (format === 'v8') {
      try {
        const serialized = v8.serialize(payload);
        body = Buffer.allocUnsafe(1 + serialized.length);
        body[0] = 0x02; // Binary frame tag for node:v8
        serialized.copy(body, 1);
      } catch (err) {
        throw new TypeError(`Invalid wire frame payload: v8 serialization failed: ${err.message}`);
      }
    } else {
      const serialized = JSON.stringify(payload);
      if (typeof serialized !== 'string') {
        throw new TypeError('Invalid wire frame payload: must be JSON-serializable');
      }
      body = Buffer.from(serialized, 'utf8');
    }
    if (body.length > maxFrameSize) {
      throw new FrameTooLargeError(`Outbound frame size (${body.length} bytes) exceeds maxFrameSize (${maxFrameSize} bytes)`);
    }
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return frame;
  }

  encodeFrame(payload, format = (this.useV8Serialization ? 'v8' : 'json')) {
    return P2PNode.encodeFrame(payload, this.maxFrameSize, format);
  }

  /**
   * Encodes a multiplexed stream frame with 2-byte streamId and 1-byte flags.
   * Frame wire layout:
   * [4 bytes total payload length] [1 byte STREAM_FRAME_TAG (0x03)] [2 bytes streamId BE] [1 byte flags] [payload data]
   * @param {number} streamId Integer 0 to 65535
   * @param {Buffer|Uint8Array|string|object} data
   * @param {number} [flags] STREAM_FLAG_DATA | STREAM_FLAG_FIN | STREAM_FLAG_RST | STREAM_FLAG_MSG
   * @param {number} [maxFrameSize]
   * @param {string} [format] 'raw' | 'json' | 'v8'
   * @returns {Buffer}
   */
  static encodeStreamFrame(streamId, data = Buffer.allocUnsafe(0), flags = STREAM_FLAG_DATA, maxFrameSize = DEFAULT_MAX_FRAME_SIZE, format = 'raw') {
    if (!Number.isSafeInteger(streamId) || streamId < 0 || streamId > 0xffff) {
      throw new RangeError(`Invalid streamId (${streamId}): must be an integer between 0 and 65535`);
    }
    let payloadBuf;
    if (Buffer.isBuffer(data)) {
      payloadBuf = data;
    } else if (data instanceof Uint8Array) {
      payloadBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    } else if (typeof data === 'string') {
      payloadBuf = Buffer.from(data, 'utf8');
    } else if (data !== undefined && data !== null && typeof data === 'object') {
      if (format === 'v8') {
        payloadBuf = v8.serialize(data);
      } else {
        payloadBuf = Buffer.from(JSON.stringify(data), 'utf8');
      }
    } else {
      payloadBuf = Buffer.allocUnsafe(0);
    }

    const bodyLength = 4 + payloadBuf.length; // 1 tag + 2 streamId + 1 flags + payload
    if (bodyLength > maxFrameSize) {
      throw new FrameTooLargeError(`Outbound stream frame size (${bodyLength} bytes) exceeds maxFrameSize (${maxFrameSize} bytes)`);
    }

    const frame = Buffer.allocUnsafe(4 + bodyLength);
    frame.writeUInt32BE(bodyLength, 0);
    frame[4] = STREAM_FRAME_TAG; // 0x03
    frame.writeUInt16BE(streamId, 5);
    frame[7] = flags & 0xff;
    if (payloadBuf.length > 0) {
      payloadBuf.copy(frame, 8);
    }
    return frame;
  }

  encodeStreamFrame(streamId, data = Buffer.allocUnsafe(0), flags = STREAM_FLAG_DATA, format = 'raw') {
    return P2PNode.encodeStreamFrame(streamId, data, flags, this.maxFrameSize, format);
  }

  /**
   * Decodes a body buffer into either a control frame or a multiplexed stream frame.
   * @param {Buffer} bodyBuf
   * @returns {{ isStream: boolean, streamId?: number, flags?: number, data: any }}
   */
  static decodeWireBody(bodyBuf) {
    if (!Buffer.isBuffer(bodyBuf)) {
      throw new TypeError('Invalid wire body: must be a Buffer');
    }
    if (bodyBuf.length >= 4 && bodyBuf[0] === STREAM_FRAME_TAG) {
      const streamId = bodyBuf.readUInt16BE(1);
      const flags = bodyBuf.readUInt8(3);
      const data = bodyBuf.subarray(4);
      return { isStream: true, streamId, flags, data };
    }

    // Standard control / encrypted frames (v8 or JSON)
    let message;
    if (bodyBuf.length > 0 && (bodyBuf[0] === 0xff || bodyBuf[0] === 0x02)) {
      const payloadSlice = bodyBuf[0] === 0x02 ? bodyBuf.subarray(1) : bodyBuf;
      message = v8.deserialize(payloadSlice);
    } else {
      const rawSlice = (bodyBuf.length > 0 && bodyBuf[0] === 0x01) ? bodyBuf.subarray(1) : bodyBuf;
      message = JSON.parse(rawSlice.toString('utf8'));
    }
    return { isStream: false, data: message };
  }

  _generateIpcPath() {
    const suffix = `${this.nodeId.slice(0, 12)}-${crypto.randomUUID()}`;
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\openside-${suffix}`;
    }
    return path.join(this._os.tmpdir(), `openside-${suffix}.sock`);
  }

  _getListeningInfo() {
    if (!this.server || !this.server.listening) {
      return null;
    }
    if (this.ipcPath) {
      return { address: 'ipc', port: 0, ipcPath: this.ipcPath };
    }
    return { address: this.address, port: this.port };
  }

  _bindServer(listenTarget, isIpc) {
    return new Promise((resolve, reject) => {
      const server = this._net.createServer((socket) => {
        this._onInboundConnection(socket);
      });

      let settled = false;

      const onError = (err) => {
        if (settled) return;
        settled = true;
        server.removeListener('listening', onListening);
        try {
          server.close();
        } catch {
          // Ignore cleanup errors on failed bind
        }
        reject(err);
      };

      const onListening = () => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);

        server.on('error', (srvErr) => {
          this._emitWireError(srvErr, { server });
        });

        this.server = server;
        if (isIpc) {
          this.address = 'ipc';
          this.port = 0;
          this.ipcPath = listenTarget;
          resolve({ address: 'ipc', port: 0, ipcPath: listenTarget });
        } else {
          const addr = server.address();
          this.address = addr && typeof addr === 'object' ? addr.address : listenTarget.host;
          this.port = addr && typeof addr === 'object' ? addr.port : listenTarget.port;
          this.ipcPath = null;
          resolve({ address: this.address, port: this.port });
        }
      };

      server.once('error', onError);
      server.once('listening', onListening);

      try {
        if (isIpc) {
          server.listen(listenTarget);
        } else {
          server.listen({ host: listenTarget.host, port: listenTarget.port });
        }
      } catch (syncErr) {
        onError(syncErr);
      }
    });
  }

  /**
   * Starts listening on TCP (host/port) or IPC path, with automatic IPC fallback
   * if TCP bind fails due to EACCES/EPERM (unless allowIpcFallback === false).
   * @param {object} [listenOptions]
   * @returns {Promise<{ address: string, port: number, ipcPath?: string }>}
   */
  async listen(listenOptions = {}) {
    if (this._closing) {
      throw new Error('Cannot listen: node is closing');
    }

    if (this.server && this.server.listening) {
      const current = this._getListeningInfo();
      const reqIpc = listenOptions.ipcPath;
      const reqPort = listenOptions.port;
      if (
        (reqIpc !== undefined && reqIpc !== this.ipcPath) ||
        (reqPort !== undefined && reqPort !== 0 && reqPort !== this.port)
      ) {
        throw new AlreadyListeningError('P2PNode server is already listening on a different endpoint');
      }
      return current;
    }

    if (this._listeningPromise) {
      return this._listeningPromise;
    }

    const host = listenOptions.host !== undefined ? listenOptions.host : this.host;
    const port = listenOptions.port !== undefined ? listenOptions.port : this._configuredPort;
    const ipcPath = listenOptions.ipcPath !== undefined ? listenOptions.ipcPath : this._configuredIpcPath;
    const allowIpcFallback = listenOptions.allowIpcFallback !== undefined
      ? Boolean(listenOptions.allowIpcFallback)
      : this.allowIpcFallback;

    if (!ipcPath) {
      if (typeof host !== 'string' || !host) {
        throw new TypeError('Invalid host: must be a non-empty string');
      }
      if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new RangeError('Invalid port: must be an integer between 0 and 65535');
      }
    } else if (typeof ipcPath !== 'string' || !ipcPath) {
      throw new TypeError('Invalid ipcPath: must be a non-empty string');
    }

    this._listeningPromise = (async () => {
      try {
        if (ipcPath) {
          return await this._bindServer(ipcPath, true);
        }

        try {
          return await this._bindServer({ host, port }, false);
        } catch (err) {
          const canFallback =
            allowIpcFallback &&
            (err.code === 'EACCES' || err.code === 'EPERM' || (port === 0 && err.code === 'EADDRINUSE'));
          if (!canFallback) {
            throw err;
          }
          const fallbackPath = this._generateIpcPath();
          return await this._bindServer(fallbackPath, true);
        }
      } finally {
        this._listeningPromise = null;
      }
    })();

    return this._listeningPromise;
  }

  /**
   * Connects to a remote TCP or local IPC peer endpoint and attaches the framed wire parser.
   * @param {{ host?: string, port?: number, ipcPath?: string } | string} endpoint
   * @returns {Promise<net.Socket>}
   */
  connect(endpoint) {
    if (this._closing) {
      return Promise.reject(new Error('Cannot connect: node is closing'));
    }

    const normalized = typeof endpoint === 'string' ? { ipcPath: endpoint } : endpoint;
    if (!normalized || typeof normalized !== 'object') {
      return Promise.reject(new TypeError('Invalid endpoint: must be an object or IPC path string'));
    }

    let connectOpts;
    let storedEndpoint;
    if (normalized.ipcPath !== undefined && normalized.ipcPath !== null) {
      if (typeof normalized.ipcPath !== 'string' || !normalized.ipcPath) {
        return Promise.reject(new TypeError('Invalid endpoint.ipcPath: must be a non-empty string'));
      }
      connectOpts = { path: normalized.ipcPath };
      storedEndpoint = { ipcPath: normalized.ipcPath };
    } else {
      const host = normalized.host !== undefined
        ? normalized.host
        : (normalized.address !== undefined && normalized.address !== 'ipc' ? normalized.address : DEFAULT_HOST);
      const port = normalized.port;
      if (typeof host !== 'string' || !host) {
        return Promise.reject(new TypeError('Invalid endpoint.host: must be a non-empty string'));
      }
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
        return Promise.reject(new RangeError('Invalid endpoint.port: must be an integer between 1 and 65535'));
      }
      connectOpts = { host, port };
      storedEndpoint = { host, port };
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;

      try {
        socket = this._net.createConnection(connectOpts);
      } catch (err) {
        reject(err);
        return;
      }

      this._sockets.add(socket);

      const cleanupPreConnect = () => {
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
        socket.removeListener('close', onCloseBeforeConnect);
      };

      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanupPreConnect();
        this._sockets.delete(socket);
        try {
          socket.destroy();
        } catch {
          // Ignore cleanup errors
        }
        reject(err);
      };

      const onCloseBeforeConnect = () => {
        if (settled) return;
        settled = true;
        cleanupPreConnect();
        this._sockets.delete(socket);
        reject(new SocketDestroyedError('Socket closed before connection completed'));
      };

      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanupPreConnect();
        if (this._closing) {
          this._sockets.delete(socket);
          socket.destroy();
          reject(new Error('Cannot connect: node is closing'));
          return;
        }
        this._setupSocket(socket, { direction: 'outbound', endpoint: storedEndpoint });
        resolve(socket);
      };

      socket.once('error', onError);
      socket.once('close', onCloseBeforeConnect);
      socket.once('connect', onConnect);
    });
  }

  _onInboundConnection(socket) {
    if (this._closing) {
      socket.destroy();
      return;
    }

    const endpoint = {
      host: socket.remoteAddress || null,
      port: socket.remotePort || null,
      ...(this.ipcPath ? { ipcPath: this.ipcPath } : {})
    };

    const meta = this._setupSocket(socket, { direction: 'inbound', endpoint });

    meta.inboundAuthTimer = setTimeout(() => {
      if (meta.handshakeState !== 'ESTABLISHED' && !socket.destroyed && !meta.closed) {
        this._failSocket(socket, new HandshakeTimeoutError(`Inbound handshake timed out after ${this.handshakeTimeoutMs}ms`));
      }
    }, this.handshakeTimeoutMs);
    if (typeof meta.inboundAuthTimer.unref === 'function') {
      meta.inboundAuthTimer.unref();
    }
  }

  _setupSocket(socket, { direction, endpoint }) {
    this._sockets.add(socket);

    const meta = {
      socket,
      direction,
      endpoint,
      handshakeState: 'UNAUTHENTICATED',
      peerId: null,
      publicKey: null,
      sessionKey: null,
      epoch: null,
      pendingHandshake: null,
      inboundAuthTimer: null,
      closed: false,
      streams: new Map(),
      parser: {
        chunks: [],
        totalBytes: 0,
        expectedLength: null
      }
    };

    this._socketMeta.set(socket, meta);

    socket.on('data', (chunk) => {
      this._onSocketData(socket, meta, chunk);
    });

    socket.on('error', (err) => {
      this._handleSocketError(socket, meta, err);
    });

    socket.on('close', () => {
      this._handleSocketClose(socket, meta);
    });

    return meta;
  }

  _readExactFromParser(parser, n) {
    if (parser.chunks.length === 1 && parser.chunks[0].length === n) {
      const exact = parser.chunks.shift();
      parser.totalBytes -= n;
      return exact;
    }

    if (parser.chunks[0].length > n) {
      const head = parser.chunks[0];
      const slice = head.subarray(0, n);
      parser.chunks[0] = head.subarray(n);
      parser.totalBytes -= n;
      return slice;
    }

    if (parser.chunks[0].length === n) {
      const exact = parser.chunks.shift();
      parser.totalBytes -= n;
      return exact;
    }

    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = parser.chunks[0];
      const needed = n - offset;
      if (chunk.length <= needed) {
        chunk.copy(out, offset);
        offset += chunk.length;
        parser.chunks.shift();
      } else {
        chunk.copy(out, offset, 0, needed);
        parser.chunks[0] = chunk.subarray(needed);
        offset += needed;
      }
    }
    parser.totalBytes -= n;
    return out;
  }

  _onSocketData(socket, meta, chunk) {
    if (meta.closed || socket.destroyed) {
      return;
    }

    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) {
      return;
    }

    const parser = meta.parser;
    parser.chunks.push(buf);
    parser.totalBytes += buf.length;

    while (!meta.closed && !socket.destroyed) {
      if (parser.expectedLength === null) {
        if (parser.totalBytes < 4) {
          break;
        }
        const header = this._readExactFromParser(parser, 4);
        const frameLength = header.readUInt32BE(0);
        if (frameLength > this.maxFrameSize) {
          parser.chunks.length = 0;
          parser.totalBytes = 0;
          this._failSocket(
            socket,
            new FrameTooLargeError(`Incoming frame length (${frameLength} bytes) exceeds maxFrameSize (${this.maxFrameSize} bytes)`)
          );
          return;
        }
        if (frameLength === 0) {
          parser.expectedLength = null;
          continue;
        }
        parser.expectedLength = frameLength;
      }

      if (parser.totalBytes < parser.expectedLength) {
        break;
      }

      const bodyBuf = this._readExactFromParser(parser, parser.expectedLength);
      parser.expectedLength = null;

      // Check for multiplexed stream frame (format tag 0x03)
      if (bodyBuf.length >= 4 && bodyBuf[0] === STREAM_FRAME_TAG) {
        const streamId = bodyBuf.readUInt16BE(1);
        const flags = bodyBuf.readUInt8(3);
        const payloadData = bodyBuf.subarray(4);
        this._handleStreamFrame(socket, meta, streamId, flags, payloadData);
        continue;
      }

      let message;
      try {
        if (bodyBuf.length > 0 && (bodyBuf[0] === 0xff || bodyBuf[0] === 0x02)) {
          const payloadSlice = bodyBuf[0] === 0x02 ? bodyBuf.subarray(1) : bodyBuf;
          message = v8.deserialize(payloadSlice);
        } else {
          const rawSlice = (bodyBuf.length > 0 && bodyBuf[0] === 0x01) ? bodyBuf.subarray(1) : bodyBuf;
          message = JSON.parse(rawSlice.toString('utf8'));
        }
      } catch (err) {
        parser.chunks.length = 0;
        parser.totalBytes = 0;
        const parseErr = new SyntaxError(`Invalid wire frame: ${err.message}`);
        parseErr.code = 'ERR_INVALID_WIRE_JSON';
        this._failSocket(socket, parseErr);
        return;
      }

      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        parser.chunks.length = 0;
        parser.totalBytes = 0;
        const shapeErr = new TypeError('Invalid wire frame: expected JSON object');
        shapeErr.code = 'ERR_INVALID_WIRE_FRAME';
        this._failSocket(socket, shapeErr);
        return;
      }

      this._handleWireFrame(socket, meta, message);
    }
  }

  _failSocket(socket, err) {
    const meta = this._socketMeta.get(socket);
    if (meta && meta.pendingHandshake) {
      const pending = meta.pendingHandshake;
      meta.pendingHandshake = null;
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    if (meta && meta.inboundAuthTimer) {
      clearTimeout(meta.inboundAuthTimer);
      meta.inboundAuthTimer = null;
    }
    this._emitWireError(err, { socket, peerId: meta ? meta.peerId : null });
    if (!socket.destroyed) {
      socket.destroy();
    }
  }

  _handleSocketError(socket, meta, err) {
    if (meta.pendingHandshake) {
      const pending = meta.pendingHandshake;
      meta.pendingHandshake = null;
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._emitWireError(err, { socket, peerId: meta.peerId });
  }

  _handleSocketClose(socket, meta) {
    if (meta.closed) {
      return;
    }
    meta.closed = true;
    meta.parser.chunks.length = 0;
    meta.parser.totalBytes = 0;
    meta.parser.expectedLength = null;

    if (meta.inboundAuthTimer) {
      clearTimeout(meta.inboundAuthTimer);
      meta.inboundAuthTimer = null;
    }

    if (meta.pendingHandshake) {
      const pending = meta.pendingHandshake;
      meta.pendingHandshake = null;
      clearTimeout(pending.timer);
      pending.reject(new SocketDestroyedError('Socket closed before handshake completed'));
    }

    if (meta.streams) {
      for (const stream of meta.streams.values()) {
        if (!stream.destroyed) {
          stream.destroy();
        }
      }
      meta.streams.clear();
    }

    this._sockets.delete(socket);

    const peerId = meta.peerId;
    if (peerId) {
      const peerEntry = this.peers.get(peerId);
      let remainingLiveSocket = null;
      if (peerEntry && peerEntry.socket === socket) {
        // Check if another established socket exists for the same peer
        for (const s of this._sockets) {
          const sMeta = this._socketMeta.get(s);
          if (sMeta && sMeta.peerId === peerId && sMeta.handshakeState === 'ESTABLISHED' && !s.destroyed) {
            remainingLiveSocket = sMeta;
            break;
          }
        }
        if (remainingLiveSocket) {
          this._storePeerSession(remainingLiveSocket, {
            peerId,
            publicKey: remainingLiveSocket.publicKey,
            sessionKey: remainingLiveSocket.sessionKey,
            epoch: remainingLiveSocket.epoch
          });
        } else {
          if (peerEntry.pendingRotation) {
            clearTimeout(peerEntry.pendingRotation.timer);
            peerEntry.pendingRotation.reject(new SocketDestroyedError('Peer disconnected during key rotation'));
            peerEntry.pendingRotation = null;
          }
          this.peers.delete(peerId);
          if (typeof this.crypto.resetReplayState === 'function') {
            this.crypto.resetReplayState(peerId);
          }
        }
      }

      // Reject any pending shard requests waiting on this peer if no socket remains (or bound to this socket)
      for (const [requestId, pending] of this._pendingShards.entries()) {
        if (pending.peerId === peerId && (!remainingLiveSocket || pending.socket === socket)) {
          clearTimeout(pending.timer);
          this._pendingShards.delete(requestId);
          const err = new SocketDestroyedError(`Peer ${peerId} disconnected during shard dispatch`);
          err.code = 'ERR_PEER_DISCONNECTED';
          pending.reject(err);
        }
      }

      if (!remainingLiveSocket) {
        if (!this._closing && this.router && typeof this.router.handlePeerDisconnect === 'function') {
          this.router.handlePeerDisconnect(peerId);
        }
        this.emit('peerDisconnected', { peerId, socket });
      }
    }
  }

  _handleStreamFrame(socket, meta, streamId, flags, payloadData) {
    if (meta.closed || socket.destroyed) return;

    let stream = meta.streams.get(streamId);
    if (!stream) {
      if (flags & STREAM_FLAG_RST) {
        // Stream already gone or reset, ignore
        return;
      }
      // Allocate inbound P2PStream
      stream = new P2PStream({
        streamId,
        node: this,
        socket,
        peerId: meta.peerId
      });
      meta.streams.set(streamId, stream);
      stream.on('close', () => {
        if (meta.streams.get(streamId) === stream) {
          meta.streams.delete(streamId);
        }
      });
      this.emit('stream', stream, { peerId: meta.peerId, socket, streamId });
    }

    if (flags & STREAM_FLAG_RST) {
      stream._reset = true;
      meta.streams.delete(streamId);
      stream.destroy(new MultiplexError(`Stream ${streamId} reset by remote peer`, 'ERR_STREAM_RESET'));
      return;
    }

    if (flags & STREAM_FLAG_MSG) {
      // Decode structured message
      let parsed = null;
      try {
        if (payloadData.length > 0 && (payloadData[0] === 0xff || payloadData[0] === 0x02)) {
          const slice = payloadData[0] === 0x02 ? payloadData.subarray(1) : payloadData;
          parsed = v8.deserialize(slice);
        } else {
          parsed = JSON.parse(payloadData.toString('utf8'));
        }
      } catch {
        parsed = payloadData;
      }
      stream.emit('message', parsed);
      this.emit('streamMessage', { streamId, data: parsed, peerId: meta.peerId, socket });
    } else if (payloadData.length > 0) {
      stream.push(payloadData);
    }

    if (flags & STREAM_FLAG_FIN) {
      stream._remoteClosed = true;
      stream.push(null);
    }
  }

  /**
   * Creates or allocates a new multiplexed logical duplex stream over an existing connection.
   * @param {string | net.Socket} peerIdOrSocket
   * @param {object} [options]
   * @param {number} [options.streamId] Explicit stream ID (0-65535) or auto-assigned
   * @returns {P2PStream}
   */
  createStream(peerIdOrSocket, options = {}) {
    if (this._closing) {
      throw new Error('Cannot create stream: node is closing');
    }
    const resolved = this._resolvePeerTarget(peerIdOrSocket);
    if (resolved.error) {
      throw resolved.error;
    }
    const { peerId, socket } = resolved;
    const meta = this._socketMeta.get(socket);
    if (!meta || meta.closed || !socket || socket.destroyed || !socket.writable) {
      throw new SocketDestroyedError(`Cannot create stream on disconnected peer or socket`);
    }

    let streamId = options.streamId;
    if (streamId !== undefined) {
      if (!Number.isSafeInteger(streamId) || streamId < 0 || streamId > 0xffff) {
        throw new RangeError(`Invalid streamId (${streamId}): must be an integer between 0 and 65535`);
      }
      if (meta.streams.has(streamId)) {
        throw new MultiplexError(`Stream ID ${streamId} already active on this socket`, 'ERR_STREAM_EXISTS');
      }
    } else {
      // Auto-assign next odd (for initiator) or next free streamId
      let candidate = (this._nextStreamId % 65534) + 1;
      let attempts = 0;
      while (meta.streams.has(candidate) && attempts < 65535) {
        candidate = (candidate % 65534) + 1;
        attempts++;
      }
      if (attempts >= 65535) {
        throw new MultiplexError('Exhausted stream ID space on connection', 'ERR_STREAM_EXHAUSTED');
      }
      this._nextStreamId = (candidate % 65534) + 1;
      streamId = candidate;
    }

    const stream = new P2PStream({
      streamId,
      node: this,
      socket,
      peerId,
      streamOptions: options
    });

    meta.streams.set(streamId, stream);
    stream.on('close', () => {
      if (meta.streams.get(streamId) === stream) {
        meta.streams.delete(streamId);
      }
    });

    return stream;
  }

  _writeFrame(socket, payload) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.destroyed || !socket.writable) {
        reject(new SocketDestroyedError('Cannot write to closed or destroyed socket'));
        return;
      }

      let frame;
      try {
        frame = this.encodeFrame(payload);
      } catch (err) {
        reject(err);
        return;
      }

      try {
        socket.write(frame, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  _validateHandshakeTimestampAndNonce(msg) {
    if (typeof msg.nodeId !== 'string' || !msg.nodeId) {
      return { ok: false, error: new TypeError('Invalid handshake nodeId: must be a non-empty string') };
    }
    if (typeof msg.publicKey !== 'string' || !msg.publicKey) {
      return { ok: false, error: new TypeError('Invalid handshake publicKey: must be a non-empty string') };
    }
    if (!Number.isSafeInteger(msg.epoch) || msg.epoch < 0) {
      return { ok: false, error: new RangeError('Invalid handshake epoch: must be a non-negative safe integer') };
    }
    if (typeof msg.timestamp !== 'number' || !Number.isSafeInteger(msg.timestamp) || msg.timestamp <= 0) {
      return { ok: false, error: new RangeError('Invalid handshake timestamp: must be a positive safe integer') };
    }

    const drift = Math.abs(this._now() - msg.timestamp);
    const maxDrift = this._maxDriftMs();
    if (drift > maxDrift) {
      return {
        ok: false,
        error: new Error(`Handshake timestamp drift (${drift}ms) exceeds tolerance (${maxDrift}ms)`)
      };
    }

    const validNonce =
      (typeof msg.nonce === 'string' && msg.nonce.length > 0) ||
      (typeof msg.nonce === 'number' && Number.isSafeInteger(msg.nonce) && msg.nonce > 0);
    if (!validNonce) {
      return { ok: false, error: new TypeError('Invalid handshake nonce') };
    }

    const nonceKey = `${msg.nodeId}:${String(msg.nonce)}`;
    if (this._seenHandshakeNonces.has(nonceKey)) {
      return { ok: false, error: new Error('Replayed handshake nonce detected') };
    }

    this._recordHandshakeNonce(msg.nodeId, msg.nonce);

    return { ok: true };
  }

  _recordHandshakeNonce(nodeId, nonce) {
    const nonceKey = `${nodeId}:${String(nonce)}`;
    this._seenHandshakeNonces.add(nonceKey);
    if (this._seenHandshakeNonces.size > MAX_SEEN_HANDSHAKE_NONCES) {
      const oldest = this._seenHandshakeNonces.values().next().value;
      this._seenHandshakeNonces.delete(oldest);
    }
  }

  _deriveEpochSessionKey(peerPublicKey, epoch, connectionSalt) {
    const opts = {
      epoch,
      info: `open-side-v1-session-key-epoch:${epoch}`
    };
    if (connectionSalt) {
      opts.salt = connectionSalt;
    }
    return this.crypto.deriveSessionKey(peerPublicKey, opts);
  }

  _storePeerSession(meta, { peerId, publicKey, sessionKey, epoch }) {
    meta.handshakeState = 'ESTABLISHED';
    meta.peerId = peerId;
    meta.publicKey = publicKey;
    meta.sessionKey = sessionKey;
    meta.epoch = epoch;

    if (meta.inboundAuthTimer) {
      clearTimeout(meta.inboundAuthTimer);
      meta.inboundAuthTimer = null;
    }

    const newEntry = {
      peerId,
      nodeId: peerId,
      publicKey,
      sessionKey,
      epoch,
      socket: meta.socket,
      endpoint: meta.endpoint,
      state: 'ESTABLISHED',
      direction: meta.direction,
      connectedAt: this._now(),
      pendingRotation: null
    };

    const existing = this.peers.get(peerId);
    if (!existing || !existing.socket || existing.socket.destroyed || existing.socket === meta.socket) {
      this.peers.set(peerId, newEntry);
      return;
    }

    if (existing.publicKey !== publicKey) {
      throw new Error(`Cannot overwrite active established peer ${peerId} with different public key`);
    }

    // Deterministic tie-breaking for simultaneous bidirectional connections (T2.F27.03):
    // Higher nodeId prefers its outbound connection; lower nodeId prefers its inbound connection.
    const preferredDirection = this.nodeId > peerId ? 'outbound' : 'inbound';
    if (meta.direction === preferredDirection && existing.direction !== preferredDirection) {
      this.peers.set(peerId, newEntry);
    }
  }

  _handleWireFrame(socket, meta, frame) {
    if (frame.kind === 'ENCRYPTED') {
      if (meta.handshakeState !== 'ESTABLISHED') {
        this._failSocket(socket, new Error('Fail-closed: received ENCRYPTED frame before handshake completed'));
        return;
      }
      this._handleEncryptedFrame(socket, meta, frame);
      return;
    }

    if (frame.type === 'HANDSHAKE') {
      this._handleIncomingHandshake(socket, meta, frame);
      return;
    }

    if (frame.type === 'HANDSHAKE_ACK') {
      this._handleIncomingHandshakeAck(socket, meta, frame);
      return;
    }

    if (meta.handshakeState !== 'ESTABLISHED') {
      this._failSocket(
        socket,
        new Error(`Fail-closed: unexpected unauthenticated frame type '${String(frame.type || frame.kind)}'`)
      );
      return;
    }

    this._failSocket(
      socket,
      new Error(`Fail-closed: unencrypted control frame '${String(frame.type || frame.kind)}' rejected on established session`)
    );
  }

  _handleIncomingHandshake(socket, meta, msg) {
    if (meta.handshakeState === 'ESTABLISHED') {
      this._failSocket(socket, new Error('Unexpected HANDSHAKE on already established socket'));
      return;
    }

    if (msg && (msg.nodeId === this.nodeId || msg.publicKey === this.crypto.publicKey)) {
      this._failSocket(socket, new Error('Handshake self-reflection rejected: remote nodeId equals local nodeId'));
      return;
    }

    const pending = meta.pendingHandshake;
    if (pending && pending.expectedPeerPublicKey && msg.publicKey !== pending.expectedPeerPublicKey) {
      this._failSocket(socket, new Error('Handshake failed: peer public key does not match expectedPeerPublicKey'));
      return;
    }

    const expectedNodeId = crypto.createHash('sha256').update(String(msg && msg.publicKey ? msg.publicKey : '')).digest('hex').slice(0, 40);
    if (!msg || msg.nodeId !== expectedNodeId) {
      this._failSocket(socket, new Error(`Handshake failed: nodeId mismatch with sha256(publicKey): ${msg ? msg.nodeId : 'null'} !== ${expectedNodeId}`));
      return;
    }

    const validation = this._validateHandshakeTimestampAndNonce(msg);
    if (!validation.ok) {
      this._failSocket(socket, validation.error);
      return;
    }

    let agreedEpoch = msg.epoch;
    if (pending && pending.epoch !== msg.epoch) {
      agreedEpoch = msg.nodeId > this.nodeId ? msg.epoch : pending.epoch;
    }

    let sessionKey;
    try {
      sessionKey = this._deriveEpochSessionKey(msg.publicKey, agreedEpoch);
    } catch (err) {
      this._failSocket(socket, err);
      return;
    }

    const ack = {
      type: 'HANDSHAKE_ACK',
      nodeId: this.nodeId,
      publicKey: this.crypto.publicKey,
      epoch: agreedEpoch,
      timestamp: this._now(),
      nonce: crypto.randomBytes(16).toString('hex')
    };

    this._writeFrame(socket, ack).catch((err) => {
      this._failSocket(socket, err);
    });

    this._storePeerSession(meta, {
      peerId: msg.nodeId,
      publicKey: msg.publicKey,
      sessionKey,
      epoch: agreedEpoch
    });

    this.emit('peerConnected', {
      peerId: msg.nodeId,
      publicKey: msg.publicKey,
      epoch: agreedEpoch,
      socket
    });

    if (pending) {
      meta.pendingHandshake = null;
      clearTimeout(pending.timer);
      pending.resolve(sessionKey);
    }
  }

  _handleIncomingHandshakeAck(socket, meta, msg) {
    // If simultaneous handshake on same socket already promoted state via HANDSHAKE, ignore duplicate ACK for same peer
    if (meta.handshakeState === 'ESTABLISHED') {
      if (msg.nodeId === meta.peerId && msg.publicKey === meta.publicKey && msg.epoch === meta.epoch) {
        return;
      }
      this._failSocket(socket, new Error('Mismatched HANDSHAKE_ACK on established socket'));
      return;
    }

    const pending = meta.pendingHandshake;
    if (!pending) {
      this._failSocket(socket, new Error('Unexpected HANDSHAKE_ACK without pending handshake'));
      return;
    }

    if (pending.expectedPeerPublicKey && msg.publicKey !== pending.expectedPeerPublicKey) {
      this._failSocket(socket, new Error('Handshake failed: peer public key does not match expectedPeerPublicKey'));
      return;
    }

    if (msg && (msg.nodeId === this.nodeId || msg.publicKey === this.crypto.publicKey)) {
      this._failSocket(socket, new Error('Handshake ACK self-reflection rejected: remote nodeId equals local nodeId'));
      return;
    }

    const expectedNodeId = crypto.createHash('sha256').update(String(msg && msg.publicKey ? msg.publicKey : '')).digest('hex').slice(0, 40);
    if (!msg || msg.nodeId !== expectedNodeId) {
      this._failSocket(socket, new Error(`Handshake ACK failed: nodeId mismatch with sha256(publicKey): ${msg ? msg.nodeId : 'null'} !== ${expectedNodeId}`));
      return;
    }

    const validation = this._validateHandshakeTimestampAndNonce(msg);
    if (!validation.ok) {
      this._failSocket(socket, validation.error);
      return;
    }

    if (msg.epoch !== pending.epoch) {
      this._failSocket(socket, new Error(`Handshake epoch mismatch: expected ${pending.epoch}, got ${msg.epoch}`));
      return;
    }

    let sessionKey;
    try {
      sessionKey = this._deriveEpochSessionKey(msg.publicKey, pending.epoch);
    } catch (err) {
      this._failSocket(socket, err);
      return;
    }

    this._storePeerSession(meta, {
      peerId: msg.nodeId,
      publicKey: msg.publicKey,
      sessionKey,
      epoch: pending.epoch
    });

    meta.pendingHandshake = null;
    clearTimeout(pending.timer);

    this.emit('peerConnected', {
      peerId: msg.nodeId,
      publicKey: msg.publicKey,
      epoch: pending.epoch,
      socket
    });

    pending.resolve(sessionKey);
  }

  /**
   * Executes a live 2-way ephemeral ECDH + HKDF-SHA512 handshake over a connected socket.
   * @param {net.Socket} socket
   * @param {string} [expectedPeerPublicKey]
   * @param {object} [options]
   * @returns {Promise<Buffer>} Derived 32-byte session key
   */
  initiateHandshake(socket, expectedPeerPublicKey, options = {}) {
    if (!socket || typeof socket.write !== 'function') {
      return Promise.reject(new TypeError('Invalid socket: expected net.Socket'));
    }
    if (socket.destroyed) {
      return Promise.reject(new SocketDestroyedError('Cannot initiate handshake on destroyed socket'));
    }
    if (expectedPeerPublicKey !== undefined && expectedPeerPublicKey !== null && typeof expectedPeerPublicKey !== 'string') {
      return Promise.reject(new TypeError('Invalid expectedPeerPublicKey: must be a string'));
    }
    if (expectedPeerPublicKey && expectedPeerPublicKey === this.crypto.publicKey) {
      return Promise.reject(new Error('Handshake self-reflection rejected: cannot initiate handshake with own public key'));
    }

    let meta = this._socketMeta.get(socket);
    if (!meta) {
      meta = this._setupSocket(socket, { direction: 'outbound', endpoint: null });
    }
    if (meta.handshakeState === 'ESTABLISHED') {
      if (expectedPeerPublicKey && meta.publicKey !== expectedPeerPublicKey) {
        const mismatchErr = new Error('Peer public key mismatch on established socket');
        this._failSocket(socket, mismatchErr);
        return Promise.reject(mismatchErr);
      }
      return Promise.resolve(meta.sessionKey);
    }
    if (meta.pendingHandshake) {
      return Promise.reject(new Error('Handshake already in progress on this socket'));
    }

    const epoch = options.epoch !== undefined ? options.epoch : 1;
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      return Promise.reject(new RangeError('Invalid handshake epoch: must be a non-negative safe integer'));
    }
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : this.handshakeTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (meta.pendingHandshake) {
          const timeoutErr = new HandshakeTimeoutError(`Handshake timed out after ${timeoutMs}ms`);
          this._failSocket(socket, timeoutErr);
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      meta.pendingHandshake = {
        epoch,
        expectedPeerPublicKey: expectedPeerPublicKey || null,
        resolve,
        reject,
        timer
      };

      const handshakeFrame = {
        type: 'HANDSHAKE',
        nodeId: this.nodeId,
        publicKey: this.crypto.publicKey,
        epoch,
        timestamp: this._now(),
        nonce: crypto.randomBytes(16).toString('hex')
      };

      this._recordHandshakeNonce(this.nodeId, handshakeFrame.nonce);

      this._writeFrame(socket, handshakeFrame).catch((err) => {
        if (meta.pendingHandshake) {
          this._failSocket(socket, err);
        }
      });
    });
  }

  /**
   * Returns the established 32-byte HKDF-SHA512 session key for a peer, or null.
   * @param {string} peerId
   * @returns {Buffer | null}
   */
  getSessionKey(peerId) {
    const peer = this.peers.get(peerId);
    return peer ? peer.sessionKey : null;
  }

  /**
   * Returns peer connection metadata for a connected peer, or null.
   * @param {string} peerId
   * @returns {object | null}
   */
  getPeer(peerId) {
    return this.peers.get(peerId) || null;
  }

  _resolvePeerTarget(peerIdOrSocket) {
    if (typeof peerIdOrSocket === 'string') {
      const peer = this.peers.get(peerIdOrSocket);
      if (!peer) {
        return { error: new Error(`Unknown or unconnected peer: ${peerIdOrSocket}`) };
      }
      return { peerId: peerIdOrSocket, peer, socket: peer.socket };
    }
    if (peerIdOrSocket && typeof peerIdOrSocket.write === 'function') {
      const meta = this._socketMeta.get(peerIdOrSocket);
      if (!meta || !meta.peerId || meta.handshakeState !== 'ESTABLISHED') {
        return { error: new Error('Cannot send encrypted message: socket handshake is not established') };
      }
      const peer = this.peers.get(meta.peerId);
      const sessionObj = peer && peer.socket === peerIdOrSocket
        ? peer
        : {
            peerId: meta.peerId,
            publicKey: meta.publicKey,
            sessionKey: meta.sessionKey,
            epoch: meta.epoch,
            socket: peerIdOrSocket,
            state: meta.handshakeState
          };
      return { peerId: meta.peerId, peer: sessionObj, socket: peerIdOrSocket };
    }
    return { error: new TypeError('Invalid target: must be a peerId string or established net.Socket') };
  }

  /**
   * Encrypts and sends a framed AES-256-GCM message bound with AAD and monotonic sequence nonce.
   * @param {string | net.Socket} peerIdOrSocket
   * @param {string} type
   * @param {any} payload
   * @returns {Promise<void>}
   */
  async sendEncryptedMessage(peerIdOrSocket, type, payload = null) {
    if (typeof type !== 'string' || !type) {
      throw new TypeError('Invalid message type: must be a non-empty string');
    }

    const resolved = this._resolvePeerTarget(peerIdOrSocket);
    if (resolved.error) {
      throw resolved.error;
    }

    const { peerId, peer, socket } = resolved;
    if (peer.state !== 'ESTABLISHED' || !Buffer.isBuffer(peer.sessionKey)) {
      throw new Error(`Peer session not established for ${peerId}`);
    }
    if (!socket || socket.destroyed || !socket.writable) {
      throw new SocketDestroyedError(`Cannot send to peer ${peerId}: socket is destroyed`);
    }

    const aad = `${this.nodeId}:${peerId}:${type}`;
    const packet = this.crypto.encryptShard({ type, payload }, peer.sessionKey, {
      aad,
      epoch: peer.epoch
    });

    const wireFrame = {
      kind: 'ENCRYPTED',
      senderId: this.nodeId,
      msgType: type,
      epoch: peer.epoch,
      packet
    };

    await this._writeFrame(socket, wireFrame);
  }

  /**
   * Initiates authenticated session key rotation with a connected peer, bumping epoch
   * and deriving a fresh HKDF-SHA512 session key once acknowledged.
   * @param {string} peerId
   * @param {number} [newEpoch]
   * @param {object} [options]
   * @returns {Promise<Buffer>}
   */
  async rotateSessionKey(peerId, newEpoch, options = {}) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.state !== 'ESTABLISHED') {
      throw new Error(`Cannot rotate key: peer ${peerId} is not established`);
    }
    if (peer.pendingRotation) {
      throw new Error(`Key rotation already in progress for peer ${peerId}`);
    }

    const nextEpoch = newEpoch !== undefined ? newEpoch : peer.epoch + 1;
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch <= peer.epoch) {
      throw new RangeError(`Invalid newEpoch (${nextEpoch}): must be a safe integer greater than current epoch (${peer.epoch})`);
    }

    const nextSessionKey = this._deriveEpochSessionKey(peer.publicKey, nextEpoch);
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : this.handshakeTimeoutMs;

    const ackPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (peer.pendingRotation && peer.pendingRotation.epoch === nextEpoch) {
          peer.pendingRotation = null;
          reject(new HandshakeTimeoutError(`Key rotation timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      peer.pendingRotation = {
        epoch: nextEpoch,
        sessionKey: nextSessionKey,
        resolve,
        reject,
        timer
      };
    });
    ackPromise.catch(() => {});

    try {
      await this.sendEncryptedMessage(peerId, 'KEY_ROTATE', {
        nextEpoch,
        epoch: nextEpoch,
        requestAck: true,
        timestamp: this._now()
      });
    } catch (err) {
      if (peer.pendingRotation && peer.pendingRotation.epoch === nextEpoch) {
        clearTimeout(peer.pendingRotation.timer);
        peer.pendingRotation = null;
      }
      throw err;
    }

    return ackPromise;
  }

  _handleEncryptedFrame(socket, meta, frame) {
    const rejectEncrypted = (err) => {
      if (/Anti-replay|Replay detected|Timestamp/i.test(err.message)) {
        this.emit('replayRejected', { senderId: frame.senderId, error: err, frame, socket });
      }
      this._emitWireError(err, { socket, frame, senderId: frame.senderId });
      if (this.destroyOnTamper && !socket.destroyed) {
        socket.destroy();
      }
    };

    if (typeof frame.senderId !== 'string' || !frame.senderId || frame.senderId !== meta.peerId) {
      rejectEncrypted(new Error('Invalid senderId in encrypted wire frame'));
      return;
    }
    if (typeof frame.msgType !== 'string' || !frame.msgType) {
      rejectEncrypted(new TypeError('Invalid msgType in encrypted wire frame'));
      return;
    }
    if (!Number.isSafeInteger(frame.epoch) || frame.epoch < 0) {
      rejectEncrypted(new RangeError('Invalid epoch in encrypted wire frame'));
      return;
    }
    if (!frame.packet || typeof frame.packet !== 'object') {
      rejectEncrypted(new TypeError('Missing encrypted packet in wire frame'));
      return;
    }
    if (frame.packet.epoch !== undefined && frame.packet.epoch !== frame.epoch) {
      rejectEncrypted(new Error('Encrypted packet epoch mismatch with wire frame epoch'));
      return;
    }

    const peer = this.peers.get(frame.senderId);
    const activeEpoch = peer && peer.socket === socket ? peer.epoch : meta.epoch;
    let decryptionKey = peer && peer.socket === socket ? peer.sessionKey : meta.sessionKey;
    let matchedPendingRotation = false;

    if (frame.epoch !== activeEpoch) {
      if (
        frame.msgType === 'KEY_ROTATE_ACK' &&
        peer &&
        peer.pendingRotation &&
        frame.epoch === peer.pendingRotation.epoch
      ) {
        decryptionKey = peer.pendingRotation.sessionKey;
        matchedPendingRotation = true;
      } else {
        rejectEncrypted(new Error(`Epoch mismatch: expected ${activeEpoch}, got ${frame.epoch}`));
        return;
      }
    }

    const expectedAad = `${frame.senderId}:${this.nodeId}:${frame.msgType}`;
    let decrypted;
    try {
      decrypted = this.crypto.decryptShard(frame.packet, decryptionKey, {
        validateReplay: true,
        senderId: frame.senderId,
        aad: expectedAad
      });
    } catch (err) {
      rejectEncrypted(err);
      return;
    }

    if (!decrypted || typeof decrypted !== 'object' || decrypted.type !== frame.msgType) {
      rejectEncrypted(new Error('Inner decrypted message type mismatch with wire frame msgType'));
      return;
    }

    const payload = decrypted.payload;
    this.emit('message', {
      senderId: frame.senderId,
      type: decrypted.type,
      payload,
      epoch: frame.epoch,
      socket
    });

    if (decrypted.type === 'KEY_ROTATE') {
      this._handleKeyRotate(socket, meta, frame.senderId, payload);
      return;
    }

    if (decrypted.type === 'KEY_ROTATE_ACK') {
      if (matchedPendingRotation && peer && peer.pendingRotation) {
        const pendingRot = peer.pendingRotation;
        peer.pendingRotation = null;
        clearTimeout(pendingRot.timer);
        peer.epoch = pendingRot.epoch;
        peer.sessionKey = pendingRot.sessionKey;
        meta.epoch = pendingRot.epoch;
        meta.sessionKey = pendingRot.sessionKey;
        this.emit('keyRotated', { peerId: frame.senderId, epoch: pendingRot.epoch });
        pendingRot.resolve(pendingRot.sessionKey);
      }
      return;
    }

    if (decrypted.type === 'SHARD_DISPATCH') {
      this._handleShardDispatch(socket, meta, frame.senderId, decryptionKey, payload);
      return;
    }

    if (decrypted.type === 'SHARD_RESULT') {
      this._handleShardResult(frame.senderId, decryptionKey, payload);
      return;
    }

    if (decrypted.type === 'SHARD_REJECTED') {
      this._handleShardRejected(frame.senderId, payload);
    }
  }

  _handleKeyRotate(socket, meta, senderId, payload) {
    const peer = this.peers.get(senderId);
    if (!peer || peer.socket !== socket) {
      this._emitWireError(new Error('Rejected KEY_ROTATE on inactive or mismatched socket'), { socket, senderId });
      return;
    }
    const currentEpoch = peer.epoch;
    const currentPub = peer.publicKey;
    const targetEpoch = payload && payload.nextEpoch !== undefined
      ? payload.nextEpoch
      : (payload && payload.epoch !== undefined ? payload.epoch : currentEpoch + 1);

    if (!Number.isSafeInteger(targetEpoch) || targetEpoch <= currentEpoch) {
      this._emitWireError(new RangeError(`Invalid KEY_ROTATE epoch ${targetEpoch} (current: ${currentEpoch})`), { socket, senderId });
      return;
    }

    let nextKey;
    try {
      nextKey = this._deriveEpochSessionKey(currentPub, targetEpoch);
    } catch (err) {
      this._emitWireError(err, { socket, senderId });
      return;
    }

    meta.epoch = targetEpoch;
    meta.sessionKey = nextKey;
    if (peer) {
      peer.epoch = targetEpoch;
      peer.sessionKey = nextKey;
    }

    this.emit('keyRotated', { peerId: senderId, epoch: targetEpoch });

    if (payload && payload.requestAck === true) {
      const target = peer && peer.socket === socket ? senderId : socket;
      this.sendEncryptedMessage(target, 'KEY_ROTATE_ACK', { epoch: targetEpoch }).catch((err) => {
        this._emitWireError(err, { socket, senderId });
      });
    }
  }

  async _handleShardDispatch(socket, meta, senderId, sessionKey, payload) {
    const shard = payload && payload.shard && typeof payload.shard === 'object' ? payload.shard : payload;
    const requestId = payload && typeof payload.requestId === 'string' && payload.requestId
      ? payload.requestId
      : (shard && typeof shard.shardId === 'string' ? shard.shardId : null);

    const sendReply = async (msgType, replyPayload) => {
      if (socket.destroyed || meta.closed || this._closing) {
        return;
      }
      const peer = this.peers.get(senderId);
      const target = peer && peer.socket === socket ? senderId : socket;
      try {
        await this.sendEncryptedMessage(target, msgType, replyPayload);
      } catch (err) {
        this._emitWireError(err, { socket, senderId });
      }
    };

    if (!shard || typeof shard !== 'object' || typeof shard.shardId !== 'string' || !shard.shardId || typeof shard.taskCode !== 'string' || !shard.taskCode) {
      await sendReply('SHARD_REJECTED', {
        shardId: shard && shard.shardId ? shard.shardId : null,
        requestId,
        reason: 'INVALID_SHARD',
        error: 'Invalid shard payload: shardId and taskCode are required',
        workerId: this.nodeId
      });
      return;
    }

    const sandbox = this._getSandbox();

    // Telemetry load-shedding check (if enabled)
    if (this.enforceTelemetry) {
      if (this.router && typeof this.router.canAcceptShard === 'function') {
        const gate = this.router.canAcceptShard();
        if (!gate || !gate.accepted) {
          await sendReply('SHARD_REJECTED', {
            shardId: shard.shardId,
            requestId,
            reason: (gate && gate.loadShedState) || 'LOAD_SHEDDING',
            loadShedState: gate ? gate.loadShedState : 'LOAD_SHEDDING',
            telemetry: gate ? gate.telemetry : undefined,
            error: `Worker load-shedding active (${(gate && gate.loadShedState) || 'LOAD_SHEDDING'})`,
            workerId: this.nodeId
          });
          return;
        }
      } else {
        const standby = typeof sandbox.isDeviceInStandby === 'function' ? sandbox.isDeviceInStandby() : null;
        let memLow = false;
        try {
          const rawTotal = this._os.totalmem();
          const rawFree = this._os.freemem();
          if (typeof rawTotal === 'number' && rawTotal > 0 && typeof rawFree === 'number') {
            if (rawFree / rawTotal < 0.10) memLow = true;
          }
        } catch {}
        const cpuOver = Boolean(standby && (!standby.standbyReady || (standby.metrics && standby.metrics.normalizedLoad > 0.25)));
        if (cpuOver || memLow) {
          const reason = (cpuOver && memLow) ? 'CPU_AND_MEMORY_EXHAUSTED' : (cpuOver ? 'CPU_OVERLOAD' : 'MEMORY_EXHAUSTED');
          await sendReply('SHARD_REJECTED', {
            shardId: shard.shardId,
            requestId,
            reason: reason,
            loadShedState: reason,
            error: `Worker node is shedding load (${reason})`,
            workerId: this.nodeId
          });
          return;
        }
      }
    }

    // Optional M4 static AST validation
    if (typeof sandbox.validateTaskCode === 'function') {
      const validation = sandbox.validateTaskCode(shard.taskCode);
      if (!validation || validation.valid !== true) {
        await sendReply('SHARD_REJECTED', {
          shardId: shard.shardId,
          requestId,
          reason: 'SANDBOX_VALIDATION_FAILED',
          error: (validation && validation.error) || 'Task code rejected by sandbox pre-validator',
          workerId: this.nodeId
        });
        return;
      }
    }

    let execResult;
    try {
      if (typeof sandbox.executeIsolatedShardAsync === 'function' && payload && payload.sync !== true) {
        const execOptions = {};
        const localMaxTimeout = this.shardTimeoutMs || DEFAULT_SHARD_TIMEOUT_MS;
        const localMaxMem = (sandbox && sandbox.maxMemoryMb) || 128;
        if (payload.timeoutMs !== undefined && typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0) {
          execOptions.timeoutMs = Math.min(payload.timeoutMs, localMaxTimeout);
        } else {
          execOptions.timeoutMs = localMaxTimeout;
        }
        if (payload.memoryLimitMb !== undefined && typeof payload.memoryLimitMb === 'number' && Number.isFinite(payload.memoryLimitMb) && payload.memoryLimitMb > 0) {
          execOptions.memoryLimitMb = Math.min(payload.memoryLimitMb, localMaxMem);
        } else {
          execOptions.memoryLimitMb = localMaxMem;
        }
        execResult = await sandbox.executeIsolatedShardAsync(shard, execOptions);
      } else {
        execResult = sandbox.executeIsolatedShard(shard);
      }
    } catch (err) {
      await sendReply('SHARD_REJECTED', {
        shardId: shard.shardId,
        requestId,
        reason: 'EXECUTION_FAILED',
        error: err && err.message ? err.message : String(err),
        workerId: this.nodeId
      });
      return;
    }

    try {
      // Use the latest peer sessionKey in case rotation occurred, or the sessionKey active for this connection
      const currentPeer = this.peers.get(senderId);
      const signingKey = (currentPeer && currentPeer.socket === socket ? currentPeer.sessionKey : meta.sessionKey) || sessionKey;
      const proofOfCompute = this.crypto.signProofOfCompute(shard.shardId, execResult.output, signingKey);

      await sendReply('SHARD_RESULT', {
        shardId: shard.shardId,
        requestId,
        index: shard.index,
        output: execResult.output,
        executionTimeMs: execResult.executionTimeMs,
        proofOfCompute,
        workerId: this.nodeId
      });
    } catch (err) {
      await sendReply('SHARD_REJECTED', {
        shardId: shard.shardId,
        requestId,
        reason: 'PROOF_GENERATION_FAILED',
        error: err && err.message ? err.message : String(err),
        workerId: this.nodeId
      });
    }
  }

  _findPendingShard(senderId, payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    if (typeof payload.requestId === 'string' && this._pendingShards.has(payload.requestId)) {
      const entry = this._pendingShards.get(payload.requestId);
      if (entry.peerId === senderId) {
        return { key: payload.requestId, entry };
      }
    }
    if (typeof payload.shardId === 'string') {
      for (const [key, entry] of this._pendingShards.entries()) {
        if (entry.peerId === senderId && entry.shardId === payload.shardId) {
          return { key, entry };
        }
      }
    }
    return null;
  }

  _handleShardResult(senderId, sessionKey, payload) {
    const match = this._findPendingShard(senderId, payload);
    if (!match) {
      return;
    }
    const { key, entry } = match;
    clearTimeout(entry.timer);
    this._pendingShards.delete(key);

    if (payload.shardId !== entry.shardId) {
      const err = new Error(`Shard ID correlation mismatch: expected ${entry.shardId}, received ${payload.shardId}`);
      err.code = 'ERR_SHARD_MISMATCH';
      entry.reject(err);
      return;
    }

    const validPoC = this.crypto.verifyProofOfCompute(
      payload.shardId,
      payload.output,
      payload.proofOfCompute,
      sessionKey
    );
    if (!validPoC) {
      const err = new Error(`Proof-of-Compute verification failed for shard ${payload.shardId}`);
      err.code = 'ERR_INVALID_POC';
      entry.reject(err);
      return;
    }

    entry.resolve({
      shardId: payload.shardId,
      output: payload.output,
      proofOfCompute: payload.proofOfCompute,
      executionTimeMs: payload.executionTimeMs,
      workerId: payload.workerId || senderId
    });
  }

  _handleShardRejected(senderId, payload) {
    const match = this._findPendingShard(senderId, payload);
    if (!match) {
      return;
    }
    const { key, entry } = match;
    clearTimeout(entry.timer);
    this._pendingShards.delete(key);

    const reason = (payload && payload.reason) || 'SHARD_REJECTED';
    const detail = (payload && payload.error) || `Shard ${entry.shardId} rejected by worker ${senderId} (${reason})`;
    const err = new Error(detail);
    err.code = 'ERR_SHARD_REJECTED';
    err.reason = reason;
    err.shardId = entry.shardId;
    err.workerId = (payload && payload.workerId) || senderId;
    entry.reject(err);
  }

  /**
   * Dispatches an encrypted compute shard to an established peer and resolves once
   * the signed Proof-of-Compute result is verified.
   * @param {string | net.Socket} peerIdOrSocket
   * @param {{ shardId: string, index?: number, taskCode: string, inputData: any[] }} shard
   * @param {object} [options]
   * @returns {Promise<{ shardId: string, output: any, proofOfCompute: string, executionTimeMs: number, workerId: string }>}
   */
  async dispatchRemoteShard(peerIdOrSocket, shard, options = {}) {
    if (this._closing) {
      throw new Error('Cannot dispatch shard: node is closing');
    }
    if (!shard || typeof shard !== 'object' || typeof shard.shardId !== 'string' || !shard.shardId || typeof shard.taskCode !== 'string' || !shard.taskCode) {
      throw new TypeError('Invalid shard: must be an object with non-empty shardId and taskCode');
    }

    const resolved = this._resolvePeerTarget(peerIdOrSocket);
    if (resolved.error) {
      throw resolved.error;
    }

    const { peerId, socket } = resolved;
    const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : this.shardTimeoutMs;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('Invalid timeoutMs: must be a positive finite number');
    }

    const requestId = crypto.randomUUID();

    const resultPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingShards.has(requestId)) {
          this._pendingShards.delete(requestId);
          const err = new Error(`Remote shard dispatch (${shard.shardId}) timed out after ${timeoutMs}ms`);
          err.code = 'ERR_SHARD_TIMEOUT';
          reject(err);
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      this._pendingShards.set(requestId, {
        requestId,
        shardId: shard.shardId,
        peerId,
        socket,
        resolve,
        reject,
        timer
      });
    });
    resultPromise.catch(() => {});

    const dispatchPayload = {
      ...shard,
      requestId
    };
    if (options.executionTimeoutMs !== undefined) {
      if (typeof options.executionTimeoutMs === 'number' && Number.isFinite(options.executionTimeoutMs) && options.executionTimeoutMs > 0) {
        dispatchPayload.timeoutMs = Math.min(options.executionTimeoutMs, timeoutMs);
      } else {
        dispatchPayload.timeoutMs = timeoutMs;
      }
    }
    if (options.memoryLimitMb !== undefined) {
      dispatchPayload.memoryLimitMb = options.memoryLimitMb;
    }
    if (options.sync !== undefined) {
      dispatchPayload.sync = Boolean(options.sync);
    }

    try {
      await this.sendEncryptedMessage(peerIdOrSocket, 'SHARD_DISPATCH', dispatchPayload);
    } catch (err) {
      const pending = this._pendingShards.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingShards.delete(requestId);
      }
      throw err;
    }

    return resultPromise;
  }

  /**
   * Gracefully shuts down the P2P server, destroys all active sockets, clears pending timers,
   * and resolves once all handles are closed cleanly.
   * @returns {Promise<void>}
   */
  close() {
    if (this._closePromise) {
      return this._closePromise;
    }

    this._closing = true;

    this._closePromise = (async () => {
      // If listen() is currently in progress, wait for it to settle so we don't leak a binding server
      if (this._listeningPromise) {
        try {
          await this._listeningPromise;
        } catch {
          // Ignore bind errors during shutdown
        }
      }

      // Reject all pending shard dispatches
      for (const [requestId, pending] of this._pendingShards.entries()) {
        clearTimeout(pending.timer);
        this._pendingShards.delete(requestId);
        const err = new SocketDestroyedError('Node closed during pending shard dispatch');
        err.code = 'ERR_NODE_CLOSED';
        pending.reject(err);
      }

      // Reject all pending key rotations
      for (const peer of this.peers.values()) {
        if (peer.pendingRotation) {
          clearTimeout(peer.pendingRotation.timer);
          peer.pendingRotation.reject(new SocketDestroyedError('Node closed during key rotation'));
          peer.pendingRotation = null;
        }
      }

      // Destroy all tracked sockets and wait for their close events
      const socketClosePromises = [];
      for (const socket of Array.from(this._sockets)) {
        const meta = this._socketMeta.get(socket);
        if (meta && meta.pendingHandshake) {
          const pending = meta.pendingHandshake;
          meta.pendingHandshake = null;
          clearTimeout(pending.timer);
          pending.reject(new SocketDestroyedError('Node closed during handshake'));
        }
        if (meta && meta.inboundAuthTimer) {
          clearTimeout(meta.inboundAuthTimer);
          meta.inboundAuthTimer = null;
        }

        if (socket.closed === false || (!socket.destroyed && socket.closed === undefined)) {
          socketClosePromises.push(
            new Promise((resolve) => {
              socket.once('close', resolve);
              if (!socket.destroyed) {
                socket.destroy();
              }
            })
          );
        } else {
          this._sockets.delete(socket);
        }
      }

      // Close server if created
      const serverClosePromise = new Promise((resolve) => {
        if (!this.server) {
          resolve();
          return;
        }
        if (!this.server.listening) {
          try {
            this.server.close(() => resolve());
          } catch {
            resolve();
          }
          return;
        }
        this.server.close(() => resolve());
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
      });

      await Promise.all([serverClosePromise, ...socketClosePromises]);

      this.peers.clear();
      this._sockets.clear();
      this._seenHandshakeNonces.clear();
      if (typeof this.crypto.resetReplayState === 'function') {
        this.crypto.resetReplayState();
      }
      this.port = null;
      this.address = null;
      this.ipcPath = null;
    })();

    return this._closePromise;
  }

  /**
   * Pipelined Shard Dispatching:
   * Dispatches multiple shards in parallel over the wire without blocking sequentially.
   * Shards fly concurrently and results are resolved as they complete.
   * @param {string|net.Socket} peerIdOrSocket
   * @param {Array<object>} shards Array of shard objects { shardId, taskCode, inputData, ... }
   * @param {object} [options] Options passed to sendShard (timeoutMs, etc.)
   * @returns {Promise<Array<object>>} Resolves with array of execution outputs in order of input shards
   */
  async dispatchPipelinedBatch(peerIdOrSocket, shards, options = {}) {
    if (!Array.isArray(shards)) {
      throw new TypeError('Invalid shards: must be an Array');
    }
    if (shards.length === 0) {
      return [];
    }

    const promises = shards.map((shard) => {
      return this.dispatchRemoteShard(peerIdOrSocket, shard, options);
    });

    return Promise.all(promises);
  }
}

module.exports = {
  P2PNode,
  P2PStream,
  MultiplexError,
  STREAM_FRAME_TAG,
  STREAM_FLAG_DATA,
  STREAM_FLAG_FIN,
  STREAM_FLAG_RST,
  STREAM_FLAG_MSG,
  FrameTooLargeError,
  SocketDestroyedError,
  AlreadyListeningError,
  HandshakeTimeoutError
};
