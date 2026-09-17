#!/usr/bin/env python3
"""Publish a lifecycle projection only after the public release says it is live.

The Pages workflow writes a small, deterministic manifest into ``dist``.  The
private worker fetches that one public file and compares it with its candidate;
there is no webhook, GitHub token, or deploy credential in this direction.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from release_check import PRODUCTION_SITE_URL, validate_release_site_url

MANIFEST_NAME = "lifecycle-release.json"
MANIFEST_SCHEMA_VERSION = 1
MANIFEST_KEYS = frozenset(
    {
        "schema_version",
        "site_url",
        "artifact_sha256",
        "release_id",
        "release_mode",
        "catalog_cycle_id",
        "projection_path",
        "projection_bytes",
        "build_code",
        "build_version",
        "provenance",
        "public_artifacts",
    }
)
PROJECTION_NAME = "lifecycle-projection.json"
BUILD_CODE = "brazil-strict-lifecycle"
BUILD_VERSION = 1
MAX_PUBLIC_BYTES = 16 * 1024 * 1024
MARKET_REPORTS_PATH = "data/market_reports.json"
MAX_MARKET_REPORTS_BYTES = 1024 * 1024
_SHA256 = re.compile(r"[0-9a-f]{64}")
_SOURCE_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


@dataclass(frozen=True)
class TransportResponse:
    body: bytes
    status: int = 200
    url: str = ""
    content_type: str = "application/json"


RECEIPT_KEYS = frozenset(
    {
        "schema_version",
        "release_id",
        "artifact_sha256",
        "release_mode",
        "catalog_cycle_id",
        "publication_state",
        "published_at",
    }
)


def observed_partial_without_global_freshness(payload: Any) -> bool:
    """Recognise the one release mode that deliberately has no global date.

    An observed-partial cycle only proves positive observations.  It must not
    acquire a synthetic whole-catalogue timestamp while being rendered, but a
    trusted complete export still has to carry one.  The predicate is strict
    enough that an incomplete trusted payload cannot opt out by merely adding
    a ``release`` object.
    """
    if not isinstance(payload, dict):
        return False
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict) or "release" not in provenance:
        return False
    if provenance.get("schema_version") != 2 or "catalog_cycle" in provenance:
        raise ValueError("Observed-partial release has ambiguous provenance")
    _observed_partial_release(payload)
    return True


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, pending = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".pending", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, path)
    except BaseException:
        Path(pending).unlink(missing_ok=True)
        raise


def _candidate_receipt(data: bytes, receipt: dict[str, Any]) -> dict[str, Any]:
    if frozenset(receipt) != RECEIPT_KEYS or receipt.get("schema_version") != 1:
        raise ValueError("Lifecycle candidate receipt has an invalid schema")
    if receipt.get("publication_state") != "candidate" or receipt.get("published_at") is not None:
        raise ValueError("Lifecycle candidate receipt is not a candidate")
    digest = hashlib.sha256(data).hexdigest()
    if receipt.get("artifact_sha256") != digest:
        raise ValueError("Lifecycle candidate receipt hash does not match artifact")
    mode, cycle = receipt.get("release_mode"), receipt.get("catalog_cycle_id")
    if mode not in {"trusted", "observed_partial"} or not isinstance(cycle, str) or not cycle:
        raise ValueError("Lifecycle candidate receipt identity is invalid")
    if receipt.get("release_id") != f"{mode}:{cycle}:{digest[:24]}":
        raise ValueError("Lifecycle candidate receipt release_id does not match artifact")
    if mode == "observed_partial":
        try:
            payload = json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Observed-partial lifecycle artifact is unreadable") from exc
        if not observed_partial_without_global_freshness(payload):
            raise ValueError("Observed-partial lifecycle artifact has no partial provenance")
    return receipt


def _aware_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be an ISO timestamp with timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO timestamp with timezone") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{label} must be an ISO timestamp with timezone")
    return parsed.astimezone(UTC)


def _observed_partial_release(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the narrow no-global-freshness release contract.

    A partial observation is publishable as a normal candidate, but it cannot
    imply that unobserved lots disappeared or that one scope's timestamp dates
    the entire catalogue.  Each exported scope therefore carries its own
    timestamp and byte digest.
    """
    provenance = payload.get("provenance")
    release = provenance.get("release") if isinstance(provenance, dict) else None
    if (
        payload.get("lifecycle_schema_version") != 1
        or "generated" in payload
        or "source_as_of" in payload
        or not isinstance(provenance, dict)
        or provenance.get("schema_version") != 2
        or "catalog_cycle" in provenance
        or not isinstance(release, dict)
        or release.get("release_mode") != "observed_partial"
        or release.get("trusted") is not False
        or release.get("absence_inference") is not False
        or "global_freshness" not in release
        or release.get("global_freshness") is not None
    ):
        raise ValueError("Observed-partial release requires explicit null global freshness")
    scopes = release.get("scopes")
    if not isinstance(scopes, list) or not scopes:
        raise ValueError("Observed-partial release requires per-scope evidence")
    seen: set[str] = set()
    for index, scope in enumerate(scopes, 1):
        label = f"Observed-partial scope #{index}"
        name = scope.get("scope") if isinstance(scope, dict) else None
        digest = scope.get("catalog_sha256") if isinstance(scope, dict) else None
        if not isinstance(name, str) or not name or name in seen:
            raise ValueError(f"{label} has an invalid or duplicate scope")
        seen.add(name)
        _aware_timestamp(scope.get("observed_at"), f"{label} observed_at")
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise ValueError(f"{label} has an invalid catalog digest")
        source_date = scope.get("source_date")
        if source_date is not None:
            if not isinstance(source_date, str) or _SOURCE_DATE.fullmatch(source_date) is None:
                raise ValueError(f"{label} has an invalid source date")
            try:
                datetime.fromisoformat(source_date)
            except ValueError as exc:
                raise ValueError(f"{label} has an invalid source date") from exc
    return release


