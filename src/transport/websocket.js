const EventEmitter = require('node:events');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const WS_GUID = '235EA68F-402E-252D-8943-FB0F868E0CD1';

const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xA
};

/**
 * Encodes a WebSocket frame into a Buffer.
 * @param {Buffer|string} data
 * @param {object} options
 * @param {number} [options.opcode] default 0x1 (TEXT) or 0x2 (BINARY)
 * @param {boolean} [options.mask] default false (client must mask, server must not)
 * @param {boolean} [options.fin] default true
 * @returns {Buffer}
 */
function encodeFrame(data, options = {}) {
  let payloadBuf;
  let defaultOpcode = OPCODES.TEXT;
  if (Buffer.isBuffer(data)) {
    payloadBuf = data;
    defaultOpcode = OPCODES.BINARY;
  } else if (typeof data === 'string') {
    payloadBuf = Buffer.from(data, 'utf8');
    defaultOpcode = OPCODES.TEXT;
  } else {
    throw new TypeError('WebSocket payload must be a Buffer or string');
  }

  const opcode = options.opcode !== undefined ? options.opcode : defaultOpcode;
  const fin = options.fin !== undefined ? Boolean(options.fin) : true;
  const mask = Boolean(options.mask);

  const payloadLength = payloadBuf.length;
  let headerLength = 2;
  let lengthField = payloadLength;

  if (payloadLength > 65535) {
    headerLength += 8;
    lengthField = 127;
  } else if (payloadLength > 125) {
    headerLength += 2;
    lengthField = 126;
  }

  if (mask) {
    headerLength += 4;
  }

  const frame = Buffer.allocUnsafe(headerLength + payloadLength);

  // Byte 0: FIN (1 bit) + RSV (3 bits) + Opcode (4 bits)
  frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0F);

  // Byte 1: MASK (1 bit) + Payload len (7 bits)
  frame[1] = (mask ? 0x80 : 0x00) | (lengthField & 0x7F);

  let offset = 2;
  if (lengthField === 126) {
    frame.writeUInt16BE(payloadLength, offset);
    offset += 2;
  } else if (lengthField === 127) {
    frame.writeBigUInt64BE(BigInt(payloadLength), offset);
    offset += 8;
  }

  if (mask) {
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;

    for (let i = 0; i < payloadLength; i++) {
      frame[offset + i] = payloadBuf[i] ^ maskKey[i % 4];
    }
  } else {
    payloadBuf.copy(frame, offset);
  }

  return frame;
}

/**
 * Streaming parser for RFC 6455 WebSocket frames over a raw duplex stream/socket.
 */
class FrameParser {
  constructor(options = {}) {
    this.maxPayloadLength = options.maxPayloadLength || 64 * 1024 * 1024; // 64MB default
    this.buffer = Buffer.alloc(0);
    this.state = 0; // 0: header (2 bytes), 1: extended len / mask key, 2: payload
    this.currentFrame = null;
  }

