## 2024-05-17 - Error details leakage in tool handler
**Vulnerability:** Tool handler errors return the raw error message (`err.message`) in the JSON-RPC response. If a tool fails with sensitive details (like database credentials, internal state, or stack traces if passed directly), this will be leaked back to the client.
**Learning:** Returning unhandled exception messages directly from dynamic, potentially third-party handlers directly to a client output stream is insecure.
**Prevention:** Catch errors and return a generic error message. If debugging is needed, log the error details locally but sanitize the message sent back to the client.
