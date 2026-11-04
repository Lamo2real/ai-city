---
name: testing-debugging
description: Find the real cause of a failure and prove the fix
version: 1
covers: Testing, debugging
---
Debugging:
1. Reproduce first. Save the exact command and output.
2. Change one thing at a time. Read the code path instead of guessing from the symptom.
3. Name the root cause in one sentence. If you cannot, you have not found it.
4. Fix it in the shared code, then check every caller.

Testing:
1. Write the test that fails without the fix, and see it fail.
2. Test behavior through public interfaces. Prefer real collaborators to mocks where they are cheap.
3. Cover the empty, zero, last-item, duplicate and restart cases when they apply.

Report the real test output, including failures. Never claim a run you did not do.
