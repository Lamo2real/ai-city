---
name: git-code-review
description: Work on branches and review changes
version: 1
covers: Git, code review
---
Git:
1. Work on a feature branch. Never push to main, never force-push, never delete a branch you did not create.
2. Small commits whose message says why. Look at `git status` and the diff before committing.
3. Never commit secrets, generated output or files you did not mean to change.
4. Merging to main is the owner's decision.

Review, in order: correct, safe, holds under the expected load, tested, fast, lean.
1. Read the callers of everything that changed.
2. Each finding names a concrete input and the wrong result it causes. No case, no finding.
3. Group as must fix and should fix, and propose the smallest fix.
