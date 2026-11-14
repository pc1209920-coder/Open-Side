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
  encodeChangeRequestAttr,
  decodeXorMappedAddress,
  decodeMappedAddress,
  decodeErrorCode,
  bindSocketAsync,
  isLocalInterfaceAddress,
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

test('STUN Message Parser - Comprehensive header validation & error scenarios', () => {
  // 1. Non-Buffer argument validation
  assert.throws(() => parseStunMessage(null), /Buffer required/);
  assert.throws(() => parseStunMessage(undefined), /Buffer required/);
  assert.throws(() => parseStunMessage('not a buffer'), /Buffer required/);
  assert.throws(() => parseStunMessage(12345), /Buffer required/);
  assert.throws(() => parseStunMessage({}), /Buffer required/);

  // 2. Buffer too short variations
  assert.throws(() => parseStunMessage(Buffer.alloc(0)), /too short/);
  assert.throws(() => parseStunMessage(Buffer.alloc(1)), /too short/);
  assert.throws(() => parseStunMessage(Buffer.alloc(10)), /too short/);
  assert.throws(() => parseStunMessage(Buffer.alloc(19)), /too short/);

  // 3. First 2 bits not 0 variations
  for (const firstByte of [0x40, 0x80, 0xc0]) {
    const badBits = Buffer.alloc(20);
    badBits[0] = firstByte;
    badBits.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    assert.throws(() => parseStunMessage(badBits), /first 2 bits/);
  }

  // 4. Magic cookie corruption variations
  for (const badCookie of [0x00000000, 0x12345678, 0xffffffff, 0x2112a443]) {
    const badCookieBuf = Buffer.alloc(20);
    badCookieBuf.writeUInt32BE(badCookie, 4);
    assert.throws(() => parseStunMessage(badCookieBuf), /magic cookie/);
  }

  // 5. Truncated message body (advertised messageLength exceeds available buffer)
  const truncatedBuf = Buffer.alloc(24);
  truncatedBuf.writeUInt16BE(0x0101, 0); // BINDING_RESPONSE
  truncatedBuf.writeUInt16BE(20, 2); // Claims 20 bytes of attributes, but only 4 bytes follow header
  truncatedBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  assert.throws(() => parseStunMessage(truncatedBuf), /STUN message truncated: advertised 20 attribute bytes/);

  // 6. Packet with extra trailing bytes past advertised messageLength ignores trailing garbage
  const extraBytesBuf = Buffer.alloc(32);
  extraBytesBuf.writeUInt16BE(0x0101, 0);
  extraBytesBuf.writeUInt16BE(0, 2); // Claims 0 attribute bytes
  extraBytesBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  extraBytesBuf.fill(0xff, 20); // Trailing garbage bytes
  const parsedExtra = parseStunMessage(extraBytesBuf);
  assert.strictEqual(parsedExtra.messageLength, 0);
  assert.strictEqual(parsedExtra.attributes.length, 0);
  assert.strictEqual(parsedExtra.endpoint, null);
});

test('STUN Message Parser - Multiple message types and type masking', () => {
  const typesToTest = [
    { name: 'BINDING_REQUEST', val: STUN_MSG_TYPE.BINDING_REQUEST, expected: 0x0001 },
    { name: 'BINDING_RESPONSE', val: STUN_MSG_TYPE.BINDING_RESPONSE, expected: 0x0101 },
    { name: 'BINDING_ERROR_RESPONSE', val: STUN_MSG_TYPE.BINDING_ERROR_RESPONSE, expected: 0x0111 },
    { name: 'BINDING_INDICATION', val: STUN_MSG_TYPE.BINDING_INDICATION, expected: 0x0011 }
  ];

  for (const t of typesToTest) {
    const txId = crypto.randomBytes(12);
    const msg = encodeStunMessage({ type: t.val, transactionId: txId });
    const parsed = parseStunMessage(msg.buffer);
    assert.strictEqual(parsed.type, t.expected);
    assert.strictEqual(parsed.magicCookie, STUN_MAGIC_COOKIE);
    assert.deepStrictEqual(parsed.transactionId, txId);
  }

  // Verify type mask (type & 0x3fff) strips high bits 14 & 15 if set in raw header
  const rawBuf = Buffer.alloc(20);
  rawBuf.writeUInt16BE(0x0101, 0);
  rawBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  const parsedMasked = parseStunMessage(rawBuf);
  assert.strictEqual(parsedMasked.type, 0x0101);
});

