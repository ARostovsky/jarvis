# jarvis

One arbiter agent that spawns, steers and watches other Claude Code agent sessions. Built on the Claude Agent SDK.

## Run

```bash
npm install
npm start        # web UI at http://127.0.0.1:7777
npm run cli      # console client
npm run check    # typecheck
```

Node 24+ runs the `.ts` files directly, so there is no build step. Agents take only `apiKeyHelper`, `env` and `model` from `~/.claude/settings.json`, which is enough for an auth proxy. They also load the repo's own settings and CLAUDE.md (`settingSources: ['project', 'local']`). Your user plugins and hooks are deliberately not loaded: with them, every turn costs about 5x more tokens.

## How it works

- `src/agents.ts` keeps one long-lived SDK session per agent and feeds it messages through an inbox. A session starts lazily on the first message.
  - The arbiter gets the MCP tools `spawn_agent`, `send_to_agent`, `list_agents`, `read_agent` and `stop_agent`.
  - Top-level agents get the same tools, scoped to their own sub-agents (max depth 2). Sub-agents of a git agent default to the same repo, each on its own branch.
  - Every agent has a shared board with `board_post` (to agent ids or names, or `"all"`) and `board_read`. Unseen notes addressed to an agent are prepended to the next message it receives, so they arrive without interrupting its current turn.
  - When an agent finishes a turn, its result is sent to its parent automatically. The report is capped at 2000 characters, and the parent can fetch the full text with `read_agent`.
- Deleting an agent stops it and removes its own workdir. If a git worktree has uncommitted changes, the server answers 409 and the UI asks you to choose: commit the changes to the agent's branch, or discard them. The `jarvis/<id>` branch is kept either way. An agent that still has sub-agents cannot be deleted.
- Runtime data lives in `~/.local/share/jarvis/` (or `$XDG_DATA_HOME/jarvis`): `arbiter/` is the arbiter's own empty working dir, `state/events.jsonl` is the event log, and `worktrees/<id>` holds the agents' workdirs. Agents work in the repo you name in the task.
- Workers run in `worktrees/<id>`. If `repo` is a git repo, this is a git worktree on branch `jarvis/<id>`.
- Permissions: workers use `acceptEdits`. Every other prompt becomes an `ask` event, which you answer with `/y <id>` or `/n <id>` in the CLI.
- Every change goes out as an event on `bus`: `spawned`, `status`, `text`, `delta` (streamed text), `tool`, `routed`, `ask`, `answered`, `result`, `session`.
- Persistence: every event except `delta`, `ask` and `answered` is appended to `state/events.jsonl`. When the server restarts, it replays this log to rebuild the agents and their logs. An agent's next message resumes its SDK session (`resume: sessionId`), so it keeps its conversation. Asks that were pending when the server stopped are dropped. To start fresh, delete `~/.local/share/jarvis/state/`.

## Web UI

`src/server.ts` serves `public/index.html`, which is one file with no build step.
- Events stream over SSE at `GET /events`. On connect the server first sends a snapshot of the agents and any pending asks.
- Commands are JSON POSTs: `/say` (to the arbiter), `/send` (directly to an agent), `/answer` (approve or deny an ask), `/stop`, `/delete` (`dirty: 'commit' | 'discard'`) and `/board` (a note from the user).
- The server binds to 127.0.0.1 only. POST requests are rejected unless the `Origin` is the page itself, so other websites cannot drive your agents.

On screen, the arbiter is the core in the center, with agents on a ring around it.
- Node color shows status: cyan = running, dim = idle, amber = waiting for your approval, red = error, gray = stopped.
- A pulse travels along a link whenever a message passes between two sessions.
- Under each node is either the agent's current tool or its streaming text.
- Click a node to open its log, where you can watch replies as they stream and message the agent directly. While the panel is open, the graph is re-centered in the space to the left of it.
- Sub-agents fan out from their parent. Board notes show as violet pulses from the sender to each recipient.
- The view matches the window's shape and auto-fits the graph until you pan or zoom.
- Drag the background to pan and use the wheel to zoom. Drag a node to move it; positions are saved in localStorage. Double-click the background to reset the view and positions.
- Ask cards appear bottom-left.
