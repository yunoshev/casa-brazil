"""Strict market-report boundary for the static Brazil release.

The market worker writes a richer, private hand-off artifact.  This module is
the only place allowed to turn that hand-off into the small public JSON file.
It deliberately knows nothing about databases, collectors, or HTTP: callers
give it bytes and an already attested lifecycle release.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable
from datetime import datetime
from typing import Any

EXPORT_SCHEMA = "brazil-market-reports-v2"
PUBLIC_SCHEMA = "brazil-market-reports-public-v1"
MIN_COMPARABLE_EVIDENCE = 5
MAX_EXPORT_BYTES = 4 * 1024 * 1024
MAX_PUBLIC_BYTES = 1024 * 1024

_EXPORT_ROOT = frozenset({"schema", "as_of", "lifecycle", "availability", "reports"})
_PUBLIC_ROOT = frozenset({"schema", "as_of", "lifecycle", "availability", "reports"})
_LIFECYCLE = frozenset({"release_id", "catalog_cycle_id", "artifact_sha256"})
_AVAILABILITY = frozenset({"status", "qualified_reports", "minimum_comparable_evidence"})
_REPORT = frozenset({"lot_id", "market", "evidence"})
# These two fields are explicitly source-only.  They are accepted only so an
# internal exporter can retain audit traceability locally; they are never
# returned from this module or copied to the public site.
_EVIDENCE = frozenset(
    {
        "source_listing_id",
        "source_url",
        "operation",
        "observed_at",
        "price_brl",
        "area_m2",
        "distance_m",
    }
)
_ISO_Z = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$"
)


def compact_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )


def lifecycle_binding(data: bytes, receipt: dict[str, Any]) -> dict[str, str]:
    """Return the immutable identity shared by catalogue and market artifacts."""
    digest = hashlib.sha256(data).hexdigest()
    if not isinstance(receipt, dict) or receipt.get("artifact_sha256") != digest:
        raise ValueError("market release lifecycle receipt hash does not match artifact")
    mode = receipt.get("release_mode")
    cycle = receipt.get("catalog_cycle_id")
    release_id = receipt.get("release_id")
    if (
        mode not in {"trusted", "observed_partial"}
        or not isinstance(cycle, str)
        or not cycle
        or not isinstance(release_id, str)
        or release_id != f"{mode}:{cycle}:{digest[:24]}"
    ):
        raise ValueError("market release lifecycle receipt identity is invalid")
    return {"release_id": release_id, "catalog_cycle_id": cycle, "artifact_sha256": digest}


def empty_public_artifact(
    binding: dict[str, str] | None, *, as_of: str | None = None
) -> dict[str, Any]:
    """Produce a valid, deliberately non-valuation artifact for an empty run."""
    return {
        "schema": PUBLIC_SCHEMA,
        "as_of": as_of,
        "lifecycle": binding,
        "availability": {
            "status": "insufficient_data",
            "qualified_reports": 0,
            "minimum_comparable_evidence": MIN_COMPARABLE_EVIDENCE,
        },
        "reports": [],
    }


def _timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ISO_Z.fullmatch(value):
        raise ValueError(f"{label} must be an ISO timestamp with timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO timestamp with timezone") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{label} must be an ISO timestamp with timezone")
    return value


def _finite(value: Any, *, minimum: float = 0, maximum: float = 100_000_000_000) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum


def _binding(value: Any, expected: dict[str, str]) -> None:
    if not isinstance(value, dict) or frozenset(value) != _LIFECYCLE:
        raise ValueError("market reports lifecycle binding has an invalid schema")
    if value != expected:
        raise ValueError("market reports lifecycle binding does not match catalogue release")


def _evidence(value: Any, label: str) -> int:
    if not isinstance(value, list) or len(value) > 1_000:
        raise ValueError(f"{label} is invalid")
    fingerprints: set[tuple[Any, ...]] = set()
    for index, row in enumerate(value, 1):
        if not isinstance(row, dict) or frozenset(row) != _EVIDENCE:
            raise ValueError(f"{label}[{index}] has unsupported fields")
        if (
            not isinstance(row["source_listing_id"], str)
            or not row["source_listing_id"]
            or len(row["source_listing_id"]) > 512
        ):
            raise ValueError(f"{label}[{index}].source_listing_id is invalid")
        # It is source-only and can carry an internal URL.  Do not normalise,
        # fetch, log, or return it; bounded validation merely prevents a huge
        # hand-off file from exhausting the static build.
        if row["source_url"] is not None and (
            not isinstance(row["source_url"], str) or len(row["source_url"]) > 4096
        ):
            raise ValueError(f"{label}[{index}].source_url is invalid")
        if row["operation"] not in {"sale", "rent"}:
            raise ValueError(f"{label}[{index}].operation is invalid")
        _timestamp(row["observed_at"], f"{label}[{index}].observed_at")
        for key, maximum in (
            ("price_brl", 100_000_000_000),
            ("area_m2", 10_000_000),
            ("distance_m", 100_000),
        ):
            if not _finite(row[key], maximum=maximum):
                raise ValueError(f"{label}[{index}].{key} is invalid")
        fingerprint = (
            row["source_listing_id"],
            row["operation"],
            row["observed_at"],
            row["price_brl"],
            row["area_m2"],
            row["distance_m"],
        )
        if fingerprint in fingerprints:
            raise ValueError(f"{label} contains a duplicate comparable row")
        fingerprints.add(fingerprint)
    return len(value)


def _availability(value: Any, *, report_count: int) -> None:
    if not isinstance(value, dict) or frozenset(value) != _AVAILABILITY:
        raise ValueError("market reports availability has an invalid schema")
    if value.get("minimum_comparable_evidence") != MIN_COMPARABLE_EVIDENCE:
        raise ValueError("market reports minimum evidence is unsupported")
    if value.get("qualified_reports") != report_count:
        raise ValueError("market reports availability count does not match reports")
    wanted = "available" if report_count else "insufficient_data"
    if value.get("status") != wanted:
        raise ValueError("market reports availability status is not honest")


def _safe_public_market_text(market: Any) -> None:
    """The browser DTO contains one free-text field; reject markup/URLs there."""
    if not isinstance(market, dict):
        raise ValueError("market report is invalid")
    disclaimer = market.get("disclaimer")
    if not isinstance(disclaimer, str) or any(char in disclaimer for char in "<>"):
        raise ValueError("market report disclaimer is not safe public text")
    if re.search(r"(?:https?://|www\.|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+)", disclaimer, re.I):
        raise ValueError("market report disclaimer contains a private reference")


def public_artifact(
    source: bytes | None,
    *,
    binding: dict[str, str] | None,
    known_lot_ids: set[str],
    validate_market: Callable[[Any, str], None],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Validate a private exporter artifact and return its bounded public projection.

    Unknown lot IDs and valid reports with fewer than five evidence rows are
    deliberately omitted.  Structural drift, provenance drift, duplicate IDs
    and unsafe market DTOs are release failures, never best-effort cleanup.
    """
    if source is None:
        return empty_public_artifact(binding), {}
    if len(source) > MAX_EXPORT_BYTES:
        raise ValueError("market reports artifact exceeds the source size cap")
    try:
        root = json.loads(source)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("market reports artifact is unreadable") from exc
    if (
        not isinstance(root, dict)
        or frozenset(root) != _EXPORT_ROOT
        or root.get("schema") != EXPORT_SCHEMA
    ):
        raise ValueError("market reports artifact has an invalid schema")
    as_of = _timestamp(root.get("as_of"), "market reports as_of")
    if binding is None:
        raise ValueError("market reports require an attested lifecycle binding")
    _binding(root.get("lifecycle"), binding)
    reports = root.get("reports")
    if not isinstance(reports, list) or len(reports) > 20_000:
        raise ValueError("market reports list is invalid")
    _availability(root.get("availability"), report_count=len(reports))
    output: dict[str, dict[str, Any]] = {}
    seen: set[str] = set()
    for number, item in enumerate(reports, 1):
        label = f"market report #{number}"
        if not isinstance(item, dict) or frozenset(item) != _REPORT:
            raise ValueError(f"{label} has unsupported fields")
        lot_id = item.get("lot_id")
        if not isinstance(lot_id, str) or not lot_id or len(lot_id) > 200:
            raise ValueError(f"{label}.lot_id is invalid")
        if lot_id in seen:
            raise ValueError(f"duplicate market report lot_id: {lot_id}")
        seen.add(lot_id)
        validate_market(item.get("market"), label)
        _safe_public_market_text(item.get("market"))
        evidence_count = _evidence(item.get("evidence"), f"{label}.evidence")
        market = item["market"]
        assert isinstance(market, dict)
        sample = market.get("sample")
        sample_count = sample.get("count") if isinstance(sample, dict) else None
        if (
            not isinstance(sample, dict)
            or type(sample_count) is not int
            or sample_count < MIN_COMPARABLE_EVIDENCE
            or evidence_count < MIN_COMPARABLE_EVIDENCE
        ):
            # A syntactically valid but insufficient record is never a public
            # valuation. It remains only in the local exporter artifact.
            continue
        if sample_count > evidence_count:
            raise ValueError(f"{label} has fewer evidence rows than its claimed sample")
        if lot_id in known_lot_ids:
            # Copy through only the reviewed browser DTO. Evidence IDs/URLs
            # and every other exporter-only field are intentionally dropped.
            output[lot_id] = dict(market)
    output = dict(sorted(output.items()))
    artifact = {
        "schema": PUBLIC_SCHEMA,
        "as_of": as_of,
        "lifecycle": binding,
        "availability": {
            "status": "available" if output else "insufficient_data",
            "qualified_reports": len(output),
            "minimum_comparable_evidence": MIN_COMPARABLE_EVIDENCE,
        },
        "reports": [{"lot_id": lot_id, "market": market} for lot_id, market in output.items()],
    }
    if len(compact_json(artifact)) > MAX_PUBLIC_BYTES:
        raise ValueError("public market reports artifact exceeds the size cap")
    return artifact, output
