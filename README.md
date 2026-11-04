# Open-Side

An experimental, early-stage Node.js project that exposes a small set of tools over JSON-RPC 2.0 via STDIO, with simple keyword-based filtering of the tool list.

![CI](https://github.com/pc1209920-coder/Open-Side/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

## Status

Alpha. This is a learning project. It is not a complete MCP server yet.

## What it does today

- Keeps a registry of tools, grouped by namespace (for example `system.health_check`).
- Handles two JSON-RPC methods over STDIO: `tools/list` and `tools/call`.
- `tools/list` accepts an optional `intent` string and returns only the tools whose name or description contains one of its words.
- Includes one built-in tool, `system.health_check`, which reports platform, memory use and uptime.
- Uses only built-in Node.js modules.

## What it does not do yet

- It does not implement the MCP `initialize` handshake, so MCP clients such as Claude Desktop will probably not connect to it yet.
- It does not connect to other MCP servers.
- Tool filtering is plain keyword matching, not semantic search.

## Run it

You need Node.js 18 or newer.

```
git clone https://github.com/pc1209920-coder/Open-Side.git
cd Open-Side
node src/index.js
```

Then type this line and press Enter:

```
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"intent":"health"}}
```

## Run the tests

```
npm test
```

## Roadmap

- Implement the MCP `initialize` handshake
- Connect to downstream MCP servers
- Better tool filtering
- HTTP/SSE transport

## License

MIT. See the LICENSE file.
