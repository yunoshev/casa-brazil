"""Public-build validation for the allowlisted saved-analysis artifact."""

import json
import re
from datetime import datetime


def load_saved_analyses(path, source):
    if not path.exists():
        return {}
    data = json.loads(path.read_text())
    if set(data) != {"schema", "reports"} or data["schema"] != "saved-matricula-analyses-v1":
        raise ValueError("invalid saved analyses schema")
    cols = {key: i for i, key in enumerate(source["cols"])}
    rows = {str(r[cols["id"]]): r for city in source["cities"] for r in city["rows"]}
    reports = {}
    for lot_id, report in data["reports"].items():
        if not re.fullmatch(r"[a-f0-9]{16}", lot_id) or set(report) != {
            "source_url",
            "document_sha256",
            "analyzed_at",
            "language",
            "analysis",
        }:
            raise ValueError("invalid saved analysis fields")
        if report["language"] != "pt" or not re.fullmatch(
            r"[a-f0-9]{64}", report["document_sha256"]
        ):
            raise ValueError("invalid saved analysis provenance")
        if datetime.fromisoformat(report["analyzed_at"].replace("Z", "+00:00")).tzinfo is None:
            raise ValueError("invalid analysis timestamp")
        a = report["analysis"]
        if set(a) != {
            "contract",
            "document_type",
            "identity",
            "entries",
            "summary",
            "warnings",
            "confidence",
            "disclaimer",
        }:
            raise ValueError("invalid saved analysis contract")
        if (
            a["contract"] not in {"brazil_matricula_v1", "brazil_matricula_v2"}
            or a["document_type"] != "matricula"
        ):
            raise ValueError("unsupported analysis")
        if not isinstance(a["entries"], list) or len(a["entries"]) > 80:
            raise ValueError("invalid entries")

        def safe(value, maximum=3000):
            return (
                isinstance(value, str)
                and 0 < len(value) <= maximum
                and not re.search(r"[<>\x00-\x08]", value)
            )

        if not safe(a["summary"]) or not safe(a["disclaimer"]):
            raise ValueError("invalid analysis text")
        if a["contract"] == "brazil_matricula_v2":
            identity = a["identity"]
            if not isinstance(identity, dict) or set(identity) != {"matricula", "address"}:
                raise ValueError("invalid identity")
            for check in identity.values():
                if not isinstance(check, dict) or set(check) != {
                    "status",
                    "catalog_value",
                    "document_value",
                    "citations",
                }:
                    raise ValueError("invalid identity fields")
                if check["status"] not in {"match", "omitted", "unverified", "contradiction"}:
                    raise ValueError("invalid identity status")
                if any(
                    v is not None and not safe(v, 500)
                    for v in (check["catalog_value"], check["document_value"])
                ):
                    raise ValueError("invalid identity text")
                if not isinstance(check["citations"], list) or len(check["citations"]) > 3:
                    raise ValueError("invalid identity citations")
                if check["status"] == "omitted":
                    if check["document_value"] is not None or check["citations"]:
                        raise ValueError("omitted identity has evidence")
                elif (
                    not check["document_value"]
                    or not check["citations"]
                    or (check["status"] != "unverified" and not check["catalog_value"])
                ):
                    raise ValueError("missing identity evidence")
                for citation in check["citations"]:
                    if (
                        set(citation) != {"page", "quote"}
                        or type(citation["page"]) is not int
                        or not 1 <= citation["page"] <= 150
                        or not safe(citation["quote"], 360)
                    ):
                        raise ValueError("invalid identity citation")
        if (
            not isinstance(a["warnings"], list)
            or not 1 <= len(a["warnings"]) <= 20
            or not all(safe(w) for w in a["warnings"])
        ):
            raise ValueError("invalid warnings")
        for entry in a["entries"]:
            if (
                set(entry) != {"kind", "number", "title", "summary", "effect", "citations"}
                or entry["kind"] not in {"R", "AV"}
                or type(entry["number"]) is not int
                or entry["effect"] != "unclear"
            ):
                raise ValueError("invalid entry")
            if not safe(entry["title"]) or not safe(entry["summary"]):
                raise ValueError("invalid entry text")
            if not isinstance(entry["citations"], list) or not 1 <= len(entry["citations"]) <= 4:
                raise ValueError("invalid citations")
            for citation in entry["citations"]:
                if (
                    set(citation) != {"page", "quote"}
                    or type(citation["page"]) is not int
                    or not 1 <= citation["page"] <= 150
                    or not safe(citation["quote"], 360)
                ):
                    raise ValueError("invalid citation")
        row = rows.get(lot_id)
        if (
            row is not None
            and row[cols["src"]] == "caixa"
            and row[cols["link"]] == report["source_url"]
        ):
            reports[lot_id] = report
    return reports
