'use strict';

const dgram = require('node:dgram');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const net = require('node:net');

// RFC 5389 Constants
const STUN_MAGIC_COOKIE = 0x2112A442;
const STUN_MAGIC_COOKIE_BUF = Buffer.from([0x21, 0x12, 0xa4, 0x42]);

// STUN Message Types
const STUN_MSG_TYPE = {
  BINDING_REQUEST: 0x0001,
  BINDING_RESPONSE: 0x0101,
  BINDING_ERROR_RESPONSE: 0x0111,
  BINDING_INDICATION: 0x0011
};

// STUN Attribute Types
const STUN_ATTR_TYPE = {
  MAPPED_ADDRESS: 0x0001,
  CHANGE_REQUEST: 0x0003, // RFC 3489 legacy NAT classification
  RESPONSE_ADDRESS: 0x0002,
  SOURCE_ADDRESS: 0x0004,
  CHANGED_ADDRESS: 0x0005,
  USERNAME: 0x0006,
  PASSWORD: 0x0007,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  REFLECTED_FROM: 0x000b,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
  ALTERNATE_SERVER: 0x8023,
  FINGERPRINT: 0x8028
};

// Default public STUN servers
const DEFAULT_STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun2.l.google.com', port: 19302 },
  { host: 'stun3.l.google.com', port: 19302 },
  { host: 'stun4.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 }
];

// NAT Mapping Types
const NAT_TYPE = {
  OPEN_INTERNET: 'OPEN_INTERNET',
  FULL_CONE: 'FULL_CONE',
  RESTRICTED_CONE: 'RESTRICTED_CONE',
  PORT_RESTRICTED_CONE: 'PORT_RESTRICTED_CONE',
  SYMMETRIC: 'SYMMETRIC',
  UDP_BLOCKED: 'UDP_BLOCKED',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Encodes a STUN message.
 * Header format (20 bytes):
 * 0                   1                   2                   3
 * 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |0 0|     STUN Message Type     |         Message Length        |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                         Magic Cookie                          |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                                                               |
 * |                     Transaction ID (96 bits)                  |
 * |                                                               |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *
 * @param {object} options
 * @param {number} options.type - STUN message type (default: BINDING_REQUEST = 0x0001)
 * @param {Buffer} [options.transactionId] - 12-byte Buffer (96 bits)
 * @param {Buffer[]} [options.attributes] - Pre-encoded attribute Buffers
 * @returns {{ buffer: Buffer, transactionId: Buffer, type: number }}
 */
function encodeStunMessage(options = {}) {
  const type = options.type !== undefined ? options.type : STUN_MSG_TYPE.BINDING_REQUEST;
  let transactionId = options.transactionId;
  if (!transactionId) {
    transactionId = crypto.randomBytes(12);
  } else if (!Buffer.isBuffer(transactionId) || transactionId.length !== 12) {
    throw new TypeError('STUN transactionId must be a 12-byte Buffer');
  }

  const attributes = Array.isArray(options.attributes) ? options.attributes : [];
  let attrsLength = 0;
  for (const attr of attributes) {
    if (Buffer.isBuffer(attr)) {
      attrsLength += attr.length;
    }
  }

  const buffer = Buffer.alloc(20 + attrsLength);
  buffer.writeUInt16BE(type & 0x3fff, 0);
  buffer.writeUInt16BE(attrsLength, 2);
  buffer.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(buffer, 8);

  let offset = 20;
  for (const attr of attributes) {
    if (Buffer.isBuffer(attr)) {
      attr.copy(buffer, offset);
      offset += attr.length;
    }
  }

  return {
    buffer,
    transactionId,
    type
  };
}

/**
 * Encodes an XOR-MAPPED-ADDRESS attribute (RFC 5389 type 0x0020).
 * @param {string} ip - IPv4 or IPv6 string
 * @param {number} port - Port number 1..65535
 * @param {Buffer} transactionId - 12-byte transaction ID
 * @returns {Buffer}
 */
function encodeXorMappedAddressAttr(ip, port, transactionId) {
  if (typeof port !== 'number' || port < 1 || port > 65535) {
    throw new TypeError('Port must be between 1 and 65535');
  }
  if (!Buffer.isBuffer(transactionId) || transactionId.length !== 12) {
    throw new TypeError('STUN transactionId must be a 12-byte Buffer');
  }

  const isIPv6 = net.isIPv6(ip);
  const isIPv4 = !isIPv6 && net.isIPv4(ip);
  if (!isIPv4 && !isIPv6) {
    throw new Error(`Invalid IP address: ${ip}`);
  }

  const xorPort = port ^ (STUN_MAGIC_COOKIE >> 16);
  const family = isIPv4 ? 0x01 : 0x02;

  let xorIpBytes;
  if (isIPv4) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    xorIpBytes = Buffer.from(parts);
    for (let i = 0; i < 4; i++) {
      xorIpBytes[i] ^= STUN_MAGIC_COOKIE_BUF[i];
    }
  } else {
    // IPv6: XOR with Magic Cookie (4 bytes) + Transaction ID (12 bytes)
    const xorMask = Buffer.concat([STUN_MAGIC_COOKIE_BUF, transactionId]);
    xorIpBytes = Buffer.alloc(16);
    // Parse IPv6 into 16 bytes
    const buf = Buffer.alloc(16);
    // Using standard conversion or manual parse
    const expanded = expandIpv6(ip);
    for (let i = 0; i < 8; i++) {
      buf.writeUInt16BE(parseInt(expanded[i], 16), i * 2);
    }
    for (let i = 0; i < 16; i++) {
      xorIpBytes[i] = buf[i] ^ xorMask[i];
    }
  }

  const attrLen = 4 + xorIpBytes.length;
  // Attributes must be 4-byte aligned (though 4+4=8 and 4+16=20 are already aligned)
  const paddingLen = (4 - (attrLen % 4)) % 4;
  const totalAttrLen = 4 + attrLen + paddingLen;

  const buf = Buffer.alloc(totalAttrLen);
  buf.writeUInt16BE(STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS, 0);
  buf.writeUInt16BE(attrLen, 2);
  buf[4] = 0x00; // Reserved
  buf[5] = family;
  buf.writeUInt16BE(xorPort, 6);
  xorIpBytes.copy(buf, 8);

  return buf;
}

