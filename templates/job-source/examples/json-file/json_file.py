#!/usr/bin/env python3
"""Jarvis job source (schema v1): jobs from a JSON file. Read-only, stdlib only.

Usage: json_file.py [--fields cost] <id> [<id> ...]
Env: JOBS_FILE path of the file (default: jobs.json next to this script; `~` is expanded).
File shape: {"<id>": {"status": "...", "step": "...", "done": 3, "total": 7, "started": "<ISO UTC>", "ended": null, "cost": 1.5}}
"""
import json
import os
import sys
from datetime import datetime, timezone

# Every source status maps to a Jarvis state; anything else becomes "unknown", never a guess.
STATES = {"pending": "queued", "active": "running", "paused": "waiting", "ok": "done", "error": "failed", "cancelled": "stopped"}


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def row(job_id, j, fields):
    if fields is not None:  # slow run: id plus only the asked fields
        return {"id": job_id, "costUsd": j.get("cost")}
    r = {"id": job_id, "label": job_id, "state": STATES.get(j.get("status"), "unknown"), "detail": str(j.get("status")),
         "step": j.get("step"), "startedAt": j.get("started"), "finishedAt": j.get("ended")}
    if "done" in j:
        r["progress"] = {"done": j["done"], "total": j.get("total")}
    return r  # costUsd is a slow field: left out of the fast run


def main(argv):
    fields = None
    if "--fields" in argv:
        i = argv.index("--fields")
        fields = set(argv[i + 1].split(",")) if i + 1 < len(argv) else set()
        argv = argv[:i] + argv[i + 2:]
    path = os.path.expanduser(os.environ.get("JOBS_FILE") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs.json"))
    try:
        with open(path) as f:
            jobs = json.load(f)
    except (OSError, ValueError) as e:  # whole-run failure: top-level error, exit 0
        return {"schema": 1, "rows": [], "error": f"cannot read {os.path.basename(path)}: {e}"[:300], "errorKind": "other"}
    # a missing id: error row in the fast run; in a slow run only id + asked fields are allowed, so it gets none
    rows = [row(i, jobs[i], fields) if i in jobs else {"id": i} if fields is not None else {"id": i, "state": "unknown", "error": f"no job {i} in file"} for i in argv]
    return {"schema": 1, "checked": now(), "rows": rows}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:])))
