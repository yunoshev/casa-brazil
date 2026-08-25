"""Assemble the static site: the index, the shared assets, one page per lot.

Nothing here recomputes anything. export_site.py flattens the pipeline into
site.json and this turns it into files, so the numbers on screen can never
disagree with the database — the only way to change them is to change the data.

The site is deliberately plain: HTML that a crawler can read, one stylesheet,
two scripts, and a page per lot at its own URL. `core.js` is loaded by the
index and by every lot page alike, so the verdict thresholds and the wording
around them exist once. Two copies of a rule is how a site starts disagreeing
with itself, and this one's whole pitch is that it does not.

It also guards the translation contract. Every visible string reaches a page
through `t(key)` or a `data-i18n` attribute, and `i18n/<lang>.json` is the only
place a string is written. This checks the two halves agree — a key the markup
asks for that no catalogue answers, or a catalogue that has drifted from the
reference language — and refuses to build rather than shipping a page with
`[some.key]` printed where a sentence belongs. Adding a language is then one
file, which is the whole point.

Run: .venv/bin/python -u experiments/brazil/site/build.py
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import date
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
DATA = HERE.parent / "data"
I18N = HERE / "i18n"
PARTS = HERE / "parts"
TEMPLATE = HERE / "template.html"
LOT_TEMPLATE = HERE / "lot_template.html"
LOT_DIR = "lote"
#: The catalogue every other language is measured against.
REFERENCE = "ru"
#: Public origin, needed for canonical URLs and structured data. Not live yet;
#: wrong is better than absent here, because absent silently disables both.
SITE_URL = "https://example.invalid"

#: How a page asks for a string. Matching `t("key")` alone would miss the column
#: headers, which arrive as `t(h[1])` from a table of key names — so any quoted
#: dotted-lowercase identifier counts, plus the markup attributes.
_KEY_PATTERNS = (
    re.compile(r'"([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)"'),
    re.compile(r'data-i18n(?:-placeholder|-aria)?="([\w.]+)"'),
)
#: The two front ends, each declaring what it is built from and which of its
#: keys no scan can see. A key assembled from a data value (`"flag." + k`,
#: `"map.source." + kind`) is invisible to the patterns above, so the front end
#: that will ask for it says so here — and a language that ships a front end
#: has to answer those keys as surely as the visible ones.
#:
#: They share one catalogue, so "unused" only means unused by *both*.
FRONTENDS = {
    "classic": {
        "files": ("template.html", "lot_template.html", "parts/core.js", "parts/index.js"),
        "dynamic": ("flag.", "lot.verdict.", "lot.geo.", "lot.row.", "lot.meta.", "map.source."),
        # Frozen at one language on purpose: v2 replaces this front end, and
        # translating six thousand characters of prose into a page that is
        # queued for deletion buys nothing. Widen this or delete the entry.
        "langs": ("ru",),
    },
    "v2": {
        "files": (
            "v2/index.tpl.html",
            "v2/page.tpl.html",
            "v2/app.js",
            "parts/lang.js",
            "parts/chrome.js",
            "parts/analyze.js",
        ),
        # Which of the three geometries a city has decides all of these. Named
        # exactly, not by prefix: `map.source.` alone would also claim the
        # classic front end's two.
        "dynamic": (
            "map.source.rio_cadastre",
            "map.source.sp_geosampa",
            "map.source.sg_points",
            "city.prep.",
            # Built from the shape of the register: a district may have flats,
            # houses, or both, so which of the two the page asks for is decided
            # by the data and not by the template.
            "mkt.kind.",
            "unit.district",
            "unit.borough",
        ),
        "langs": None,  # every catalogue there is
    },
}
CLASSIC, V2 = FRONTENDS["classic"]["files"], FRONTENDS["v2"]["files"]
ALL_SOURCES = CLASSIC + V2
_DYNAMIC_PREFIXES = tuple(d for f in FRONTENDS.values() for d in f["dynamic"])

_NOT_KEYS = ("js", "css", "html", "json", "xml", "svg", "png", "jpg", "webp", "ico")

#: CLDR plural categories. A key ending in one of these is one form of a
#: pluralised noun, and the page asks for the *base* — `plur("unit.lot", n)` —
#: so the base is what has to exist, and the forms are what has to agree with
#: the language.
_FORMS = ("zero", "one", "two", "few", "many", "other")
_PLURAL = re.compile(r"^(.+)\.(" + "|".join(_FORMS) + r")$")


def split_plurals(keys: set[str]) -> tuple[set[str], dict[str, set[str]]]:
    """Plain keys, and the plural bases with the forms each one carries."""
    plain: set[str] = set()
    bases: dict[str, set[str]] = {}
    for k in keys:
        m = _PLURAL.match(k)
        if m:
            bases.setdefault(m.group(1), set()).add(m.group(2))
        else:
            plain.add(k)
    return plain, bases


def blob(obj: object) -> str:
    # separators kill the pretty-print whitespace; </script> inside a string
    # would close the tag early, so escape the only sequence that can do it.
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def source_text(files: tuple[str, ...] = ALL_SOURCES) -> str:
    """Everything that can name a translation key, concatenated."""
    paths = [HERE / f for f in files]
    return "\n".join(p.read_text() for p in paths if p.exists())


def template_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for pat in _KEY_PATTERNS:
        keys.update(pat.findall(text))
    return {k for k in keys if k and not k.endswith(".") and k.rsplit(".", 1)[-1] not in _NOT_KEYS}


def load_catalogues() -> dict[str, dict[str, str]]:
    if not I18N.is_dir():
        raise SystemExit(f"no {I18N} — the page has no strings to render")
    cats = {p.stem: json.loads(p.read_text()) for p in sorted(I18N.glob("*.json"))}
    if REFERENCE not in cats:
        raise SystemExit(f"{I18N}/{REFERENCE}.json is the reference catalogue and is missing")
    return cats


def bases_of(keys: set[str]) -> set[str]:
    """Plural forms collapsed onto the base a page actually asks for."""
    return {(m.group(1) if (m := _PLURAL.match(k)) else k) for k in keys}


def required(front: str, ref: dict[str, str]) -> set[str]:
    """Every key this front end can ask for, as bases.

    The ones a scan can see, plus the data-driven prefixes the front end
    declares — those are invisible to any scan but a reader will still meet
    them, so a language shipping this page has to answer them too.
    """
    spec = FRONTENDS[front]
    seen = template_keys(source_text(spec["files"]))
    dyn = {k for k in ref if not k.startswith("_") and k.startswith(spec["dynamic"])}
    return bases_of(seen | dyn)


def shipped(front: str, cats: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    """The catalogues this front end actually ships."""
    langs = FRONTENDS[front].get("langs")
    return cats if langs is None else {k: v for k, v in cats.items() if k in langs}


def check(front: str, cats: dict[str, dict[str, str]]) -> None:
    """Fail loudly on the ways a translation contract rots.

    Scoped to one front end: it is checked against the languages it ships, so
    a page can go multilingual before its neighbour does without either build
    lying about the other.
    """
    ref = cats[REFERENCE]
    known = {k for k in ref if not k.startswith("_")}
    ref_plain, ref_bases = split_plurals(known)
    need = required(front, ref)
    problems: list[str] = []

    if missing := sorted(need - ref_plain - set(ref_bases)):
        problems.append(f"{REFERENCE}.json is missing keys {front} asks for: {missing}")

    # A string is dead only when *no* front end wants it — they share a
    # catalogue, and each would otherwise report the other's strings as unused.
    everyone = set().union(*(required(f, ref) for f in FRONTENDS))
    if unused := sorted((ref_plain | set(ref_bases)) - everyone):
        # Not fatal: a dead string costs nothing but a translator's time. Say it
        # anyway, because the cheapest moment to delete it is now.
        print(f"  note: {len(unused)} unused strings in {REFERENCE}.json: {unused}", flush=True)

    for lang, cat in shipped(front, cats).items():
        meta = cat.get("_meta") or {}
        have = {k for k in cat if not k.startswith("_")}
        plain, bases = split_plurals(have)

        # Every language needs the categories its own locale actually has —
        # Russian four, Portuguese two — so the catalogue declares them rather
        # than being forced into the reference language's shape.
        forms = meta.get("plurals")
        if not forms:
            problems.append(f"{lang}.json has no _meta.plurals, so nouns cannot be counted")
        elif bad := [f for f in forms if f not in _FORMS]:
            problems.append(f"{lang}.json declares plural categories that do not exist: {bad}")
        else:
            for base in sorted(set(bases) & need):
                if bases[base] != set(forms):
                    problems.append(
                        f"{lang}.json: {base} has forms {sorted(bases[base])}, "
                        f"but this language needs {sorted(forms)}"
                    )

        if not meta.get("locale"):
            problems.append(f"{lang}.json has no _meta.locale, so numbers cannot be formatted")
        if lang == REFERENCE:
            continue
        if gaps := sorted(need - plain - set(bases)):
            problems.append(f"{lang}.json cannot ship {front} yet, missing: {gaps}")
        if extra := sorted((plain - ref_plain) | (set(bases) - set(ref_bases))):
            problems.append(f"{lang}.json has keys {REFERENCE} does not: {extra}")

    if problems:
        raise SystemExit("translation contract broken:\n  - " + "\n  - ".join(problems))


def fold(s: str | None) -> str:
    import unicodedata

    if not s:
        return ""
    n = unicodedata.normalize("NFKD", s)
    return " ".join("".join(c for c in n if not unicodedata.combining(c)).upper().split())


def lot_payload(payload: dict[str, Any], city: dict[str, Any], row: list[Any]) -> dict[str, Any]:
    """One lot, and only what is needed to say something true about it.

    Shaped exactly like the index's payload — a list of cities, each with rows —
    so the shared renderer needs no idea which page it is running on.
    """
    col = {c: i for i, c in enumerate(payload["cols"])}
    bairro = fold(row[col["bairro"]])
    paid = city.get("paid_by_district") or {}
    return {
        "cols": payload["cols"],
        "generated": payload["generated"],
        "cities": [
            {
                "uf": city["uf"],
                "cidade": city["cidade"],
                "nome": city["nome"],
                "slug": city["slug"],
                "chain": city["chain"],
                # Only this lot's district: the rest of the table is another page.
                "paid_by_district": {bairro: paid[bairro]} if bairro in paid else {},
                "rows": [row],
            }
        ],
    }


def lot_meta(city: dict[str, Any], row: list[Any], col: dict[str, int], cats: dict) -> dict:
    """Title, description and slug, built from the lot rather than the template.

    Copart puts the risk word first in its slugs — `salvage-2020-…` against
    `clean-title-2009-…` — so the thing that decides whether you look is in the
    URL. Ours leads with type and size, then where, because that is what a
    person searching for a flat in a district actually types.
    """
    ref = cats[REFERENCE]
    tipo = (row[col["tipo"]] or "imovel").lower().replace(" ", "-")
    area = row[col["area"]] or 0
    bairro = fold(row[col["bairro"]]).lower().replace(" ", "-") or "sem-bairro"
    slug = re.sub(r"[^a-z0-9-]", "", f"{tipo}-{area}m2-{bairro}")
    ident = row[col["id"]]
    parts = [row[col["tipo"]] or "", f"{area} m²" if area else "", row[col["bairro"]] or ""]
    title = " · ".join(p for p in parts if p) + f" — {city['nome']}"
    desc = ref.get("lot.meta.desc", "{opening} → {hammer}").format(
        opening=f"R$ {row[col['preco']]:,}".replace(",", " "),
        hammer=f"R$ {row[col['hammer']]:,}".replace(",", " "),
        city=city["nome"],
    )
    return {"file": f"{slug}-{ident[:8]}.html", "title": title, "desc": desc}


def ld_json(city: dict, row: list, col: dict, url: str) -> dict:
    """Product + Offer + BreadcrumbList, and nothing else.

    Google has never had a real-estate rich result and removed vehicle listings
    in September 2025, so anything richer than this is markup nobody reads.
    """
    return {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "Product",
                "name": f"{row[col['tipo']] or 'Imóvel'} — {row[col['bairro']] or city['nome']}",
                "url": url,
                "offers": {
                    "@type": "Offer",
                    "price": row[col["preco"]],
                    "priceCurrency": "BRL",
                    "availability": "https://schema.org/InStock",
                    **({"priceValidUntil": row[col["data"]]} if row[col["data"]] else {}),
                },
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {"@type": "ListItem", "position": 1, "name": city["nome"]},
                    {"@type": "ListItem", "position": 2, "name": row[col["bairro"]] or "—"},
                ],
            },
        ],
    }


def write_lots(payload: dict, cats: dict, out_dir: Path) -> tuple[int, dict[str, str]]:
    """One page per lot, and the index's map from lot id to its URL."""
    tpl = LOT_TEMPLATE.read_text()
    col = {c: i for i, c in enumerate(payload["cols"])}
    lot_root = out_dir / LOT_DIR
    if lot_root.exists():
        shutil.rmtree(lot_root)
    lot_root.mkdir(parents=True)

    urls: dict[str, str] = {}
    n = 0
    for city in payload["cities"]:
        for row in city["rows"]:
            meta = lot_meta(city, row, col, cats)
            url = f"{SITE_URL}/{LOT_DIR}/{meta['file']}"
            html = (
                tpl.replace("__TITLE__", meta["title"])
                .replace("__DESC__", meta["desc"])
                .replace("__CANON__", url)
                .replace("__SLUG__", city["slug"])
                .replace("__LD__", blob(ld_json(city, row, col, url)))
                # a plain "__DATA__" would also match the `window.__DATA__ =` it is
                # being assigned to, and replace both halves of the line
                .replace("__LOT_DATA__", blob(lot_payload(payload, city, row)))
            )
            (lot_root / meta["file"]).write_text(html)
            urls[row[col["id"]]] = f"{LOT_DIR}/{meta['file']}"
            n += 1
    return n, urls