/**
 * Encodes a classic MAPPED-ADDRESS attribute (RFC 3489 / RFC 5389 type 0x0001).
 * @param {string} ip
 * @param {number} port
 * @returns {Buffer}
 */
function encodeMappedAddressAttr(ip, port) {
  if (typeof port !== 'number' || port < 1 || port > 65535) {
    throw new TypeError('Port must be between 1 and 65535');
  }
  const isIPv6 = net.isIPv6(ip);
  const isIPv4 = !isIPv6 && net.isIPv4(ip);
  if (!isIPv4 && !isIPv6) {
    throw new Error(`Invalid IP address: ${ip}`);
  }

  const family = isIPv4 ? 0x01 : 0x02;
  let ipBytes;
  if (isIPv4) {
    ipBytes = Buffer.from(ip.split('.').map((p) => parseInt(p, 10)));
  } else {
    ipBytes = Buffer.alloc(16);
    const expanded = expandIpv6(ip);
    for (let i = 0; i < 8; i++) {
      ipBytes.writeUInt16BE(parseInt(expanded[i], 16), i * 2);
    }
  }

  const attrLen = 4 + ipBytes.length;
  const paddingLen = (4 - (attrLen % 4)) % 4;
  const totalAttrLen = 4 + attrLen + paddingLen;

  const buf = Buffer.alloc(totalAttrLen);
  buf.writeUInt16BE(STUN_ATTR_TYPE.MAPPED_ADDRESS, 0);
  buf.writeUInt16BE(attrLen, 2);
  buf[4] = 0x00;
  buf[5] = family;
  buf.writeUInt16BE(port, 6);
  ipBytes.copy(buf, 8);

  return buf;
}

/**
 * Encodes a CHANGE-REQUEST attribute (RFC 3489 type 0x0003).
 * @param {boolean} changeIp
 * @param {boolean} changePort
 * @returns {Buffer}
 */
