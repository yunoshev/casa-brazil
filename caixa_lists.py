#!/usr/bin/env python3
"""Mirror Caixa's own state lists for the private catalogue worker.

Runs every hour in this repository's GitHub Actions (`caixa-lists.yml`) and
keeps the newest lists on the `caixa-lists` branch, which the worker reads.

Why here: Caixa answers 403 to the server the worker runs on, and the partner
feed that republishes the lists can sit on an old one for days (9 Oct 2026 was
served until the 14th while Caixa already had the 13th). GitHub's runners
download the same public CSVs with a plain curl, no browser and no proxy.

Polite by construction: the smallest list (CE, ~200 KB) tells whether Caixa
has regenerated its lists since the last run; the other three are fetched only
when it has. Nothing replaces the mirrored lists unless every one of them
downloads and parses; a failed run leaves `checked_at` old, and the worker
treats a mirror older than a few hours as unavailable.

Run: python3 caixa_lists.py --dir <checkout of the caixa-lists branch>
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
from datetime import UTC, date, datetime
from pathlib import Path

URL = "https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_{uf}.csv"
STATES = ("CE", "PE", "RJ", "SP")
PROBE = "CE"
SCHEMA = "caixa-lists-v1"
MAX_BYTES = 20 * 1024 * 1024
ATTEMPTS = 3
TIMEOUT_SECONDS = 120


class ListError(RuntimeError):
    pass


def filename(uf: str) -> str:
    return f"Lista_imoveis_{uf}.csv"


def parse(raw: bytes, uf: str, today: date | None = None) -> tuple[str, int]:
    """The list's own generation date and its row count; raises on anything else."""
    head = raw[:4096].lower()
    if b"<html" in head or b"perfdrive" in head or b"<!doctype" in head:
        raise ListError(f"{uf}: challenge page instead of the list")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    match = re.search(r"Data de gera\w+o:;\s*(\d{2}/\d{2}/\d{4})", text)
    if not match:
        raise ListError(f"{uf}: no generation date")
    generated = datetime.strptime(match[1], "%d/%m/%Y").date()
    if generated > (today or datetime.now(UTC).date()):
        raise ListError(f"{uf}: generation date in the future")
    lines = text.splitlines()
    header = next((i for i, line in enumerate(lines) if ";UF;" in line), None)
    if header is None:
        raise ListError(f"{uf}: no column header")
    rows = 0
    for row in csv.reader(io.StringIO("\n".join(lines[header + 1 :])), delimiter=";"):
        if not row or not any(value.strip() for value in row):
            continue
        if len(row) < 2 or not row[0].strip().isdigit() or row[1].strip() != uf:
            raise ListError(f"{uf}: malformed or cross-state row")
        rows += 1
    if not rows:
        raise ListError(f"{uf}: empty list")
    return generated.isoformat(), rows


def download(uf: str, run=subprocess.run, pause=time.sleep) -> bytes:
    """Plain curl, as a person's terminal would ask; a browser-like request
    is what Caixa's bot manager challenges."""
    last = "no attempt"
    for attempt in range(1, ATTEMPTS + 1):
        result = run(
            [
                "curl",
                "-sS",
                "--max-time",
                str(TIMEOUT_SECONDS),
                "--max-filesize",
                str(MAX_BYTES),
                "-w",
                "%{http_code}",
                "-o",
                "-",
                URL.format(uf=uf),
            ],
            capture_output=True,
            check=False,
        )
        body, code = result.stdout[:-3], result.stdout[-3:].decode("ascii", "replace")
        if result.returncode == 0 and code == "200" and body:
            return body
        last = f"HTTP {code} curl {result.returncode}"
        if attempt < ATTEMPTS:
            pause(20 * attempt)
    raise ListError(f"{uf}: download failed ({last})")


def refresh(
    directory: Path, *, fetch=download, pause=time.sleep, now: datetime | None = None
) -> bool:
    """Bring the mirror up to date. True when the lists themselves changed."""
    now = now or datetime.now(UTC)
    manifest_path = directory / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    known = previous.get("states", {}) if previous.get("schema") == SCHEMA else {}
    fetched_at = now.isoformat().replace("+00:00", "Z")
    lists = {PROBE: fetch(PROBE)}
    probe_date, _rows = parse(lists[PROBE], PROBE, now.date())
    unchanged = all(
        known.get(uf, {}).get("source_date") == probe_date and (directory / filename(uf)).is_file()
        for uf in STATES
    )
    if unchanged:
        manifest = {**previous, "checked_at": fetched_at}
        manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
        return False
    for uf in STATES:
        if uf not in lists:
            pause(3)
            lists[uf] = fetch(uf)
    states = {}
    for uf in STATES:
        source_date, rows = parse(lists[uf], uf, now.date())
        states[uf] = {
            "source_date": source_date,
            "rows": rows,
            "bytes": len(lists[uf]),
            "sha256": hashlib.sha256(lists[uf]).hexdigest(),
            "fetched_at": fetched_at,
            "url": URL.format(uf=uf),
        }
    for uf, raw in lists.items():
        temporary = directory / (filename(uf) + ".next")
        temporary.write_bytes(raw)
        os.replace(temporary, directory / filename(uf))
    manifest = {"schema": SCHEMA, "checked_at": fetched_at, "states": states}
    manifest_path.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, required=True)
    args = parser.parse_args(argv)
    args.dir.mkdir(parents=True, exist_ok=True)
    changed = refresh(args.dir)
    manifest = json.loads((args.dir / "manifest.json").read_text())
    dates = sorted({state["source_date"] for state in manifest["states"].values()})
    print(f"caixa-lists: {'new lists' if changed else 'unchanged'} {', '.join(dates)}", flush=True)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a") as handle:
            handle.write(f"changed={'true' if changed else 'false'}\n")
            handle.write(f"source_date={dates[-1]}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