  push(chunk) {
    if (chunk && chunk.length > 0) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    const frames = [];

    while (true) {
      if (this.state === 0) {
        if (this.buffer.length < 2) break;
        const b0 = this.buffer[0];
        const b1 = this.buffer[1];

        // RFC 6455 5.2: RSV1, RSV2, RSV3 MUST be 0 unless negotiated via an extension
        if ((b0 & 0x70) !== 0) {
          this.buffer = Buffer.alloc(0);
          this.state = 0;
          this.currentFrame = null;
          const err = new Error('WebSocket RSV bits must be 0');
          err.code = 1002;
          throw err;
        }

        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0F;

        // RFC 6455 5.2: Validate opcode
        const isControl = (opcode & 0x08) !== 0;
        const validOpcodes = [
          OPCODES.CONTINUATION,
          OPCODES.TEXT,
          OPCODES.BINARY,
          OPCODES.CLOSE,
          OPCODES.PING,
          OPCODES.PONG
        ];
        if (!validOpcodes.includes(opcode)) {
          this.buffer = Buffer.alloc(0);
          this.state = 0;
          this.currentFrame = null;
          const err = new Error(`WebSocket reserved/unknown opcode: 0x${opcode.toString(16)}`);
          err.code = 1002;
          throw err;
        }

        // RFC 6455 5.5: Control frames MUST NOT be fragmented
        if (isControl && !fin) {
          this.buffer = Buffer.alloc(0);
          this.state = 0;
          this.currentFrame = null;
          const err = new Error('WebSocket control frames cannot be fragmented (FIN must be 1)');
          err.code = 1002;
          throw err;
        }

        const masked = (b1 & 0x80) !== 0;
        const basicLen = b1 & 0x7F;

        // RFC 6455 5.5: Control frames MUST have a payload length of 125 bytes or less
        if (isControl && basicLen > 125) {
          this.buffer = Buffer.alloc(0);
          this.state = 0;
          this.currentFrame = null;
          const err = new Error('WebSocket control frame payload cannot exceed 125 bytes');
          err.code = 1002;
          throw err;
        }

        let extraBytesNeeded = 0;
        if (basicLen === 126) extraBytesNeeded += 2;
        else if (basicLen === 127) extraBytesNeeded += 8;
        if (masked) extraBytesNeeded += 4;

        this.currentFrame = {
          fin,
          opcode,
          isControl,
          masked,
          basicLen,
          extraBytesNeeded,
          payloadLength: basicLen,
          maskKey: null
        };
        this.state = 1;
      }

      if (this.state === 1) {
        const needed = 2 + this.currentFrame.extraBytesNeeded;
        if (this.buffer.length < needed) break;

        let offset = 2;
        if (this.currentFrame.basicLen === 126) {
          this.currentFrame.payloadLength = this.buffer.readUInt16BE(offset);
          // RFC 6455 5.2: Minimal length representation check
          if (this.currentFrame.payloadLength < 126) {
            this.buffer = Buffer.alloc(0);
            this.state = 0;
            this.currentFrame = null;
            const err = new Error('WebSocket non-minimal 16-bit payload length representation');
            err.code = 1002;
            throw err;
          }
          offset += 2;
        } else if (this.currentFrame.basicLen === 127) {
          // RFC 6455 5.2: Most significant bit MUST be 0
          if ((this.buffer[offset] & 0x80) !== 0) {
            this.buffer = Buffer.alloc(0);
            this.state = 0;
            this.currentFrame = null;
            const err = new RangeError('WebSocket 64-bit payload length MSB cannot be 1');
            err.code = 1002;
            throw err;
          }
          const bigLen = this.buffer.readBigUInt64BE(offset);
          if (bigLen < 65536n) {
            this.buffer = Buffer.alloc(0);
            this.state = 0;
            this.currentFrame = null;
            const err = new Error('WebSocket non-minimal 64-bit payload length representation');
            err.code = 1002;
            throw err;
          }
          if (bigLen > BigInt(Number.MAX_SAFE_INTEGER) || Number(bigLen) > this.maxPayloadLength) {
            this.buffer = Buffer.alloc(0);
            this.state = 0;
            this.currentFrame = null;
            const err = new RangeError('WebSocket payload exceeds maximum allowed size');
            err.code = 1009;
            throw err;
          }
          this.currentFrame.payloadLength = Number(bigLen);
          offset += 8;
        }

        if (this.currentFrame.payloadLength > this.maxPayloadLength) {
          this.buffer = Buffer.alloc(0);
          this.state = 0;
          this.currentFrame = null;
          const err = new RangeError(`WebSocket payload size ${this.currentFrame.payloadLength} exceeds limit ${this.maxPayloadLength}`);
          err.code = 1009;
          throw err;
        }

        if (this.currentFrame.masked) {
          this.currentFrame.maskKey = this.buffer.subarray(offset, offset + 4);
          offset += 4;
        }

        this.state = 2;
        this.headerSize = offset;
      }

      if (this.state === 2) {
        const totalNeeded = this.headerSize + this.currentFrame.payloadLength;
        if (this.buffer.length < totalNeeded) break;

        const rawPayload = this.buffer.subarray(this.headerSize, totalNeeded);
        let payload;

        if (this.currentFrame.masked && this.currentFrame.maskKey) {
          payload = Buffer.allocUnsafe(rawPayload.length);
          const key = this.currentFrame.maskKey;
          for (let i = 0; i < rawPayload.length; i++) {
            payload[i] = rawPayload[i] ^ key[i % 4];
          }
        } else {
          payload = Buffer.from(rawPayload);
        }

        // RFC 6455 5.5.1: Close frame payload validation
        if (this.currentFrame.opcode === OPCODES.CLOSE) {
          if (payload.length === 1) {
            this.buffer = Buffer.alloc(0);
            this.state = 0;
            this.currentFrame = null;
            const err = new Error('WebSocket close frame payload cannot be 1 byte (must be 0 or >= 2 bytes)');
            err.code = 1002;
            throw err;
          }
        }

        frames.push({
          fin: this.currentFrame.fin,
          opcode: this.currentFrame.opcode,
          masked: this.currentFrame.masked,
          payload
        });

        this.buffer = this.buffer.subarray(totalNeeded);
        this.currentFrame = null;
        this.state = 0;
        this.headerSize = 0;
      }
    }

    return frames;
  }
}

