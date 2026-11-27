---
name: job-source
description: Build a job source for a kind of long job (CI runs, Kubernetes jobs, training, deploys, pipeline runs): a small deterministic, read-only program that prints job status as JSON, so Jarvis shows it in a panel above its chat and nobody (no person, no model) has to poll it. Use when asked to "make a status view / job source for X" or to stop checking a job by hand.
---

# Build a job source

A job source is a folder with `manifest.json` and a small program. Jarvis runs the program on an interval with job ids and reads one JSON object from its stdout. This file is enough to build one. Longer reference: `<jarvis repo>/docs/JOB-SOURCES.md` (`<jarvis repo>` is the folder that holds `bin/jarvis.mjs`).

## Contract (schema v1)

**How Jarvis calls the program.** `manifest.command` + `manifest.args`. `{ids}` expands to one argv entry per id, one call for all ids. `{id}` makes one call per id (max 4 at once). No shell, argv only. cwd is the job source folder. Env is a minimal base (`PATH`, `HOME`, `USER`, `LANG`, `TZ`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `SSL_CERT_FILE`, `HTTPS_PROXY`, `NO_PROXY`; no `HTTP_PROXY`), plus `env.pass` names, plus `env.set`, plus `JARVIS_STATUS_SCHEMA=1`. A slow run adds `--fields cost` (the `slow_fields` keys) to the same argv.

**What the program prints.** Exactly one JSON object on stdout, exit code 0. Non-JSON stdout fails the poll with "output is not a JSON object". Exit != 0 or a timeout fails it too, and the last stderr line (300 chars) becomes the error. Failed polls back off 1x, 2x, 4x `pollS` (max 5 min). Stdout max 2 MB.

```json
{"schema": 1, "checked": "2026-11-25T14:05:12Z", "rows": [
  {"id": "run-42", "label": "nightly-train", "state": "running", "detail": "running",
   "step": "evaluate", "progress": {"done": 3, "total": 7},
   "startedAt": "2026-11-25T08:12:40Z", "finishedAt": null,
   "link": "https://dashboard.example/runs/run-42", "costUsd": 12.4}]}
```

| Field | Rule |
|---|---|
| top `schema` | required, `1` |
| top `checked` | optional ISO 8601 UTC |
| top `error`, `errorKind` | whole-run failure you caught (login, network); `rows` may be `[]`. `errorKind`: `auth`, `network` or `other`; the UI then shows the manifest `needs` |
| row `id` | required, one of the asked ids (other rows are dropped) |
| row `state` | required: `queued`, `running`, `waiting` (a person or outside event is needed), `done`, `failed`, `stopped`, `unknown`. Terminal: `done`, `failed`, `stopped`. Anything else becomes `unknown` |
| row `label`, `step`, `detail`, `error` | strings, max 200 (`detail` and `error` 300). `detail` is the raw status or reason; `error` is a per-id failure (unknown id) |
| row `progress` | `{"done": n, "total": n}`, numbers >= 0, `total` optional |
| row `startedAt`, `finishedAt` | ISO 8601 UTC or null. Never print a duration: the UI computes it |
| row `link` | http(s) URL only, else dropped |
| row `costUsd` | finite number >= 0, or null. Slow field by convention |

Rules: unknown fields are ignored. At most 200 rows. Output is shown as text and written to the event log: no secrets in it. In a fast run, fields named in `slow_fields` are dropped with a warning. In a slow run (`--fields`), only `id` and the asked fields are kept: `state` is dropped silently, any other field (also `error`) with a warning.

**Manifest.** Full example: `manifest.example.json`.

