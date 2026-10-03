# Frontend conventions

Read for frontend changes; [design-system.md](design-system.md) owns UI geometry
and tokens. [development.md](development.md) owns setup and quality commands.

- TanStack Query owns server state. Hooks in `frontend/src/hooks/` own fetching
  and polling; `frontend/src/services/api.ts` owns API types, re-exported from
  `frontend/src/types/api.ts`.
- Surface errors through `errorUtils.ts`, toasts and per-step retry props. Never
  display raw stack traces. Keep root/app ErrorBoundary and startup splash coverage.
- Use semantic HSL tokens from `frontend/src/index.css` rather than raw colors.
- Declare helpers before hooks/initializers: no-use-before-define is enforced.
- Run lint with zero warnings, format check, Vitest and build. Pure logic uses
  the node test environment; components opt into jsdom with its environment docblock.
