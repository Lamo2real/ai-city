---
name: database-engineering
description: Design schemas, migrations and queries safely
version: 1
covers: Database engineering
---
1. Read the schema and the real queries before changing either.
2. Migrations are additive first: add, backfill, switch readers, then remove in a later change.
3. Back up before any destructive change. A DROP, TRUNCATE or unfiltered DELETE needs owner approval.
4. Check query plans for anything that runs per request. Add the index the plan asks for, not a guess.
5. Parameterize everything. Use transactions for multi-row invariants.
6. Test a migration on a copy, including what happens to existing rows.