| Field | Default and limits |
|---|---|
| `schema` | required, `1` |
| `name` | required, `^[a-z0-9][a-z0-9-]{0,39}$`, equals the folder name |
| `kind` | `jobs` (the only one) |
| `description` | required, one line |
| `command` | required argv. A relative entry is a file of the folder (it is hashed); others come from `PATH`. Never `claude` |
| `args` | `["{ids}"]`; exactly one of `{ids}` or `{id}` |
| `cwd` | default: the job source folder. Leave it unset: a project folder, notes folder or worktree is refused or warned |
| `pollS` | 60, clamped 15..3600 |
| `timeoutS` | 60, clamped 5..300; the child is killed after it |
| `slow_fields` | none. `{"cost": "30m"}`: key = row field (`cost` means `costUsd`; also `label`, `detail`, `step`, `progress`, `startedAt`, `finishedAt`, `link`, `error`; never `id` or `state`). Value `15m`..`60m`, clamped (not refused); `null` or `true` = `30m` |
| `idPattern` | default `^[A-Za-z0-9][A-Za-z0-9._:/@#=+-]{0,199}$`; yours can only narrow it. Make it strict: it is your input check |
| `maxIds` | 50, clamped 1..200 |
| `env.pass` | names taken from the server env. `ANTHROPIC_*` and `CLAUDE*` are refused |
| `env.set` | fixed values (shown on the approval card, no secrets). Refused: `ANTHROPIC_*`, `CLAUDE*`, `PATH`, `PYTHONPATH`, `PYTHONHOME`, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, `DYLD_*` and similar |
| `needs` | list of human prerequisites ("VPN", "gh login"), shown with errors |
| `notify` | `any` (default), `terminal`, `failed`, `none`: when the arbiter is told about a change |
| `screenshot` | optional relative image path in the folder. The manifest member is not hashed; the image file is, so replacing it needs re-approval |

**Folder limits.** Regular files only, no symlinks, at most 50 files and 1 MB, no `.venv`, `node_modules`, `__pycache__`.

**Where it goes.** Build it in `<your worktree>/job-sources/<name>/`, outside any notes folder and project folder. Installed job sources live in `~/.config/jarvis/job-sources/<name>/` (`$JARVIS_JOB_SOURCES_DIR`); only the user installs, by approving in the UI.

## Examples (run them first, copy the closest)

In `examples/` next to this file, each with `manifest.json`:
- `http-up/`: shell + `curl`, ids are host names. Smallest case.
- `json-file/`: Python stdlib, reads a JSON file, state map, progress, slow `cost` field, per-id error.
- `github-prs/`: Python + `gh api graphql`, ids are PR numbers, `env.set` for the repo, `errorKind` from the error text.

Check one: `node <jarvis repo>/bin/jarvis.mjs job-source-check <folder> <id> ...`. See `examples/README.md`.

## Pitfalls

- A slow run that prints `error` or other fields outside `--fields` gets warnings (`state` is dropped silently). Print only `id` and the asked fields.
- Printing logs or progress bars on stdout breaks the JSON. Send them to stderr, or print nothing.
- `"command": ["check.sh"]` without the exec bit fails with `spawn ... EACCES`. Use `["sh", "x.sh"]` or `["python3", "x.py"]`, or `chmod +x`.
- Missing id in the output gives the warning `no row for asked id`. Always print a row per id, with `error` for an unknown one.
- An id is passed as argv: validate it with `idPattern`, and never splice it into a shell string or JSON by hand unless the pattern forbids quotes and backslashes (`http-up` relies on that).
- A hard-coded user value (repo, project, namespace) in the code is wrong: put it in `env.set`.
- Print times as ISO 8601 UTC with `Z`, never local times.
- Do not call `claude`, an LLM or a login command. On auth failure print top-level `error` with `errorKind: "auth"`.
- `job-source-check` skips the location rules and approval. A folder inside a project, notes folder or worktree is refused later by the server.

## Hard rules

- **Deterministic.** The status path is a script only: no LLM call, no agent, no `claude`, nothing that needs a model to read or format the result. The same input gives the same output.
- **Read-only.** Never start, stop, retry or change a job. Never log in: on an auth failure print a top-level `error` with `errorKind: "auth"`.
- **No secrets** in the output, in `manifest.json` or in the code. Credentials come from the user's existing login or config (CLI config files, env names listed in `env.pass`).
- **Self-contained folder:** no symlinks, no `.venv` or `node_modules` inside, at most 50 files, under 1 MB. Dependencies come from the system or a tool cache, pinned by version (`uv run --no-project --with <pkg>==<version>`, `npx -y <pkg>@<version>`).
- **No user or project values in the code.** URLs, workspace or project names, namespaces and project ids go to `manifest.json` `env.set`, so the same code works for another user.
- **Not in a project.** Do not point `cwd` at a project folder, a notes folder or a worktree, and do not import from one. Jarvis refuses notes folders and worktrees and shows a warning for project folders.
- Fresh work: build from these steps. Existing scripts, skills and notes of the project are sources of facts (how status is read, ids, links). Do not edit or replace them.

## Steps

