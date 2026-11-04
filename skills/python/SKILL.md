---
name: python
description: Write and fix Python the way this organization expects
version: 1
covers: Python
---
1. Python 3.12 and `uv` (`uv sync`, `uv run`). Do not install into the system Python.
2. Standard library first. A new dependency needs a reason that a few lines of code cannot meet.
3. Type-hint public functions. Catch specific exceptions. Never swallow one silently.
4. Use `subprocess.run([...], check=True)` with a list, never `shell=True` on input you did not write.
5. Use parameterized SQL, always.
6. Add a pytest test for each branch, parser, money or security path, and run it before reporting.

Report what you ran and its result, not what should work.
