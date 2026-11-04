---
name: typescript-react
description: Write and fix TypeScript, React and frontend code
version: 1
covers: TypeScript, React, frontend development
---
1. Follow the repo's build. This city runs TypeScript by type stripping, so use erasable syntax only and check with `tsc --noEmit`.
2. Avoid `any`. Validate data at the boundary, then trust the types.
3. React: state as local as possible, derive instead of syncing with effects, stable keys, an empty and an error state for every list.
4. Accessibility: real buttons and labels, keyboard reachable, visible focus, works at phone width.
5. Render text with text nodes. Agent-written or external text never goes through innerHTML.
6. Look at UI changes in a browser. Passing tests do not prove a page renders.
