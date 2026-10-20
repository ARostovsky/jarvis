# jarvis

One arbiter agent that spawns, steers and watches other Claude Code agent sessions. Built on the Claude Agent SDK.

## Run

```bash
npm install
npm run cli      # console client (stage 1)
npm run check    # typecheck
```

Node 24+ runs the `.ts` files directly, so there is no build step. Auth and proxy come from `~/.claude/settings.json` through `settingSources: ['user']`.

## How it works

- `src/agents.ts` keeps one long-lived SDK session per agent and feeds it messages through an inbox.
  - The arbiter gets the MCP tools `spawn_agent`, `send_to_agent`, `list_agents` and `stop_agent`.
  - When a worker finishes a turn, its result is sent to the arbiter automatically.
- Workers run in `worktrees/<id>`. If `repo` is a git repo, this is a git worktree on branch `jarvis/<id>`.
- Permissions: workers use `acceptEdits`. Every other prompt becomes an `ask` event, which you answer with `/y <id>` or `/n <id>` in the CLI.
- Every change goes out as an event on `bus`: `spawned`, `status`, `text`, `tool`, `routed`, `ask`, `result`. The web UI will consume these events.
