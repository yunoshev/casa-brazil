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

import json
import re
import sqlite3
import statistics
import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / "site"))
import build as classic
import shapes

HERE = Path(__file__).parent
SITE = HERE / "site" / "v2"
DATA = HERE / "data" / "site.json"

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
    return hit


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


def build_city(c: dict, cols: dict[str, int]) -> dict:
    rows = c["rows"]

    def reliable(r):
        return r[cols["conf"]] == "ok" and (r[cols["ring"]] or 0) <= TIGHT_RING_M

    rel = [r for r in rows if reliable(r)]

    promised = [r[cols["promised"]] for r in rel if r[cols["promised"]] is not None]
    loud = [r for r in rel if (r[cols["promised"]] or 0) >= LOUD_PROMISE]

    stats = {
        "lots": len(rows),
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

    # The UF is its own path segment, not a suffix glued to the city: that is
    # what ranks in Brazil, and it buys a state-level hub page for free.
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
        "upkeep": upkeep(norm(c["cidade"]), set((shp or {}).get("nice") or ())),
        "streets": streets(norm(c["cidade"]), set((shp or {}).get("nice") or ())),
        "rows": rows,
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
    src = json.loads(DATA.read_text())
    cols = {name: i for i, name in enumerate(src["cols"])}

    payload = {
        "generated": src.get("generated")
        or max((c.get("generated") or "") for c in src["cities"])
        or "",
        "cols": src["cols"],
        "cities": [build_city(c, cols) for c in src["cities"]],
    }
    save_shape_cache()
    if not payload["generated"]:
        payload["generated"] = __import__("datetime").date.today().isoformat()

    cats = classic.load_catalogues()
    classic.check("v2", cats)
    check_prepositions(payload, cats)
    ref = cats[DEFAULT_LANG]

    tpl = (SITE / "index.tpl.html").read_text()
    out = (
        tpl.replace("__PAYLOAD__", classic.blob(payload))
        # A plain "__I18N__" would also match the `window.__I18N__ =` it is
        # being assigned to, and replace both halves of the line.
        .replace("__I18N_DATA__", classic.blob(cats))
        # The <title> and description are rewritten by the runtime, but a
        # crawler that runs no JS has to find something better than a marker.
        .replace("__TITLE__", ref["meta.title"])
        .replace("__DESC__", ref["meta.desc"])
    )
    (SITE / "index.html").write_text(out)

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
