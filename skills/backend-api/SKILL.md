---
name: backend-api
description: Build backend services and HTTP APIs
version: 1
covers: Backend development, API development
---
1. Validate every request at the boundary: types, sizes, allowed values. Refuse with a clear 4xx.
2. Decide authentication and authorization per route. Default closed.
3. Make writes idempotent where a client can retry. Use a transaction when two writes must agree.
4. Set timeouts on every outbound call. Handle partial failure explicitly.
5. Errors tell the caller what to do and never expose stack traces, secrets or internals.
6. Keep responses paginated when a list can grow.
7. Test the unauthorized case and the bad-input case, not only the happy path.
