"""Build the phone-first site from the exported data.

The first page was one long scroll with a city-sized point cloud on top; this
one is three screens joined by the map, because the reader's question is not
"show me everything" but "is *this* place cheap". The map is the navigation:
the city's real districts on the first screen, one district and its neighbours
on the second, one lot at the end — each a URL, so any level can be sent to
somebody.

Reads data/site.json (written by export_site.py), traces every city's outlines
with shapes.py, and writes site/v2/index.html.

Strings never appear here or in app.js. They live in site/i18n/<lang>.json and
reach the page through t(); this runs the same contract check build.py does, so
a key the page asks for and no catalogue answers fails the build instead of
printing a bracketed key at a reader.

Run: .venv/bin/python -u experiments/brazil/proto_build.py
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
import re
import sqlite3
import statistics
import sys
import unicodedata
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / "site"))
import build as classic
import shapes
from market_release import compact_json as market_compact_json
from market_release import lifecycle_binding, public_artifact
from public_config import (
    analysis_script_src,
    app_script_src,
    copy_script_src,
    snippet,
    stylesheet_href,
)
from release_check import validate_release_site_url
from release_promotion import (
    MANIFEST_NAME,
    PROJECTION_NAME,
    atomic_write,
    candidate_contract,
    emit_manifest,
)
from seo import source_date, validate_site_url

HERE = Path(__file__).parent
SITE = HERE / "site" / "v2"
DATA = HERE / "data" / "site.json"
MARKET_REPORTS = HERE / "data" / "market_reports.json"
PUBLIC_MARKET_REPORTS = HERE / "site" / "data" / "market_reports.json"
# Generated offline by export_lot_media.py from already saved auction
# snapshots.  This file is deliberately optional: a catalogue refresh must
# never stop publishing just because no approved photo projection exists yet.
LOT_MEDIA = HERE / "data" / "lot-media.json"
DOCUMENT_REPORTS = HERE / "site" / "content" / "document-reports.json"
# Reviewed, hand-authored context for a publishable area or street.  This is
# intentionally a tiny editorial projection: it is never populated by a
# crawler and is embedded at build time rather than fetched by a reader.
LOCAL_PROFILES = HERE / "site" / "content" / "local-profiles.json"
SAVED_ANALYSES = HERE / "site" / "content" / "saved-analyses.json"
LIFECYCLE_RECEIPT = HERE / "data" / "site.json.release.json"

# A profile is editorial work, not a mechanism for opening arbitrary landing
# pages.  Start with the routes selected for the twenty-page pilot; additional
# places require an explicit code review of both the route and its sources.
PILOT_LOCAL_PROFILE_ROUTES = {
    "area": {
        "rio-de-janeiro-rj": {"campo-grande", "santa-cruz", "barra-da-tijuca", "copacabana"},
        "recife-pe": {"poco-da-panela", "boa-viagem"},
        "sao-paulo-sp": {"jardim-paulista", "mooca"},
        "fortaleza-ce": {"praia-de-iracema", "farias-brito"},
    },
    "street": {
        "rio-de-janeiro-rj": {
            "rua-antonio-basilio",
            "avenida-rui-barbosa",
            "praia-do-flamengo",
            "rua-vilela-tavares",
            "rua-dos-invalidos",
            "estrada-do-campinho",
            "rua-andre-cavalcanti",
            "rua-prof-henrique-costa",
            "estrada-dos-bandeirantes",
            "avenida-nossa-senhora-de-copacabana",
        },
    },
}


def load_local_profiles(path: Path, cities: list[dict]) -> dict:
    """Load reviewed local context without making it an unbounded CMS.

    Profiles are optional, but an artifact which *is* present is strict: each
    entry names an already-published city route and its public area/street
    URL slug, carries
    a dated source trail, and provides the three shipped interface languages.
    The normalized return value is deliberately route-keyed so the browser can
    only render context on its matching page.
    """
    empty: dict[str, dict[str, dict[str, Any]]] = {"area": {}, "street": {}}
    if not path.exists():
        return empty
    try:
        data = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("invalid local profiles JSON") from exc
    if set(data) != {"schema", "license", "profiles"} or data["schema"] != "local-profiles-v1":
        raise ValueError("invalid local profiles schema")
    expected_license = {
        "scope": "OpenStreetMap-derived POI counts and names in these profiles",
        "attribution": "© OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "url": "https://www.openstreetmap.org/copyright",
    }
    if data["license"] != expected_license:
        raise ValueError("invalid local profiles license")
    if not isinstance(data["profiles"], list):
        raise ValueError("invalid local profiles list")

    def route_slug(value: str) -> str:
        folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
        return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", folded.lower()))

    route_keys: dict[str, dict[str, dict[str, str | None]]] = {}
    for city in cities:
        areas: dict[str, str | None] = {}
        for key, name in ((city.get("shapes") or {}).get("nice") or {}).items():
            route = route_slug(name)
            if route in areas and areas[route] != key:
                route = route + "-" + route_slug(key)[:6]
            areas[route] = key
        streets: dict[str, str | None] = {}
        for key, street in ((city.get("streets") or {}).get("d") or {}).items():
            street_route = street.get("slug") if isinstance(street, dict) else None
            if not isinstance(street_route, str) or not street_route:
                continue
            streets[street_route] = None if street_route in streets else key
        route_keys[city["slug"]] = {"area": areas, "street": streets}
    required = {
        "scope",
        "city",
        "route",
        "observed_at",
        "summary",
        "attribution",
        "limitations",
        "citations",
    }

    def text(value: Any, limit: int) -> bool:
        return (
            isinstance(value, str)
            and 0 < len(value.strip()) <= limit
            and not re.search(r"[<>\x00-\x08]", value)
        )

    def timestamp(value: Any) -> datetime:
        if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value
        ):
            raise ValueError("invalid local profile observed_at")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("invalid local profile observed_at") from exc
        if parsed.tzinfo is None:
            raise ValueError("invalid local profile observed_at")
        return parsed

    def source_url(value: Any) -> bool:
        if not isinstance(value, str) or not value or re.search(r"[\s<>\"'\\\\]", value):
            return False
        try:
            parsed = urlsplit(value)
        except ValueError:
            return False
        return (
            parsed.scheme == "https"
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and urlunsplit(parsed) == value
        )

    seen: set[tuple[str, str, str]] = set()
    result: dict[str, dict[str, dict[str, Any]]] = {"area": {}, "street": {}}
    for profile in data["profiles"]:
        if not isinstance(profile, dict) or set(profile) != required:
            raise ValueError("invalid local profile fields")
        scope, city_slug, route = profile["scope"], profile["city"], profile["route"]
        if (
            scope not in result
            or not isinstance(city_slug, str)
            or not isinstance(route, str)
            or route not in PILOT_LOCAL_PROFILE_ROUTES.get(scope, {}).get(city_slug, set())
            or route not in route_keys.get(city_slug, {}).get(scope, {})
            or route_keys[city_slug][scope][route] is None
        ):
            raise ValueError("local profile does not match published route")
        identity = (scope, city_slug, route)
        if identity in seen:
            raise ValueError("duplicate local profile")
        seen.add(identity)
        observed = timestamp(profile["observed_at"])
        localized = {}
        for field, limit in (("summary", 1200), ("attribution", 360), ("limitations", 700)):
            value = profile[field]
            if (
                not isinstance(value, dict)
                or set(value) != {"pt", "en", "ru"}
                or not all(text(value[lang], limit) for lang in value)
            ):
                raise ValueError(f"invalid local profile {field}")
            localized[field] = value
        citations = profile["citations"]
        if not isinstance(citations, list) or not 1 <= len(citations) <= 8:
            raise ValueError("invalid local profile citations")
        cleaned_citations = []
        for citation in citations:
            if not isinstance(citation, dict) or set(citation) != {
                "label",
                "url",
                "observed_at",
                "evidence",
            }:
                raise ValueError("invalid local profile citation")
            citation_observed = timestamp(citation["observed_at"])
            if citation_observed > observed or not source_url(citation["url"]):
                raise ValueError("invalid local profile citation")
            localized_citation = {}
            for field, limit in (("label", 180), ("evidence", 700)):
                value = citation[field]
                if (
                    not isinstance(value, dict)
                    or set(value) != {"pt", "en", "ru"}
                    or not all(text(value[lang], limit) for lang in value)
                ):
                    raise ValueError("invalid local profile citation")
                localized_citation[field] = value
            cleaned_citations.append(
                {
                    **localized_citation,
                    "url": citation["url"],
                    "observed_at": citation["observed_at"],
                }
            )
        # The public artifact says `route`, while the renderer receives the
        # data key it already uses after route parsing.  This keeps authored
        # content bound to a URL without duplicating routing logic in JSON.
        key = route_keys[city_slug][scope][route]
        if key is None:  # Defensive narrowing; duplicate slugs were rejected above.
            raise ValueError("local profile route is ambiguous")
        result[scope].setdefault(city_slug, {})[key] = {
            "observed_at": profile["observed_at"],
            **localized,
            "citations": cleaned_citations,
        }
    return result


def load_document_reports(path: Path, source: dict) -> dict:
    """Only reviewed, non-personal screenshot summaries for an exact source ID.

    These are versioned editorial artifacts, never original-PDF cache entries.
    Missing lots are omitted; malformed or mismatched reports fail the build.
    """
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if set(data) != {"schema", "reports"} or data["schema"] != "reviewed-screenshot-reports-v1":
        raise ValueError("invalid document reports schema")
    cols = {name: i for i, name in enumerate(source["cols"])}
    rows = {str(row[cols["id"]]): row for city in source["cities"] for row in city["rows"]}
    result = {}
    allowed = {
        "source_kind",
        "original_pdf_available",
        "reviewed",
        "source_id",
        "source_url",
        "captured_at",
        "document_date",
        "page_count",
        "language",
        "model",
        "summary",
        "findings",
        "unknowns",
        "next_checks",
        "limitations",
    }

    def safe(value):
        return (
            isinstance(value, str)
            and 0 < len(value) <= 2000
            and not re.search(r"[<>\x00-\x08]", value)
        )

    for lot_id, report in data["reports"].items():
        if (
            not re.fullmatch(r"[a-f0-9]{16}", lot_id)
            or not isinstance(report, dict)
            or set(report) != allowed
        ):
            raise ValueError("invalid reviewed report fields")
        if (
            report["source_kind"] != "browser_screenshots"
            or report["original_pdf_available"] is not False
            or report["reviewed"] is not True
            or report["language"] != "pt"
            or type(report["page_count"]) is not int
            or not 1 <= report["page_count"] <= 150
            or not isinstance(report["source_id"], str)
            or not re.fullmatch(r"\d{8,20}", report["source_id"])
        ):
            raise ValueError("invalid reviewed report provenance")
        expected = (
            "https://venda-imoveis.caixa.gov.br/sistema/detalhe-imovel.asp?hdnimovel="
            + report["source_id"]
        )
        if report["source_url"] != expected:
            raise ValueError("invalid reviewed report source")
        try:
            captured = datetime.fromisoformat(report["captured_at"].replace("Z", "+00:00"))
            document_day = date.fromisoformat(report["document_date"])
            if captured.tzinfo is None or document_day > captured.date():
                raise ValueError("invalid report chronology")
        except (TypeError, AttributeError, ValueError) as exc:
            raise ValueError("invalid reviewed report date") from exc
        if not safe(report["summary"]) or not safe(report["model"]):
            raise ValueError("invalid reviewed report text")
        for key in ("unknowns", "next_checks", "limitations"):
            if (
                not isinstance(report[key], list)
                or not 1 <= len(report[key]) <= 12
                or not all(safe(x) for x in report[key])
            ):
                raise ValueError("invalid reviewed report section")
        if not isinstance(report["findings"], list) or not 1 <= len(report["findings"]) <= 12:
            raise ValueError("invalid reviewed report findings")
        for finding in report["findings"]:
            if (
                not isinstance(finding, dict)
                or set(finding) != {"page", "title", "quote", "text"}
                or type(finding["page"]) is not int
                or not 1 <= finding["page"] <= report["page_count"]
                or not all(safe(finding[k]) for k in ("title", "quote", "text"))
            ):
                raise ValueError("invalid reviewed report citation")
        row = rows.get(lot_id)
        if row is None:
            continue
        if row[cols["src"]] != "caixa" or row[cols["link"]] != expected:
            raise ValueError("document report does not match catalog source")
        result[lot_id] = report
    return result


MARKET_KEYS = {
    "schema",
    "currency",
    "sale_asking",
    "discount_pct",
    "rent_monthly",
    "yield_pct",
    "condo_monthly",
    "sample",
    "disclaimer",
    "comparables",
}
MARKET_RANGE_KEYS = {"min", "max"}
MARKET_SAMPLE_KEYS = {"count", "radius_m", "freshness_days", "confidence"}
MARKET_CONFIDENCE = {"high", "medium", "low"}
MAX_MEDIA_PER_LOT = 24


def _safe_public_media_url(value: Any) -> str | None:
    """Return one image URL safe to place in a public HTML payload.

    ``export_lot_media.py`` has a stricter source-side allowlist.  This
    second, independent boundary matters because this module is the final
    writer of the browser payload: no source-only query token, credential,
    fragment, local address or script-looking value can pass through merely
    because a stale or hand-edited artifact contains it.
    """
    if not isinstance(value, str) or not value or len(value) > 2048:
        return None
    if any(char.isspace() for char in value) or any(char in value for char in "<>'\\\""):
        return None
    try:
        parsed = urlsplit(value)
        hostname = (parsed.hostname or "").lower().rstrip(".")
        # Accessing .port also validates malformed ports such as :not-a-port.
        port = parsed.port
    except ValueError:
        return None
    if (
        parsed.scheme.lower() != "https"
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or port not in (None, 443)
    ):
        return None
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(".local"):
            return None
    else:
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
            or address.is_multicast
            or address.is_unspecified
        ):
            return None
    path = parsed.path or "/"
    return urlunsplit(("https", hostname, path, "", ""))


def _public_media_urls(values: Any) -> list[str]:
    """Normalise a list of media values without changing its visible order."""
    if not isinstance(values, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        # New media uses gallery entries; legacy media used plain URL arrays.
        candidate = value.get("url") if isinstance(value, dict) else value
        url = _safe_public_media_url(candidate)
        if url and url not in seen:
            seen.add(url)
            result.append(url)
        if len(result) >= MAX_MEDIA_PER_LOT:
            break
    return result


def load_lot_media(path: Path, published_lots: dict[str, set[str]]) -> dict[str, Any]:
    """Return the minimal, safe media projection for currently published lots.

    The exporter has emitted version 1 since its first release.  Earlier
    reviewed artifacts did not always carry a version field, so that shape is
    deliberately accepted as a legacy input.  Unknown cities and lot IDs are
    stale data, not a reason to make the whole public catalogue disappear.
    """
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read lot media {path}: {exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("cities"), dict):
        raise ValueError("lot media root must contain a cities object")
    version = raw.get("version")
    if version not in (None, 1):
        raise ValueError("lot media version must be 1")

    cities: dict[str, dict[str, dict[str, Any]]] = {}
    for city_slug in sorted(published_lots):
        source_city = raw["cities"].get(city_slug)
        if not isinstance(source_city, dict):
            continue
        lots: dict[str, dict[str, Any]] = {}
        for lot_id in sorted(published_lots[city_slug]):
            record = source_city.get(lot_id)
            if not isinstance(record, dict):
                continue
            # Preserve the ordered gallery for new exports.  We intentionally
            # omit exporter provenance here: it is not needed by the reader
            # and would make every public lot carry private snapshot names.
            gallery = _public_media_urls(record.get("gallery"))
            photos = _public_media_urls(record.get("photos"))
            primary = _safe_public_media_url(record.get("primary_photo"))
            if not gallery and not photos and not primary:
                continue
            compact: dict[str, Any] = {}
            if gallery:
                compact["gallery"] = [{"url": url} for url in gallery]
            if photos:
                compact["photos"] = photos
            if primary:
                compact["primary_photo"] = primary
            lots[lot_id] = compact
        if lots:
            cities[city_slug] = lots
    return {"version": 1, "cities": cities}


def _market_number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _market_range(value: Any, maximum: float, label: str) -> None:
    if not isinstance(value, dict) or set(value) != MARKET_RANGE_KEYS:
        raise ValueError(f"market report {label} must contain only min and max")
    if not _market_number(value["min"]) or not _market_number(value["max"]):
        raise ValueError(f"market report {label} values must be finite numbers")
    if value["min"] < 0 or value["max"] < value["min"] or value["max"] > maximum:
        raise ValueError(f"market report {label} range is invalid")


def _validate_market_report(value: Any, label: str) -> None:
    if not isinstance(value, dict) or set(value) not in (
        MARKET_KEYS,
        MARKET_KEYS - {"comparables"},
    ):
        raise ValueError(f"{label} has unsupported or missing market fields")
    if value["schema"] != "market-v1" or value["currency"] != "BRL":
        raise ValueError(f"{label} must be market-v1 in BRL")
    _market_range(value["sale_asking"], 100_000_000_000, f"{label}.sale_asking")
    discount = value["discount_pct"]
    if discount is not None and (not _market_number(discount) or discount < -100 or discount > 100):
        raise ValueError(f"{label}.discount_pct is invalid")
    for key, maximum in (("rent_monthly", 100_000_000), ("condo_monthly", 10_000_000)):
        current = value[key]
        if current is not None:
            _market_range(current, maximum, f"{label}.{key}")
    yield_pct = value["yield_pct"]
    if yield_pct is not None and (
        not _market_number(yield_pct) or yield_pct < 0 or yield_pct > 1000
    ):
        raise ValueError(f"{label}.yield_pct is invalid")
    sample = value["sample"]
    if not isinstance(sample, dict) or set(sample) != MARKET_SAMPLE_KEYS:
        raise ValueError(f"{label}.sample has unsupported or missing fields")
    for key, maximum in (("count", 1_000_000), ("radius_m", 100_000), ("freshness_days", 3650)):
        current = sample[key]
        if type(current) is not int or not 0 <= current <= maximum:
            raise ValueError(f"{label}.sample.{key} is invalid")
    if sample["confidence"] not in MARKET_CONFIDENCE:
        raise ValueError(f"{label}.sample.confidence is invalid")
    disclaimer = value["disclaimer"]
    if not isinstance(disclaimer, str) or not disclaimer.strip() or len(disclaimer) > 2000:
        raise ValueError(f"{label}.disclaimer is invalid")
    comparables = value.get("comparables")
    if comparables is None:
        # Private exporter input is the stable market-v1 aggregate.  The
        # release boundary appends independently sanitised direct evidence.
        return
    if not isinstance(comparables, list) or len(comparables) > 20:
        raise ValueError(f"{label}.comparables is invalid")
    for number, comparable in enumerate(comparables, 1):
        if not isinstance(comparable, dict) or set(comparable) != {
            "source",
            "url",
            "observed_at",
            "price_brl",
            "area_m2",
            "price_per_m2",
            "distance_m",
        }:
            raise ValueError(f"{label}.comparables[{number}] has invalid fields")
        if not isinstance(comparable["source"], str) or comparable["source"] not in {
            "ZAP Imóveis",
            "Viva Real",
        }:
            raise ValueError(f"{label}.comparables[{number}].source is invalid")
        url = comparable["url"]
        parsed = urlsplit(url) if isinstance(url, str) else None
        if (
            not isinstance(url, str)
            or not parsed
            or parsed.scheme != "https"
            or parsed.hostname
            not in {
                "zapimoveis.com.br",
                "www.zapimoveis.com.br",
                "vivareal.com.br",
                "www.vivareal.com.br",
            }
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
            or not parsed.path.startswith("/imove")
        ):
            raise ValueError(f"{label}.comparables[{number}].url is invalid")
        for key, maximum in (
            ("price_brl", 100_000_000_000),
            ("area_m2", 10_000_000),
            ("price_per_m2", 100_000_000_000),
            ("distance_m", 100_000),
        ):
            if (
                not _market_number(comparable[key])
                or comparable[key] < 0
                or comparable[key] > maximum
            ):
                raise ValueError(f"{label}.comparables[{number}].{key} is invalid")
        if not isinstance(comparable["observed_at"], str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z", comparable["observed_at"]
        ):
            raise ValueError(f"{label}.comparables[{number}].observed_at is invalid")


def market_release_binding(data_path: Path, receipt_path: Path) -> dict[str, str]:
    """Read the two lifecycle inputs once and derive the market binding.

    The receipt is deliberately not inferred from a build date, current DB
    state, or a previous public page.  Market numbers can only join the exact
    catalogue bytes they were calculated for.
    """
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        data = data_path.read_bytes()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("cannot read lifecycle artifact or receipt for market reports") from exc
    return lifecycle_binding(data, receipt)


def prepare_market_reports(
    path: Path,
    lot_ids: set[str],
    binding: dict[str, str] | None,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Build the one bounded public market file plus its deterministic lookup."""
    try:
        source = path.read_bytes() if path.exists() else None
    except OSError as exc:
        raise ValueError(f"cannot read market reports {path}: {exc}") from exc
    return public_artifact(
        source,
        binding=binding,
        known_lot_ids=lot_ids,
        validate_market=_validate_market_report,
    )