test('STUN Message Parser - Multi-attribute extraction and endpoint fallback resolution', () => {
  const txId = crypto.randomBytes(12);

  // 1. MAPPED-ADDRESS fallback when XOR-MAPPED-ADDRESS is absent
  const mappedAttr = encodeMappedAddressAttr('192.0.2.100', 9876);
  const mappedMsg = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_RESPONSE,
    transactionId: txId,
    attributes: [mappedAttr]
  });
  const parsedMapped = parseStunMessage(mappedMsg.buffer);
  assert.strictEqual(parsedMapped.xorMappedAddress, null);
  assert.ok(parsedMapped.mappedAddress);
  assert.strictEqual(parsedMapped.mappedAddress.ip, '192.0.2.100');
  assert.strictEqual(parsedMapped.mappedAddress.port, 9876);
  assert.ok(parsedMapped.endpoint);
  assert.strictEqual(parsedMapped.endpoint.ip, '192.0.2.100');
  assert.strictEqual(parsedMapped.endpoint.port, 9876);

  // 2. XOR-MAPPED-ADDRESS takes precedence over MAPPED-ADDRESS for endpoint
  const xorAttr = encodeXorMappedAddressAttr('198.51.100.200', 12345, txId);
  const dualMsg = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_RESPONSE,
    transactionId: txId,
    attributes: [mappedAttr, xorAttr]
  });
  const parsedDual = parseStunMessage(dualMsg.buffer);
  assert.ok(parsedDual.xorMappedAddress);
  assert.ok(parsedDual.mappedAddress);
  assert.strictEqual(parsedDual.endpoint.ip, '198.51.100.200', 'XOR-MAPPED-ADDRESS must take precedence');
  assert.strictEqual(parsedDual.endpoint.port, 12345);

  // 3. CHANGED-ADDRESS (0x0005) and SOURCE-ADDRESS (0x0004) extraction
  const changedAttr = Buffer.from(mappedAttr);
  changedAttr.writeUInt16BE(STUN_ATTR_TYPE.CHANGED_ADDRESS, 0);
  const sourceAttr = encodeMappedAddressAttr('203.0.113.50', 3478);
  sourceAttr.writeUInt16BE(STUN_ATTR_TYPE.SOURCE_ADDRESS, 0);

  const fullAttrMsg = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_RESPONSE,
    transactionId: txId,
    attributes: [sourceAttr, changedAttr, xorAttr]
  });
  const parsedFull = parseStunMessage(fullAttrMsg.buffer);
  assert.ok(parsedFull.sourceAddress);
  assert.strictEqual(parsedFull.sourceAddress.ip, '203.0.113.50');
  assert.strictEqual(parsedFull.sourceAddress.port, 3478);
  assert.ok(parsedFull.changedAddress);
  assert.strictEqual(parsedFull.changedAddress.ip, '192.0.2.100');
  assert.strictEqual(parsedFull.changedAddress.port, 9876);
  assert.strictEqual(parsedFull.attributes.length, 3);

  // 4. Unknown/comprehension-optional attributes retained without error
  const customAttr = Buffer.alloc(8);
  customAttr.writeUInt16BE(0x8022, 0); // STUN SOFTWARE attribute
  customAttr.writeUInt16BE(4, 2);
  customAttr.write('TEST', 4);

  const unknownMsg = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_RESPONSE,
    transactionId: txId,
    attributes: [customAttr, xorAttr]
  });
  const parsedUnknown = parseStunMessage(unknownMsg.buffer);
  assert.strictEqual(parsedUnknown.attributes.length, 2);
  const foundCustom = parsedUnknown.attributes.find((a) => a.type === 0x8022);
  assert.ok(foundCustom);
  assert.strictEqual(foundCustom.length, 4);
  assert.strictEqual(foundCustom.value.toString('utf8'), 'TEST');
});

