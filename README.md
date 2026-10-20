# jarvis

One arbiter agent that spawns, steers and watches other Claude Code agent sessions. Built on the Claude Agent SDK.

## Run

```bash
npm install
ln -s "$PWD/bin/jarvis.mjs" ~/.local/bin/jarvis   # once

jarvis            # start the server in the background (if not running) and open the UI
jarvis stop | restart | status | logs
```

The server logs to `~/.local/share/jarvis/server.log`. `npm start` runs it in the foreground instead, and `npm run check` runs the typecheck.

Node 24+ runs the `.ts` files directly, so there is no build step. Agents take only `apiKeyHelper`, `env` and `model` from `~/.claude/settings.json`, which is enough for an auth proxy. They also load the repo's own settings and CLAUDE.md (`settingSources: ['project', 'local']`). Your user plugins and hooks are deliberately not loaded: with them, every turn costs about 5x more tokens.

## How it works

- `src/agents.ts` keeps one long-lived SDK session per agent and feeds it messages through an inbox. A session starts lazily on the first message.
  - The arbiter gets the MCP tools `spawn_agent`, `send_to_agent`, `list_agents`, `read_agent` and `stop_agent`.
  - Top-level agents get the same tools, scoped to their own sub-agents (max depth 2). Sub-agents of a git agent default to the same repo, each on its own branch.
  - Every agent has a shared board with `board_post` (to agent ids or names, or `"all"`) and `board_read`. Unseen notes addressed to an agent are prepended to the next message it receives, so they arrive without interrupting its current turn.
  - When an agent finishes a turn, its result is sent to its parent automatically. The report is capped at 2000 characters, and the parent can fetch the full text with `read_agent`.
- Deleting an agent stops it and removes its own workdir. If a git worktree has uncommitted changes, the server answers 409 and the UI asks you to choose: commit the changes to the agent's branch, or discard them. The `jarvis/<id>` branch is kept either way. An agent that still has sub-agents cannot be deleted.
- Workspaces: each UI tab is an independent workspace with its own arbiter, agents, board and event log. A workspace can have a project folder, which becomes the default repo for the arbiter's agents. The list of workspaces is kept in `workspaces.json`.
- Right-click a tab for Rename, Stop all agents and Archive workspace. Double-clicking a tab also renames it. Right-clicking an agent node gives Open log, Stop and Delete; right-clicking the arbiter core gives Stop all agents. Stopping an agent also drops its pending permission prompts.
- Deleting a workspace is archiving, and it is designed to lose nothing:
  - It is refused while any agent is running or waiting for your approval.
  - Uncommitted changes in agent worktrees are listed. The only way forward is to commit them to each agent's own `jarvis/<id>` branch; to discard changes, delete those agents one by one first.
  - Clean git worktrees are then removed, and their branches are kept. Plain (non-git) workdirs move into the archive together with the event log.
  - If git refuses to remove a worktree partway through, everything already removed is put back and the workspace stays active.
  - The project folder is never touched.
  - The workspace moves to `archive/<id>/`. Restoring it (the `ARCHIVE n` button) re-creates the worktrees from their branches and keeps the agents' conversations.
  - There is no permanent delete in the UI: to purge, remove `archive/<id>/` and the `jarvis/*` branches by hand.
- Runtime data lives in `~/.local/share/jarvis/` (or `$XDG_DATA_HOME/jarvis`):
  - `workspaces/<id>/arbiter/` is the arbiter's own empty working dir;
  - `workspaces/<id>/events.jsonl` is the workspace's event log;
  - `worktrees/<id>` holds the agents' workdirs. Agents work in the repo named in the task, or in the workspace project.
- Workers run in `worktrees/<id>`. If `repo` is a git repo, this is a git worktree on branch `jarvis/<id>`.
- Permissions: agents run in Claude Code's `auto` mode by default. A classifier approves safe calls on its own, and only what it can't decide becomes an `ask` card in the UI. Override with `JARVIS_PERMISSION_MODE` (`acceptEdits`, `default`, ...).
- Every change goes out as an event on `bus`: `spawned`, `status`, `text`, `delta` (streamed text), `tool`, `routed`, `ask`, `answered`, `result`, `session`.
- Persistence: every event except `delta`, `ask` and `answered` is appended to the workspace's `events.jsonl`. When the server restarts, it replays this log to rebuild the agents and their logs. An agent's next message resumes its SDK session (`resume: sessionId`), so it keeps its conversation. Asks that were pending when the server stopped are dropped. To reset a workspace, delete its `workspaces/<id>/` folder.

## Web UI

`src/server.ts` serves `public/index.html`, which is one file with no build step.
- `GET /workspaces` returns `{workspaces, archived}`, the tabs with their running and waiting counts. `POST /workspaces {name, project?}` creates one; `/workspaces/rename {ws, name}`, `/workspaces/archive {ws, commit?}` and `/workspaces/restore {id}` handle the rest. `/stopall {ws}` stops every agent in a workspace.
- Events stream over SSE at `GET /events?ws=<id>`. On connect the server first sends a snapshot of the agents and any pending asks.
- Commands are JSON POSTs that carry `ws`: `/say` (to the arbiter), `/send` (directly to an agent), `/answer` (approve or deny an ask), `/stop`, `/delete` (`dirty: 'commit' | 'discard'`) and `/board` (a note from the user).
- The server binds to 127.0.0.1 only. POST requests are rejected unless the `Origin` is the page itself, so other websites cannot drive your agents.

On screen, the arbiter is the core in the center, with agents on a ring around it.
- Node color shows status: cyan = running, dim = idle, amber = waiting for your approval, red = error, gray = stopped.
- A pulse travels along a link whenever a message passes between two sessions.
- Under each node is either the agent's current tool or its streaming text.
- Drag the left edge of the log panel to make it wider or narrower. The width is remembered, and double-clicking the edge resets it.
- There is no separate input bar: the side panel is the chat. It opens on the arbiter, clicking a node switches it to that agent, Esc closes it, and Enter or `/` brings back the arbiter chat.
- Click a node to open its log, where you can watch replies as they stream and message the agent directly. While the panel is open, the graph is re-centered in the space to the left of it.
- Sub-agents fan out from their parent. Board notes show as violet pulses from the sender to each recipient.
- The view matches the window's shape and auto-fits the graph until you pan or zoom.
- Drag the background to pan and use the wheel to zoom. Drag a node to move it; positions are saved in localStorage. Double-click the background to reset the view and positions.
- Ask cards appear bottom-left.
