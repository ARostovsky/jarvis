[![CI](https://github.com/ARostovsky/jarvis/actions/workflows/ci.yml/badge.svg)](https://github.com/ARostovsky/jarvis/actions/workflows/ci.yml)

# Jarvis

**One AI manager that runs a team of AI coding agents, and a live map where you watch them work.**

Describe a goal in plain words. Jarvis splits it into tasks, hands each to its own [Claude Code](https://claude.com/claude-code) agent, and shows the whole team on screen: who works on what, what it costs, and when someone needs your OK. Jarvis never edits code, and asks an independent read-only Opus advisor before it hands a hard decision to you.

![Jarvis splits a goal into tasks, hires agents and a lead with its own helpers, and asks for approval when needed](docs/screenshots/demo.webp)

## Quick start

Needs Linux or macOS, **Node.js 24+**, **git**, and Claude Code set up so that `claude` works in your terminal (agents reuse its login, API key or proxy).

```bash
git clone https://github.com/ARostovsky/jarvis.git
cd jarvis
npm install
ln -s "$PWD/bin/jarvis.mjs" ~/.local/bin/jarvis   # once; any folder in your PATH works

jarvis            # starts the server in the background, opens http://127.0.0.1:7777
```

Also `jarvis stop|restart|status|logs`; foreground: `npm start`. Then click **NEW WORKSPACE**, name it, optionally give the path to your git project, and describe a goal in the Jarvis chat.

![Jarvis in the center, agents around it, Jarvis's chat on the right](docs/screenshots/hero.png)

## Features

- **Live map.** Jarvis in the center, agents around it, one tab per workspace. Color shows state: working, idle, waiting for approval, error, stopped.
- **Safe by default.** Each agent works in its own git worktree on `jarvis/<agent-id>`; you review and merge. Nothing is lost silently, workspaces are archived, not deleted.
- **Approvals.** Agents run in Claude Code's `auto` mode; only what its classifier cannot decide shows up as an ALLOW / DENY card.
- **Teams.** Jarvis picks the cheapest fitting model per task; leads hire helpers; big teams fold into `+N` badges.
- **Costs.** Cost per agent and workspace, COMPACT and RESET for long contexts, nothing stopped automatically.
- **Notes folder.** Optional shared markdown folder Jarvis keeps current and commits to git.
- **Jobs panel.** Long jobs (CI, training, deploys) show above Jarvis's chat, polled by small approved scripts called status providers: no agent and no tokens per poll. With several providers the panel has one tab per provider, with failed and running counts; a tab lights up when its jobs changed since you last opened it. Drag a tab, or press Alt+Left or Alt+Right on it, to reorder the tabs; the order is kept per workspace and new providers join at the end. Jarvis hears about state changes in one batched message. See [docs/STATUS-PROVIDERS.md](docs/STATUS-PROVIDERS.md). To build one, see the [status provider skill](templates/status-provider/SKILL.md) and its [runnable examples](templates/status-provider/examples/README.md).
- **Open items panel.** With a notes folder, the workspace's `open-items.md` shows above the chat; it is read-only: tell Jarvis in chat that something is done and it edits the file.
- **Claude health dot** (bottom left): from your own agent runs plus the Claude API and Claude Code components of Anthropic's status page. Green works, amber slow or degraded API, red auth, network or server error, grey unknown (no run yet).
- **Local only.** Listens on `127.0.0.1`, rejects other origins; every event is on disk, so restarts lose nothing.

Details, screenshots and all behavior: [docs/GUIDE.md](docs/GUIDE.md).

## Voice input (optional)

Off by default. A mic button next to SEND turns speech into text with a local Whisper model (faster-whisper); audio stays on your machine and is never stored.

1. Needs Linux with PipeWire (`pw-record`) and a GPU for `large-v3` (about 4 GB VRAM; CPU falls back to a slower model).
2. Run `voice/setup.sh` (creates `voice/.venv`, fetches the models).
3. Start Jarvis with `JARVIS_VOICE=1` (`cpu` forces CPU).

Hold the mic button, `Ctrl+Space` in the input box or `Alt+V` anywhere; release to transcribe and send to the agent selected when you started (`JARVIS_VOICE_AUTOSEND=0` puts the text into the input box instead). Cancel with `Esc`, a short press (under 0.4 s), or by dragging the pointer away from the button before releasing. Bias recognition toward your own terms with `JARVIS_VOICE_PROMPT` (appended to a built-in list; `JARVIS_VOICE_PROMPT_DEFAULT=0` drops the built-in list). More in [docs/GUIDE.md](docs/GUIDE.md#voice-input-optional).

## Settings

All optional, set as environment variables before `jarvis` or `npm start`. Data lives in `~/.local/share/jarvis/` (or `$XDG_DATA_HOME/jarvis`).

| Variable | Default | What it does |
|----------|---------|--------------|
| `PORT` | `7777` | Web UI port |
| `JARVIS_AGENT_MODEL` | `sonnet` | Default model for new agents |
| `JARVIS_ARBITER_MODEL` | `sonnet` | Jarvis model |
| `JARVIS_PERMISSION_MODE` | `auto` | `auto`, `acceptEdits`, `default`, ... |
| `JARVIS_PLAYWRIGHT` | `1` | Headless browser for each agent; `headed` shows windows; `0` turns it off |
| `JARVIS_VOICE` | unset (off) | `1` turns voice input on, `cpu` forces CPU |
| `JARVIS_VOICE_AUTOSEND` | `1` | `0` inserts the transcript into the input box instead of sending it |
| `JARVIS_JOBS` | `1` | `0` turns off the Jobs panel, its tools and prompt text |
| `JARVIS_OPEN_ITEMS` | `1` | `0` turns off the Open items panel and its prompt text |

The full list (effort, plugins, reset bounds, Claude binary, providers folder, every voice variable) is in [docs/GUIDE.md](docs/GUIDE.md#settings).

## Develop

`npm run check` (tsc), `npm test`, `npm run e2e` (Playwright with a fake SDK, no API calls). Internals, the HTTP API and recipes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Token report

`node scripts/token-report.ts [dataDir]` prints tokens, cost and context size per agent from the event logs, to compare consumption before and after a change.

## License

[MIT](LICENSE)
