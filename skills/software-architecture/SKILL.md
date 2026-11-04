---
name: software-architecture
description: Choose and record the structure of a system before building it
version: 1
covers: Software architecture
---
1. Write down the load, the data, who runs it, and what failure costs. Read the existing code first.
2. Prefer the structure the repo already has. A new service, queue or framework needs a concrete reason.
3. Compare at most three options by cost to run, cost to change, and failure modes. Recommend one.
4. Name every boundary where untrusted input enters and what validates it.
5. Record the decision: context, choice, what was rejected and why, what would change the decision.

Report the decision and the smallest first step. Do not build beyond the step you were given.
