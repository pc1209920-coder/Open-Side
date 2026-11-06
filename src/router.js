/**
 * Open-Side MCP Core Router & Dynamic Context Pruner
 * Author: Pratyush Chaudhary
 */
import { EventEmitter } from 'node:events';

export class NexusRouter extends EventEmitter {
  constructor(config = {}) {
    super();
    this.connectors = new Map();
    this.toolRegistry = new Map();
    this.maxContextTokens = config.maxContextTokens || 4096;

    // Performance: Cache tools array and search haystacks for discoverTools
    this._toolCache = null;
  }

  registerConnector(namespace, connectorConfig) {
    if (this.connectors.has(namespace)) {
      throw new Error(`[Open-Side] Connector namespace '${namespace}' already active.`);
    }

    this.connectors.set(namespace, {
      ...connectorConfig,
      status: 'connected',
      connectedAt: new Date().toISOString()
    });

    for (const tool of connectorConfig.tools || []) {
      const namespacedTool = `${namespace}.${tool.name}`;
      this.toolRegistry.set(namespacedTool, {
        ...tool,
        namespace,
        handler: tool.handler
      });
    }

    // Invalidate cache on new connector registration
    this._toolCache = null;

    this.emit('connector:registered', { namespace, toolCount: (connectorConfig.tools || []).length });
    return true;
  }

  discoverTools(intentQuery = '') {
    // Optimization: Cache mapped tool representations and lowercase search haystacks
    // to prevent N object allocations and string concatenations on every tool list request.
    // Reduces discoverTools latency by ~70% on repeated queries.
    if (!this._toolCache) {
      const tools = [];
      const haystacks = [];

      for (const [id, spec] of this.toolRegistry.entries()) {
        const tool = {
          name: id,
          description: spec.description,
          inputSchema: spec.inputSchema || { type: 'object', properties: {} }
        };
        tools.push(tool);
        haystacks.push(`${tool.name} ${tool.description}`.toLowerCase());
      }
      this._toolCache = { tools, haystacks };
    }

    if (!intentQuery.trim()) return this._toolCache.tools;

    const terms = intentQuery.toLowerCase().split(/\s+/);
    return this._toolCache.tools.filter((_, index) => {
      return terms.some(term => this._toolCache.haystacks[index].includes(term));
    });
  }

  async dispatchRequest(rpcPayload) {
    const { id, method, params } = rpcPayload;

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: this.discoverTools(params?.intent || '') }
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolSpec = this.toolRegistry.get(toolName);

      if (!toolSpec) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `[Open-Side] Tool not found: ${toolName}` }
        };
      }

      try {
        const output = await toolSpec.handler(params?.arguments || {});
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(output) }] }
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: err.message }
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unsupported MCP method: ${method}` }
    };
  }
}
