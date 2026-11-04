# ⚡ Open-Side

> Next-Gen MCP 2.0 Universal App Connection Engine & Dynamic Context Pruner

[![Open-Side CI Pipeline](https://github.com/pc1209920-coder/Open-Side/actions/workflows/ci.yml/badge.svg)](https://github.com/pc1209920-coder/Open-Side/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/Node-v18%2B-green.svg)](https://nodejs.org/)

Open-Side is a lightweight, low-latency multiplexer and context-aware routing layer built on top of the **Model Context Protocol (MCP)**. It dynamically registers tool connectors and selectively prunes tool schemas based on runtime intent queries to prevent token bloat inside large language models like Claude.

---

## 🚀 Key Features

* **Dynamic Context Pruning**: Automatically filters tool specifications by query keywords to minimize context window usage.
* **JSON-RPC 2.0 Multiplexer**: Routes queries across multiple downstream MCP connectors over standard STDIO.
* **Built-in System Diagnostics**: Native local health check connector exposing memory, platform, and uptime metrics.
* **Zero Overhead**: Engineered entirely with native Node.js core modules without heavy third-party runtimes.

---

## 🛠️ Architecture

~~~text
LLM (Claude / Agent)
       │
       ▼ (JSON-RPC 2.0 via STDIO)
┌─────────────────────────────────┐
│     Open-Side NexusRouter       │
│  - Dynamic Context Pruner       │
│  - Namespaced Tool Registry     │
└────────┬───────────────┬────────┘
         │               │
         ▼               ▼
   [System Bridge]  [Downstream MCP]
~~~

---

## 📦 Installation & Usage

### Prerequisites
* Node.js v18.0.0 or higher

### Running Locally

~~~bash
git clone https://github.com/pc1209920-coder/Open-Side.git
cd Open-Side
node src/index.js
~~~

### Claude Desktop Integration
Add the following to your `claude_desktop_config.json`:

~~~json
{
  "mcpServers": {
    "open-side": {
      "command": "node",
      "args": ["/absolute/path/to/Open-Side/src/index.js"]
    }
  }
}
~~~

---

## 🗺️ Roadmap

- [x] JSON-RPC 2.0 STDIO bridge
- [x] Dynamic context pruning by keyword intent
- [ ] SSE & WebSocket bidirectional streaming transport
- [ ] Semantic vector caching for high-density tool registries
- [ ] Sandboxed permission policies for local filesystem connectors

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
