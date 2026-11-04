## 2023-11-04 - Caching discovered tools
**Learning:** In the `discoverTools` method of `NexusRouter`, `Array.from(this.toolRegistry.entries())` is called every time `discoverTools` is invoked. This regenerates an array of tools and concatenates strings for matching.
**Action:** We can incrementally cache the list of tools and their search strings whenever `registerConnector` is called. This changes the O(N) object creation on every query to an O(1) array access when no query is passed, and avoids string concatenation and object creation during filtering.