def candidate_contract(
    data: bytes, receipt: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    """Bind candidate identity to the release mode declared by its payload."""
    receipt = _candidate_receipt(data, receipt)
    provenance = payload.get("provenance")
    trusted = provenance.get("catalog_cycle") if isinstance(provenance, dict) else None
    partial = provenance.get("release") if isinstance(provenance, dict) else None
    mode = receipt["release_mode"]
    release = trusted if mode == "trusted" else _observed_partial_release(payload)
    generated = payload.get("generated")
    if (
        not isinstance(release, dict)
        or release.get("cycle_id") != receipt["catalog_cycle_id"]
        or (mode == "trusted" and partial is not None)
        or (mode == "observed_partial" and trusted is not None)
    ):
        raise ValueError("Lifecycle candidate receipt identity does not match artifact")
    if mode == "trusted":
        if release.get("trusted") is not True:
            raise ValueError("Trusted lifecycle candidate is not explicitly complete")
        if not isinstance(generated, str) or _SOURCE_DATE.fullmatch(generated) is None:
            raise ValueError("Trusted lifecycle candidate requires global generated metadata")
        try:
            datetime.fromisoformat(generated)
        except ValueError as exc:
            raise ValueError(
                "Trusted lifecycle candidate requires global generated metadata"
            ) from exc
    return receipt


def manifest_for_candidate(
    data: bytes,
    receipt: dict[str, Any],
    payload: dict[str, Any] | None = None,
    *,
    public_artifacts: dict[str, bytes] | None = None,
) -> dict[str, Any]:
    if payload is None:
        try:
            payload = json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Lifecycle candidate artifact is unreadable") from exc
    if not isinstance(payload, dict):
        raise ValueError("Lifecycle candidate artifact has an invalid schema")
    receipt = candidate_contract(data, receipt, payload)
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "site_url": PRODUCTION_SITE_URL,
        "artifact_sha256": receipt["artifact_sha256"],
        "release_id": receipt["release_id"],
        "release_mode": receipt["release_mode"],
        "catalog_cycle_id": receipt["catalog_cycle_id"],
        "projection_path": PROJECTION_NAME,
        "projection_bytes": len(data),
        "build_code": BUILD_CODE,
        "build_version": BUILD_VERSION,
        "provenance": payload.get("provenance"),
        "public_artifacts": {
            path: {"sha256": hashlib.sha256(contents).hexdigest(), "bytes": len(contents)}
            for path, contents in sorted((public_artifacts or {}).items())
        },
    }


def emit_manifest(
    candidate: Path,
    receipt_path: Path,
    output: Path,
    *,
    legacy_baseline: bool = False,
    public_artifacts: dict[str, bytes] | None = None,
) -> dict[str, Any]:
    """Write the exact public attestation from a strict build's input bytes."""
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Lifecycle candidate receipt is unreadable") from exc
    data = candidate.read_bytes()
    try:
        payload = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Lifecycle candidate artifact is unreadable") from exc
    if legacy_baseline:
        _strict_legacy_bootstrap(payload)
    candidate_contract(data, receipt, payload)
    manifest = manifest_for_candidate(data, receipt, payload, public_artifacts=public_artifacts)
    atomic_write(output, json_bytes(manifest) + b"\n")
    return manifest


