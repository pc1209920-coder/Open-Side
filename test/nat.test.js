'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const {
  STUN_MAGIC_COOKIE,
  STUN_MSG_TYPE,
  STUN_ATTR_TYPE,
  NAT_TYPE,
  encodeStunMessage,
  parseStunMessage,
  encodeXorMappedAddressAttr,
  encodeMappedAddressAttr,
  decodeXorMappedAddress,
  decodeMappedAddress,
  StunClient,
  NatTraversal,
  UdpHolePuncher
} = require('../src/transport/nat');
const {
  StunClient: IndexStunClient,
  NatTraversal: IndexNatTraversal,
  UdpHolePuncher: IndexUdpHolePuncher
} = require('../src/index');

test('Index Exports - StunClient, NatTraversal and UdpHolePuncher correctly exported', () => {
  assert.strictEqual(IndexStunClient, StunClient);
  assert.strictEqual(IndexNatTraversal, NatTraversal);
  assert.strictEqual(IndexUdpHolePuncher, UdpHolePuncher);
});

test('STUN Message Encoding - Header, magic cookie, and transaction ID structure', () => {
  const customTxId = Buffer.alloc(12, 0xab);
  const { buffer, transactionId, type } = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_REQUEST,
    transactionId: customTxId
  });

  assert.strictEqual(buffer.length, 20, 'Header must be 20 bytes when no attributes');
  assert.strictEqual(type, 0x0001);
  assert.deepStrictEqual(transactionId, customTxId);

  // Check first 2 bits are 00
  const firstByte = buffer[0];
  assert.strictEqual(firstByte >> 6, 0);

  // Message type (0x0001)
  assert.strictEqual(buffer.readUInt16BE(0), 0x0001);
  // Message length (0)
  assert.strictEqual(buffer.readUInt16BE(2), 0);
  // Magic cookie (0x2112A442)
  assert.strictEqual(buffer.readUInt32BE(4), STUN_MAGIC_COOKIE);
  // Transaction ID
  assert.deepStrictEqual(buffer.subarray(8, 20), customTxId);

  // Auto-generate random transaction ID if omitted
  const randomMsg = encodeStunMessage();
  assert.strictEqual(randomMsg.transactionId.length, 12);
  assert.strictEqual(randomMsg.buffer.readUInt32BE(4), STUN_MAGIC_COOKIE);
});

test('XOR-MAPPED-ADDRESS Attribute Encoding and Decoding - IPv4', () => {
  const txId = Buffer.from('0123456789ab', 'utf8');
  const testIp = '198.51.100.45';
  const testPort = 54321;

  const attrBuf = encodeXorMappedAddressAttr(testIp, testPort, txId);
  assert.strictEqual(attrBuf.readUInt16BE(0), STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS);
  const attrLen = attrBuf.readUInt16BE(2);
  assert.strictEqual(attrLen, 8); // 1 reserved + 1 family + 2 port + 4 ip = 8

  // Check XOR port
  const xorPort = attrBuf.readUInt16BE(6);
  assert.strictEqual(xorPort ^ (STUN_MAGIC_COOKIE >> 16), testPort);

  // Decode value slice (skipping 4-byte TLV header)
  const decoded = decodeXorMappedAddress(attrBuf.subarray(4, 4 + attrLen), txId);
  assert.strictEqual(decoded.family, 'IPv4');
  assert.strictEqual(decoded.ip, testIp);
  assert.strictEqual(decoded.port, testPort);
});

test('XOR-MAPPED-ADDRESS Attribute Encoding and Decoding - IPv6', () => {
  const txId = Buffer.from('abcdef123456', 'utf8');
  const testIp = '2001:db8:85a3::8a2e:370:7334';
  const testPort = 49152;

  const attrBuf = encodeXorMappedAddressAttr(testIp, testPort, txId);
  assert.strictEqual(attrBuf.readUInt16BE(0), STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS);
  const attrLen = attrBuf.readUInt16BE(2);
  assert.strictEqual(attrLen, 20); // 1 reserved + 1 family + 2 port + 16 ip = 20

  const decoded = decodeXorMappedAddress(attrBuf.subarray(4, 4 + attrLen), txId);
  assert.strictEqual(decoded.family, 'IPv6');
  assert.strictEqual(decoded.port, testPort);

  // Re-encode and decode roundtrip consistency check
  const roundtrip = encodeXorMappedAddressAttr(decoded.ip, decoded.port, txId);
  const decodedRoundtrip = decodeXorMappedAddress(roundtrip.subarray(4, 4 + attrLen), txId);
  assert.strictEqual(decodedRoundtrip.port, testPort);
  assert.strictEqual(decodedRoundtrip.ip, decoded.ip);
});

