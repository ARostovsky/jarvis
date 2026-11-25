#!/usr/bin/env python3
"""Skeleton of a Jarvis status provider (schema v1).

Usage: status_provider_example.py [--fields cost] <id> [<id> ...]

Prints exactly one JSON object. Replace `read_job()` with the real read of
your job source. Read-only and deterministic: no LLM, no `claude`, no login.
"""
import json
import sys
from datetime import datetime, timezone

SLOW_FIELDS = {"costUsd"}  # fields the manifest lists in slow_fields (cost means costUsd)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_job(job_id: str) -> dict:
    """Return one row as a dict. Replace with a real read of the job source."""
    return {
        "id": job_id,
        "label": f"example-{job_id}",
        "state": "running",  # queued|running|waiting|done|failed|stopped|unknown
        "detail": "running",
        "step": "evaluate",
        "progress": {"done": 3, "total": 7},
        "startedAt": "2026-01-01T08:00:00Z",
        "finishedAt": None,
        "link": f"https://dashboard.example/runs/{job_id}",
        "costUsd": 12.4,
    }


def build(ids: list[str], fields: set[str] | None) -> dict:
    rows = []
    for job_id in ids:
        try:
            row = read_job(job_id)
        except Exception as e:  # per-id failure goes into that row's error
            rows.append({"id": job_id, "state": "unknown", "error": str(e)[:300]})
            continue
        if fields is None:  # fast run: leave the slow fields out
            row = {k: v for k, v in row.items() if k not in SLOW_FIELDS}
        else:  # slow run: id plus only the asked fields
            row = {k: v for k, v in row.items() if k == "id" or k in fields}
        rows.append(row)
    return {"schema": 1, "checked": now(), "rows": rows}


def main(argv: list[str]) -> int:
    fields = None
    if "--fields" in argv:
        i = argv.index("--fields")
        names = argv[i + 1].split(",") if i + 1 < len(argv) else []
        fields = {"costUsd" if n == "cost" else n for n in names if n}
        argv = argv[:i] + argv[i + 2:]
    json.dump(build(argv, fields), sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