/**
 * Zero-dependency RFC 6455 WebSocket peer socket wrapper around a duplex net.Socket.
 */
class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {boolean} isServer
   * @param {object} [options]
   */
  constructor(socket, isServer = false, options = {}) {
    super();
    this.socket = socket;
    this.isServer = Boolean(isServer);
    this.maskOutgoing = !this.isServer; // RFC 6455: client MUST mask, server MUST NOT mask
    this.maxPayloadLength = options.maxPayloadLength || 64 * 1024 * 1024;
    this.parser = new FrameParser({ maxPayloadLength: this.maxPayloadLength });
    this.readyState = 1; // 1 = OPEN
    this.closed = false;

    this._fragments = [];
    this._fragmentOpcode = 0;

    this._setupSocket();
  }

  _setupSocket() {
    this.socket.on('data', (chunk) => {
      try {
        const frames = this.parser.push(chunk);
        for (const frame of frames) {
          this._handleFrame(frame);
        }
      } catch (err) {
        this.emit('error', err);
        const code = typeof err.code === 'number' ? err.code : 1002;
        this.close(code, err.message);
      }
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
    });

    this.socket.on('close', (hadError) => {
      this._onSocketClosed(hadError);
    });

    this.socket.on('end', () => {
      if (this.readyState === 1) {
        this.readyState = 2; // CLOSING
      }
    });
  }

  _handleFrame(frame) {
    if (this.closed) return;

    // RFC 6455 5.1: The server MUST close the connection upon receiving a frame that is not masked.
    // In this case, the server MUST send a Close frame with status code 1002 (protocol error).
    if (this.isServer && !frame.masked) {
      const err = new Error('Client frame must be masked');
      this.emit('error', err);
      this.close(1002, 'Protocol Error: unmasked client frame');
      return;
    }

    // RFC 6455 5.1: A client MUST close a connection if it detects a masked frame from server (code 1002).
    if (!this.isServer && frame.masked) {
      const err = new Error('Server frame must not be masked');
      this.emit('error', err);
      this.close(1002, 'Protocol Error: masked server frame');
      return;
    }

    // Control frames (CLOSE, PING, PONG)
    if (frame.opcode === OPCODES.CLOSE) {
      this.readyState = 2; // CLOSING
      let code = 1000;
      let reason = '';
      if (frame.payload && frame.payload.length >= 2) {
        code = frame.payload.readUInt16BE(0);
        reason = frame.payload.subarray(2).toString('utf8');
      }
      this._sendCloseFrame(code, reason);
      this.readyState = 3; // CLOSED
      this.closed = true;
      this.socket.end();
      this.emit('close', code, reason);
      return;
    }

    if (frame.opcode === OPCODES.PING) {
      this.pong(frame.payload);
      this.emit('ping', frame.payload);
      return;
    }

    if (frame.opcode === OPCODES.PONG) {
      this.emit('pong', frame.payload);
      return;
    }

    // Fragmentation handling
    if (frame.opcode === OPCODES.CONTINUATION) {
      if (this._fragments.length === 0) {
        // Unexpected continuation without initial data frame
        const err = new Error('Unexpected continuation frame');
        this.emit('error', err);
        this.close(1002, 'Protocol Error: unexpected continuation');
        return;
      }
      this._fragments.push(frame.payload);
      if (frame.fin) {
        const fullPayload = Buffer.concat(this._fragments);
        const op = this._fragmentOpcode;
        this._fragments = [];
        this._fragmentOpcode = 0;
        this._emitMessage(op, fullPayload);
      }
      return;
    }

    if (!frame.fin) {
      if (this._fragments.length > 0) {
        // Cannot start a new fragment sequence while one is already in progress
        const err = new Error('Cannot start new fragment before previous fragmented message completed');
        this.emit('error', err);
        this.close(1002, 'Protocol Error: unfinished fragment sequence');
        return;
      }
      this._fragmentOpcode = frame.opcode;
      this._fragments = [frame.payload];
      return;
    }

    if (this._fragments.length > 0) {
      // Received unfragmented data frame while fragment sequence was pending
      const err = new Error('Expected continuation frame during fragmented message');
      this.emit('error', err);
      this.close(1002, 'Protocol Error: expected continuation frame');
      return;
    }

    this._emitMessage(frame.opcode, frame.payload);
  }

  _emitMessage(opcode, payload) {
    if (opcode === OPCODES.TEXT) {
      this.emit('message', payload.toString('utf8'), false);
    } else if (opcode === OPCODES.BINARY) {
      this.emit('message', payload, true);
    }
  }

  /**
   * Sends data (string or Buffer) over the WebSocket.
   * @param {string|Buffer} data
   * @param {object} [options]
   * @param {boolean} [options.binary]
   * @param {function} [cb]
   */
  send(data, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    options = options || {};

    if (this.readyState !== 1 || this.socket.destroyed) {
      const err = new Error('WebSocket is not open (readyState=' + this.readyState + ')');
      if (cb) cb(err);
      else this.emit('error', err);
      return;
    }

    let isBinary = options.binary;
    if (isBinary === undefined) {
      isBinary = Buffer.isBuffer(data);
    }
    const opcode = isBinary ? OPCODES.BINARY : OPCODES.TEXT;

    const frame = encodeFrame(data, {
      opcode,
      mask: this.maskOutgoing,
      fin: true
    });

    this.socket.write(frame, cb);
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState !== 1 || this.socket.destroyed) return;
    const frame = encodeFrame(data, {
      opcode: OPCODES.PING,
      mask: this.maskOutgoing,
      fin: true
    });
    this.socket.write(frame);
  }

  pong(data = Buffer.alloc(0)) {
    if (this.readyState !== 1 || this.socket.destroyed) return;
    const frame = encodeFrame(data, {
      opcode: OPCODES.PONG,
      mask: this.maskOutgoing,
      fin: true
    });
    this.socket.write(frame);
  }

  _sendCloseFrame(code = 1000, reason = '') {
    if (this.socket.destroyed || !this.socket.writable) return;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);

    try {
      const frame = encodeFrame(payload, {
        opcode: OPCODES.CLOSE,
        mask: this.maskOutgoing,
        fin: true
      });
      this.socket.write(frame);
    } catch {
      // socket might be closed already
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2; // CLOSING
    this._sendCloseFrame(code, reason);
    this.readyState = 3; // CLOSED
    this.closed = true;
    setTimeout(() => {
      if (!this.socket.destroyed) {
        this.socket.destroy();
      }
    }, 200).unref();
    this.emit('close', code, reason);
  }

  _onSocketClosed(hadError) {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.closed = true;
      this.emit('close', 1006, 'Abnormal Closure');
    }
  }
}

