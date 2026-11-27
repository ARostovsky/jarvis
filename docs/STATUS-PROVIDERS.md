# Status providers

A status provider is a small program that reads the state of long jobs (CI runs, training, deploys, pipeline runs) and prints it as JSON. Jarvis runs it on an interval and shows the result in a panel above the arbiter chat. No person and no model polls the job.

This page is the contract (schema v1). `templates/status-provider/SKILL.md` repeats the contract for builder agents: change both together. A ready skeleton and an agent skill that builds providers are in [`templates/status-provider/`](../templates/status-provider/).

## Contents

- [How it works](#how-it-works)
- [Invocation](#invocation)
- [Output](#output)
- [Manifest](#manifest)
- [Run modes: fast and slow](#run-modes-fast-and-slow)
- [Where providers live](#where-providers-live)
- [Approval](#approval)
- [Location rules](#location-rules)
- [Security limits](#security-limits)
- [Examples](#examples)

## How it works

1. A provider is a folder with `manifest.json` and a program.
2. The user approves the folder once, in the Jarvis UI. Approval pins the exact files by hash.
3. The arbiter passes job ids to the server (`watch_jobs`). The server runs the provider on the manifest interval with those ids.
4. The server validates the output and shows it in the Jobs panel. The arbiter is told about state changes in one batched `[jobs]` message per poll, never one LLM turn per poll.

## Invocation

- The server runs `manifest.command` plus `manifest.args` with the template filled in. `{ids}` expands to one argv entry per id (one call for all ids). `{id}` means one call per id, at most 4 in parallel. There is no shell, only argv.
- cwd: the provider folder, unless the manifest sets `cwd` (see [Location rules](#location-rules)).
- Env: a minimal base (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `TZ`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `SSL_CERT_FILE`, `HTTPS_PROXY`, `NO_PROXY`), plus the names in `env.pass`, plus `env.set`, plus `JARVIS_STATUS_SCHEMA=1`. No other server env (no `ANTHROPIC_*`) reaches the provider.
- Timeout `timeoutS`: the child is killed after that.
- Deterministic and read-only. A provider only reads job state: no LLM call, no agent, no `claude` process. It never starts, stops, retries or changes a job, and never logs in. The approval card states this. The server refuses a manifest whose command is a `claude` binary or has a `command` entry named `claude` (best-effort check; `args` are not checked). The rest is a contract rule Jarvis cannot enforce.

## Output

One JSON object on stdout, exit code 0:

```json
{
  "schema": 1,
  "checked": "2026-11-25T14:05:12Z",
  "rows": [
    {
      "id": "run-42",
      "label": "nightly-train",
      "state": "running",
      "detail": "running",
      "step": "evaluate",
      "progress": { "done": 3, "total": 7 },
      "startedAt": "2026-11-25T08:12:40Z",
      "finishedAt": null,
      "link": "https://dashboard.example/runs/run-42",
      "costUsd": null,
      "error": null
    }
  ]
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` (top) | integer | yes | Schema major version. Jarvis knows `1`; a higher one fails the poll with "provider speaks schema N, Jarvis knows 1" |
| `checked` (top) | ISO 8601 | no | When the provider read the source; the server time is used when missing |
| `error` (top) | string | no | Whole-poll failure the provider caught itself (auth, network); `rows` may then be empty |
| `errorKind` (top) | `auth`, `network` or `other` | no | The UI then shows the manifest's `needs` hint |
| `id` | string | yes | One of the ids asked for; other rows are dropped |
| `label` | string | no | Name from the source; the `watch_jobs` label wins in the UI |
| `state` | enum | yes | `queued`, `running`, `waiting` (needs a person or an outside event), `done`, `failed`, `stopped`, `unknown`. Terminal: `done`, `failed`, `stopped` |
| `detail` | string | no | Short raw status or reason, e.g. `completed (failed: evaluate)` |
| `step` | string | no | Current step or stage |
| `progress` | `{done, total?}` | no | Steps, percent (`37/100`) or any count |
| `startedAt`, `finishedAt` | ISO 8601 or null | no | The UI computes durations; a provider never prints a ticking duration |
| `link` | string | no | http(s) only; makes the id a link |
| `costUsd` | number or null | no | Slow field by convention (`slow_fields: {"cost": ...}`; `cost` means `costUsd`). Shown with its fetch time (`$12.40 (as of 14:05)`). Not rendered when the provider has no such field or has not returned it yet |
| `error` | string | no | Per-row failure (unknown id, not found) |

Rules:

- Unknown fields are ignored. An absent field is never filled in or guessed.
- In a slow run, a field outside `--fields` is dropped. In a fast run, fields listed in `slow_fields` are dropped the same way.
- Adding an optional field is not a version change. Removing or renaming a field, adding a required one, or changing the meaning of `state` makes a new major version; Jarvis then reads the old one for at least one release.
- A non-zero exit, a timeout or stdout that is not one JSON object fails the poll. The error is the last stderr line, capped at 300 characters. Failed polls back off: 1x, 2x, 4x the interval, up to 5 minutes.
- The server validates every value at this trust boundary: string caps (200, and 300 for `detail` and `error`), an unknown `state` becomes `unknown`, a bad `link` is dropped, numbers must be finite, at most 200 rows.
- Provider output is untrusted. The UI shows it only as text. It reaches the arbiter only inside a marked, indented `[jobs]` block. It is written to the event log, so a provider must never print secrets.

## Manifest

`manifest.json`, schema v1:

```json
{
  "schema": 1,
  "name": "example",
  "kind": "jobs",
  "description": "Example jobs: state, step and progress, cost refreshed slowly",
  "command": ["python3", "status_provider_example.py"],
  "args": ["{ids}"],
  "cwd": null,
  "pollS": 60,
  "timeoutS": 60,
  "slow_fields": { "cost": "30m" },
  "idPattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
  "maxIds": 50,
  "env": { "pass": [], "set": {} },
  "needs": [],
  "notify": "any"
}
```

| Field | Default | Meaning |
|---|---|---|
| `schema` | required | `1` |
| `name` | required | `^[a-z0-9][a-z0-9-]{0,39}$`, equals the folder name |
| `kind` | `jobs` | Panel kind the output feeds. v1 accepts only `jobs`; any other value is refused |
| `description` | required | One line, shown to the user and in `list_providers` |
| `command` | required | argv. A relative entry is a file in the provider folder (hashed); other entries come from `PATH` |
| `args` | `["{ids}"]` | Template with exactly one of `{ids}` or `{id}` |
| `cwd` | provider folder | See [Location rules](#location-rules) |
| `pollS` | `60` | Fast poll interval in seconds, clamped to 15..3600 |
| `slow_fields` | none | Map of row field to refresh interval, e.g. `{"cost": "30m"}`. Key: a row field name (`cost` means `costUsd`). Value: `15m` to `60m`, clamped; `null` or `true` means the default `30m` |
| `timeoutS` | `60` | Clamped to 5..300 |
| `idPattern` | `^[A-Za-z0-9][A-Za-z0-9._:/@#=+-]{0,199}$` | Can only narrow the default: an id never starts with `-` and never holds whitespace |
| `maxIds` | `50` | Per workspace and provider, clamped to 1..200 |
| `env.pass`, `env.set` | none | Names passed through from the server env; fixed values. `set` values are shown in the approval card, so no secrets. Refused in both: `ANTHROPIC_*` and `CLAUDE*`. Also refused in `set`: `PATH`, `PYTHONPATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_PATH`, `PYTHONHOME`, `PERL5LIB`, `RUBYLIB`, `BASH_ENV`, `LD_AUDIT`, `LD_*`, `DYLD_*` |
| `needs` | none | Human prerequisites (VPN, a login), shown with errors |
| `notify` | `any` | When the arbiter is told, batched per poll: `any` (every job state change), `terminal` (only `done`, `failed`, `stopped`), `failed` (only `failed`), `none` |
| `screenshot` | none | Optional relative path of an image in the provider folder (`screenshot.png`; png, webp or jpg, at most 1 MB, no `..`, no absolute path, no symlink). Shown in the Providers dialog, never run. The `screenshot` member is not part of the approval hash, but the picture file is like any other file: changing it after approval needs a re-approval. An invalid value is ignored with a warning |

A manifest holds no values of one user in the code: URLs, project names and namespaces go to `env.set`, logic goes to the program.

## Run modes: fast and slow

- The **fast** run happens every `pollS`. It returns every field except the `slow_fields`.
- The **slow** run happens on the `slow_fields` interval. It uses the same argv with `--fields <names>` appended (e.g. `--fields cost`) and returns rows with `id` and only those fields. Same env, cwd, timeout and rules.
- The server merges slow values into the rows by id and stores the fetch time next to each value.
- A provider without `slow_fields` is never run in slow mode and needs no `--fields` support.
- Both modes are deterministic and read-only. Neither costs tokens.

## Where providers live

| Path | What |
|---|---|
| `$JARVIS_PROVIDERS_DIR`, default `$XDG_CONFIG_HOME/jarvis/status-providers/` | Installed providers, one folder per name. Shareable (dotfiles); a copied folder needs approval on each machine |
| `$DATA/providers.json` | Approvals: `{name: {sha256, approvedAt, files: [{path, size, sha256}]}}` |
| `$DATA/provider-staging/<name>-<hash16>/` | Snapshot of a proposal: the user approves exactly what will run |
| `$DATA/provider-old/<name>-<date>/` | The version a newer approval replaced |

`$DATA` is `$XDG_DATA_HOME/jarvis` (default `~/.local/share/jarvis`).

## Approval

- Folder hash: sha256 over the sorted `path NUL size NUL sha256(file)` of every file. Only regular files and folders are allowed: no symlinks, at most 50 files and 1 MB in total, no `.venv`, `node_modules` or `__pycache__`. Dependencies come from a tool cache, e.g. `uv run --with <pkg>==<version>`.
- Approval by proposal: the arbiter calls `propose_provider`. Jarvis copies the draft into staging and hashes the copy. The card shows the manifest, the files with sizes and hashes, the script text, `needs`, `env`, `cwd` warnings and the `provider-check` report. APPROVE installs the snapshot; an older version moves to `provider-old/`. REJECT drops the snapshot, and the optional reason goes to the arbiter.
- The PROVIDERS button shows the number of proposals waiting for approval; the dialog lists them. The approval card loads the provider's files first, and Approve stays off until they are on screen; the same holds for APPROVE in the dialog (FILES button). Unsaved checkboxes in the per-workspace choice survive a refresh, and ticking every box saves an empty list (all approved providers).
- A hand-placed folder shows in the Providers dialog as `not approved`. Its APPROVE button pins the folder as it is at that moment (the hash it listed; a folder that changed since answers 409). The details card (manifest, files, hashes, `provider-check` report) exists for proposals.
- Which approved providers a workspace may use is set per workspace: tab menu, **Job providers…**. No choice means all approved providers (`list_providers` and `watch_jobs` honor it).
- Before each poll the server hashes the installed folder again. On a mismatch that provider stops: its rows go stale with "provider files changed, approve again", and the arbiter is told once. The Providers dialog (and the Jobs panel note) offers APPROVE AGAIN.
- Approval happens only in the UI. No MCP tool approves or installs. Agents pass ids, never commands or paths to run.
- The card says: "Runs every N s with your rights, outside any sandbox."

## Location rules

After `realpath` (also through a symlinked parent), the server refuses to install, approve or run a provider when:

- its folder, or a relative `command` file, is inside a notes folder, a workspace project folder, `$DATA/worktrees` or `$DATA/workspaces`;
- its `cwd` is a notes folder, a worktree or inside `$DATA`;
- an `args` entry breaks the same rules: an absolute one is checked against the barred folders; a relative one with a `/` that leaves the provider folder is refused; entries starting with `-` are skipped, but the part after `=` in `--opt=/abs` is checked;
- an `env.set` value that is an absolute path (for a value with `{id}`, the literal text before the first `{`) is checked against the same barred folders, so `ZENML_PYTHON=/project/.venv/bin/python` is refused. The message names the variable: compute the path inside the script, or use a location outside project folders and the data folder. Values that are not absolute paths (URLs, plain words, `~/...`) are not checked, as for `args`.

A `cwd` inside a project folder is allowed only with a red warning in the card ("runs inside <path>, which agents may edit"). Avoid it.

## Security limits

- Interpreters, CLIs, tool caches and libraries are trusted like any program on `PATH`. They are not pinned.
- Every process of the user can write the providers folder and `$DATA`. Pinning catches changes made by mistake or by a prompt-steered agent through normal edits, at the next poll. It does not stop a hostile local process.
- The race between hash check and run is accepted.
- Provider output is untrusted input: validated, capped, shown as text, quoted in marked blocks for the arbiter.
- Settings: `JARVIS_JOBS=0` turns the feature off (nothing is spawned). `JARVIS_PROVIDERS_DIR` moves the providers folder. `JARVIS_JOBS_MIN_POLL_S` is for tests: it replaces the lower bounds of `pollS` (15 s) and of the `slow_fields` interval (15 min) with that many seconds, and lowers the `timeoutS` minimum (5 s) to that value when it is below 5, so a spec can poll every second.

## Examples

Test a provider the way the server runs it:

```bash
node bin/jarvis.mjs provider-check <folder> <id> [<id> ...]
```

It validates the manifest, runs the program with the server's argv, env base, cwd and timeout, validates the output (also a slow run with `--fields` when the manifest has `slow_fields`) and prints the normalized rows, warnings and the folder hash.

Runnable examples: [`templates/status-provider/examples/`](../templates/status-provider/examples/README.md).

Skeleton: [`templates/status-provider/status_provider_example.py`](../templates/status-provider/status_provider_example.py) with [`manifest.example.json`](../templates/status-provider/manifest.example.json).

A fast run, `python3 status_provider_example.py run-1`:

```json
{"schema": 1, "checked": "2026-11-25T14:05:12Z", "rows": [{"id": "run-1", "label": "example-run-1", "state": "running", "detail": "running", "step": "evaluate", "progress": {"done": 3, "total": 7}, "startedAt": "2026-01-01T08:00:00Z", "finishedAt": null, "link": "https://dashboard.example/runs/run-1"}]}
```

The matching slow run, `python3 status_provider_example.py run-1 --fields cost`:

```json
{"schema": 1, "checked": "2026-11-25T14:05:14Z", "rows": [{"id": "run-1", "costUsd": 12.4}]}
```

A whole-poll failure the provider caught itself:

```json
{"schema": 1, "error": "login expired", "errorKind": "auth", "rows": []}
```