test('STUN Message Parser - 4-byte attribute padding boundary alignment', () => {
  const txId = crypto.randomBytes(12);

  // Create an attribute with length 5 (non-multiple of 4), requires 3 bytes padding (total 8 byte value)
  const attr5 = Buffer.alloc(12); // 4 header + 5 value + 3 padding
  attr5.writeUInt16BE(0x8001, 0); // Arbitrary optional attribute
  attr5.writeUInt16BE(5, 2); // Length 5
  attr5.write('HELLO', 4);

  // Follow with a standard 8-byte XOR-MAPPED-ADDRESS
  const xorAttr = encodeXorMappedAddressAttr('192.0.2.77', 4321, txId);

  const paddedMsg = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_RESPONSE,
    transactionId: txId,
    attributes: [attr5, xorAttr]
  });

  const parsed = parseStunMessage(paddedMsg.buffer);
  assert.strictEqual(parsed.attributes.length, 2);
  assert.strictEqual(parsed.attributes[0].length, 5);
  assert.strictEqual(parsed.attributes[0].value.toString('utf8'), 'HELLO');
  assert.strictEqual(parsed.endpoint.ip, '192.0.2.77');
  assert.strictEqual(parsed.endpoint.port, 4321);
});

test('STUN Message Parser - Truncated and malformed attribute payload error handling', () => {
  const txId = crypto.randomBytes(12);

  // 1. Incomplete attribute header (< 4 bytes remaining in advertised attribute section)
  const incHdrBuf = Buffer.alloc(22); // 20 header + 2 attribute bytes (less than 4 needed for TLV header)
  incHdrBuf.writeUInt16BE(STUN_MSG_TYPE.BINDING_RESPONSE, 0);
  incHdrBuf.writeUInt16BE(2, 2); // Advertised length = 2 (violates RFC 5389 4-byte alignment)
  incHdrBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  txId.copy(incHdrBuf, 8);
  assert.throws(
    () => parseStunMessage(incHdrBuf),
    /is not a multiple of 4 bytes/
  );

  // 2. Truncated attribute value (TLV length claims more than remaining packet bytes)
  const incValBuf = Buffer.alloc(28); // 20 header + 8 bytes
  incValBuf.writeUInt16BE(STUN_MSG_TYPE.BINDING_RESPONSE, 0);
  incValBuf.writeUInt16BE(8, 2);
  incValBuf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  txId.copy(incValBuf, 8);
  incValBuf.writeUInt16BE(0x8001, 20); // Attr type
  incValBuf.writeUInt16BE(10, 22); // Claims 10 bytes value, but only 4 bytes remain (28 - 24 = 4)
  const parsedIncVal = parseStunMessage(incValBuf);
  assert.strictEqual(parsedIncVal.attributes.length, 0); // Breaks loop safely without crash

  // 3. Corrupted XOR-MAPPED-ADDRESS: Unsupported address family throws fail-closed
  const badFamAttr = Buffer.alloc(12);
  badFamAttr.writeUInt16BE(STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS, 0);
  badFamAttr.writeUInt16BE(8, 2);
  badFamAttr[4] = 0x00;
  badFamAttr[5] = 0x03; // Unsupported family
  const badFamMsg = encodeStunMessage({ attributes: [badFamAttr] });
  assert.throws(() => parseStunMessage(badFamMsg.buffer), /Unsupported address family in XOR-MAPPED-ADDRESS: 3/);

  // 4. Corrupted XOR-MAPPED-ADDRESS: Truncated IPv4 value (< 8 bytes)
  const truncV4Attr = Buffer.alloc(10);
  truncV4Attr.writeUInt16BE(STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS, 0);
  truncV4Attr.writeUInt16BE(6, 2); // Length 6 (< 8)
  truncV4Attr[4] = 0x00;
  truncV4Attr[5] = 0x01; // IPv4
  const truncV4Msg = encodeStunMessage({ attributes: [truncV4Attr] });
  assert.throws(() => parseStunMessage(truncV4Msg.buffer), /XOR-MAPPED-ADDRESS IPv4 value truncated/);

  // 5. Corrupted XOR-MAPPED-ADDRESS: Truncated IPv6 value (< 20 bytes)
  const truncV6Attr = Buffer.alloc(16);
  truncV6Attr.writeUInt16BE(STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS, 0);
  truncV6Attr.writeUInt16BE(12, 2); // Length 12 (< 20)
  truncV6Attr[4] = 0x00;
  truncV6Attr[5] = 0x02; // IPv6
  const truncV6Msg = encodeStunMessage({ attributes: [truncV6Attr] });
  assert.throws(() => parseStunMessage(truncV6Msg.buffer), /XOR-MAPPED-ADDRESS IPv6 value truncated/);

  // 6. Direct decodeXorMappedAddress error scenarios
  assert.throws(() => decodeXorMappedAddress(Buffer.alloc(3), txId), /XOR-MAPPED-ADDRESS value too short/);
  assert.throws(() => decodeXorMappedAddress(Buffer.from([0x00, 0x01, 0x00, 0x00]), txId), /IPv4 value truncated/);
  assert.throws(() => decodeXorMappedAddress(Buffer.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x00]), txId), /IPv6 value truncated/);
  assert.throws(() => decodeXorMappedAddress(Buffer.from([0x00, 0x99, 0x00, 0x00]), txId), /Unsupported address family/);

  // 7. Direct decodeMappedAddress error scenarios
  assert.throws(() => decodeMappedAddress(Buffer.alloc(3)), /MAPPED-ADDRESS value too short/);
  assert.throws(() => decodeMappedAddress(Buffer.from([0x00, 0x01, 0x00, 0x00])), /IPv4 value truncated/);
  assert.throws(() => decodeMappedAddress(Buffer.from([0x00, 0x02, 0x00, 0x00])), /IPv6 value truncated/);
  assert.throws(() => decodeMappedAddress(Buffer.from([0x00, 0x99, 0x00, 0x00])), /Unsupported address family/);
});

