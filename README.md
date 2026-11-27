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

- **Live map.** Jarvis in the center, agents around it, one tab per workspace, color shows state. [Details](docs/USAGE.md#what-you-see)
- **Safe by default.** Each agent works in its own git worktree; you review and merge; nothing is lost silently. [Details](docs/USAGE.md#safety)
- **Approvals.** Only what Claude Code's `auto` classifier cannot decide shows up as an ALLOW / DENY card. [Details](docs/USAGE.md#approvals)
- **Teams.** Jarvis picks the cheapest fitting model per task; leads hire helpers. [Details](docs/USAGE.md#big-teams)
- **Costs.** Cost per agent and workspace, COMPACT and RESET for long contexts. [Details](docs/USAGE.md#costs)
- **Notes folder.** Optional shared markdown folder Jarvis keeps current and commits to git. [Details](docs/NOTES.md)
- **Connections.** Your Anthropic login or a company gateway such as LiteLLM, per workspace. [Details](docs/USAGE.md#connections)
- **Jobs panel.** Long jobs (CI, training, deploys) polled by small approved scripts, with no tokens per poll. [Details](docs/USAGE.md#panels-and-jobs), [contract](docs/JOB-SOURCES.md), [skill](templates/job-source/SKILL.md) and [examples](templates/job-source/examples/README.md)
- **Voice input** (optional, off by default). Push-to-talk with a local Whisper model. [Details](docs/VOICE.md)
- **Open items panel.** The workspace's `open-items.md` above the chat, read-only. [Details](docs/NOTES.md#open-items)
- **Telegram** (optional, off by default). Talk to Jarvis from your phone: a topic per workspace in your private group. [Details](docs/TELEGRAM.md)
- **Claude health dot** (bottom left). Whether your Claude access works. [Details](docs/USAGE.md#claude-health-dot)
- **Local only.** Listens on `127.0.0.1`, every event is on disk. [Details](docs/USAGE.md#safety)

Details, screenshots and all behavior: [docs/USAGE.md](docs/USAGE.md).

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

The full list (effort, plugins, reset bounds, Claude binary, job sources folder, every voice variable) is in [docs/USAGE.md](docs/USAGE.md#settings) and [docs/VOICE.md](docs/VOICE.md#configuration).

## Develop

`npm run check` (tsc), `npm test`, `npm run e2e` (Playwright with a fake SDK, no API calls). Internals, the HTTP API and recipes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Token report

`node scripts/token-report.ts [dataDir]` prints tokens, cost and context size per agent from the event logs, to compare consumption before and after a change.

## License

[MIT](LICENSE)