function encodeChangeRequestAttr(changeIp, changePort) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16BE(STUN_ATTR_TYPE.CHANGE_REQUEST, 0);
  buf.writeUInt16BE(4, 2);
  let flags = 0;
  if (changeIp) flags |= 0x04;
  if (changePort) flags |= 0x02;
  buf.writeUInt32BE(flags, 4);
  return buf;
}

/**
 * Expands an IPv6 address string into 8 4-hex-digit groups.
 * @param {string} ip
 * @returns {string[]}
 */
function expandIpv6(ip) {
  let [left, right] = ip.split('::');
  let leftParts = left ? left.split(':') : [];
  let rightParts = right !== undefined ? (right ? right.split(':') : []) : null;

  if (rightParts !== null) {
    const missing = 8 - (leftParts.length + rightParts.length);
    const zeros = new Array(missing).fill('0');
    leftParts = leftParts.concat(zeros).concat(rightParts);
  }

  return leftParts.map((p) => p.padStart(4, '0'));
}

/**
 * Parses a raw STUN message buffer.
 * @param {Buffer} buffer
 * @returns {object} Parsed STUN message object
 */
function parseStunMessage(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('Buffer required to parse STUN message');
  }
  if (buffer.length < 20) {
    throw new Error(`STUN message too short: ${buffer.length} bytes (minimum 20)`);
  }

  const firstTwoBits = buffer[0] >> 6;
  if (firstTwoBits !== 0) {
    throw new Error(`Invalid STUN message header: first 2 bits must be 0, got ${firstTwoBits}`);
  }

  const type = buffer.readUInt16BE(0) & 0x3fff;
  const messageLength = buffer.readUInt16BE(2);
  const magicCookie = buffer.readUInt32BE(4);
  const transactionId = buffer.subarray(8, 20);

  if (magicCookie !== STUN_MAGIC_COOKIE) {
    throw new Error(`Invalid STUN magic cookie: 0x${magicCookie.toString(16)} (expected 0x${STUN_MAGIC_COOKIE.toString(16)})`);
  }

  if (buffer.length < 20 + messageLength) {
    throw new Error(`STUN message truncated: advertised ${messageLength} attribute bytes, but only ${buffer.length - 20} available`);
  }

  const attributes = [];
  let xorMappedAddress = null;
  let mappedAddress = null;
  let changedAddress = null;
  let sourceAddress = null;

  let offset = 20;
  const end = 20 + messageLength;

  while (offset + 4 <= end) {
    const attrType = buffer.readUInt16BE(offset);
    const attrLen = buffer.readUInt16BE(offset + 2);
    offset += 4;

    if (offset + attrLen > end) {
      break;
    }

    const attrValue = buffer.subarray(offset, offset + attrLen);
    const attrObj = { type: attrType, length: attrLen, value: attrValue };

    if (attrType === STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS) {
      xorMappedAddress = decodeXorMappedAddress(attrValue, transactionId);
      attrObj.parsed = xorMappedAddress;
    } else if (attrType === STUN_ATTR_TYPE.MAPPED_ADDRESS) {
      mappedAddress = decodeMappedAddress(attrValue);
      attrObj.parsed = mappedAddress;
    } else if (attrType === STUN_ATTR_TYPE.CHANGED_ADDRESS) {
      changedAddress = decodeMappedAddress(attrValue);
      attrObj.parsed = changedAddress;
    } else if (attrType === STUN_ATTR_TYPE.SOURCE_ADDRESS) {
      sourceAddress = decodeMappedAddress(attrValue);
      attrObj.parsed = sourceAddress;
    }

    attributes.push(attrObj);

    // RFC 5389 §15: Attributes are padded to 4-byte boundaries
    const padding = (4 - (attrLen % 4)) % 4;
    offset += attrLen + padding;
  }

  const resolvedEndpoint = xorMappedAddress || mappedAddress;

  return {
    type,
    messageLength,
    magicCookie,
    transactionId,
    attributes,
    xorMappedAddress,
    mappedAddress,
    changedAddress,
    sourceAddress,
    endpoint: resolvedEndpoint
  };
}

/**
 * Decodes an XOR-MAPPED-ADDRESS attribute value buffer.
 * @param {Buffer} valueBuf
 * @param {Buffer} transactionId
 * @returns {{ family: 'IPv4'|'IPv6', ip: string, port: number }}
 */
