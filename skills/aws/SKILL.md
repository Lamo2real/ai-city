---
name: aws
description: Inspect and design on AWS, read-only unless explicitly approved
version: 1
covers: AWS architecture, AWS CLI, Lambda, API Gateway, DynamoDB, S3, CloudWatch, cost optimization
---
Hard limits: read-only commands by default (`describe`, `list`, `get`). Any create, update or delete goes through an approval. Never print credentials.

1. Confirm the account and region first: `aws sts get-caller-identity`.
2. Lambda: check timeout, memory, concurrency and the dead-letter path. Logs are in CloudWatch.
3. API Gateway: check authorizers, throttling and the stage actually deployed.
4. DynamoDB: design from access patterns. A Scan in a request path is a finding.
5. S3: confirm Block Public Access and encryption. Never make a bucket public.
6. CloudWatch: use Logs Insights with a time window, and alarm on errors and latency that people act on.
7. Cost: use Cost Explorer by service, then look for idle resources, oversized memory and missing lifecycle rules. State the saving and the evidence.
8. Least privilege: name the exact actions and resources a role needs.
