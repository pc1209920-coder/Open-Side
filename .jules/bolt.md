## 2024-11-09 - Caching OS Hardware Info
**Learning:** `os.cpus()` and `os.totalmem()` in Node.js are surprisingly expensive because they require system calls to the OS kernel. In a polling loop (like checking if a device is ready for standby compute), repeated calls can cause significant overhead.
**Action:** Cache static hardware values (like total CPU count and total memory) in class constructors rather than calling `os.cpus()` and `os.totalmem()` on every poll.
