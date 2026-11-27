# Status provider examples

Three runnable providers. Each folder has a `manifest.json` and a program. Check one the way the server runs it, from the Jarvis repo root:

```bash
node bin/jarvis.mjs provider-check templates/status-provider/examples/json-file job-1 job-2 job-3 nope
node bin/jarvis.mjs provider-check templates/status-provider/examples/http-up example.com localhost:1
node bin/jarvis.mjs provider-check templates/status-provider/examples/github-prs 1   # set GITHUB_REPO in its manifest to a repo you can read first
```

Each ends with `OK` when manifest, argv, output and (with `slow_fields`) the slow run are valid.

| Folder | Shows |
|---|---|
| `http-up/` | Smallest case: a shell script and `curl`, one row per host |
| `json-file/` | State map, progress, `slow_fields` (`--fields cost`), per-id `error`, a whole-run `error` |
| `github-prs/` | Real-world provider: `gh api graphql`, `env.set` for the repo, `errorKind` from error text |

The contract is in [`../SKILL.md`](../SKILL.md) and [`docs/STATUS-PROVIDERS.md`](../../../docs/STATUS-PROVIDERS.md). To use one as your own provider, copy the folder, rename it and the manifest `name`, and change the code.

A `screenshot.png` in a provider folder is optional. A builder agent cannot make one: rows reach the panel only through the arbiter tool `watch_jobs` (see step 6 of `SKILL.md`). The image file is hashed, so changing it needs re-approval.