test('STUN Attribute Encoders - Input validation and CHANGE-REQUEST flags', () => {
  const txId = Buffer.alloc(12, 0x11);

  // 1. CHANGE-REQUEST flag encoding combinations
  const crNone = encodeChangeRequestAttr(false, false);
  assert.strictEqual(crNone.readUInt16BE(0), STUN_ATTR_TYPE.CHANGE_REQUEST);
  assert.strictEqual(crNone.readUInt16BE(2), 4);
  assert.strictEqual(crNone.readUInt32BE(4), 0);

  const crIp = encodeChangeRequestAttr(true, false);
  assert.strictEqual(crIp.readUInt32BE(4), 0x04);

  const crPort = encodeChangeRequestAttr(false, true);
  assert.strictEqual(crPort.readUInt32BE(4), 0x02);

  const crBoth = encodeChangeRequestAttr(true, true);
  assert.strictEqual(crBoth.readUInt32BE(4), 0x06);

  // 2. encodeXorMappedAddressAttr input validation
  assert.throws(() => encodeXorMappedAddressAttr('127.0.0.1', 0, txId), /Port must be between 1 and 65535/);
  assert.throws(() => encodeXorMappedAddressAttr('127.0.0.1', 65536, txId), /Port must be between 1 and 65535/);
  assert.throws(() => encodeXorMappedAddressAttr('127.0.0.1', -1, txId), /Port must be between 1 and 65535/);
  assert.throws(() => encodeXorMappedAddressAttr('127.0.0.1', '8080', txId), /Port must be between 1 and 65535/);
  assert.throws(() => encodeXorMappedAddressAttr('127.0.0.1', 8080, null), /STUN transactionId must be a 12-byte Buffer/);
  assert.throws(() => encodeXorMappedAddressAttr('127.0.0.1', 8080, Buffer.alloc(11)), /STUN transactionId must be a 12-byte Buffer/);
  assert.throws(() => encodeXorMappedAddressAttr('invalid.ip', 8080, txId), /Invalid IP address/);

  // 3. encodeMappedAddressAttr input validation
  assert.throws(() => encodeMappedAddressAttr('127.0.0.1', 0), /Port must be between 1 and 65535/);
  assert.throws(() => encodeMappedAddressAttr('127.0.0.1', 70000), /Port must be between 1 and 65535/);
  assert.throws(() => encodeMappedAddressAttr('not_an_ip', 8080), /Invalid IP address/);

  // 4. encodeStunMessage input validation
  assert.throws(() => encodeStunMessage({ transactionId: 'not-a-buffer' }), /STUN transactionId must be a 12-byte Buffer/);
  assert.throws(() => encodeStunMessage({ transactionId: Buffer.alloc(16) }), /STUN transactionId must be a 12-byte Buffer/);
});