def _valid_source_freshness(value: Any) -> str | None:
    """Validate a documented ISO source date/timestamp without changing it."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("generated source metadata must be an ISO date or timestamp")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        observed = date.fromisoformat(value)
    elif re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?",
        value,
    ):
        observed = datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    else:
        raise ValueError("generated source metadata must be an ISO date or timestamp")
    if observed > date.today():
        raise ValueError("generated source metadata cannot be in the future")
    return value


def source_freshness(source: dict[str, Any]) -> str | None:
    """Return only freshness explicitly carried by the public projection.

    The projection is the public export's authority. Do not substitute a city
    date, file timestamp, git date, or this build's clock: none says when the
    underlying whole dataset was observed. A source timestamp is deliberately
    returned verbatim so its precision is not silently changed for the reader.
    """
    projection = source.get("site_projection")
    projection_generated = (
        projection.get("generated") if isinstance(projection, dict) else projection
    )
    generated = source.get("generated")
    candidates = (
        projection_generated,
        generated.get("source") if isinstance(generated, dict) else None,
        generated,
    )
    for value in candidates:
        if value is not None and value != "":
            return _valid_source_freshness(value)
    return None


def strict_release_freshness(source: dict[str, Any], release_mode: str) -> str | None:
    """Validate global freshness only after the attested mode is known."""
    generated = source_freshness(source)
    if release_mode == "observed_partial":
        if generated is not None:
            raise ValueError("observed-partial release cannot claim global source freshness")
        return None
    if release_mode != "trusted":
        raise ValueError("unsupported lifecycle release mode")
    # A common date on all city objects and catalog-cycle source_as_of are not
    # a declaration about the exact public artifact. Trusted publication needs
    # the projection's explicit whole-export date.
    source_date({"generated": source.get("generated"), "cities": []}, release=True)
    if generated is None:
        raise ValueError("trusted release requires top-level generated source metadata")
    return generated


def load_release_candidate(data_path: Path, receipt_path: Path) -> tuple[dict[str, Any], str]:
    """Bind candidate bytes, provenance and receipt before any output is written."""
    try:
        data = data_path.read_bytes()
        payload = json.loads(data)
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("cannot read lifecycle candidate artifact or receipt") from exc
    if not isinstance(payload, dict) or not isinstance(receipt, dict):
        raise ValueError("lifecycle candidate artifact or receipt has an invalid schema")
    candidate_contract(data, receipt, payload)
    return payload, receipt["release_mode"]


def projected_lifecycle(lifecycle: dict, *, as_of: datetime | None = None) -> dict:
    """Copy lifecycle state and age only stale active availability in UTC.

    This is a display-time policy for a committed snapshot, not source
    freshness. It never changes the export: missing and archived are retained,
    while an active record without a recent, non-future observation becomes
    unverified after three days.
    """
    as_of = as_of or datetime.now(UTC)
    if as_of.tzinfo is None:
        raise ValueError("as_of must be an explicit UTC timestamp")
    as_of = as_of.astimezone(UTC)
    copied = {
        key: dict(value) if isinstance(value, dict) else value for key, value in lifecycle.items()
    }
    for value in copied.values():
        if not isinstance(value, dict) or value.get("status") != "active":
            continue
        seen = value.get("last_seen_at")
        try:
            if not isinstance(seen, str):
                raise ValueError
            observed = datetime.fromisoformat(seen.replace("Z", "+00:00"))
            if observed.tzinfo is None:
                raise ValueError
            observed = observed.astimezone(UTC)
            if observed > as_of or as_of - observed > timedelta(days=3):
                value["status"] = "unverified"
        except ValueError:
            value["status"] = "unverified"
    return copied


def catalogue_for_freshness(catalogues: dict[str, dict], generated: str | None) -> dict[str, dict]:
    """Use the localized unknown-state footer when the export has no source date."""
    if generated is not None:
        return catalogues
    return {
        lang: {**catalogue, "foot.note": catalogue["foot.note.unknown"]}
        for lang, catalogue in catalogues.items()
    }


def copy_top_metadata(payload: dict, source: dict) -> None:
    """Pass renderer contracts through exactly when the export supplies them."""
    for key in ("provenance", "lifecycle_schema_version"):
        if key in source:
            payload[key] = source[key]


#: Same reliability gate the page draws with, so the headline counts and the
#: per-lot verdicts can never disagree.
TIGHT_RING_M = 1000

#: A promise this large is the one the platforms actually advertise; the share
#: of those that still open above the going hammer is the site's whole argument.
LOUD_PROMISE = 45.0

#: What a crawler that runs no JS sees in <title> and the description, and what
#: a reader gets before the runtime has picked their language. Brazilian
#: Portuguese, because the readers are Brazilian — deliberately not
#: `build.REFERENCE`, which is the language the *contract* is measured against
#: and stays Russian only because that is the one a human here can proofread.
DEFAULT_LANG = "pt"

#: Timezone -> city, so the page can open on the right place without asking for
#: a location. Every Brazilian city we cover shares one zone today, so this only
#: separates Brazil from everywhere else; it is here for when that stops being
#: true.
TZ = {
    "RIO DE JANEIRO": "America/Sao_Paulo",
    "SAO GONCALO": "America/Sao_Paulo",
    "SAO PAULO": "America/Sao_Paulo",
    "FORTALEZA": "America/Fortaleza",
    "RECIFE": "America/Recife",
}


#: Where each city's map geometry comes from. Three cities, three answers,
#: because Brazil publishes its boundaries unevenly — and the page says which
#: one it used rather than implying every map is the same kind of fact.
#:
#: `polys` is always preferable: those are the city's own boundaries. `points`
#: infers them from where addresses are, which is a real picture at the
#: resolution stated and not a legal border.
#:
#: `unit` and `source` are translation keys, not sentences. The build knows
#: which of three very different things it traced; saying so in the reader's
#: language is the page's job.
SHAPES: dict[str, dict[str, Any]] = {
    "RIO DE JANEIRO": {
        "kind": "points",
        "db": "rio_cadlog.sqlite",
        "sql": "select lat, lon, bairro from streets where lat is not null and bairro is not null",
        "cell": 70.0,
        "maxd": 500.0,
        "unit": "district",
        "source": "map.source.rio_cadastre",
        "exact": False,
    },
    "SAO PAULO": {
        "kind": "polys",
        "file": "sp_distritos.geojson",
        "field": "nm_distrito_municipal",
        "cell": 80.0,
        "unit": "borough",
        "source": "map.source.sp_geosampa",
        "exact": True,
    },
    "SAO GONCALO": {
        "kind": "points",
        "zap": "São Gonçalo",
        "cell": 80.0,
        "maxd": 800.0,
        "unit": "district",
        "source": "map.source.sg_points",
        "exact": False,
    },
    # IBGE's census address register (CNEFE): a district label on every address
    # in the country. Coarser than Rio's cadastre but national — it is how a
    # city with no open cadastre still gets real outlines instead of a search
    # box. Rows labelled with the city's own name are census noise, dropped.
    "FORTALEZA": {
        "kind": "points",
        "db": "cnefe_points.sqlite",
        "sql": "select lat, lon, bairro from points where city = 'FORTALEZA' "
        "and bairro is not null and upper(bairro) <> 'FORTALEZA'",
        "cell": 80.0,
        "maxd": 600.0,
        "unit": "district",
        "source": "map.source.cnefe",
        "titlecase": True,
        "exact": False,
    },
    "RECIFE": {
        "kind": "points",
        "db": "cnefe_points.sqlite",
        "sql": "select lat, lon, bairro from points where city = 'RECIFE' "
        "and bairro is not null and upper(bairro) <> 'RECIFE'",
        "cell": 80.0,
        "maxd": 600.0,
        "unit": "district",
        "source": "map.source.cnefe",
        "titlecase": True,
        "exact": False,
    },
}


def norm(s: str) -> str:
    """`Brás de Pina` and `BRAS DE PINA` are the same district in two feeds."""
    s = unicodedata.normalize("NFKD", (s or "").strip())
    return "".join(ch for ch in s if not unicodedata.combining(ch)).upper()


#: Same rule as the front end's `title()`: connectives stay down.
_SMALL = {"de", "da", "do", "das", "dos", "e", "em", "a", "o"}


def pt_title(s: str) -> str:
    """BOA VIAGEM -> Boa Viagem. CNEFE shouts; a page heading should not."""
    words = (s or "").lower().split()
    return " ".join(w if i and w in _SMALL else w.capitalize() for i, w in enumerate(words))


def _point_source(cfg: dict) -> list[tuple[float, float, str]]:
    """Labelled coordinates, from a cadastre if we have one and listings if not."""
    out: list[tuple[float, float, str]] = []
    if cfg.get("db"):
        db = DATA.parent / cfg["db"]
        if not db.exists():
            return []
        out += list(sqlite3.connect(db).execute(cfg["sql"]))
    if cfg.get("zap"):
        zap = DATA.parent / "zap.sqlite"
        if zap.exists():
            out += list(
                sqlite3.connect(zap).execute(
                    "select lat, lon, neighborhood from listings where city = ? "
                    "and lat is not null and neighborhood is not null and neighborhood <> ''",
                    (cfg["zap"],),
                )
            )
        lots = DATA.parent / "lots.sqlite"
        if lots.exists():
            out += list(
                sqlite3.connect(lots).execute(
                    "select lat, lon, bairro from lots where cidade_norm = ? and lat is not null "
                    "and bairro is not null and geo_precision <> 'cidade'",
                    (norm(cfg["zap"]),),
                )
            )
    return out


#: Traced outlines, written by whichever build had the geometry sources and
#: read by whichever build does not. The public repository that GitHub builds
#: the site from carries `site.json` but not the 30-136 MB point registers the
#: outlines are traced from — without this cache its build would silently ship
#: every city without a map. Written and read as one file next to site.json,
#: so the lot-to-area mapping inside it is always from the same run as the
#: lots themselves.
SHAPE_CACHE = HERE / "data" / "shapes_cache.json"
_shape_cache: dict[str, Any] | None = None
_shape_fresh: dict[str, Any] = {}


def _cached_outline(cidade: str) -> dict | None:
    global _shape_cache
    if _shape_cache is None:
        _shape_cache = json.loads(SHAPE_CACHE.read_text()) if SHAPE_CACHE.exists() else {}
    hit = _shape_cache.get(cidade)
    if hit:
        print(f"  {cidade}: геометрии-источника нет — контуры из shapes_cache.json", flush=True)
    return hit if isinstance(hit, dict) else None


def save_shape_cache() -> None:
    """Persist what this run traced, keeping cached entries it had to reuse."""
    if not _shape_fresh:
        return
    merged = {**(_shape_cache or {}), **_shape_fresh}
    SHAPE_CACHE.write_text(json.dumps(merged, ensure_ascii=False, separators=(",", ":")))
    kb = SHAPE_CACHE.stat().st_size / 1024
    print(f"data/shapes_cache.json — {kb:,.0f} KB, {len(merged)} городов", flush=True)


def outlines(cidade: str, rows: list, cols: dict[str, int]) -> dict | None:
    """The city's map: one outline per area, and which area each lot sits in.

    Lots are placed on the map by coordinate, never by name. The auction feeds
    write GUAIANAZES where São Paulo writes GUAIANASES, and most of that city's
    lots carry a street-level neighbourhood no boundary file has ever heard of;
    matching those strings threw away two lots in three. The raster knows what
    is under a pair of coordinates, so it answers instead.
    """
    cfg = SHAPES.get(cidade)
    if not cfg:
        return None

    if cfg["kind"] == "polys":
        path = DATA.parent / cfg["file"]
        if not path.exists():
            return _cached_outline(cidade)
        feats = json.loads(path.read_text())["features"]
        nice: dict[str, str] = {}
        for f in feats:
            nm = f["properties"][cfg["field"]]
            nice.setdefault(norm(nm), nm.title())
        keys = sorted(nice)
        gid = {k: i for i, k in enumerate(keys)}
        polys = []
        for f in feats:
            g = f["geometry"]
            rings = (
                g["coordinates"]
                if g["type"] == "Polygon"
                else [r for part in g["coordinates"] for r in part]
            )
            polys.append((gid[norm(f["properties"][cfg["field"]])], rings))
        lab, geo = shapes.rasterise_polys(polys, cell_m=cfg["cell"])
    else:
        pts = _point_source(cfg)
        if len(pts) < 500:
            return _cached_outline(cidade)
        nice = {}
        for _, _, b in pts:
            nice.setdefault(norm(b), pt_title(b) if cfg.get("titlecase") else b)
        keys = sorted(nice)
        gid = {k: i for i, k in enumerate(keys)}
        lab, geo = shapes.rasterise(
            [(la, lo, gid[norm(b)]) for la, lo, b in pts],
            cell_m=cfg["cell"],
            max_d_m=cfg["maxd"],
        )

    paths = shapes.trace(lab, list(range(len(keys))))
    if not paths:
        return None

    of: dict[str, str] = {}
    for r in rows:
        la, lo = r[cols["lat"]], r[cols["lon"]]
        if la is None or lo is None:
            continue
        g = shapes.locate(geo, lab, la, lo)
        if g >= 0 and g in paths:
            of[str(r[cols["id"]])] = keys[g]

    boxes = [v["box"] for v in paths.values()]
    out = {
        "unit": cfg["unit"],
        "source": cfg["source"],
        "exact": cfg["exact"],
        "cols": geo["cols"],
        "rows": geo["rows"],
        # The inhabited extent, so the page frames the city and not the padding
        # the raster needed around it.
        "box": [
            min(b[0] for b in boxes),
            min(b[1] for b in boxes),
            max(b[2] for b in boxes),
            max(b[3] for b in boxes),
        ],
        "nice": {keys[g]: nice[keys[g]] for g in paths},
        "d": {keys[g]: v["d"] for g, v in paths.items()},
        # label anchor, then the area's own box — the page needs the box both to
        # decide whether a name fits and to frame a single area.
        "at": {keys[g]: [v["cx"], v["cy"]] + v["box"] for g, v in paths.items()},
        "of": of,
    }
    _shape_fresh[cidade] = out
    return out


def market(cidade: str, keys: set[str]) -> dict[str, Any]:
    """What was actually paid per m² in each district, from `itbi_bairro.py`.

    The reason a district page with no lots is still a page worth having: it
    carries a number about the district itself, computed here, rather than a
    stub around a search term. Only districts the map knows are carried, and
    only from cities whose town hall publishes the register — everywhere else
    the page omits the block instead of inventing one.
    """
    path = DATA.parent / "itbi_bairro.json"
    if not path.exists():
        return {}
    c = json.loads(path.read_text()).get("cities", {}).get(cidade)
    if not c:
        return {}
    out: dict[str, Any] = {
        "year": c["year"],
        # "base_value" marks the cities whose register holds max(declared,
        # appraised) rather than the declared price — the page must say so.
        "basis": c.get("basis") or "aggregates",
        "city": {
            "flat": c["city"].get("f"),
            "house": c["city"].get("h"),
            "res": c["city"].get("r"),
        },
        "d": {k: v for k, v in c["d"].items() if k in keys and v},
    }
    return out if out["d"] else {}


def upkeep(cidade: str, keys: set[str]) -> dict[str, Any]:
    """Median condominium fee per district, from `condo_costs.py`.

    Listings are a legitimate source for this one number even though the site
    refuses to value property by them: the fee is a fact about the building,
    not a seller's position. IPTU is deliberately absent — see condo_costs.py
    for why that field cannot be trusted yet.
    """
    path = DATA.parent / "condo_bairro.json"
    if not path.exists():
        return {}
    doc = json.loads(path.read_text()).get(cidade)
    if not doc:
        return {}
    d = {k: v["c"] for k, v in doc["d"].items() if k in keys and v.get("c")}
    return {"city": doc["city"]["condo"], "d": d} if d else {}


def streets(cidade: str, keys: set[str]) -> dict[str, Any]:
    """Street-level medians from `itbi_street.py`, for cities that have them.

    Filtered to streets whose home district is on the map, because the street
    page leans on its district for the comparison and the way back. Streets
    lost here are counted out loud rather than silently.
    """
    path = DATA.parent / "itbi_street.json"
    if not path.exists():
        return {}
    doc = json.loads(path.read_text())
    if doc.get("city") != cidade:
        return {}
    kept = {
        c: dict(r, bairros=[b for b in r["bairros"] if b in keys])
        for c, r in doc["streets"].items()
        if r["bairro"] in keys
    }
    dropped = len(doc["streets"]) - len(kept)
    if dropped:
        print(f"  {cidade}: {dropped} улиц вне карты районов — пропущены")
    by = {k: [c for c in v if c in kept] for k, v in doc["by"].items() if k in keys}
    return {"year": doc["year"], "d": kept, "by": {k: v for k, v in by.items() if v}}


def borrowed(c: dict) -> dict[str, str]:
    """Which links of the price chain this city did not measure itself.

    Only São Paulo publishes both halves — its own ITBI *and* enough finished
    auctions to price a hammer. Everyone else borrows a link, and a city that
    borrows one is not entitled to the same sentence as a city that measured
    it, so the page is handed the donors by name instead of a boolean.
    """
    chain = c.get("chain") or {}
    if not chain.get("transferred"):
        return {}
    basis = chain.get("basis") or ""
    out: dict[str, str] = {}
    m = re.search(r"asking premium from ([^,]+)", basis)
    if m:
        out["premium"] = m.group(1).strip()
    m = re.search(r"auction factor from ([^,]+)", basis) or re.search(
        r"transferred from ([^,]+)", basis
    )
    if m and "auction" in chain["transferred"]:
        out["auction"] = m.group(1).strip()
    return out


def build_city(c: dict, cols: dict[str, int], *, as_of: datetime | None = None) -> dict:
    rows = c["rows"]
    lifecycle = projected_lifecycle(c.get("lifecycle") or {}, as_of=as_of)
    current = [r for r in rows if lifecycle.get(str(r[cols["id"]]), {}).get("status") == "active"]
    unverified = [
        r
        for r in rows
        if lifecycle.get(str(r[cols["id"]]), {}).get("status")
        not in {"active", "missing", "archived"}
    ]

    def reliable(r):
        return r[cols["conf"]] == "ok" and (r[cols["ring"]] or 0) <= TIGHT_RING_M

    rel = [r for r in current if reliable(r)]

    promised = [r[cols["promised"]] for r in rel if r[cols["promised"]] is not None]
    loud = [r for r in rel if (r[cols["promised"]] or 0) >= LOUD_PROMISE]

    stats = {
        "lots": len(current),
        "unverified": len(unverified),
        "reliable": len(rel),
        "below": sum(1 for r in rel if r[cols["margin"]] > 0),
        "paid_deals": c.get("paid_deals") or 0,
        "listings": c.get("listings") or 0,
        # Their claim and ours, side by side. `real_med` is signed the way a
        # reader thinks: positive means the median lot opens *above* the price
        # auctions really end at.
        "promised_med": round(statistics.median(promised), 1) if promised else None,
        "real_med": round(-statistics.median(r[cols["margin"]] for r in rel), 1) if rel else None,
        "promised_hi_n": len(loud),
        "above_hammer": sum(1 for r in loud if r[cols["margin"]] < 0),
        # Within the loud group, not city-wide: the sentence next to these
        # numbers says "and the other way round", and a counterpart drawn from
        # a different population is not the other way round of anything.
        "loud_below": sum(1 for r in loud if r[cols["margin"]] > 0),
    }

    shp = outlines(c["cidade"], rows, cols)

    # UF disambiguates cities; it does not imply that a state hub exists.
    slug = c["slug"]
    uf = slug.rsplit("-", 1)[-1] if len(slug.rsplit("-", 1)[-1]) == 2 else ""
    return {
        "slug": slug,
        "uf": uf,
        "cslug": slug[: -(len(uf) + 1)] if uf else slug,
        "cidade": c["cidade"],
        "nome": c["nome"],
        "tz": TZ.get(c["cidade"], "America/Sao_Paulo"),
        "borrowed": borrowed(c),
        # The three links of the price chain, so the honest page can draw the
        # method instead of only describing it.
        "chain": c.get("chain") or {},
        "stats": stats,
        "shapes": shp,
        # Keyed the same way the map is, so a district page can ask for its own
        # number without another spelling to get wrong.
        "market": market(norm(c["cidade"]), set((shp or {}).get("nice") or ())),
        # What a property in this district usually *is* — median size, asking
        # per m², how many listings say so. Not filtered to the map's keys:
        # the reader who needs it most is on a lot the map could not place.
        "asking_by_district": c.get("asking_by_district") or {},
        "upkeep": upkeep(norm(c["cidade"]), set((shp or {}).get("nice") or ())),
        "streets": streets(norm(c["cidade"]), set((shp or {}).get("nice") or ())),
        "rows": rows,
        # Keep every row and the source's dates/evidence, including stable URLs.
        # A missing lifecycle is unverified, never inferred active; current
        # statistics count active records only.
        "lifecycle": lifecycle,
    }


def check_prepositions(payload: dict, cats: dict[str, dict]) -> None:
    """Every city needs its own preposition in every language, or none.

    build.py checks the catalogues against each other; only this build knows
    which cities exist. Without that link a fourth city would quietly fall back
    to the generic form — harmless for `em São Paulo`, wrong for `no Recife` —
    and nothing would say so. Falling back is still allowed, but a language has
    to decline the city explicitly rather than by omission.
    """
    slugs = [c["slug"] for c in payload["cities"]]
    missing = {
        lang: [s for s in slugs if f"city.prep.{s}" not in cat]
        for lang, cat in cats.items()
        if any(k.startswith("city.prep.") for k in cat)
    }
    missing = {k: v for k, v in missing.items() if v}
    if missing:
        lines = "; ".join(f"{lang}: {', '.join(v)}" for lang, v in sorted(missing.items()))
        raise SystemExit(f"нет city.prep.<slug> для новых городов — {lines}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--data",
        type=Path,
        default=DATA,
        help="source JSON export (default: data/site.json); does not modify the input",
    )
    ap.add_argument(
        "--market-reports",
        type=Path,
        default=MARKET_REPORTS,
        help="optional strict market report export (default: data/market_reports.json)",
    )
    ap.add_argument(
        "--lot-media",
        type=Path,
        default=LOT_MEDIA,
        help="optional approved photo projection (default: data/lot-media.json)",
    )
    release_mode = ap.add_mutually_exclusive_group()
    release_mode.add_argument(
        "--release",
        action="store_true",
        help="require documented generated metadata from the source export",
    )
    release_mode.add_argument(
        "--legacy-baseline-release",
        action="store_true",
        help="strict one-time observed-partial baseline; generated source date must be absent",
    )
    ap.add_argument(
        "--lifecycle-receipt",
        type=Path,
        default=LIFECYCLE_RECEIPT,
        help="candidate lifecycle receipt; required by --release",
    )
    ap.add_argument(
        "--site",
        default=os.environ.get("SITE_URL", ""),
        help="public site URL used for the privacy notice and API settings",
    )
    args = ap.parse_args()
    strict_release = args.release or args.legacy_baseline_release
    # Preview builds retain the project-page default for local development.
    # Releases have no fallback: an unset or legacy SITE_URL fails closed.
    if not args.site and not strict_release:
        args.site = "https://yunoshev.github.io/casa-brazil"
    try:
        args.site = (
            validate_release_site_url(args.site) if strict_release else validate_site_url(args.site)
        )
    except ValueError as exc:
        ap.error(str(exc))
    try:
        if strict_release:
            src, candidate_mode = load_release_candidate(args.data, args.lifecycle_receipt)
            if args.legacy_baseline_release and candidate_mode != "observed_partial":
                raise ValueError("legacy baseline requires an observed-partial candidate")
            generated = strict_release_freshness(src, candidate_mode)
        else:
            src = json.loads(args.data.read_text())
            generated = source_freshness(src)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        ap.error(str(exc))
    if not generated:
        notice = (
            "LEGACY BASELINE: source freshness is intentionally null"
            if args.legacy_baseline_release
            else (
                "OBSERVED PARTIAL: global source freshness is intentionally null"
                if strict_release
                else "PREVIEW: source snapshot date unknown; no lastmod may be inferred from build time"
            )
        )
        print(notice, flush=True)
    cols = {name: i for i, name in enumerate(src["cols"])}

    cities = [build_city(c, cols) for c in src["cities"]]
    payload = {
        "preview": not strict_release,
        "cols": src["cols"],
        "cities": cities,
    }
    if generated is not None:
        payload["generated"] = generated
    lot_ids = {str(row[cols["id"]]) for city in src["cities"] for row in city["rows"]}
    market_binding = (
        market_release_binding(args.data, args.lifecycle_receipt) if strict_release else None
    )
    try:
        public_market_reports, market_reports = prepare_market_reports(
            args.market_reports, lot_ids, market_binding
        )
    except ValueError as exc:
        ap.error(str(exc))
    # This is an intentional public artifact, not a fetch-at-render-time
    # cache.  It is always present — including the explicit insufficient-data
    # shape — so readers, crawlers and the release attestation see the same
    # honest state.
    atomic_write(PUBLIC_MARKET_REPORTS, market_compact_json(public_market_reports) + b"\n")
    if market_reports:
        payload["market_reports"] = market_reports
    payload["document_reports"] = load_document_reports(DOCUMENT_REPORTS, src)
    payload["local_profiles"] = load_local_profiles(LOCAL_PROFILES, cities)
    from saved_analyses import load_saved_analyses

    payload["saved_analyses"] = load_saved_analyses(SAVED_ANALYSES, src)
    # The media projection joins against the post-build cities.  That means a
    # stale photo record for a city/lifecycle row that is no longer published
    # cannot make the payload larger or produce an orphan URL.
    published_lots = {
        city["slug"]: {str(row[cols["id"]]) for row in city["rows"]} for city in cities
    }
    lot_media = load_lot_media(args.lot_media, published_lots)
    if lot_media:
        payload["media"] = lot_media
    copy_top_metadata(payload, src)
    save_shape_cache()

    cats = classic.load_catalogues()
    classic.check("v2", cats)
    cats = catalogue_for_freshness(cats, generated)
    check_prepositions(payload, cats)
    ref = cats[DEFAULT_LANG]

    tpl = (SITE / "index.tpl.html").read_text()
    out = (
        tpl.replace("__PAYLOAD__", classic.blob(payload))
        .replace("__COUNTERS__", snippet(args.site))
        # A plain "__I18N__" would also match the `window.__I18N__ =` it is
        # being assigned to, and replace both halves of the line.
        .replace("__I18N_DATA__", classic.blob(cats))
        # The <title> and description are rewritten by the runtime, but a
        # crawler that runs no JS has to find something better than a marker.
        .replace("__TITLE__", ref["meta.title"])
        .replace("__DESC__", ref["meta.desc"])
        .replace('src="/parts/analyze.js"', f'src="{analysis_script_src()}"')
        .replace('src="/parts/copy-analysis.js"', f'src="{copy_script_src()}"')
        .replace('src="/v2/app.js"', f'src="{app_script_src()}"')
        .replace('href="/v2/style.css"', f'href="{stylesheet_href()}"')
    )
    (SITE / "index.html").write_text(out)
    if strict_release:
        # Serve the source projection beside its attestation. The private
        # promoter compares these exact bytes; HTML embedding is not evidence.
        atomic_write(HERE / "site" / PROJECTION_NAME, args.data.read_bytes())
        emit_manifest(
            args.data,
            args.lifecycle_receipt,
            HERE / "site" / MANIFEST_NAME,
            legacy_baseline=args.legacy_baseline_release,
            public_artifacts={"data/market_reports.json": PUBLIC_MARKET_REPORTS.read_bytes()},
        )

    kb = len(out) / 1024
    langs = ", ".join(sorted(cats))
    print(f"site/v2/index.html — {kb:,.0f} KB, {len(cats)} lang ({langs})", flush=True)
    for c in payload["cities"]:
        sh = c["shapes"] or {}
        placed = len(sh.get("of") or {})
        print(
            f"  {c['nome']:<18} lots={c['stats']['lots']:<5} "
            f"reliable={c['stats']['reliable']:<5} below={c['stats']['below']:<5} "
            f"areas={len(sh.get('d') or {}):<4} placed={placed} "
            f"promised={c['stats']['promised_med']} real={c['stats']['real_med']}",
            flush=True,
        )


if __name__ == "__main__":
    main()
