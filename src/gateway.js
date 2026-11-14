const http = require('node:http');
const crypto = require('node:crypto');

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_CORS_HEADERS = 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-request-id, openai-organization, openai-project';

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
   * @param {number} [options.port] Default 8080 (0 allows OS ephemeral port)
   * @param {string} [options.host] Default 127.0.0.1
   * @param {string} [options.apiKey] Optional API key to validate Bearer token
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    this.port = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : DEFAULT_PORT;
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
          srv.on('error', () => {});
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
          srv.on('error', () => {});
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

  async start(...args) {
    return this.listen(...args);
  }

  async stop(...args) {
    return this.close(...args);
  }

  _getCorsHeaders(req) {
    const requestedHeaders = req && req.headers && req.headers['access-control-request-headers'];
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': requestedHeaders || ALLOWED_CORS_HEADERS,
      'Access-Control-Expose-Headers': 'Content-Type, X-Request-ID'
    };
  }

  _sendJson(res, statusCode, data, headers = {}) {
    if (res.writableEnded || res.headersSent) return;
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      ...this._getCorsHeaders(),
      ...headers
    });
    res.end(body);
  }

  _sendError(res, statusCode, message, type = 'invalid_request_error', code = null, headers = {}) {
    if (res.writableEnded || res.headersSent) return;
    this._sendJson(res, statusCode, {
      error: {
        message,
        type,
        param: null,
        code
      }
    }, headers);
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
          req.pause();
          const err = new RangeError('Payload Too Large: request body exceeds maximum allowed size (10MB)');
          err.statusCode = 413;
          reject(err);
          req.resume();
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
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            const err = new SyntaxError('Request body must be a JSON object');
            err.statusCode = 400;
            reject(err);
            return;
          }
          resolve(parsed);
        } catch (err) {
          const parseErr = new SyntaxError(err.statusCode ? err.message : `Invalid JSON in request body: ${err.message}`);
          parseErr.statusCode = err.statusCode || 400;
          reject(parseErr);
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
    const tokenHash = crypto.createHash('sha256').update(token).digest();
    const keyHash = crypto.createHash('sha256').update(this.apiKey).digest();
    if (!crypto.timingSafeEqual(tokenHash, keyHash)) {
      this._sendError(res, 401, 'Invalid API Key', 'authentication_error');
      return false;
    }
    return true;
  }

  async _handleRequest(req, res) {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...this._getCorsHeaders(req),
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
    // Normalize pathname: strip trailing slashes and multiple consecutive slashes
    const pathname = (parsedUrl.pathname.replace(/\/+/g, '/').replace(/\/+$/, '') || '/');

    // Health check (GET or HEAD)
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/health' || pathname === '/healthz')) {
      const telemetry = this.sea && typeof this.sea.getTelemetry === 'function'
        ? this.sea.getTelemetry()
        : null;
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          ...this._getCorsHeaders()
        });
        return res.end();
      }
      return this._sendJson(res, 200, {
        status: 'ok',
        version: '0.6.0',
        protocol: 'open-side-protocol',
        nodeId: this.sea ? this.sea.nodeId : null,
        telemetry
      });
    }

    // Models endpoint (OpenAI-compatible)
    const availableModels = [
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
    ];

    if (req.method === 'GET' && pathname === '/v1/models') {
      if (!this._checkAuth(req, res)) return;
      return this._sendJson(res, 200, {
        object: 'list',
        data: availableModels
      });
    }

    if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
      if (!this._checkAuth(req, res)) return;
      const modelId = decodeURIComponent(pathname.slice('/v1/models/'.length));
      const found = availableModels.find(m => m.id === modelId);
      if (!found) {
        return this._sendError(res, 404, `The model '${modelId}' does not exist`, 'invalid_request_error', 'model_not_found');
      }
      return this._sendJson(res, 200, found);
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
      const headers = code === 413 ? { Connection: 'close' } : {};
      return this._sendError(res, code, err.message, code === 413 ? 'request_entity_too_large' : 'invalid_request_error', null, headers);
    }

    const { messages, model = 'open-side-sea', temperature = 0.7, max_tokens, stream = false } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return this._sendError(res, 400, "Missing or invalid 'messages' array in request body", 'invalid_request_error');
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        return this._sendError(res, 400, `Invalid message at index ${i}: must be a non-null object`, 'invalid_request_error');
      }
    }

    if (temperature !== undefined && (typeof temperature !== 'number' || Number.isNaN(temperature) || temperature < 0 || temperature > 2)) {
      return this._sendError(res, 400, "Invalid 'temperature': must be a number between 0 and 2", 'invalid_request_error');
    }
    if (max_tokens !== undefined && (!Number.isInteger(max_tokens) || max_tokens <= 0)) {
      return this._sendError(res, 400, "Invalid 'max_tokens': must be a positive integer", 'invalid_request_error');
    }

    // Map input messages into ComputeSea workload partition safely
    const workloadCode = `
      // Process conversational chat messages across Compute Sea nodes
      return data.map(msg => {
        const role = msg && msg.role ? msg.role : 'user';
        const rawContent = msg ? msg.content : '';
        const content = typeof rawContent === 'string'
          ? rawContent
          : (rawContent !== undefined && rawContent !== null ? JSON.stringify(rawContent) : '');
        return {
          role,
          tokens: content ? content.split(/\\s+/).filter(Boolean).length : 0,
          chars: content.length,
          preview: content.slice(0, 100)
        };
      });
    `;

    let clientAborted = false;
    req.once('close', () => {
      clientAborted = true;
    });

    try {
      const seaResult = await this.sea.submitWorkload(workloadCode, messages, {
        chunkSize: Math.max(1, Math.min(messages.length, 4))
      });

      if (clientAborted || res.writableEnded) return;

      if (seaResult.status !== 'COMPLETED') {
        const statusMap = {
          REJECTED: 429,
          INSUFFICIENT_CREDIT_BALANCE: 402,
          SANDBOX_VALIDATION_FAILED: 503,
          SHED: 503
        };
        const httpStatus = statusMap[seaResult.status] || 502;
        const errMsg = `Compute Sea workload ${seaResult.status}: ${seaResult.error || seaResult.reason || 'Workload was not completed'}`;

        if (stream && res.headersSent) {
          // Headers already sent on SSE stream: deliver SSE error chunk
          res.write(`data: ${JSON.stringify({
            error: {
              message: errMsg,
              type: 'compute_sea_error',
              code: seaResult.status
            }
          })}\n\n`);
          res.end();
          return;
        }

        return this._sendError(
          res,
          httpStatus,
          errMsg,
          'compute_sea_error',
          seaResult.status
        );
      }

      const responseText = `[Open-Side ComputeSea] Workload executed across ${seaResult.shards?.length || 1} mesh shard(s). Processed ${messages.length} message(s). Total mesh compute cost: ${seaResult.totalCost || 0} credits.`;
      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        // Server-Sent Events (SSE) streaming mode
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          ...this._getCorsHeaders(req)
        });
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }

        // Emit role chunk
        const roleChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: responseText },
              finish_reason: null
            }
          ]
        };
        res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

        // Emit finish chunk
        const finishChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }
          ]
        };
        res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Non-streaming response
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
          prompt_tokens: messages.reduce((acc, m) => {
            const c = m && typeof m.content === 'string' ? m.content : (m && m.content != null ? JSON.stringify(m.content) : '');
            return acc + (c ? c.split(/\s+/).filter(Boolean).length : 0);
          }, 0),
          completion_tokens: responseText.split(/\s+/).filter(Boolean).length,
          total_tokens: messages.reduce((acc, m) => {
            const c = m && typeof m.content === 'string' ? m.content : (m && m.content != null ? JSON.stringify(m.content) : '');
            return acc + (c ? c.split(/\s+/).filter(Boolean).length : 0);
          }, 0) + responseText.split(/\s+/).filter(Boolean).length
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
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: { message: `Compute Sea workload execution failed: ${err.message}`, type: 'api_error' } })}\n\n`);
        res.end();
        return;
      }
      this._sendError(res, 500, `Compute Sea workload execution failed: ${err.message}`, 'api_error');
    }
  }

  async _handleEmbeddings(req, res) {
    let body;
    try {
      body = await this._readBody(req);
    } catch (err) {
      const code = err.statusCode || 400;
      const headers = code === 413 ? { Connection: 'close' } : {};
      return this._sendError(res, code, err.message, code === 413 ? 'request_entity_too_large' : 'invalid_request_error', null, headers);
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
        const str = String(text != null ? text : '');
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

      if (seaResult.status !== 'COMPLETED') {
        const statusMap = {
          REJECTED: 429,
          INSUFFICIENT_CREDIT_BALANCE: 402,
          SANDBOX_VALIDATION_FAILED: 503,
          SHED: 503
        };
        const httpStatus = statusMap[seaResult.status] || 502;
        return this._sendError(
          res,
          httpStatus,
          `Compute Sea workload ${seaResult.status}: ${seaResult.error || seaResult.reason || 'Workload was not completed'}`,
          'compute_sea_error',
          seaResult.status
        );
      }

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
          prompt_tokens: inputs.reduce((acc, t) => acc + String(t != null ? t : '').split(/\s+/).filter(Boolean).length, 0),
          total_tokens: inputs.reduce((acc, t) => acc + String(t != null ? t : '').split(/\s+/).filter(Boolean).length, 0)
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
      const headers = code === 413 ? { Connection: 'close' } : {};
      return this._sendError(res, code, err.message, code === 413 ? 'request_entity_too_large' : 'invalid_request_error', null, headers);
    }

    const { messages, model = 'open-side-sea', max_tokens = 1024, stream = false } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return this._sendError(res, 400, "Missing or invalid 'messages' array in request body", 'invalid_request_error');
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        return this._sendError(res, 400, `Invalid message at index ${i}: must be a non-null object`, 'invalid_request_error');
      }
    }

    if (max_tokens !== undefined && (!Number.isInteger(max_tokens) || max_tokens <= 0)) {
      return this._sendError(res, 400, "Invalid 'max_tokens': must be a positive integer", 'invalid_request_error');
    }

    const workloadCode = `
      return data.map(msg => {
        const role = msg && msg.role ? msg.role : 'user';
        const rawContent = msg ? msg.content : '';
        const content = typeof rawContent === 'string'
          ? rawContent
          : (rawContent !== undefined && rawContent !== null ? JSON.stringify(rawContent) : '');
        return {
          role,
          tokens: content ? content.split(/\\s+/).filter(Boolean).length : 0,
          chars: content.length,
          preview: content.slice(0, 100)
        };
      });
    `;

    try {
      const seaResult = await this.sea.submitWorkload(workloadCode, messages, {
        chunkSize: Math.max(1, Math.min(messages.length, 4))
      });

      if (seaResult.status !== 'COMPLETED') {
        const statusMap = {
          REJECTED: 429,
          INSUFFICIENT_CREDIT_BALANCE: 402,
          SANDBOX_VALIDATION_FAILED: 503,
          SHED: 503
        };
        const httpStatus = statusMap[seaResult.status] || 502;
        const errMsg = `Compute Sea workload ${seaResult.status}: ${seaResult.error || seaResult.reason || 'Workload was not completed'}`;

        if (stream && res.headersSent) {
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errMsg } })}\n\n`);
          res.end();
          return;
        }

        return this._sendError(
          res,
          httpStatus,
          errMsg,
          'compute_sea_error',
          seaResult.status
        );
      }

      const msgId = `msg_${crypto.randomUUID()}`;
      const responseText = `[Open-Side ComputeSea] Workload executed across ${seaResult.shards?.length || 1} mesh shard(s). Processed ${messages.length} message(s). Total mesh compute cost: ${seaResult.totalCost || 0} credits.`;

      const inputTokens = messages.reduce((acc, m) => {
        const c = m && typeof m.content === 'string' ? m.content : (m && m.content != null ? JSON.stringify(m.content) : '');
        return acc + (c ? c.split(/\s+/).filter(Boolean).length : 0);
      }, 0);
      const outputTokens = responseText.split(/\s+/).filter(Boolean).length;

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          ...this._getCorsHeaders(req)
        });
        if (typeof res.flushHeaders === 'function') {
          res.flushHeaders();
        }

        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: responseText } })}\n\n`);
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } })}\n\n`);
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
        return;
      }

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
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: err.message } })}\n\n`);
        res.end();
        return;
      }
      this._sendError(res, 500, `Compute Sea workload execution failed: ${err.message}`, 'api_error');
    }
  }
}

module.exports = {
  OpenSideGateway,
  DEFAULT_PORT,
  DEFAULT_HOST,
  MAX_BODY_SIZE,
  ALLOWED_CORS_HEADERS
};
