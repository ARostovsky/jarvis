---
name: status-provider
description: Build a status provider for a kind of long job (CI runs, Kubernetes jobs, training, deploys, pipeline runs): a small deterministic, read-only program that prints job status as JSON, so Jarvis shows it in a panel above its chat and nobody (no person, no model) has to poll it. Use when asked to "make a status view / status provider for X" or to stop checking a job by hand.
---

# Build a status provider

A status provider is a folder with `manifest.json` and a small program. Jarvis runs it on an interval with job ids and reads one JSON object from its stdout. The full contract (schema v1, manifest, rules) is in `<jarvis repo>/docs/STATUS-PROVIDERS.md`: read it before you start. A skeleton is next to this file: `status_provider_example.py` (prints valid schema v1 from a dict) and `manifest.example.json`.

Hard rules:
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
3. **Write the program** in a new folder `<your worktree>/status-providers/<name>/` (`name`: lower case, digits, dashes, named after the job kind or tool). Start from `status_provider_example.py`, or write the same in any language. It must:
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
5. **Test on real jobs.** Run `jarvis provider-check <folder> <id> ...` (from the Jarvis repo: `node <jarvis repo>/bin/jarvis.mjs provider-check ...`):
   - with at least one finished job and, if one exists, one running job, read only;
   - once with a bogus id;
   - the check also runs the slow mode (`--fields cost`) when the manifest has `slow_fields`; read its output too;
   - once without the login or network, if you can do that without changing the user's setup.

   Fix and repeat until it passes, and explain any warning you leave. Compare by hand: state, step and link must match what the user sees in the source.
6. **Report.** Your final message: the VERDICT line, the folder path, the provider name, the `provider-check` report of the real-job run, the state map and the `needs`. Do not install anything. Jarvis proposes the folder (`propose_provider`), and only the user approves it in the Jarvis UI. Outside Jarvis, tell the user to copy the folder into `~/.config/jarvis/status-providers/` (or `$JARVIS_PROVIDERS_DIR`) and approve it in the Providers dialog.
