"""Self-hosted, subset webfonts — run once, commit the result.

Three families arrive from Google as ~248 KB of "latin" and "latin-ext" that
carry a Latin the site will never type. This cuts them to the characters a
Brazilian auction page actually contains, writes them next to the stylesheet,
and prints the `@font-face` block to paste into it.

Why self-host at all: fonts.googleapis.com is the only third party the page
blocks on. Removing it takes out two DNS lookups, two TLS handshakes and a
render-blocking stylesheet on the critical path — and the last request that
hands a reader's IP to somebody else, which is worth saying plainly on a site
whose footer promises no tracking.

Why commit the .woff2 rather than build them in CI: the build would need
network, fonttools and brotli to produce bytes that change only when a designer
changes their mind. Four files, 60 KB, in git.

Run: .venv/bin/python -u experiments/brazil/fonts_build.py
"""

from __future__ import annotations

import io
import json
import urllib.request
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).parent
OUT = HERE / "site" / "v2" / "fonts"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

#: Every family, its variable query, and the CSS role it fills.
#: Neither the display nor the body face ships Cyrillic upstream, so the one
#: Cyrillic word on the page — the language switcher's own name — falls back to
#: a system font exactly as it does today. Nothing regresses; 17 KB does not
#: get downloaded.
#: Upstream, not the CDN. `fonts.googleapis.com` never serves a whole font: it
#: serves range-slices, and `latin-ext` is a *sibling* of `latin`, not a
#: superset — subsetting that slice yields a face with accents and no alphabet.
#: The project's own repository has the real variable TTF, under the OFL, which
#: is also the licence that permits hosting it here at all.
GH = "https://raw.githubusercontent.com/google/fonts/main/ofl"
FAMILIES = {
    "bricolage": (
        f"{GH}/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf",
        "Bricolage Grotesque",
        # opsz survives because the browser drives it automatically from the
        # type size, and this face is set from 18px to 36px on one screen —
        # but clipped to that range, not the designspace's 12..96.
        {"wdth": 100, "wght": (400, 800), "opsz": (14, 40)},
    ),
    "instrument": (
        f"{GH}/instrumentsans/InstrumentSans[wdth,wght].ttf",
        "Instrument Sans",
        {"wdth": 100, "wght": (400, 700)},
    ),
    "martian": (
        f"{GH}/martianmono/MartianMono[wdth,wght].ttf",
        "Martian Mono",
        {"wdth": 100, "wght": (400, 600)},
    ),
}

#: What the pages may contain, not what today's data happens to contain.
#: Subsetting to the exact glyph inventory of one build is a trap: the next
#: district name with a foreign letter would render in a fallback face and
#: nobody would notice for months. Latin-1 covers Portuguese completely and
#: Latin Extended-A covers the surnames that turn up in a street name.
RANGES = [
    (0x0020, 0x007E),  # ASCII printable
    (0x00A0, 0x00FF),  # Latin-1: every Portuguese accent lives here
]
#: Punctuation and maths the typography actually uses, plus close neighbours,
#: because a missing arrow is a tofu box in the middle of a sentence.
EXTRA = "–—‘’“”„…‹›«»•′″←↑→↓↔−×÷±≈≤≥≠™€°‰№"

#: Latin Extended-A (U+0100-017F) is deliberately absent. It was in here on the
#: theory that a Polish surname might turn up in a street name; a scan of all
#: 9 319 built pages and all three catalogues found exactly zero of it, and it
#: costs 27 KB across the three faces on every first visit. What replaces the
#: insurance is `charset.json` next to the fonts: the pre-render compares every
#: page against it and says so out loud if the data ever grows a character
#: these files cannot draw. A visible risk beats a paid-for invisible one.


def charset() -> set[int]:
    cps = {c for lo, hi in RANGES for c in range(lo, hi + 1)}
    cps |= {ord(c) for c in EXTRA}
    return cps


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as r:
        return r.read()


def source(url: str) -> bytes:
    return fetch(url)


def shrink(raw: bytes, keep: set[int], axes: dict) -> bytes:
    """Drop the glyphs, then pin the axes nobody varies.

    A variable font pays for every axis in every glyph's delta set. Width is
    never touched by this stylesheet and weight never goes below 400, so both
    are dead weight — literally the majority of the file.

    Order matters and cost an hour: instancing first leaves `gvar` entries for
    glyphs the subsetter then removes, and the subsetter dies on the first one
    (`KeyError: 'ldot'`). Subsetting first hands the instancer a font whose
    tables already agree with each other.
    """
    font = TTFont(io.BytesIO(raw))
    opts = subset.Options()
    opts.name_IDs = ["*"]
    opts.name_legacy = False
    opts.layout_features = ["*"]
    opts.drop_tables += ["DSIG"]
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=keep)
    sub.subset(font)
    font = instancer.instantiateVariableFont(font, axes, inplace=True, updateFontNames=False)
    buf = io.BytesIO()
    font.flavor = "woff2"
    font.save(buf)
    return buf.getvalue()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    keep = charset()
    print(f"оставляем {len(keep)} кодовых точек", flush=True)
    total_before = total_after = 0
    for slug, (url, name, axes) in FAMILIES.items():
        raw = source(url)
        small = shrink(raw, keep, axes)
        (OUT / f"{slug}.woff2").write_bytes(small)
        total_before += len(raw)
        total_after += len(small)
        print(
            f"  {name:20} {len(raw) / 1024:6.1f} → {len(small) / 1024:5.1f} KB "
            f"({100 - 100 * len(small) / len(raw):.0f}% меньше)",
            flush=True,
        )
    print(f"итого {total_before / 1024:.0f} → {total_after / 1024:.0f} KB", flush=True)
    (OUT / "charset.json").write_text(json.dumps(sorted(keep), separators=(",", ":")) + "\n")
    print(f"{OUT.name}/charset.json — {len(keep)} точек, по нему проверяет пререндер", flush=True)


if __name__ == "__main__":
    main()