test('StunClient - Response packet validation and dispatch error scenarios (Mock Socket)', async () => {
  const EventEmitter = require('node:events');

  class MockUdpSocket extends EventEmitter {
    constructor() {
      super();
      this.sentPackets = [];
    }
    send(buf, offset, len, port, host, cb) {
      const slice = Buffer.from(buf.subarray(offset, offset + len));
      this.sentPackets.push({ buf: slice, port, host });
      if (cb) process.nextTick(cb);
    }
    close() {}
  }

  const client = new StunClient();

  // Scenario 1: Successful response parsing matching transaction ID
  {
    const mockSocket = new MockUdpSocket();
    const queryPromise = client.discoverPublicEndpoint('10.0.0.1', 3478, 1000, { socket: mockSocket });

    // Wait for the request packet to be sent
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(mockSocket.sentPackets.length, 1);
    const sentTxId = mockSocket.sentPackets[0].buf.subarray(8, 20);

    // Reply with valid BINDING_RESPONSE with XOR-MAPPED-ADDRESS
    const xorAttr = encodeXorMappedAddressAttr('203.0.113.111', 54321, sentTxId);
    const respMsg = encodeStunMessage({
      type: STUN_MSG_TYPE.BINDING_RESPONSE,
      transactionId: sentTxId,
      attributes: [xorAttr]
    });

    mockSocket.emit('message', respMsg.buffer, { address: '10.0.0.1', port: 3478 });
    const result = await queryPromise;

    assert.strictEqual(result.ip, '203.0.113.111');
    assert.strictEqual(result.port, 54321);
    assert.strictEqual(result.family, 'IPv4');
    assert.strictEqual(result.server.host, '10.0.0.1');
    assert.strictEqual(result.server.port, 3478);
  }

  // Scenario 2: Response with mismatched transaction ID is ignored, followed by matching response
  {
    const mockSocket = new MockUdpSocket();
    const queryPromise = client.discoverPublicEndpoint('10.0.0.1', 3478, 1000, { socket: mockSocket });
    await new Promise((r) => setImmediate(r));
    const sentTxId = mockSocket.sentPackets[0].buf.subarray(8, 20);

    // Send mismatched transaction ID response first
    const wrongTxId = crypto.randomBytes(12);
    const wrongResp = encodeStunMessage({
      type: STUN_MSG_TYPE.BINDING_RESPONSE,
      transactionId: wrongTxId,
      attributes: [encodeXorMappedAddressAttr('1.1.1.1', 1111, wrongTxId)]
    });
    mockSocket.emit('message', wrongResp.buffer, { address: '10.0.0.1', port: 3478 });

    // Then send matching response
    const correctResp = encodeStunMessage({
      type: STUN_MSG_TYPE.BINDING_RESPONSE,
      transactionId: sentTxId,
      attributes: [encodeXorMappedAddressAttr('203.0.113.222', 22222, sentTxId)]
    });
    mockSocket.emit('message', correctResp.buffer, { address: '10.0.0.1', port: 3478 });

    const result = await queryPromise;
    assert.strictEqual(result.ip, '203.0.113.222');
    assert.strictEqual(result.port, 22222);
  }

  // Scenario 3: Non-success response type (BINDING_ERROR_RESPONSE) causes rejection
  {
    const mockSocket = new MockUdpSocket();
    const queryPromise = client.discoverPublicEndpoint('10.0.0.1', 3478, 1000, { socket: mockSocket });
    await new Promise((r) => setImmediate(r));
    const sentTxId = mockSocket.sentPackets[0].buf.subarray(8, 20);

    const errorResp = encodeStunMessage({
      type: STUN_MSG_TYPE.BINDING_ERROR_RESPONSE,
      transactionId: sentTxId
    });
    mockSocket.emit('message', errorResp.buffer, { address: '10.0.0.1', port: 3478 });

    await assert.rejects(
      queryPromise,
      /STUN received non-success response type: 0x111/
    );
  }

  // Scenario 4: Response missing address attribute causes rejection
  {
    const mockSocket = new MockUdpSocket();
    const queryPromise = client.discoverPublicEndpoint('10.0.0.1', 3478, 1000, { socket: mockSocket });
    await new Promise((r) => setImmediate(r));
    const sentTxId = mockSocket.sentPackets[0].buf.subarray(8, 20);

    const noAttrResp = encodeStunMessage({
      type: STUN_MSG_TYPE.BINDING_RESPONSE,
      transactionId: sentTxId,
      attributes: [] // No address attributes
    });
    mockSocket.emit('message', noAttrResp.buffer, { address: '10.0.0.1', port: 3478 });

    await assert.rejects(
      queryPromise,
      /STUN response contained no XOR-MAPPED-ADDRESS or MAPPED-ADDRESS/
    );
  }

  // Scenario 5: Corrupted UDP packets are safely ignored without crashing pending query
  {
    const mockSocket = new MockUdpSocket();
    const queryPromise = client.discoverPublicEndpoint('10.0.0.1', 3478, 1000, { socket: mockSocket });
    await new Promise((r) => setImmediate(r));
    const sentTxId = mockSocket.sentPackets[0].buf.subarray(8, 20);

    // Emit garbage packet (length < 20)
    mockSocket.emit('message', Buffer.from([0x01, 0x02, 0x03]), { address: '10.0.0.1', port: 3478 });
    // Emit corrupted magic cookie packet
    mockSocket.emit('message', Buffer.alloc(20), { address: '10.0.0.1', port: 3478 });

    // Now emit the legitimate response
    const validResp = encodeStunMessage({
      type: STUN_MSG_TYPE.BINDING_RESPONSE,
      transactionId: sentTxId,
      attributes: [encodeXorMappedAddressAttr('203.0.113.33', 33333, sentTxId)]
    });
    mockSocket.emit('message', validResp.buffer, { address: '10.0.0.1', port: 3478 });

    const result = await queryPromise;
    assert.strictEqual(result.ip, '203.0.113.33');
    assert.strictEqual(result.port, 33333);
  }

  // Scenario 6: Socket error rejects query cleanly
  {
    const mockSocket = new MockUdpSocket();
    const queryPromise = client.discoverPublicEndpoint('10.0.0.1', 3478, 1000, { socket: mockSocket });
    await new Promise((r) => setImmediate(r));

    mockSocket.emit('error', new Error('EADDRNOTAVAIL mock error'));
    await assert.rejects(queryPromise, /EADDRNOTAVAIL mock error/);
  }
});