/**
 * WebSocket Server attaching to an existing http.Server or running standalone.
 * Emits 'connection' (ws, request) on successful upgrade.
 */
class WebSocketServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('node:http').Server} [options.server]
   * @param {number} [options.port]
   * @param {string} [options.host]
   * @param {string} [options.path] WebSocket path prefix to accept (e.g. '/sea')
   */
  constructor(options = {}) {
    super();
    this.options = options;
    this.server = options.server || null;
    this.path = options.path || null;
    this.clients = new Set();
    this._isOwnedServer = false;

    if (this.server) {
      this._bindUpgrade(this.server);
    }
  }

  _bindUpgrade(server) {
    this._onUpgrade = (req, socket, head) => {
      if (this.path && !req.url.startsWith(this.path)) {
        return; // Not our path, ignore or allow other handlers
      }

      const upgradeHeader = req.headers['upgrade'];
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }

      // Compute Sec-WebSocket-Accept
      const acceptValue = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue}`
      ];

      socket.write(headers.join('\r\n') + '\r\n\r\n');

      const ws = new WebSocketConnection(socket, true, this.options);
      this.clients.add(ws);

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      if (head && head.length > 0) {
        socket.unshift(head);
      }

      this.emit('connection', ws, req);
    };

    server.on('upgrade', this._onUpgrade);
  }

  listen(port, host, cb) {
    if (typeof host === 'function') {
      cb = host;
      host = '127.0.0.1';
    }
    host = host || '127.0.0.1';

    return new Promise((resolve, reject) => {
      this._isOwnedServer = true;
      this.server = http.createServer((_req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Upgrade Required');
      });

      this._bindUpgrade(this.server);

      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        const addr = this.server.address();
        if (cb) cb();
        resolve(addr);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.close(1001, 'Server shutting down');
      }
      this.clients.clear();

      if (this._isOwnedServer && this.server) {
        this.server.close(() => resolve());
      } else {
        if (this.server && this._onUpgrade) {
          this.server.removeListener('upgrade', this._onUpgrade);
        }
        resolve();
      }
    });
  }
}

/**
 * Zero-dependency RFC 6455 WebSocket Client.
 * Connects to ws:// or wss:// endpoints.
 */
class WebSocketClient extends EventEmitter {
  /**
   * @param {string} url
   * @param {object} [options]
   * @param {object} [options.headers]
   * @param {number} [options.handshakeTimeout]
   */
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0; // 0: CONNECTING, 1: OPEN, 2: CLOSING, 3: CLOSED
    this._connection = null;

    this._connect();
  }

  _connect() {
    let parsed;
    try {
      parsed = new URL(this.url);
    } catch (err) {
      process.nextTick(() => this.emit('error', err));
      return;
    }

    const isSecure = parsed.protocol === 'wss:';
    const httpMod = isSecure ? https : http;
    const defaultPort = isSecure ? 443 : 80;
    const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    const reqHeaders = {
      Host: parsed.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(this.options.headers || {})
    };

    const reqOptions = {
      protocol: isSecure ? 'https:' : 'http:',
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + (parsed.search || ''),
      headers: reqHeaders,
      timeout: this.options.handshakeTimeout || 10000
    };
    if (this.options.socketPath) {
      reqOptions.socketPath = this.options.socketPath;
    }

    const req = httpMod.request(reqOptions);
    this._req = req;

    req.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept'];
      if (accept !== expectedAccept) {
        const err = new Error('Invalid Sec-WebSocket-Accept header from server');
        socket.destroy();
        this.emit('error', err);
        return;
      }

      this.readyState = 1; // OPEN
      const ws = new WebSocketConnection(socket, false, this.options);
      this._connection = ws;

      ws.on('message', (data, isBinary) => this.emit('message', data, isBinary));
      ws.on('ping', (data) => this.emit('ping', data));
      ws.on('pong', (data) => this.emit('pong', data));
      ws.on('error', (err) => this.emit('error', err));
      ws.on('close', (code, reason) => {
        this.readyState = 3;
        this.emit('close', code, reason);
      });

      if (head && head.length > 0) {
        socket.unshift(head);
      }

      this.emit('open');
    });

    req.on('error', (err) => {
      this.readyState = 3;
      this.emit('error', err);
    });

    req.end();
  }

  send(data, options, cb) {
    if (this._connection) {
      this._connection.send(data, options, cb);
    } else {
      const err = new Error('WebSocket is not connected');
      if (typeof options === 'function') options(err);
      else if (cb) cb(err);
      else this.emit('error', err);
    }
  }

  ping(data) {
    if (this._connection) {
      this._connection.ping(data);
    }
  }

  pong(data) {
    if (this._connection) {
      this._connection.pong(data);
    }
  }

  close(code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2; // CLOSING
    if (this._connection) {
      this._connection.close(code, reason);
    } else {
      if (this._req) {
        this._req.destroy();
      }
      this.readyState = 3;
      this.emit('close', code !== undefined ? code : 1000, reason || '');
    }
  }
}

module.exports = {
  WebSocketConnection,
  WebSocketServer,
  WebSocketClient,
  encodeFrame,
  FrameParser,
  OPCODES,
  WS_GUID
};
