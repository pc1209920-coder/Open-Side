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
    // ⚡ Bolt: Cache for discoverTools output to prevent redundant object allocations
    this._cachedTools = null;
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

    // ⚡ Bolt: Invalidate tool cache when new tools are registered
    this._cachedTools = null;

    this.emit('connector:registered', { namespace, toolCount: (connectorConfig.tools || []).length });
    return true;
  }

  discoverTools(intentQuery = '') {
    // ⚡ Bolt: Memoize tool objects to avoid O(N) allocation on every tools/list call
    if (!this._cachedTools) {
      this._cachedTools = Array.from(this.toolRegistry.entries()).map(([id, spec]) => ({
        name: id,
        description: spec.description,
        inputSchema: spec.inputSchema || { type: 'object', properties: {} }
      }));
    }

    const allTools = this._cachedTools;

    if (!intentQuery.trim()) return allTools;

    const terms = intentQuery.toLowerCase().split(/\s+/);
    return allTools.filter(tool => {
      const haystack = `${tool.name} ${tool.description}`.toLowerCase();
      return terms.some(term => haystack.includes(term));
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