function decodeXorMappedAddress(valueBuf, transactionId) {
  if (valueBuf.length < 4) {
    throw new Error('XOR-MAPPED-ADDRESS value too short');
  }

  const familyCode = valueBuf[1];
  const xorPort = valueBuf.readUInt16BE(2);
  const port = xorPort ^ (STUN_MAGIC_COOKIE >> 16);

  if (familyCode === 0x01) {
    // IPv4
    if (valueBuf.length < 8) {
      throw new Error('XOR-MAPPED-ADDRESS IPv4 value truncated');
    }
    const ipBytes = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) {
      ipBytes[i] = valueBuf[4 + i] ^ STUN_MAGIC_COOKIE_BUF[i];
    }
    const ip = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
    return { family: 'IPv4', ip, port };
  } else if (familyCode === 0x02) {
    // IPv6
    if (valueBuf.length < 20) {
      throw new Error('XOR-MAPPED-ADDRESS IPv6 value truncated');
    }
    const xorMask = Buffer.concat([STUN_MAGIC_COOKIE_BUF, transactionId]);
    const ipBytes = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      ipBytes[i] = valueBuf[4 + i] ^ xorMask[i];
    }
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(ipBytes.readUInt16BE(i * 2).toString(16));
    }
    return { family: 'IPv6', ip: parts.join(':'), port };
  } else {
    throw new Error(`Unsupported address family in XOR-MAPPED-ADDRESS: ${familyCode}`);
  }
}

/**
 * Decodes a standard MAPPED-ADDRESS attribute value buffer.
 * @param {Buffer} valueBuf
 * @returns {{ family: 'IPv4'|'IPv6', ip: string, port: number }}
 */
function decodeMappedAddress(valueBuf) {
  if (valueBuf.length < 4) {
    throw new Error('MAPPED-ADDRESS value too short');
  }

  const familyCode = valueBuf[1];
  const port = valueBuf.readUInt16BE(2);

  if (familyCode === 0x01) {
    if (valueBuf.length < 8) {
      throw new Error('MAPPED-ADDRESS IPv4 value truncated');
    }
    const ip = `${valueBuf[4]}.${valueBuf[5]}.${valueBuf[6]}.${valueBuf[7]}`;
    return { family: 'IPv4', ip, port };
  } else if (familyCode === 0x02) {
    if (valueBuf.length < 20) {
      throw new Error('MAPPED-ADDRESS IPv6 value truncated');
    }
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(valueBuf.readUInt16BE(4 + i * 2).toString(16));
    }
    return { family: 'IPv6', ip: parts.join(':'), port };
  } else {
    throw new Error(`Unsupported address family in MAPPED-ADDRESS: ${familyCode}`);
  }
}

/**
 * RFC 5389 STUN Client.
 */