def write_sitemap(out_dir: Path, urls: dict[str, str], stamp: str) -> None:
    rows = "".join(
        f"<url><loc>{SITE_URL}/{u}</loc><lastmod>{stamp}</lastmod></url>" for u in urls.values()
    )
    (out_dir / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        f"<url><loc>{SITE_URL}/</loc><lastmod>{stamp}</lastmod></url>{rows}</urlset>"
    )


def run(src: Path, out_dir: Path, stamp: str, with_lots: bool = True) -> None:
    payload = json.loads(src.read_text())
    payload["generated"] = stamp
    cats = load_catalogues()
    check("classic", cats)
    cats = shipped("classic", cats)

    out_dir.mkdir(parents=True, exist_ok=True)
    n, urls = (0, {})
    if with_lots:
        n, urls = write_lots(payload, cats, out_dir)
        write_sitemap(out_dir, urls, stamp)
    # The index needs to know where each lot lives, so a row can be a real link
    # rather than something only JavaScript knows how to open.
    payload["lot_urls"] = urls

    (PARTS / "i18n.js").write_text(f"window.__I18N__ = {blob(cats)};\n")
    (PARTS / "data.js").write_text(f"window.__DATA__ = {blob(payload)};\n")
    (out_dir / "index.html").write_text(TEMPLATE.read_text())

    size = (PARTS / "data.js").stat().st_size / 1e6
    total = sum(len(c["rows"]) for c in payload["cities"])
    print(
        f"{len(payload['cities'])} cities, {total} lots, "
        f"{len(cats)} languages ({', '.join(sorted(cats))})\n"
        f"  index.html + parts/data.js ({size:.1f} MB) -> {out_dir}\n"
        f"  {n} lot pages -> {out_dir / LOT_DIR}",
        flush=True,
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(DATA / "site.json"))
    ap.add_argument("--out", default=str(HERE))
    ap.add_argument("--date", default=date.today().isoformat())
    ap.add_argument("--no-lots", action="store_true", help="skip the per-lot pages")
    a = ap.parse_args()
    run(Path(a.src), Path(a.out), a.date, with_lots=not a.no_lots)
