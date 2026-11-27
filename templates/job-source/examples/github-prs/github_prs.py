#!/usr/bin/env python3
"""Jarvis job source (schema v1): GitHub pull requests of one repo. Read-only.

Usage: github_prs.py <pr number> [<pr number> ...]
Env: GITHUB_REPO owner/name (required). Uses the existing `gh` login; never logs in.
One `gh api graphql` call reads all PRs.
"""
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

FIELDS = """number title url state isDraft reviewDecision mergeable headRefName
  createdAt updatedAt closedAt mergedAt
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  reviewThreads(first: 100) { totalCount nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }"""


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def err(msg, kind):
    return {"schema": 1, "rows": [], "error": " ".join(msg.split())[:300], "errorKind": kind}


def gh_error_kind(text):
    t = text.lower()
    if "not_found" in t or "to a repository" in t:  # repo missing or no access: not a network problem
        return "other"
    if any(k in t for k in ("gh auth login", "authentication", "bad credentials", "http 401", "not logged in", "oauth token", "token has expired")):
        return "auth"
    if any(k in t for k in ("could not resolve host", "timeout", "timed out", "connection", "dial tcp", "network", "no route")):
        return "network"
    return "other"


def state_of(p):
    """Return (state, reason) for one PR node."""
    if p["state"] == "MERGED":
        return "done", "merged"
    if p["state"] == "CLOSED":
        return "stopped", "closed, not merged"
    if p["state"] != "OPEN":
        return "unknown", p["state"]
    nodes = p["commits"]["nodes"]
    ci = ((nodes[0]["commit"].get("statusCheckRollup") or {}).get("state")) if nodes else None
    # shortcut: rollup counts all checks, not only required ones; refine if branch protection lists required checks
    if p["mergeable"] == "CONFLICTING":
        return "failed", "merge conflicts"
    if ci in ("FAILURE", "ERROR"):
        return "failed", "CI failing"
    if ci in ("PENDING", "EXPECTED"):
        return "running", "CI pending"
    if p["isDraft"]:
        return "waiting", "draft"
    return "waiting", {"CHANGES_REQUESTED": "changes requested", "REVIEW_REQUIRED": "review required",
                       "APPROVED": "approved, ready to merge"}.get(p["reviewDecision"], "open, no review decision")


def read_pr(p):
    state, reason = state_of(p)
    nodes = p["commits"]["nodes"]
    ci = ((nodes[0]["commit"].get("statusCheckRollup") or {}).get("state")) if nodes else None
    parts = [reason, f"head {p['headRefName']}"]
    if p["state"] == "OPEN":
        rv = [(n["requestedReviewer"] or {}).get("login") or (n["requestedReviewer"] or {}).get("slug")
              for n in p["reviewRequests"]["nodes"]]
        th = p["reviewThreads"]
        unresolved = sum(1 for t in th["nodes"] if not t["isResolved"])
        parts += ["draft" if p["isDraft"] else "ready",
                  f"review {p['reviewDecision'] or 'none'}",
                  f"CI {(ci or 'none').lower()}",
                  {"MERGEABLE": "no conflicts", "CONFLICTING": "conflicts"}.get(p["mergeable"], "conflicts unknown"),
                  f"unresolved threads {unresolved}{'+' if th['totalCount'] > 100 else ''}",
                  "reviewers " + (", ".join(r for r in rv if r) or "none")]
    parts.append(f"updated {p['updatedAt']}")
    return {"id": str(p["number"]), "label": f"#{p['number']} {p['title']}"[:200], "state": state,
            "detail": "; ".join(parts)[:300], "startedAt": p["createdAt"],
            "finishedAt": p["mergedAt"] or p["closedAt"], "link": p["url"]}


def main(ids):
    repo = os.environ.get("GITHUB_REPO", "")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        return err("GITHUB_REPO is not set to owner/name", "other")
    owner, name = repo.split("/")
    aliases = " ".join(f"p{int(i)}: pullRequest(number: {int(i)}) {{ {FIELDS} }}" for i in ids)
    query = f"query($o: String!, $n: String!) {{ repository(owner: $o, name: $n) {{ {aliases} }} }}"
    try:
        r = subprocess.run(["gh", "api", "graphql", "-f", f"query={query}", "-F", f"o={owner}", "-F", f"n={name}"],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return err(f"gh: {type(e).__name__}: {e}", "network" if isinstance(e, subprocess.TimeoutExpired) else "other")
    try:
        out = json.loads(r.stdout)
    except ValueError:
        text = (r.stderr or r.stdout or "gh failed").strip()
        return err(f"gh: {text.splitlines()[-1] if text else 'failed'}", gh_error_kind(text))
    repo_data = (out.get("data") or {}).get("repository")
    if repo_data is None:  # repo missing or whole query rejected
        text = json.dumps(out.get("errors") or out)
        return err(f"graphql: {text}", gh_error_kind(text))
    rows = []
    for i in ids:
        p = repo_data.get(f"p{int(i)}")
        rows.append(read_pr(p) if p else {"id": i, "state": "unknown", "error": f"PR {i} not found in {repo}"})
    return {"schema": 1, "checked": now(), "rows": rows}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:])))
