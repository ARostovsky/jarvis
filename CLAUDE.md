# Jarvis

Before changing anything, read `docs/ARCHITECTURE.md`: code map, event model, HTTP API, invariants and recipes.

- Check: `npm run check` (tsc). Try changes with a throwaway data dir: `XDG_DATA_HOME=/tmp/jarvis-dev PORT=7799 npm start`.
- Node 24 runs `.ts` directly: erasable TypeScript only, no build step. The UI is one file, `public/index.html`.
- Keep the invariants: never lose user work, event log is the source of truth, loopback only with the Origin check.
- Update `README.md` (users) and `docs/ARCHITECTURE.md` (developers) when behavior changes.