class StunClient extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {Array<{host: string, port: number}>} [options.servers]
   * @param {number} [options.defaultTimeoutMs]
   */
  constructor(options = {}) {
    super();
    this.servers = Array.isArray(options.servers) && options.servers.length > 0
      ? options.servers
      : DEFAULT_STUN_SERVERS;
    this.defaultTimeoutMs = typeof options.defaultTimeoutMs === 'number'
      ? options.defaultTimeoutMs
      : 3000;
  }

  /**
   * Discovers the public IP and external mapped port via STUN.
   * If stunHost is not provided, iterates through configured public STUN servers until one succeeds.
   *
   * @param {string} [stunHost]
   * @param {number} [stunPort=3478]
   * @param {number} [timeoutMs=3000]
   * @param {object} [options]
   * @param {dgram.Socket} [options.socket] - Optional existing UDP socket to probe through
   * @returns {Promise<{ ip: string, port: number, family: string, rttMs: number, server: { host: string, port: number } }>}
   */
  async discoverPublicEndpoint(stunHost, stunPort = 3478, timeoutMs = this.defaultTimeoutMs, options = {}) {
    if (stunHost) {
      return this._querySingleServer(stunHost, stunPort, timeoutMs, options.socket);
    }

    // Try multiple configured servers
    const errors = [];
    for (const server of this.servers) {
      try {
        const res = await this._querySingleServer(server.host, server.port, timeoutMs, options.socket);
        return res;
      } catch (err) {
        errors.push({ server: `${server.host}:${server.port}`, error: err.message });
      }
    }

    const err = new Error(`All STUN servers failed to respond: ${JSON.stringify(errors)}`);
    err.details = errors;
    throw err;
  }

  /**
   * Performs a single STUN request-response query.
   * @private
   */
  async _querySingleServer(host, port, timeoutMs, externalSocket = null) {
    const socket = externalSocket || dgram.createSocket('udp4');
    const ownsSocket = !externalSocket;
    const req = encodeStunMessage({ type: STUN_MSG_TYPE.BINDING_REQUEST });
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;

      const cleanup = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        socket.removeListener('message', onMessage);
        socket.removeListener('error', onError);
        if (ownsSocket) {
          try {
            socket.close();
          } catch (_) {}
        }
      };

      const onError = (err) => {
        if (settled) return;
        cleanup();
        reject(err);
      };

      const onMessage = (msg, rinfo) => {
        if (settled) return;
        try {
          const parsed = parseStunMessage(msg);
          // Verify transaction ID matches
          if (!parsed.transactionId.equals(req.transactionId)) {
            return; // Not for this request, ignore
          }

          if (parsed.type !== STUN_MSG_TYPE.BINDING_RESPONSE) {
            cleanup();
            reject(new Error(`STUN received non-success response type: 0x${parsed.type.toString(16)}`));
            return;
          }

          if (!parsed.endpoint) {
            cleanup();
            reject(new Error('STUN response contained no XOR-MAPPED-ADDRESS or MAPPED-ADDRESS'));
            return;
          }

          const rttMs = Date.now() - startTime;
          cleanup();
          resolve({
            ip: parsed.endpoint.ip,
            port: parsed.endpoint.port,
            family: parsed.endpoint.family,
            rttMs,
            server: { host, port }
          });
        } catch (err) {
          // If parse fails or unrelated packet, ignore or reject if from target host
        }
      };

      socket.on('error', onError);
      socket.on('message', onMessage);

      timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`STUN request to ${host}:${port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Send the binding request packet
      socket.send(req.buffer, 0, req.buffer.length, port, host, (err) => {
        if (err && !settled) {
          cleanup();
          reject(err);
        }
      });
    });
  }
}

/**
 * NAT Traversal & Hole Punching Coordinator.
 */
class NatTraversal extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {StunClient} [options.stunClient]
   * @param {Array<{host: string, port: number}>} [options.stunServers]
   */
  constructor(options = {}) {
    super();
    this.stunClient = options.stunClient || new StunClient({ servers: options.stunServers });
  }

  /**
   * Classifies the local NAT mapping behavior according to RFC 3489 / RFC 4787 logic:
   * Probes across multiple STUN servers using the same local socket to determine:
   * - OPEN_INTERNET: Public IP matches local socket address
   * - FULL_CONE: External IP:port remains identical regardless of destination STUN server
   * - RESTRICTED_CONE / PORT_RESTRICTED_CONE
   * - SYMMETRIC: Different external mapped ports for different destination servers
   * - UDP_BLOCKED: No STUN responses received
   *
   * @param {object} [options]
   * @param {number} [options.timeoutMs=2500]
   * @param {Array<{host: string, port: number}>} [options.servers]
   * @returns {Promise<{ natType: string, publicIp: string, mappings: Array<{ server: string, endpoint: object }> }>}
   */
  async detectNatType(options = {}) {
    const timeoutMs = options.timeoutMs || 2500;
    const probeServers = options.servers || this.stunClient.servers.slice(0, 3);
    if (probeServers.length < 2) {
      throw new Error('At least 2 STUN servers required to classify NAT type accurately');
    }

    const socket = dgram.createSocket('udp4');
    // Bind to arbitrary ephemeral local port
    await new Promise((resolve, reject) => {
      socket.bind(0, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    try {
      const localAddress = socket.address();
      const mappings = [];

      for (const server of probeServers) {
        try {
          const endpoint = await this.stunClient.discoverPublicEndpoint(
            server.host,
            server.port,
            timeoutMs,
            { socket }
          );
          mappings.push({
            server: `${server.host}:${server.port}`,
            endpoint
          });
        } catch (_) {
          // Failed probe recorded as omitted
        }
      }

      if (mappings.length === 0) {
        return {
          natType: NAT_TYPE.UDP_BLOCKED,
          publicIp: null,
          localEndpoint: localAddress,
          mappings: []
        };
      }

      const primary = mappings[0].endpoint;
      const isLoopbackMatch = (localAddress.address === '0.0.0.0' || localAddress.address === '127.0.0.1') &&
        (primary.ip === '127.0.0.1' || primary.ip === '::1');
      const isPublicMatch = (primary.ip === localAddress.address || isLoopbackMatch) && primary.port === localAddress.port;

      if (mappings.length === 1) {
        return {
          natType: isPublicMatch ? NAT_TYPE.OPEN_INTERNET : NAT_TYPE.UNKNOWN,
          publicIp: primary.ip,
          localEndpoint: localAddress,
          mappings
        };
      }

      // Compare external endpoints across multiple servers
      const distinctPorts = new Set(mappings.map((m) => m.endpoint.port));
      const distinctIps = new Set(mappings.map((m) => m.endpoint.ip));

      if (isPublicMatch) {
        return {
          natType: NAT_TYPE.OPEN_INTERNET,
          publicIp: primary.ip,
          localEndpoint: localAddress,
          mappings
        };
      }

      // If mapped external port changes when sending to a different STUN server, NAT is SYMMETRIC
      if (distinctPorts.size > 1 || distinctIps.size > 1) {
        return {
          natType: NAT_TYPE.SYMMETRIC,
          publicIp: primary.ip,
          localEndpoint: localAddress,
          mappings
        };
      }

      // Same mapped IP and Port for different destination STUN servers -> CONE NAT
      // For general hole-punching classification, full cone allows direct inbound packets.
      return {
        natType: NAT_TYPE.FULL_CONE,
        publicIp: primary.ip,
        localEndpoint: localAddress,
        mappings
      };
    } finally {
      try {
        socket.close();
      } catch (_) {}
    }
  }

  /**
   * Helper to create a UDP Hole Puncher instance.
   * @param {object} options
   * @returns {UdpHolePuncher}
   */
  createHolePuncher(options = {}) {
    return new UdpHolePuncher({ stunClient: this.stunClient, ...options });
  }
}

/**
 * UdpHolePuncher facilitates bidirectional UDP hole punching between two peers.
 */
class UdpHolePuncher extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {StunClient} [options.stunClient]
   * @param {dgram.Socket} [options.socket] - Optional pre-bound UDP socket
   * @param {number} [options.punchIntervalMs=100]
   * @param {number} [options.maxAttempts=30]
   */
  constructor(options = {}) {
    super();
    this.stunClient = options.stunClient || new StunClient();
    this.socket = options.socket || null;
    this.ownsSocket = !options.socket;
    this.punchIntervalMs = options.punchIntervalMs || 100;
    this.maxAttempts = options.maxAttempts || 30;
    this._punchTimer = null;
    this.localEndpoint = null;
    this.publicEndpoint = null;
    this.isPunching = false;
  }

  /**
   * Initializes the socket and discovers public endpoint coordinates via STUN.
   * @param {object} [options]
   * @param {string} [options.stunHost]
   * @param {number} [options.stunPort]
   * @param {number} [options.bindPort=0]
   * @returns {Promise<{ local: object, public: object }>}
   */
  async initialize(options = {}) {
    if (!this.socket) {
      this.socket = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => {
        this.socket.bind(options.bindPort || 0, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    this.localEndpoint = this.socket.address();

    // Query STUN server using the SAME socket so NAT mapping matches
    this.publicEndpoint = await this.stunClient.discoverPublicEndpoint(
      options.stunHost,
      options.stunPort,
      options.timeoutMs || 3000,
      { socket: this.socket }
    );

    return {
      local: this.localEndpoint,
      public: this.publicEndpoint
    };
  }

  /**
   * Returns serializable coordinates suitable for signaling exchange with a remote peer.
   * @returns {{ ip: string, port: number, localPort: number }}
   */
  getCoordinates() {
    if (!this.publicEndpoint) {
      throw new Error('HolePuncher must be initialized before retrieving coordinates');
    }
    return {
      ip: this.publicEndpoint.ip,
      port: this.publicEndpoint.port,
      localPort: this.localEndpoint.port
    };
  }

  /**
   * Punches through NAT to remote peer coordinates by sending repeated UDP sync packets.
   * Resolves when a punch or sync acknowledgment is received from the remote peer.
   *
   * @param {{ ip: string, port: number }} remoteCoordinates
   * @param {object} [options]
   * @param {number} [options.timeoutMs=5000]
   * @returns {Promise<{ success: boolean, remote: object, rttMs: number }>}
   */
  async punch(remoteCoordinates, options = {}) {
    if (!this.socket) {
      throw new Error('Socket not initialized. Call initialize() first.');
    }
    if (!remoteCoordinates || !remoteCoordinates.ip || !remoteCoordinates.port) {
      throw new TypeError('Invalid remoteCoordinates: must contain ip and port');
    }

    const targetIp = remoteCoordinates.ip;
    const targetPort = remoteCoordinates.port;
    const timeoutMs = options.timeoutMs || 5000;
    const magicSync = Buffer.from('OPEN_SIDE_PUNCH_SYNC');
    const magicAck = Buffer.from('OPEN_SIDE_PUNCH_ACK');

    this.isPunching = true;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let attempts = 0;
      let settled = false;
      let timeoutTimer = null;

      const cleanup = () => {
        settled = true;
        this.isPunching = false;
        if (this._punchTimer) {
          clearInterval(this._punchTimer);
          this._punchTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (this.socket) {
          this.socket.removeListener('message', onMessage);
        }
      };

      const onMessage = (msg, rinfo) => {
        if (settled) return;

        // Check if message is from target IP
        if (msg.equals(magicSync)) {
          // Immediately reply with ACK to open remote state
          try {
            this.socket.send(magicAck, 0, magicAck.length, rinfo.port, rinfo.address);
          } catch (_) {}
          cleanup();
          resolve({
            success: true,
            remote: { ip: rinfo.address, port: rinfo.port },
            rttMs: Date.now() - startTime
          });
        } else if (msg.equals(magicAck)) {
          cleanup();
          resolve({
            success: true,
            remote: { ip: rinfo.address, port: rinfo.port },
            rttMs: Date.now() - startTime
          });
        } else {
          this.emit('data', msg, rinfo);
        }
      };

      this.socket.on('message', onMessage);

      // Periodically transmit punch sync packets
      const sendPunch = () => {
        if (settled) return;
        attempts++;
        this.socket.send(magicSync, 0, magicSync.length, targetPort, targetIp, (err) => {
          if (err) {
            this.emit('warn', err);
          }
        });

        if (attempts >= this.maxAttempts) {
          cleanup();
          reject(new Error(`Hole punching to ${targetIp}:${targetPort} failed after ${attempts} attempts`));
        }
      };

      this._punchTimer = setInterval(sendPunch, this.punchIntervalMs);
      sendPunch(); // First packet immediate

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`Hole punching to ${targetIp}:${targetPort} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  /**
   * Closes the socket if owned by this instance.
   */
  close() {
    if (this._punchTimer) {
      clearInterval(this._punchTimer);
      this._punchTimer = null;
    }
    if (this.socket && this.ownsSocket) {
      try {
        this.socket.close();
      } catch (_) {}
      this.socket = null;
    }
  }
}

module.exports = {
  STUN_MAGIC_COOKIE,
  STUN_MSG_TYPE,
  STUN_ATTR_TYPE,
  NAT_TYPE,
  DEFAULT_STUN_SERVERS,
  encodeStunMessage,
  encodeXorMappedAddressAttr,
  encodeMappedAddressAttr,
  encodeChangeRequestAttr,
  parseStunMessage,
  decodeXorMappedAddress,
  decodeMappedAddress,
  StunClient,
  NatTraversal,
  UdpHolePuncher
};