test('MAPPED-ADDRESS Attribute Encoding and Decoding - IPv4 & IPv6', () => {
  // IPv4
  const ipv4Buf = encodeMappedAddressAttr('192.0.2.1', 8080);
  assert.strictEqual(ipv4Buf.readUInt16BE(0), STUN_ATTR_TYPE.MAPPED_ADDRESS);
  const decodedV4 = decodeMappedAddress(ipv4Buf.subarray(4, 4 + ipv4Buf.readUInt16BE(2)));
  assert.strictEqual(decodedV4.family, 'IPv4');
  assert.strictEqual(decodedV4.ip, '192.0.2.1');
  assert.strictEqual(decodedV4.port, 8080);

  // IPv6
  const ipv6Buf = encodeMappedAddressAttr('fe80::1', 9999);
  const decodedV6 = decodeMappedAddress(ipv6Buf.subarray(4, 4 + ipv6Buf.readUInt16BE(2)));
  assert.strictEqual(decodedV6.family, 'IPv6');
  assert.strictEqual(decodedV6.port, 9999);
});

test('STUN Message Parser - Full packet with XOR-MAPPED-ADDRESS attribute', () => {
  const txId = crypto.randomBytes(12);
  const xorAttr = encodeXorMappedAddressAttr('203.0.113.195', 41234, txId);
  const responseMsg = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_RESPONSE,
    transactionId: txId,
    attributes: [xorAttr]
  });

  const parsed = parseStunMessage(responseMsg.buffer);
  assert.strictEqual(parsed.type, STUN_MSG_TYPE.BINDING_RESPONSE);
  assert.strictEqual(parsed.magicCookie, STUN_MAGIC_COOKIE);
  assert.deepStrictEqual(parsed.transactionId, txId);
  assert.ok(parsed.endpoint);
  assert.strictEqual(parsed.endpoint.ip, '203.0.113.195');
  assert.strictEqual(parsed.endpoint.port, 41234);
});

test('STUN Message Parser - Malformed packet rejection (fail-closed)', () => {
  // Buffer too short (<20 bytes)
  assert.throws(() => parseStunMessage(Buffer.alloc(19)), /too short/);

  // Invalid magic cookie
  const badCookieBuf = Buffer.alloc(20);
  badCookieBuf.writeUInt16BE(0x0101, 0);
  badCookieBuf.writeUInt32BE(0x12345678, 4);
  assert.throws(() => parseStunMessage(badCookieBuf), /magic cookie/);

  // First 2 bits not 0
  const badBitsBuf = Buffer.alloc(20);
  badBitsBuf[0] = 0x80; // bits 10......
  assert.throws(() => parseStunMessage(badBitsBuf), /first 2 bits/);
});

let isUdpLoopbackSupported = null;
async function checkUdpLoopback() {
  if (isUdpLoopbackSupported !== null) return isUdpLoopbackSupported;
  return new Promise((resolve) => {
    const s1 = dgram.createSocket('udp4');
    const s2 = dgram.createSocket('udp4');
    let timer = setTimeout(() => {
      try { s1.close(); s2.close(); } catch (_) {}
      isUdpLoopbackSupported = false;
      resolve(false);
    }, 300);
    s1.on('message', () => {
      clearTimeout(timer);
      try { s1.close(); s2.close(); } catch (_) {}
      isUdpLoopbackSupported = true;
      resolve(true);
    });
    s1.bind(0, '127.0.0.1', () => {
      try {
        s2.send(Buffer.from('ping'), s1.address().port, '127.0.0.1');
      } catch (_) {
        clearTimeout(timer);
        try { s1.close(); s2.close(); } catch (_) {}
        isUdpLoopbackSupported = false;
        resolve(false);
      }
    });
  });
}

test('Local Mock UDP STUN Server - Full discoverPublicEndpoint request-response cycle', async (t) => {
  if (!(await checkUdpLoopback())) {
    t.skip('Local UDP loopback delivery is blocked by environment sandbox');
    return;
  }
  const server = dgram.createSocket('udp4');
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;

  // Mock STUN server handler
  server.on('message', (msg, rinfo) => {
    try {
      const parsed = parseStunMessage(msg);
      if (parsed.type === STUN_MSG_TYPE.BINDING_REQUEST) {
        // Echo back client's seen IP and Port via XOR-MAPPED-ADDRESS
        const xorAttr = encodeXorMappedAddressAttr(rinfo.address, rinfo.port, parsed.transactionId);
        const resp = encodeStunMessage({
          type: STUN_MSG_TYPE.BINDING_RESPONSE,
          transactionId: parsed.transactionId,
          attributes: [xorAttr]
        });
        server.send(resp.buffer, 0, resp.buffer.length, rinfo.port, rinfo.address);
      }
    } catch (_) {}
  });

  try {
    const stunClient = new StunClient();
    const result = await stunClient.discoverPublicEndpoint('127.0.0.1', serverPort, 1500);

    assert.ok(result);
    assert.strictEqual(result.ip, '127.0.0.1');
    assert.strictEqual(typeof result.port, 'number');
    assert.ok(result.port > 0);
    assert.strictEqual(result.family, 'IPv4');
    assert.ok(result.rttMs >= 0);
    assert.strictEqual(result.server.host, '127.0.0.1');
    assert.strictEqual(result.server.port, serverPort);
  } finally {
    server.close();
  }
});

