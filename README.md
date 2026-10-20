# jarvis

One arbiter agent that spawns, steers and watches other Claude Code agent sessions. Built on the Claude Agent SDK.

## Run

```bash
npm install
npm start        # web UI at http://127.0.0.1:7777
npm run cli      # console client
npm run check    # typecheck
```

Node 24+ runs the `.ts` files directly, so there is no build step. Auth and proxy come from `~/.claude/settings.json` through `settingSources: ['user']`.

## How it works

- `src/agents.ts` keeps one long-lived SDK session per agent and feeds it messages through an inbox.
  - The arbiter gets the MCP tools `spawn_agent`, `send_to_agent`, `list_agents` and `stop_agent`.
  - When a worker finishes a turn, its result is sent to the arbiter automatically.
- Workers run in `worktrees/<id>`. If `repo` is a git repo, this is a git worktree on branch `jarvis/<id>`.
- Permissions: workers use `acceptEdits`. Every other prompt becomes an `ask` event, which you answer with `/y <id>` or `/n <id>` in the CLI.
- Every change goes out as an event on `bus`: `spawned`, `status`, `text`, `tool`, `routed`, `ask`, `answered`, `result`.

## Web UI

`src/server.ts` serves `public/index.html`, which is one file with no build step.
- Events stream over SSE at `GET /events`. On connect the server first sends a snapshot of the agents and any pending asks.
- Commands are JSON POSTs: `/say` (to the arbiter), `/send` (directly to an agent), `/answer` (approve or deny an ask) and `/stop`.
- The server binds to 127.0.0.1 only. POST requests are rejected unless the `Origin` is the page itself, so other websites cannot drive your agents.

On screen, the arbiter is the core in the center, with agents on a ring around it.
- Node color shows status: cyan = running, dim = idle, amber = waiting for your approval, red = error, gray = stopped.
- A pulse travels along a link whenever a message passes between two sessions.
- Click a node to see its log and message it directly. Ask cards appear bottom-left.
