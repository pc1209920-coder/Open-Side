const crypto = require('node:crypto');

class MeshCryptoEngine {
  constructor() {
    this.ecdh = crypto.createECDH('prime256v1');
    this.publicKey = this.ecdh.generateKeys('hex');
    this.nodeId = crypto.createHash('sha256').update(this.publicKey).digest('hex').slice(0, 40);
  }
  deriveSharedKey(peerPublicKeyHex) {
    const rawSecret = this.ecdh.computeSecret(peerPublicKeyHex, 'hex');
    return crypto.createHash('sha256').update(rawSecret).digest();
  }
  encryptShard(payloadObj, sharedKeyBuffer) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sharedKeyBuffer, iv);
    let encrypted = cipher.update(JSON.stringify(payloadObj), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), ciphertext: encrypted, timestamp: Date.now() };
  }
  decryptShard(encryptedPacket, sharedKeyBuffer) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKeyBuffer, Buffer.from(encryptedPacket.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encryptedPacket.authTag, 'hex'));
    let decrypted = decipher.update(encryptedPacket.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  }
  signProofOfCompute(shardId, resultData) {
    return crypto.createHmac('sha256', this.publicKey).update(`${shardId}:${JSON.stringify(resultData)}`).digest('hex');
  }
}
module.exports = { MeshCryptoEngine };
