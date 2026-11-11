const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

function getComputeSeaClass() {
  const { ComputeSea } = require('./index');
  return ComputeSea;
}

/**
 * Drop-in AI/Agent HTTP Gateway (OpenAI/Anthropic-compatible)
 * Routes incoming AI workloads (/v1/chat/completions, /v1/embeddings)
 * directly into the decentralized Single Compute Sea mesh.
 */
class OpenSideGateway {
  /**
   * @param {object} [options]
   * @param {object} [options.sea] Existing ComputeSea instance or creates new
   * @param {number} [options.port] Default 8080
   * @param {string} [options.host] Default 127.0.0.1
   * @param {string} [options.apiKey] Optional API key to validate Bearer token
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.port = Number.isInteger(opts.port) && opts.port > 0 ? opts.port : DEFAULT_PORT;
    this.host = typeof opts.host === 'string' && opts.host ? opts.host : DEFAULT_HOST;
    this.apiKey = typeof opts.apiKey === 'string' && opts.apiKey ? opts.apiKey : null;
    this._ownsSea = !opts.sea;
    if (opts.sea) {
      this.sea = opts.sea;
    } else {
      const ComputeSeaClass = getComputeSeaClass();
      this.sea = new ComputeSeaClass({ enableLedger: true, initialBalance: 10000 });
    }
    this.server = null;
    this._closing = false;
  }

  /**
   * Starts the HTTP gateway server.
   * @param {number|string} [target] Port number or IPC path
   * @param {string} [host] Default 127.0.0.1 (ignored if target is IPC path)
   * @returns {Promise<{ address: string, port: number, ipcPath?: string }>}
   */
  async listen(target = this.port, host = this.host) {
    if (this.server) {
      const addr = this.server.address();
      if (typeof addr === 'string') {
        return { address: 'ipc', port: 0, ipcPath: addr };
      }
      return {
        address: addr && typeof addr === 'object' ? addr.address : host,
        port: addr && typeof addr === 'object' ? addr.port : (typeof target === 'number' ? target : this.port)
      };
    }

    if (this._ownsSea && typeof this.sea.start === 'function') {
      try {
        await this.sea.start();
      } catch (err) {
        // Fallback or ignore if already running
      }
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this._handleRequest(req, res).catch(() => {
          if (!res.headersSent && !res.writableEnded) {
            this._sendError(res, 500, 'Internal server error', 'api_error');
          }
        });
      });

      const onListeningError = (err) => {
        reject(err);
      };
      srv.once('error', onListeningError);

      const isIpc = typeof target === 'string' && (target.startsWith('\\\\.\\pipe\\') || target.startsWith('/'));

