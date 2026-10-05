# Frontend conventions

Read for frontend changes; [design-system.md](design-system.md) owns UI geometry
and tokens. [development.md](development.md) owns setup and quality commands.

- TanStack Query owns server state. Hooks in `frontend/src/hooks/` own fetching
  and polling; `frontend/src/services/api.ts` owns API types, re-exported from
  `frontend/src/types/api.ts`.
- Surface errors through `errorUtils.ts`, toasts and per-step retry props. Never
  display raw stack traces. Keep root/app ErrorBoundary and startup splash coverage.

Startup includes settings, completed-plan recovery, initial task diagnostics and
the first status snapshot of a reattached task. Keep the startup screen until
these settle and their navigation is applied. Initialize StageShell from the
allowed recovered stage; native `frontend_ready` must follow this startup gate.
Readiness latches so later polling cannot restart the loading screen.
`useInitialProgressRestoration` owns task reattachment and this one-time gate;
MainPage composes it after recovered-plan navigation.

The interface locale belongs to `I18nProvider` and device storage. The title-bar
selector must not save `Config.language`, discard workflow artifacts, restart task
polling or change query identities. Backend `language` remains operational because
it affects generated category labels. Keep reviewed destinations stable while
translating their surrounding UI; exercise a running scan and a recovered plan in
the browser when changing locale wiring.

- Use semantic HSL tokens from `frontend/src/index.css` rather than raw colors.
- Declare helpers before hooks/initializers: no-use-before-define is enforced.
- Run lint with zero warnings, format check, Vitest and build. Pure logic uses
  the node test environment; components opt into jsdom with its environment docblock.