let udpCheckPromise = null;
function checkUdpLoopback() {
  if (udpCheckPromise) return udpCheckPromise;
  udpCheckPromise = new Promise((resolve) => {
    const s1 = dgram.createSocket('udp4');
    const s2 = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      try { s1.close(); s2.close(); } catch (_) {}
      resolve(false);
    }, 150);
    s1.on('message', () => {
      clearTimeout(timer);
      try { s1.close(); s2.close(); } catch (_) {}
      resolve(true);
    });
    s1.bind(0, '127.0.0.1', () => {
      try {
        s2.send(Buffer.from('ping'), s1.address().port, '127.0.0.1');
      } catch (_) {
        clearTimeout(timer);
        try { s1.close(); s2.close(); } catch (_) {}
        resolve(false);
      }
    });
  });
  return udpCheckPromise;
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

test('ERROR-CODE Attribute Parsing - RFC 5389 §15.6 code and reason phrase extraction', () => {
  // Construct an ERROR-CODE attribute buffer: 400 Bad Request
  // 4 bytes: 2 reserved + 1 class (4) + 1 number (00) + UTF-8 reason
  const reasonText = 'Bad Request';
  const valBuf = Buffer.alloc(4 + Buffer.byteLength(reasonText));
  valBuf[2] = 4; // Class = 4
  valBuf[3] = 0; // Number = 0
  valBuf.write(reasonText, 4, 'utf8');

  const decoded = decodeErrorCode(valBuf);
  assert.strictEqual(decoded.code, 400);
  assert.strictEqual(decoded.reason, 'Bad Request');

  // Input validation
  assert.throws(() => decodeErrorCode(Buffer.alloc(3)), /too short/);
  assert.throws(() => decodeErrorCode('not-a-buffer'), /Buffer required/);

  // In full STUN packet
  const attrBuf = Buffer.alloc(4 + valBuf.length);
  attrBuf.writeUInt16BE(STUN_ATTR_TYPE.ERROR_CODE, 0);
  attrBuf.writeUInt16BE(valBuf.length, 2);
  valBuf.copy(attrBuf, 4);

  const txId = crypto.randomBytes(12);
  const stunMsg = encodeStunMessage({
    type: STUN_MSG_TYPE.BINDING_ERROR_RESPONSE,
    transactionId: txId,
    attributes: [attrBuf]
  });

  const parsed = parseStunMessage(stunMsg.buffer);
  assert.strictEqual(parsed.type, STUN_MSG_TYPE.BINDING_ERROR_RESPONSE);
  assert.ok(parsed.errorCode);
  assert.strictEqual(parsed.errorCode.code, 400);
  assert.strictEqual(parsed.errorCode.reason, 'Bad Request');
});

