## 2026-02-18 - Caching Static Node OS Properties
**Learning:** In Node.js, `os.cpus()` and `os.totalmem()` are surprisingly expensive operations because they make synchronous system calls to the underlying OS. In high-throughput paths (like `isDeviceInStandby` checks that may be polled frequently by the GridCoordinator), calling these repeatedly causes significant CPU overhead.
**Action:** Always cache static hardware properties like CPU count and total memory during initialization (e.g. in class constructors) instead of re-evaluating them in hot paths.