test('StunClient - Timeout handling on unresponsive host', async () => {
  // Bind a dummy server that drops all packets without responding
  const silentServer = dgram.createSocket('udp4');
  await new Promise((resolve) => serverBindSilent(silentServer, resolve));
  const silentPort = silentServer.address().port;

  try {
    const stunClient = new StunClient();
    await assert.rejects(
      async () => {
        await stunClient.discoverPublicEndpoint('127.0.0.1', silentPort, 200);
      },
      /timed out/
    );
  } finally {
    silentServer.close();
  }
});

function serverBindSilent(server, cb) {
  server.bind(0, '127.0.0.1', cb);
}

test('NatTraversal - Detects NAT mapping behavior across multiple mock STUN servers', async (t) => {
  if (!(await checkUdpLoopback())) {
    t.skip('Local UDP loopback delivery is blocked by environment sandbox');
    return;
  }
  // Create two distinct mock STUN servers
  const s1 = dgram.createSocket('udp4');
  const s2 = dgram.createSocket('udp4');
  await new Promise((r) => s1.bind(0, '127.0.0.1', r));
  await new Promise((r) => s2.bind(0, '127.0.0.1', r));

  const respondStun = (srv) => {
    srv.on('message', (msg, rinfo) => {
      try {
        const parsed = parseStunMessage(msg);
        if (parsed.type === STUN_MSG_TYPE.BINDING_REQUEST) {
          const xorAttr = encodeXorMappedAddressAttr(rinfo.address, rinfo.port, parsed.transactionId);
          const resp = encodeStunMessage({
            type: STUN_MSG_TYPE.BINDING_RESPONSE,
            transactionId: parsed.transactionId,
            attributes: [xorAttr]
          });
          srv.send(resp.buffer, 0, resp.buffer.length, rinfo.port, rinfo.address);
        }
      } catch (_) {}
    });
  };
  respondStun(s1);
  respondStun(s2);

  try {
    const nat = new NatTraversal();
    const result = await nat.detectNatType({
      servers: [
        { host: '127.0.0.1', port: s1.address().port },
        { host: '127.0.0.1', port: s2.address().port }
      ],
      timeoutMs: 1000
    });

    assert.ok(result);
    // Since local loopback sends directly with identical source port, detected as OPEN_INTERNET
    assert.strictEqual(result.natType, NAT_TYPE.OPEN_INTERNET);
    assert.strictEqual(result.publicIp, '127.0.0.1');
    assert.strictEqual(result.mappings.length, 2);
  } finally {
    s1.close();
    s2.close();
  }
});

test('UdpHolePuncher - End-to-end peer hole punching and coordinate exchange simulation', async (t) => {
  if (!(await checkUdpLoopback())) {
    t.skip('Local UDP loopback delivery is blocked by environment sandbox');
    return;
  }
  // Setup mock STUN server
  const stunSrv = dgram.createSocket('udp4');
  await new Promise((r) => stunSrv.bind(0, '127.0.0.1', r));
  stunSrv.on('message', (msg, rinfo) => {
    try {
      const parsed = parseStunMessage(msg);
      if (parsed.type === STUN_MSG_TYPE.BINDING_REQUEST) {
        const xorAttr = encodeXorMappedAddressAttr(rinfo.address, rinfo.port, parsed.transactionId);
        const resp = encodeStunMessage({
          type: STUN_MSG_TYPE.BINDING_RESPONSE,
          transactionId: parsed.transactionId,
          attributes: [xorAttr]
        });
        stunSrv.send(resp.buffer, 0, resp.buffer.length, rinfo.port, rinfo.address);
      }
    } catch (_) {}
  });

  const stunPort = stunSrv.address().port;
  const peerA = new UdpHolePuncher();
  const peerB = new UdpHolePuncher();

  try {
    // Both peers initialize and discover their public endpoints
    const coordsA = await peerA.initialize({ stunHost: '127.0.0.1', stunPort });
    const coordsB = await peerB.initialize({ stunHost: '127.0.0.1', stunPort });

    assert.strictEqual(peerA.getCoordinates().ip, '127.0.0.1');
    assert.strictEqual(peerB.getCoordinates().ip, '127.0.0.1');

    // Peers initiate hole punching to each other's mapped coordinates
    const [resA, resB] = await Promise.all([
      peerA.punch({ ip: coordsB.public.ip, port: coordsB.public.port }),
      peerB.punch({ ip: coordsA.public.ip, port: coordsA.public.port })
    ]);

    assert.ok(resA.success);
    assert.ok(resB.success);
    assert.strictEqual(resA.remote.port, coordsB.public.port);
    assert.strictEqual(resB.remote.port, coordsA.public.port);
  } finally {
    peerA.close();
    peerB.close();
    stunSrv.close();
  }
});
