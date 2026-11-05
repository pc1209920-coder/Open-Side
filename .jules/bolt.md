
## 2024-05-18 - JSON-RPC Tool Discovery Caching
**Learning:** In an STDIO JSON-RPC bridge (like `open-side`), tool list queries (`discoverTools`) are frequently called, but iterating maps and reconstructing tool objects on every call creates heavy garbage collection overhead and slow response times for O(N) objects.
**Action:** When working on tool discovery endpoints, always cache the mapped registry results and invalidate them during connector/tool registration instead of lazily recreating them on read.
