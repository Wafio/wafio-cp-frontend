#!/usr/bin/env python3
"""Fail on known advisories for the packages in a lockfile that are not in the allowlist.

    scripts/advisories.py Cargo.lock
    scripts/advisories.py web/bun.lock

Asks OSV (api.osv.dev) about every locked registry package. Only the ecosystem, package
name and version are sent. Unmaintained notices count as advisories. When OSV cannot be
reached the step prints a warning and passes, so the gate still works offline.
The allowlist is advisories.allow next to this file: "id | package | reason | date reviewed".
Needs Python 3.11 or newer (tomllib).
"""
import json
import os
import re
import sys
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

OSV = os.environ.get("WAFIO_OSV_URL", "https://api.osv.dev/v1/querybatch")
ALLOW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "advisories.allow")


def parse_cargo(text):
    """Registry crates only: workspace members and git sources have no OSV record."""
    pkgs = tomllib.loads(text).get("package", [])
    return {("crates.io", p["name"], p["version"]) for p in pkgs if str(p.get("source", "")).startswith("registry+")}


def parse_bun(text):
    """bun.lock is JSON with trailing commas; entry[0] is "name@version"."""
    pkgs = json.loads(re.sub(r",(\s*[}\]])", r"\1", text)).get("packages", {})
    found = (re.fullmatch(r"(@?[^@]+)@(\d[^@]*)", entry[0]) for entry in pkgs.values())
    return {("npm", m[1], m[2]) for m in found if m}


PARSERS = {"Cargo.lock": parse_cargo, "bun.lock": parse_bun}


def read_allow(path):
    allowed = set()
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        f = [x.strip() for x in line.split("|")]
        if len(f) != 4 or not all(f) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", f[3]):
            sys.exit(f"{path}: want 'id | package | reason | yyyy-mm-dd', got: {line}")
        allowed.add((f[0], f[1]))
    return allowed


def query(pkgs):
    """Returns (id, package, version) for every advisory OSV lists."""
    pkgs, found = sorted(pkgs), []
    for i in range(0, len(pkgs), 500):
        chunk = pkgs[i : i + 500]
        queries = [{"package": {"ecosystem": e, "name": n}, "version": v} for e, n, v in chunk]
        req = urllib.request.Request(OSV, json.dumps({"queries": queries}).encode(), {"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            results = json.load(resp)["results"]
        for (_, n, v), r in zip(chunk, results):
            if r.get("next_page_token"):  # shortcut: no paging, a package with this many advisories needs a look
                sys.exit(f"OSV paged the answer for {n} {v}: extend query() before trusting this gate")
            found += [(x["id"], n, v) for x in r.get("vulns", [])]
    return found


def main(path, allow=ALLOW):
    pkgs = PARSERS[os.path.basename(path)](Path(path).read_text())
    allowed = read_allow(allow)
    try:
        found = query(pkgs)
    except OSError as e:  # URLError, timeouts and refused connections
        if isinstance(e, urllib.error.HTTPError) and e.code < 500:
            raise
        print(f"WARNING: OSV not reachable ({e}). The {len(pkgs)} packages in {path} were NOT checked; this step passes without a result.")
        return 0
    new = sorted(f for f in found if f[:2] not in allowed)
    for id_, n, v in new:
        print(f"ADVISORY {id_}: {n} {v} (https://osv.dev/{id_}). Fix it, or add it to {os.path.basename(allow)} with a reason.")
    for id_, p in sorted(allowed - {(i, n) for i, n, _ in found}):
        print(f"note: {os.path.basename(allow)} lists {id_} for {p}, which OSV no longer reports for {path}")
    print(f"{path}: {len(pkgs)} packages, {len(found)} advisories, {len(found) - len(new)} allowed, {len(new)} not allowed")
    return 1 if new else 0


if __name__ == "__main__":
    if len(sys.argv) != 2 or os.path.basename(sys.argv[1]) not in PARSERS:
        sys.exit("usage: advisories.py Cargo.lock|bun.lock")
    sys.exit(main(sys.argv[1]))