      if (isIpc) {
        srv.listen(target, () => {
          srv.removeListener('error', onListeningError);
          this.server = srv;
          this.port = 0;
          this.host = 'ipc';
          this.ipcPath = target;
          resolve({ address: 'ipc', port: 0, ipcPath: target });
        });
      } else {
        const listenPort = typeof target === 'number' ? target : this.port;
        srv.listen(listenPort, host, () => {
          srv.removeListener('error', onListeningError);
          this.server = srv;
          const addr = srv.address();
          this.port = addr && typeof addr === 'object' ? addr.port : listenPort;
          this.host = addr && typeof addr === 'object' ? addr.address : host;
          resolve({ address: this.host, port: this.port });
        });
      }
    });
  }

  /**
   * Closes the HTTP gateway and owned resources.
   * @returns {Promise<void>}
   */
  async close() {
    this._closing = true;
    if (this.server) {
      if (this.server.closeAllConnections) {
        this.server.closeAllConnections();
      }
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }
    if (this._ownsSea && this.sea && typeof this.sea.close === 'function') {
      await this.sea.close();
    }
  }

  _sendJson(res, statusCode, data, headers = {}) {
    if (res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
      ...headers
    });
    res.end(body);
  }

  _sendError(res, statusCode, message, type = 'invalid_request_error', code = null) {
    this._sendJson(res, statusCode, {
      error: {
        message,
        type,
        param: null,
        code
      }
    });
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let isOverLimit = false;
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        if (isOverLimit) return;
        total += chunk.length;
        if (total > MAX_BODY_SIZE) {
          isOverLimit = true;
          const err = new RangeError('Payload Too Large: request body exceeds maximum allowed size (2MB)');
          err.statusCode = 413;
          reject(err);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (isOverLimit) return;
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (!raw.trim()) {
            resolve({});
            return;
          }
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (err) {
          reject(new SyntaxError(`Invalid JSON in request body: ${err.message}`));
        }
      });
      req.on('error', (err) => {
        if (isOverLimit) return;
        reject(err);
      });
    });
  }

  _checkAuth(req, res) {
    if (!this.apiKey) return true;
    const authHeader = req.headers.authorization || req.headers['x-api-key'];
    if (!authHeader) {
      this._sendError(res, 401, 'Missing Authorization header or x-api-key', 'authentication_error');
      return false;
    }
    const headerStr = String(authHeader).trim();
    const token = /^bearer\s+/i.test(headerStr) ? headerStr.replace(/^bearer\s+/i, '').trim() : headerStr;
    const tokenBuf = Buffer.from(token);
    const keyBuf = Buffer.from(this.apiKey);
    if (tokenBuf.length !== keyBuf.length || !crypto.timingSafeEqual(tokenBuf, keyBuf)) {
      this._sendError(res, 401, 'Invalid API Key', 'authentication_error');
      return false;
    }
    return true;
  }

  async _handleRequest(req, res) {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return this._sendError(res, 400, 'Invalid request URL or host header', 'invalid_request_error');
    }
    const pathname = parsedUrl.pathname;

    // Health check
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
      const telemetry = this.sea && typeof this.sea.getTelemetry === 'function'
        ? this.sea.getTelemetry()
        : null;
      return this._sendJson(res, 200, {
        status: 'ok',
        version: '0.6.0',
        protocol: 'open-side-protocol',
        nodeId: this.sea ? this.sea.nodeId : null,
        telemetry
      });
    }

    // Models endpoint (OpenAI-compatible)
    if (req.method === 'GET' && pathname === '/v1/models') {
      if (!this._checkAuth(req, res)) return;
      return this._sendJson(res, 200, {
        object: 'list',
        data: [
          {
            id: 'open-side-sea',
            object: 'model',
            created: 1700000000,
            owned_by: 'open-side',
            permission: [],
            root: 'open-side-sea',
            parent: null
          },
          {
            id: 'open-side-embeddings',
            object: 'model',
            created: 1700000000,
            owned_by: 'open-side',
            permission: [],
            root: 'open-side-embeddings',
            parent: null
          }
        ]
      });
    }

    // Chat completions (OpenAI-compatible)
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      if (!this._checkAuth(req, res)) return;
      return this._handleChatCompletions(req, res);
    }

    // Embeddings (OpenAI-compatible)
    if (req.method === 'POST' && pathname === '/v1/embeddings') {
      if (!this._checkAuth(req, res)) return;
      return this._handleEmbeddings(req, res);
    }

    // Anthropic-compatible /v1/messages endpoint
    if (req.method === 'POST' && pathname === '/v1/messages') {
      if (!this._checkAuth(req, res)) return;
      return this._handleAnthropicMessages(req, res);
    }

    // 404 for any other path
    this._sendError(res, 404, `Not Found: ${req.method} ${pathname}`, 'not_found');
  }

  async _handleChatCompletions(req, res) {
    let body;
    try {
      body = await this._readBody(req);
    } catch (err) {
      const code = err.statusCode || 400;
      return this._sendError(res, code, err.message, code === 413 ? 'request_entity_too_large' : 'invalid_request_error');
    }

    const { messages, model = 'open-side-sea', temperature = 0.7, max_tokens } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return this._sendError(res, 400, "Missing or invalid 'messages' array in request body", 'invalid_request_error');
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') {
        return this._sendError(res, 400, `Invalid message at index ${i}: must be a non-null object`, 'invalid_request_error');
      }
    }

    // Map input messages into ComputeSea workload partition
    const workloadCode = `
      // Process conversational chat messages across Compute Sea nodes
      return data.map(msg => {
        const role = msg.role || 'user';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return {
          role,
          tokens: content.split(/\\s+/).filter(Boolean).length,
          chars: content.length,
          preview: content.slice(0, 100)
        };
      });
    `;

    try {
      const seaResult = await this.sea.submitWorkload(workloadCode, messages, {
        chunkSize: Math.max(1, Math.min(messages.length, 4))
      });

      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      const userPrompt = lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
      
      const responseText = `[Open-Side ComputeSea] Workload executed across ${seaResult.shards?.length || 1} mesh shard(s). Processed ${messages.length} message(s). Total mesh compute cost: ${seaResult.totalCost || 0} credits.`;

      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      this._sendJson(res, 200, {
        id: completionId,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: responseText
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: messages.reduce((acc, m) => acc + (m && typeof m.content === 'string' ? m.content.split(/\s+/).filter(Boolean).length : 0), 0),
          completion_tokens: responseText.split(/\s+/).filter(Boolean).length,
          total_tokens: messages.reduce((acc, m) => acc + (m && typeof m.content === 'string' ? m.content.split(/\s+/).filter(Boolean).length : 0), 0) + responseText.split(/\s+/).filter(Boolean).length
        },
        compute_sea: {
          workloadId: seaResult.workloadId,
          status: seaResult.status,
          shardsCount: seaResult.shards?.length || 0,
          totalCost: seaResult.totalCost,
          durationMs: seaResult.durationMs
        }
      });
    } catch (err) {
      this._sendError(res, 500, `Compute Sea workload execution failed: ${err.message}`, 'api_error');
    }
  }

  async _handleEmbeddings(req, res) {
    let body;
    try {
      body = await this._readBody(req);
    } catch (err) {
      const code = err.statusCode || 400;
      return this._sendError(res, code, err.message, code === 413 ? 'request_entity_too_large' : 'invalid_request_error');
    }

    const { input, model = 'open-side-embeddings' } = body;
    if (input === undefined || input === null) {
      return this._sendError(res, 400, "Missing required 'input' field in request body", 'invalid_request_error');
    }

    const inputs = Array.isArray(input) ? input : [String(input)];
    if (inputs.length === 0) {
      return this._sendError(res, 400, "'input' array must not be empty", 'invalid_request_error');
    }

    // Embedding computation distributed across ComputeSea mesh shards
    const workloadCode = `
      // Computes deterministic normalized vector representations across Compute Sea shards
      return data.map((text, idx) => {
        const str = String(text);
        const dim = 16;
        let sumSq = 0;
        const raw = [];
        for (let d = 0; d < dim; d++) {
          let sum = 0;
          for (let i = 0; i < str.length; i++) {
            sum += (str.charCodeAt(i) * (d + 1) * 31) % 1000;
          }
          const val = sum / 1000;
          raw.push(val);
          sumSq += val * val;
        }
        const norm = Math.sqrt(sumSq) || 1;
        const vec = raw.map(v => Number((v / norm).toFixed(6)));
        return { index: idx, embedding: vec };
      });
    `;

    try {
      const seaResult = await this.sea.submitWorkload(workloadCode, inputs, {
        chunkSize: Math.max(1, Math.min(inputs.length, 4))
      });

      const embeddingData = [];
      if (Array.isArray(seaResult.output)) {
        for (let i = 0; i < seaResult.output.length; i++) {
          const item = seaResult.output[i];
          embeddingData.push({
            object: 'embedding',
            index: i,
            embedding: item && item.embedding ? item.embedding : []
          });
        }
      }

      this._sendJson(res, 200, {
        object: 'list',
        data: embeddingData,
        model,
        usage: {
          prompt_tokens: inputs.reduce((acc, t) => acc + String(t).split(/\s+/).length, 0),
          total_tokens: inputs.reduce((acc, t) => acc + String(t).split(/\s+/).length, 0)
        },
        compute_sea: {
          workloadId: seaResult.workloadId,
          status: seaResult.status,
          totalCost: seaResult.totalCost,
          durationMs: seaResult.durationMs
        }
      });
    } catch (err) {
      this._sendError(res, 500, `Compute Sea embeddings workload failed: ${err.message}`, 'api_error');
    }
  }

  async _handleAnthropicMessages(req, res) {
    let body;
    try {
      body = await this._readBody(req);
    } catch (err) {
      const code = err.statusCode || 400;
      return this._sendError(res, code, err.message, code === 413 ? 'request_entity_too_large' : 'invalid_request_error');
    }

    const { messages, model = 'open-side-sea', max_tokens = 1024 } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return this._sendError(res, 400, "Missing or invalid 'messages' array in request body", 'invalid_request_error');
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') {
        return this._sendError(res, 400, `Invalid message at index ${i}: must be a non-null object`, 'invalid_request_error');
      }
    }

    const workloadCode = `
      return data.map(msg => {
        const role = msg.role || 'user';
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        return {
          role,
          tokens: content.split(/\\s+/).filter(Boolean).length,
          chars: content.length,
          preview: content.slice(0, 100)
        };
      });
    `;

    try {
      const seaResult = await this.sea.submitWorkload(workloadCode, messages, {
        chunkSize: Math.max(1, Math.min(messages.length, 4))
      });

      const msgId = `msg_${crypto.randomUUID()}`;
      const responseText = `[Open-Side ComputeSea] Workload executed across ${seaResult.shards?.length || 1} mesh shard(s). Processed ${messages.length} message(s). Total mesh compute cost: ${seaResult.totalCost || 0} credits.`;

      const inputTokens = messages.reduce((acc, m) => acc + (m && typeof m.content === 'string' ? m.content.split(/\s+/).filter(Boolean).length : 0), 0);
      const outputTokens = responseText.split(/\s+/).filter(Boolean).length;

      this._sendJson(res, 200, {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: responseText
          }
        ],
        model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        },
        compute_sea: {
          workloadId: seaResult.workloadId,
          status: seaResult.status,
          shardsCount: seaResult.shards?.length || 0,
          totalCost: seaResult.totalCost,
          durationMs: seaResult.durationMs
        }
      });
    } catch (err) {
      this._sendError(res, 500, `Compute Sea workload execution failed: ${err.message}`, 'api_error');
    }
  }
}

module.exports = {
  OpenSideGateway,
  DEFAULT_PORT,
  DEFAULT_HOST
};
