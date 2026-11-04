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

    // Performance optimization: Cache tool list and search haystack
    this._cachedToolList = null;
    this._cachedToolSearch = null;
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

    // Invalidate caches when tools are modified
    this._cachedToolList = null;
    this._cachedToolSearch = null;

    this.emit('connector:registered', { namespace, toolCount: (connectorConfig.tools || []).length });
    return true;
  }

  discoverTools(intentQuery = '') {
    // Lazily rebuild cache
    if (!this._cachedToolList) {
      this._cachedToolList = [];
      this._cachedToolSearch = [];
      for (const [id, spec] of this.toolRegistry.entries()) {
        const toolData = {
          name: id,
          description: spec.description,
          inputSchema: spec.inputSchema || { type: 'object', properties: {} }
        };
        this._cachedToolList.push(toolData);
        this._cachedToolSearch.push({
          tool: toolData,
          haystack: `${id} ${spec.description}`.toLowerCase()
        });
      }
    }

    // Return deeply cloned objects to prevent accidental cache mutation by callers
    if (!intentQuery.trim()) return structuredClone(this._cachedToolList);

    const terms = intentQuery.toLowerCase().split(/\s+/);
    return this._cachedToolSearch
      .filter(entry => terms.some(term => entry.haystack.includes(term)))
      .map(entry => structuredClone(entry.tool));
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