def _manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or frozenset(value) != MANIFEST_KEYS:
        raise ValueError("Public lifecycle manifest has an invalid schema")
    if value.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("Public lifecycle manifest schema is unsupported")
    site_url = value.get("site_url")
    if not isinstance(site_url, str):
        raise ValueError("Public lifecycle manifest site URL is invalid")
    validate_release_site_url(site_url)
    digest = value.get("artifact_sha256")
    if (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(c not in "0123456789abcdef" for c in digest)
    ):
        raise ValueError("Public lifecycle manifest hash is invalid")
    mode, cycle = value.get("release_mode"), value.get("catalog_cycle_id")
    if mode not in {"trusted", "observed_partial"} or not isinstance(cycle, str) or not cycle:
        raise ValueError("Public lifecycle manifest identity is invalid")
    if value.get("release_id") != f"{mode}:{cycle}:{digest[:24]}":
        raise ValueError("Public lifecycle manifest release_id is invalid")
    if (
        value.get("projection_path") != PROJECTION_NAME
        or type(value.get("projection_bytes")) is not int
        or not 0 < value["projection_bytes"] <= MAX_PUBLIC_BYTES
    ):
        raise ValueError("Public lifecycle manifest projection is invalid")
    if (
        value.get("build_code") != BUILD_CODE
        or value.get("build_version") != BUILD_VERSION
        or not isinstance(value.get("provenance"), dict)
    ):
        raise ValueError("Public lifecycle manifest build contract is invalid")
    artifacts = value.get("public_artifacts")
    if not isinstance(artifacts, dict) or set(artifacts) - {MARKET_REPORTS_PATH}:
        raise ValueError("Public lifecycle manifest artifacts are invalid")
    for _path, metadata in artifacts.items():
        if not isinstance(metadata, dict) or set(metadata) != {"sha256", "bytes"}:
            raise ValueError("Public lifecycle manifest artifact metadata is invalid")
        digest, size = metadata.get("sha256"), metadata.get("bytes")
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(char not in "0123456789abcdef" for char in digest)
            or type(size) is not int
            or not 0 < size <= MAX_MARKET_REPORTS_BYTES
        ):
            raise ValueError("Public lifecycle manifest artifact hash is invalid")
    return value


def _verify_public_artifacts(
    manifest: dict[str, Any],
    transport: Callable[[str], bytes | TransportResponse],
    site_url: str,
) -> None:
    """Verify the bounded market JSON named by the immutable release manifest."""
    artifacts = manifest["public_artifacts"]
    assert isinstance(artifacts, dict)
    for path, metadata in artifacts.items():
        public = _response(transport, f"{site_url}/{path}")
        if (
            len(public) != metadata["bytes"]
            or hashlib.sha256(public).hexdigest() != metadata["sha256"]
        ):
            raise ValueError("Public market artifact bytes do not match lifecycle manifest")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def default_transport(url: str) -> TransportResponse:
    """Small strict HTTP client: HTTPS response only, no redirects or auth."""
    try:
        with build_opener(_NoRedirect).open(
            Request(url, headers={"Accept": "application/json"}), timeout=15
        ) as response:
            body = response.read(MAX_PUBLIC_BYTES + 1)
            return TransportResponse(
                body, response.status, response.url, response.headers.get_content_type()
            )
    except HTTPError as exc:
        return TransportResponse(
            exc.read(MAX_PUBLIC_BYTES + 1), exc.code, exc.url, exc.headers.get_content_type()
        )


def _response(transport: Callable[[str], bytes | TransportResponse], url: str) -> bytes:
    response = transport(url)
    if isinstance(response, bytes):  # lightweight test transport
        response = TransportResponse(response, url=url)
    if (
        not isinstance(response, TransportResponse)
        or response.status != 200
        or response.url not in {"", url}
    ):
        raise ValueError("Public lifecycle transport did not return the exact HTTPS resource")
    if (
        response.content_type not in {"application/json", "text/json"}
        or len(response.body) > MAX_PUBLIC_BYTES
    ):
        raise ValueError("Public lifecycle transport response is unsafe")
    return response.body


def deployed_manifest(
    transport: Callable[[str], bytes | TransportResponse], site_url: str = PRODUCTION_SITE_URL
) -> dict[str, Any]:
    """Fetch only the exact production-origin manifest; transport is injectable."""
    validate_release_site_url(site_url)
    url = f"{site_url}/{MANIFEST_NAME}"
    raw = _response(transport, url)
    try:
        return _manifest(json.loads(raw))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Public lifecycle manifest is unreadable") from exc


