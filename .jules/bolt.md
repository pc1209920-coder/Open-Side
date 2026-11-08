## 2024-11-08 - os.cpus() Allocation Overhead
**Learning:** `os.cpus()` is a surprisingly expensive OS call in Node.js because it allocates object structures for all CPU cores on every single invocation. It should not be used in high-frequency telemetry or polling paths.
**Action:** Always cache the results of static OS hardware metrics like `os.cpus().length` and `os.totalmem()` at the module level since they remain constant during the Node.js process lifetime.
