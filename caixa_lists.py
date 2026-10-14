#!/usr/bin/env python3
"""Mirror Caixa's own state lists for the private catalogue worker.

Runs every hour in this repository's GitHub Actions (`caixa-lists.yml`) and
keeps the newest lists on the `caixa-lists` branch, which the worker reads.

Why here: Caixa answers 403 to the server the worker runs on, and the partner
feed that republishes the lists can sit on an old one for days (9 Oct 2026 was
served until the 14th while Caixa already had the 13th). GitHub's runners
download the same public CSVs with a plain curl, no browser and no proxy.

One download per runner: Caixa's bot manager (Radware) lets a runner's first
request through and answers its second, three seconds later, with a 302 to a
challenge page (both runs on 14 Oct 2026: CE fetched, PE challenged on every
retry). So the workflow is three steps, each its own command here:

  probe     one runner fetches the smallest list (CE, ~200 KB); when its date
            equals the mirrored one, only `checked_at` moves;
  fetch     otherwise PE, RJ and SP are fetched by one runner each;
  assemble  the four lists are validated together and replace the mirror.

Nothing replaces the mirrored lists unless every one downloads and parses; a
failed run leaves `checked_at` old, and the worker treats a mirror older than a
few hours as unavailable.
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
import tempfile
import time
from datetime import UTC, date, datetime
from pathlib import Path

URL = "https://venda-imoveis.caixa.gov.br/listaweb/Lista_imoveis_{uf}.csv"
STATES = ("CE", "PE", "RJ", "SP")
PROBE = "CE"
SCHEMA = "caixa-lists-v1"
MAX_BYTES = 20 * 1024 * 1024
# A challenged address stays challenged for a while; one retry is enough.
ATTEMPTS = 2
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


def annotate(level: str, message: str) -> None:
    """A GitHub annotation: readable through the public API, unlike the job log."""
    print(f"::{level} title=caixa-lists::{message}", flush=True)


def download(uf: str, run=subprocess.run, pause=time.sleep) -> bytes:
    """Plain curl into a file, as a person's terminal would ask; a browser-like
    request is what Caixa's bot manager challenges."""
    last = "no attempt"
    with tempfile.TemporaryDirectory() as scratch:
        target = Path(scratch) / filename(uf)
        for attempt in range(1, ATTEMPTS + 1):
            target.unlink(missing_ok=True)
            result = run(
                [
                    "curl",
                    "-sS",
                    "--max-time",
                    str(TIMEOUT_SECONDS),
                    "-o",
                    str(target),
                    "-w",
                    "%{http_code} %{size_download} %{redirect_url}",
                    URL.format(uf=uf),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            code, _, rest = result.stdout.strip().partition(" ")
            body = target.read_bytes() if target.exists() else b""
            if result.returncode == 0 and code == "200" and body:
                if len(body) > MAX_BYTES:
                    raise ListError(f"{uf}: list larger than {MAX_BYTES} bytes")
                return body
            size, _, redirect = rest.partition(" ")
            where = redirect.split("?", 1)[0]
            last = f"HTTP {code or '-'} curl {result.returncode} {size} bytes {where}".strip()
            annotate("warning", f"{uf} attempt {attempt}: {last} {result.stderr.strip()[:160]}")
            if attempt < ATTEMPTS:
                pause(20 * attempt)
    raise ListError(f"{uf}: download failed ({last})")


def _read_manifest(directory: Path) -> dict:
    path = directory / "manifest.json"
    manifest = json.loads(path.read_text()) if path.exists() else {}
    return manifest if manifest.get("schema") == SCHEMA else {}


def _write(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".next")
    temporary.write_bytes(data)
    os.replace(temporary, path)


def _stamp(now: datetime) -> str:
    return now.isoformat().replace("+00:00", "Z")


def probe(
    directory: Path, out: Path, *, fetch=None, now: datetime | None = None
) -> tuple[bool, str]:
    """Fetch CE. Unchanged: move `checked_at` in place. Changed: leave CE in ``out``."""
    now = now or datetime.now(UTC)
    raw = (fetch or download)(PROBE)
    day, _rows = parse(raw, PROBE, now.date())
    known = _read_manifest(directory)
    unchanged = all(
        known.get("states", {}).get(uf, {}).get("source_date") == day
        and (directory / filename(uf)).is_file()
        for uf in STATES
    )
    if unchanged:
        manifest = {**known, "checked_at": _stamp(now)}
        _write(
            directory / "manifest.json",
            (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode(),
        )
        return False, day
    out.mkdir(parents=True, exist_ok=True)
    _write(out / filename(PROBE), raw)
    return True, day


def fetch_one(uf: str, out: Path, *, fetch=None, now: datetime | None = None) -> str:
    """One state's list into ``out``, validated."""
    now = now or datetime.now(UTC)
    raw = (fetch or download)(uf)
    day, _rows = parse(raw, uf, now.date())
    out.mkdir(parents=True, exist_ok=True)
    _write(out / filename(uf), raw)
    return day


def assemble(directory: Path, source: Path, *, now: datetime | None = None) -> dict:
    """Validate the four fetched lists together and make them the mirror."""
    now = now or datetime.now(UTC)
    lists, states = {}, {}
    for uf in STATES:
        path = source / filename(uf)
        if not path.is_file():
            raise ListError(f"{uf}: list missing from this run")
        lists[uf] = path.read_bytes()
        day, rows = parse(lists[uf], uf, now.date())
        states[uf] = {
            "source_date": day,
            "rows": rows,
            "bytes": len(lists[uf]),
            "sha256": hashlib.sha256(lists[uf]).hexdigest(),
            "fetched_at": _stamp(now),
            "url": URL.format(uf=uf),
        }
    directory.mkdir(parents=True, exist_ok=True)
    for uf, raw in lists.items():
        _write(directory / filename(uf), raw)
    manifest = {"schema": SCHEMA, "checked_at": _stamp(now), "states": states}
    _write(
        directory / "manifest.json",
        (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode(),
    )
    return manifest


def _output(**values: str) -> None:
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a") as handle:
            for key, value in values.items():
                handle.write(f"{key}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    probe_parser = commands.add_parser("probe")
    probe_parser.add_argument("--dir", type=Path, required=True)
    probe_parser.add_argument("--out", type=Path, required=True)
    fetch_parser = commands.add_parser("fetch")
    fetch_parser.add_argument("--uf", choices=STATES, required=True)
    fetch_parser.add_argument("--out", type=Path, required=True)
    assemble_parser = commands.add_parser("assemble")
    assemble_parser.add_argument("--dir", type=Path, required=True)
    assemble_parser.add_argument("--from", dest="source", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "probe":
            args.dir.mkdir(parents=True, exist_ok=True)
            changed, day = probe(args.dir, args.out)
            print(f"caixa-lists: CE list {day}, {'new' if changed else 'unchanged'}", flush=True)
            _output(changed="true" if changed else "false", source_date=day)
        elif args.command == "fetch":
            day = fetch_one(args.uf, args.out)
            print(f"caixa-lists: {args.uf} list {day}", flush=True)
        else:
            manifest = assemble(args.dir, args.source)
            dates = sorted({state["source_date"] for state in manifest["states"].values()})
            print(f"caixa-lists: mirrored {', '.join(dates)}", flush=True)
            _output(source_date=dates[-1])
    except ListError as exc:
        annotate("error", str(exc))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