def _published_receipt(data: bytes, receipt: dict[str, Any]) -> dict[str, Any]:
    candidate = dict(receipt, publication_state="candidate", published_at=None)
    if receipt.get("release_mode") == "legacy_baseline":
        # Legacy is a published-base label only; it is never an export
        # candidate and must retain the observed-partial safety semantics.
        payload = json.loads(data)
        _strict_legacy_bootstrap(payload)
        digest = hashlib.sha256(data).hexdigest()
        if (
            receipt.get("artifact_sha256") != digest
            or not isinstance(receipt.get("catalog_cycle_id"), str)
            or receipt.get("release_id")
            != f"legacy_baseline:{receipt['catalog_cycle_id']}:{digest[:24]}"
        ):
            raise ValueError("Published legacy lifecycle receipt is invalid")
    else:
        _candidate_receipt(data, candidate)
    if receipt.get("publication_state") != "published" or not isinstance(
        receipt.get("published_at"), str
    ):
        raise ValueError("Published lifecycle receipt is invalid")
    try:
        moment = datetime.fromisoformat(receipt["published_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Published lifecycle receipt has invalid published_at") from exc
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError("Published lifecycle receipt has invalid published_at")
    return receipt


def _release_rank(payload: dict[str, Any]) -> datetime | None:
    provenance = payload.get("provenance")
    if not isinstance(provenance, dict):
        return None
    release = provenance.get("catalog_cycle") or provenance.get("release")
    if not isinstance(release, dict):
        return None
    stamps = [release.get(key) for key in ("finalized_at", "observed_at", "started_at")]
    for value in stamps:
        if isinstance(value, str):
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                continue
            if parsed.tzinfo is not None and parsed.utcoffset() is not None:
                return parsed.astimezone(UTC)
    return None


def _strict_legacy_bootstrap(payload: dict[str, Any]) -> None:
    """The one escape hatch for a pre-receipt lifecycle baseline is narrow.

    It is only an observed-partial projection: it must explicitly disclaim
    global freshness and absence inference, and cannot smuggle a source date
    from the old export into a new publication receipt.
    """
    try:
        _observed_partial_release(payload)
    except ValueError as exc:
        raise ValueError(
            "Legacy bootstrap requires a strict observed-partial lifecycle baseline"
        ) from exc


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _current_generation(exports: Path) -> tuple[Path, bytes, dict[str, Any], dict[str, Any]] | None:
    """Read both immutable files through one captured generation pointer."""
    pointer = exports / "published.current"
    if not pointer.exists() and not pointer.is_symlink():
        return None
    if not pointer.is_symlink():
        raise ValueError("Published lifecycle pointer is unsafe")
    target = os.readlink(pointer)
    if (
        not target.startswith("releases/")
        or Path(target).is_absolute()
        or ".." in Path(target).parts
    ):
        raise ValueError("Published lifecycle pointer is unsafe")
    generation = (exports / target).resolve()
    releases = (exports / "releases").resolve()
    if not generation.is_relative_to(releases) or not generation.is_dir():
        raise ValueError("Published lifecycle pointer is unsafe")
    artifact, receipt_path = generation / "published.json", generation / "published.release.json"
    try:
        data = artifact.read_bytes()
        receipt = _published_receipt(data, json.loads(receipt_path.read_text("utf-8")))
        payload = json.loads(data)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Published lifecycle generation is unreadable") from exc
    return generation, data, receipt, payload


def load_current_published(state_dir: Path | str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Public consumer entrypoint: one pointer snapshot, never flat paths."""
    current = _current_generation(Path(state_dir) / "exports")
    if current is None:
        raise ValueError("Explicit published lifecycle artifact and receipt are required")
    _, _, receipt, payload = current
    # Reuse the projection contract before a collector overlays observations.
    from export_history_projection import verify_published_lifecycle_artifact

    verify_published_lifecycle_artifact(payload, receipt)
    return payload, receipt


def _commit_generation(exports: Path, release_id: str, artifact: bytes, receipt: bytes) -> None:
    """Write an immutable pair, then atomically switch the single pointer."""
    if not release_id or "/" in release_id or ".." in release_id:
        raise ValueError("Lifecycle generation release id is unsafe")
    releases = exports / "releases"
    generation = releases / release_id
    if generation.exists():
        raise ValueError("Lifecycle generation already exists")
    generation.mkdir(parents=True, mode=0o700)
    try:
        atomic_write(generation / "published.json", artifact)
        atomic_write(generation / "published.release.json", receipt)
        _fsync_directory(generation)
        _fsync_directory(releases)
        pointer = exports / "published.current"
        temporary = exports / ".published.current.pending"
        temporary.unlink(missing_ok=True)
        os.symlink(f"releases/{release_id}", temporary)
        os.replace(temporary, pointer)
        _fsync_directory(exports)
    except BaseException:
        # Before the pointer switch, an orphan generation cannot be consumed.
        # After it, both immutable files were synced before the one atomic swap.
        (exports / ".published.current.pending").unlink(missing_ok=True)
        raise


def promote(
    candidate: Path,
    candidate_receipt: Path,
    state_dir: Path,
    *,
    transport: Callable[[str], bytes | TransportResponse] = default_transport,
    site_url: str = PRODUCTION_SITE_URL,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    bootstrap_legacy: bool = False,
) -> str:
    """Advance the private published base through one atomic generation pointer."""
    data = candidate.read_bytes()
    try:
        receipt = json.loads(candidate_receipt.read_text(encoding="utf-8"))
        payload = json.loads(data)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("Lifecycle candidate artifact or receipt is unreadable") from exc
    receipt = candidate_contract(data, receipt, payload)
    manifest = deployed_manifest(transport, site_url)
    expected = manifest_for_candidate(data, receipt, payload)
    # The static build adds public artifact hashes after the lifecycle bytes
    # are fixed. Compare lifecycle identity separately, then verify those
    # exact public bytes below; a private worker must never regenerate a
    # market projection while promoting its catalogue base.
    expected_lifecycle = {
        key: value for key, value in expected.items() if key != "public_artifacts"
    }
    if {key: manifest[key] for key in expected_lifecycle} != expected_lifecycle:
        raise ValueError("Public lifecycle manifest does not attest this candidate")
    public_data = _response(transport, f"{site_url}/{manifest['projection_path']}")
    if public_data != data:
        raise ValueError("Public lifecycle projection bytes do not match this candidate")
    _verify_public_artifacts(manifest, transport, site_url)

    exports = state_dir / "exports"
    current = _current_generation(exports)
    if current is not None:
        _, old_data, old_receipt, old_payload = current
        if old_receipt["release_id"] == receipt["release_id"]:
            if old_data != data:
                raise ValueError("Published lifecycle release id has conflicting bytes")
            return "already_published"
        if (
            old_receipt["release_mode"] == "legacy_baseline"
            and old_receipt["catalog_cycle_id"] == receipt["catalog_cycle_id"]
            and old_data == data
        ):
            return "already_published"
        if bootstrap_legacy:
            raise ValueError("Legacy lifecycle bootstrap is allowed only once")
        old_rank, candidate_rank = _release_rank(old_payload), _release_rank(payload)
        if old_rank is None or candidate_rank is None:
            raise ValueError("Lifecycle promotion refuses an unranked baseline or candidate")
        if candidate_rank <= old_rank:
            raise ValueError("Lifecycle promotion refuses rollback or equal-ranked replacement")
    elif not bootstrap_legacy:
        raise ValueError("Published lifecycle baseline is absent; use explicit strict bootstrap")
    else:
        _strict_legacy_bootstrap(payload)

    published_at = now().astimezone(UTC).isoformat().replace("+00:00", "Z")
    final_receipt = dict(receipt, publication_state="published", published_at=published_at)
    if bootstrap_legacy:
        final_receipt["release_mode"] = "legacy_baseline"
        final_receipt["release_id"] = (
            f"legacy_baseline:{receipt['catalog_cycle_id']}:{receipt['artifact_sha256'][:24]}"
        )
    _commit_generation(
        exports, final_receipt["release_id"], data, json_bytes(final_receipt) + b"\n"
    )
    return "bootstrapped" if bootstrap_legacy else "promoted"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--emit-manifest", action="store_true")
    group.add_argument("--promote", action="store_true")
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--candidate-receipt", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--site", default=PRODUCTION_SITE_URL)
    parser.add_argument("--bootstrap-legacy", action="store_true")
    args = parser.parse_args(argv)
    if args.emit_manifest:
        if args.out is None or args.state_dir is not None or args.bootstrap_legacy:
            parser.error("--emit-manifest requires --out only")
        emit_manifest(args.candidate, args.candidate_receipt, args.out)
        return 0
    if args.state_dir is None or args.out is not None:
        parser.error("--promote requires --state-dir and no --out")
    print(
        promote(
            args.candidate,
            args.candidate_receipt,
            args.state_dir,
            site_url=args.site,
            bootstrap_legacy=args.bootstrap_legacy,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
