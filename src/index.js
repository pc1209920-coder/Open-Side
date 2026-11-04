#!/usr/bin/env node
/**
 * Open-Side — Universal MCP 2.0 Entrypoint
 * Maintained by Pratyush Chaudhary
 */
import readline from 'node:readline';
import { NexusRouter } from './router.js';

const router = new NexusRouter({ maxContextTokens: 8192 });

// Built-in System Diagnostics Bridge
router.registerConnector('system', {
  name: 'Local OS Diagnostics Bridge',
  tools: [
    {
      name: 'health_check',
      description: 'Verify local system memory, uptime, and active MCP bridge status',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        status: 'healthy',
        platform: process.platform,
        arch: process.arch,
        memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        uptimeSeconds: Math.round(process.uptime())
      })
    }
  ]
});

// JSON-RPC 2.0 listener over STDIO
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

console.error('[Open-Side] Engine v0.2.0-alpha initialized. Listening on STDIO...');

rl.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    const response = await router.dispatchRequest(request);
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error: Invalid JSON payload' }
    }) + '\n');
  }
});