1. **Discover how status is checked today.** Look in your task, in the project's notes (README, status, CLAUDE.md, journal), its skills (`.claude/skills/`) and its scripts for how the user checks this kind of job: a CLI (`gh run view`, `kubectl get job`, a vendor CLI), a client library, a REST API, a dashboard, a log or status file. Write down:
   - what a job id looks like, with two real examples (one finished, one running if possible);
   - where state, current step, progress, start and end time, link and cost (if any) come from;
   - which login, config, VPN or network the check needs;
   - how long one check takes;
   - which numbers change slowly or are costly to read (cost, totals from logs) and how often they need a refresh.

   Ask the task giver (or the user) which numbers change slowly (cost etc.) and how often to refresh them. Offer cost every 30 min as the default (15 to 60 min allowed). If the job has no such numbers, skip the slow fields.

   An existing script is the best source of logic, but do not copy its display choices (time zone, duration text, Markdown tables) or its location.
2. **Map the states.** Write a table from every source state to `queued | running | waiting | done | failed | stopped | unknown`. Look for final states that hide a failed part, such as a run "completed" with a failed step, or a workflow "success" with an allowed failure. Map them to `failed` and name the part in `detail`. Unmapped states become `unknown`, never a guess.
3. **Write the program** in a new folder `<your worktree>/job-sources/<name>/` (`name`: lower case, digits, dashes, named after the job kind or tool). Start from the closest folder in `examples/` or from `job_source_example.py`, or write the same in any language. It must:
   - take the ids as arguments (or one id, if you use `{id}`);
   - if the manifest has `slow_fields`, accept `--fields <names>` (comma separated): with it, print rows with `id` and only those fields; without it, leave the slow fields out;
   - print exactly one JSON object with `"schema": 1`;
   - print times as ISO 8601 UTC, never a duration;
   - put per-id failures into that row's `error`;
   - catch whole-run failures (auth, network) as top-level `error` and `errorKind`;
   - exit non-zero only on a bug;
   - check all ids in seconds, not minutes.
4. **Write `manifest.json`** from `manifest.example.json`:
   - `description`; `command`, with files relative to the folder; `args`;
   - `pollS`: as slow as the user can accept; 60 s is a good default, longer for slow or rate-limited sources;
   - `timeoutS`; a strict `idPattern` from step 1; `env.pass` and `env.set`;
   - `slow_fields`: the slow numbers and their refresh intervals from step 1, e.g. `{"cost": "30m"}` (15m to 60m);
   - `needs`: what the user must have, e.g. VPN or a login; `notify` (default `any`).
5. **Test on real jobs.** Run `jarvis job-source-check <folder> <id> ...` (from the Jarvis repo: `node <jarvis repo>/bin/jarvis.mjs job-source-check ...`):
   - with at least one finished job and, if one exists, one running job, read only;
   - once with a bogus id;
   - the check also runs the slow mode (`--fields cost`) when the manifest has `slow_fields`; read its output too;
   - once without the login or network, if you can do that without changing the user's setup.

   Fix and repeat until it passes, and explain any warning you leave. Compare by hand: state, step and link must match what the user sees in the source.
6. **Screenshot (optional, only if you can run Jarvis).** Rows reach the panel only through the arbiter tool `watch_jobs`, and a builder agent has no such tool, so skip this step unless your session can run a separate Jarvis and drive its arbiter. If it can: start it (`XDG_DATA_HOME=<empty temp dir> XDG_CONFIG_HOME=<temp dir> JARVIS_JOB_SOURCES_DIR=<temp dir with a copy of your folder> PORT=<spare port> node <jarvis repo>/src/server.ts`; never the user's instance on 7777), approve the copy in its Job sources dialog, have its arbiter call `watch_jobs` with test ids, open it with a headless browser (e.g. Playwright) and save the panel as `screenshot.png` (png, webp or jpg, under 1 MB) in the job source folder. No real secrets, ids or private project data in the picture. Set `"screenshot": "screenshot.png"` in `manifest.json`. Jarvis only displays it. The image file is part of the approval hash, so a later change of the picture needs re-approval. Otherwise skip this step.
7. **Report.** Your final message: the VERDICT line, the folder path, the job source name, the `job-source-check` report of the real-job run, the state map and the `needs`. Do not install anything. The arbiter proposes your folder with `propose_job_source` (name, absolute folder path, your report); an approval card appears and only the user approves it in the Jarvis UI. Outside Jarvis, tell the user to copy the folder into `~/.config/jarvis/job-sources/` (or `$JARVIS_JOB_SOURCES_DIR`) and approve it in the Job sources dialog.
