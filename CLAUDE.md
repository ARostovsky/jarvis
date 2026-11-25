# Jarvis

Before changing anything, read `docs/ARCHITECTURE.md`: code map, event model, HTTP API, invariants and recipes.

- Check: `npm run check` (tsc, covers `e2e/`), `npm test` and `npm run e2e` (Playwright, its own server on port 7798 with a throwaway data dir and the fake SDK, no API cost). Set `E2E_PORT`, e.g. `E2E_PORT=7810 npm run e2e`, so parallel runs and worktrees do not clash. Try changes with a throwaway data dir: `XDG_DATA_HOME=/tmp/jarvis-dev PORT=7799 npm start`.
- Agent-session behavior is tested through the script commands of `e2e/fake-sdk.ts` (list in `docs/ARCHITECTURE.md`). A UI or agent-behavior change needs an e2e test.
- E2e specs share one server: assert only on your own temp folders and workspaces, never on global lists.
- Voice input is off by default; e2e and unit tests run it with `JARVIS_VOICE=1 JARVIS_VOICE_CMD="node e2e/fake-voice.ts"`, never real Python or models. Capture is stubbed too: `JARVIS_VOICE_CAPTURE_CMD="node e2e/fake-capture.ts"` stands in for `pw-record` (tests only), so no PipeWire or microphone is needed.
- Tests never use the real API or `~/.local/share/jarvis`. CI (`.github/workflows/ci.yml`) runs check, test and e2e.
- Node 24 runs `.ts` directly: erasable TypeScript only, no build step. The UI is one file, `public/index.html`.
- Keep the invariants: never lose user work, event log is the source of truth, loopback only with the Origin check.
- Update `README.md` (users) and `docs/ARCHITECTURE.md` (developers) when behavior changes.
