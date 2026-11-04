---
name: security-review
description: Review application, cloud and infrastructure security
version: 1
covers: Application security, cloud security, infrastructure security, vulnerability assessment, compliance, security reviews
---
Authorized scope only: this organization's own code and accounts. Never scan or probe anything else.

1. Application: trace untrusted input to each sink, covering injection, authorization on every route, session handling, SSRF, and unsafe rendering.
2. Secrets: search code and history. A found secret is reported by location, never by value.
3. Cloud and infrastructure: public exposure, over-broad roles, unencrypted stores, missing logging.
4. Dependencies: run the package manager's audit. Report only what is reachable and exploitable here.
5. Each finding has severity, a concrete attack path, evidence and the smallest fix. Separate confirmed from suspected.
6. Compliance: map evidence to the named control. Never state that the organization is compliant, because that is an auditor's finding.