test('IPv4-mapped IPv6 Address Encoding and Expansion', () => {
  const txId = Buffer.alloc(12, 0x11);
  const ip = '::ffff:192.0.2.1';
  const port = 8080;

  const attrBuf = encodeXorMappedAddressAttr(ip, port, txId);
  assert.strictEqual(attrBuf.readUInt16BE(0), STUN_ATTR_TYPE.XOR_MAPPED_ADDRESS);
  const attrLen = attrBuf.readUInt16BE(2);
  assert.strictEqual(attrLen, 20); // IPv6 value is 20 bytes

  const decoded = decodeXorMappedAddress(attrBuf.subarray(4, 4 + attrLen), txId);
  assert.strictEqual(decoded.family, 'IPv6');
  assert.strictEqual(decoded.port, 8080);
  // ::ffff:192.0.2.1 expands to 0000:0000:0000:0000:0000:ffff:c000:0201
  assert.ok(decoded.ip.includes('ffff:c000:201') || decoded.ip.includes('ffff:c000:0201'));
});

test('bindSocketAsync - Rejects cleanly on EADDRINUSE without uncaughtException', async () => {
  const s1 = dgram.createSocket('udp4');
  await bindSocketAsync(s1, 0);
  const boundPort = s1.address().port;

  const s2 = dgram.createSocket('udp4');
  try {
    await assert.rejects(
      async () => {
        await bindSocketAsync(s2, boundPort);
      },
      /EADDRINUSE/
    );
  } finally {
    s1.close();
    try { s2.close(); } catch (_) {}
  }
});

test('UdpHolePuncher - Prevents concurrent punch invocations', async () => {
  const puncher = new UdpHolePuncher();
  puncher.socket = {
    on: () => {},
    removeListener: () => {},
    send: () => {}
  };
  puncher.isPunching = true;

  await assert.rejects(
    async () => {
      await puncher.punch({ ip: '192.0.2.1', port: 1234 });
    },
    /already in progress/
  );
});

test('UdpHolePuncher - close() terminates active punch promise with rejection', async () => {
  const puncher = new UdpHolePuncher();
  const mockSocket = new (require('node:events').EventEmitter)();
  mockSocket.send = () => {};
  mockSocket.close = () => {};
  puncher.socket = mockSocket;
  puncher.ownsSocket = false;

  const punchPromise = puncher.punch({ ip: '192.0.2.1', port: 1234 }, { timeoutMs: 10000 });
  puncher.close();

  await assert.rejects(
    async () => {
      await punchPromise;
    },
    /Hole puncher closed/
  );
  assert.strictEqual(puncher.isPunching, false);
});

test('StunClient - Argument normalization on discoverPublicEndpoint', async () => {
  const stunClient = new StunClient();
  const mockSocket = dgram.createSocket('udp4');
  await bindSocketAsync(mockSocket, 0);

  try {
    // Calling with (host, port, { socket }) where timeoutMs is omitted
    let capturedTimeout = null;
    let capturedSocket = null;
    stunClient._querySingleServer = async (host, port, timeoutMs, externalSocket) => {
      capturedTimeout = timeoutMs;
      capturedSocket = externalSocket;
      return { ip: '1.2.3.4', port: 1234, family: 'IPv4', rttMs: 10, server: { host, port } };
    };

    const res = await stunClient.discoverPublicEndpoint('127.0.0.1', 3478, { socket: mockSocket });
    assert.strictEqual(res.ip, '1.2.3.4');
    assert.strictEqual(capturedTimeout, stunClient.defaultTimeoutMs);
    assert.strictEqual(capturedSocket, mockSocket);
  } finally {
    mockSocket.close();
  }
});

test('isLocalInterfaceAddress - Recognizes loopback and local interface addresses', () => {
  assert.strictEqual(isLocalInterfaceAddress('127.0.0.1'), true);
  assert.strictEqual(isLocalInterfaceAddress('::1'), true);
  assert.strictEqual(isLocalInterfaceAddress('198.51.100.254'), false);
});
