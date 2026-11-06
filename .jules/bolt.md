
## 2026-11-06 - Optimize JSON-RPC tool list queries
**Learning:** JSON-RPC servers can face significant overhead if they reconstruct the entire tool list (objects and lowercased strings) for every intent query in `tools/list`. Because these lists are frequently fetched by clients and rarely updated after initial connection setup, re-mapping and string building in a hot path causes high latency.
**Action:** When working on tool discovery or routing logic in MCP/JSON-RPC, cache the derived data structures (like pre-computed search haystacks and mapped object arrays) upon tool registration and invalidate only when new connectors are added.
