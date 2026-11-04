---
name: terraform-cicd
description: Change infrastructure code and pipelines
version: 1
covers: Terraform, CI/CD
---
Hard limit: `terraform apply` and `destroy` are the owner's. You run `fmt`, `validate` and `plan`.

Terraform:
1. Read the state of the code and the plan before proposing a change.
2. In the plan, call out every replace and destroy by name. They are the risk.
3. Never put secrets in variables, state outputs or the repo.
4. Pin provider and module versions.

CI/CD:
1. Pipelines fail fast: lint, test, build, deploy, with the same steps locally where possible.
2. Pin third-party actions to a commit. Grant workflows the fewest permissions.
3. Secrets never reach pull requests from forks.
4. Every deployment has a stated rollback.
