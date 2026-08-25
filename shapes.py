"""Draw a city's real district outlines from the addresses inside them.

No open boundary file survives contact with this project: IBGE has no bairro
level in its mesh API, Rio's own pgeo3 server answers "Service not started",
and the hosted mirrors want a token. But we already downloaded the thing the
boundaries are drawn around — 132 000 geocoded street segments, each labelled
with its bairro by the city's own cadastre. A district is the ground its
addresses stand on, so the addresses can give the district back.

The method is a nearest-neighbour partition on a raster: lay a grid over the
city, give every cell the bairro of the closest catalogued street, then trace
the borders between differently-labelled cells. Cells with no street within
half a kilometre stay empty, which is what carves out Guanabara Bay, the
Tijuca forest and the lagoons — without that mask the partition would happily
fill the water and Rio would come out a rectangle.

What this is and is not: it is where the city's addresses actually are, at
70-metre resolution. It is not the legal boundary, and along an unbuilt edge —
a hillside, a park, a runway — it can sit some way off one. The page has to say
so rather than pass it off as cartography.

Nothing here is city-specific; it needs points with labels and nothing else.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

#: Grid resolution. Fine enough that a city block is a couple of cells, coarse
#: enough that the whole of Rio is under half a million cells.
CELL_M = 70.0

#: A cell further than this from any catalogued street belongs to no district.
#: Tuned on Rio: below ~350 m the forest starts eating inhabited hillsides,
#: above ~700 m the bay starts filling in.
MAX_D_M = 500.0

#: Douglas-Peucker tolerance, in cells. The raw trace is a staircase of 70 m
#: steps; about a cell and a half of tolerance reads as a coastline instead.
SIMPLIFY = 1.4

#: Regions smaller than this are speckle from a stray geocode, not districts.
MIN_CELLS = 12
MIN_RING_CELLS = 40

#: Share of points trimmed from each end of each axis before the grid is sized.
#: Feeds carry sign-flipped coordinates — ZAP puts a handful of São Paulo flats
#: in the northern hemisphere — and one of those stretches the raster across
#: five thousand kilometres, which is how a city map becomes an out-of-memory
#: kill. Trimming by rank costs nothing when the data is clean.
TRIM_Q = 0.002


def _inliers(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Drop the far tails of each axis, and anything absurdly far from them.

    A rank cut alone is not enough when a feed flips a sign: the trimmed box is
    right, but points outside it must be discarded rather than clamped, or they
    pile onto the border and invent a district there.
    """
    if len(lat) < 100:
        return np.ones(len(lat), dtype=bool)
    la0, la1 = np.quantile(lat, [TRIM_Q, 1 - TRIM_Q])
    lo0, lo1 = np.quantile(lon, [TRIM_Q, 1 - TRIM_Q])
    # Let the real extent breathe past the trimmed box by its own size, so an
    # outlying but genuine edge of the city survives.
    dla, dlo = (la1 - la0) or 0.01, (lo1 - lo0) or 0.01
    return (lat >= la0 - dla) & (lat <= la1 + dla) & (lon >= lo0 - dlo) & (lon <= lo1 + dlo)


def _project(lat: np.ndarray, lon: np.ndarray, lat0: float):
    k = math.cos(math.radians(lat0))
    return lon * k * 111320.0, -lat * 110540.0


def rasterise(
    points: list[tuple[float, float, int]], cell_m: float = CELL_M, max_d_m: float = MAX_D_M
):
    """Label every grid cell with the nearest point's group, or -1 if too far."""
    lats = np.array([p[0] for p in points], dtype=float)
    lons = np.array([p[1] for p in points], dtype=float)
    gids = np.array([p[2] for p in points], dtype=np.int32)

    keep = _inliers(lats, lons)
    if not keep.all():
        lats, lons, gids = lats[keep], lons[keep], gids[keep]

    xs, ys = _project(lats, lons, float(lats.mean()))
    pad = max_d_m
    x0, x1 = xs.min() - pad, xs.max() + pad
    y0, y1 = ys.min() - pad, ys.max() + pad
    cols = math.ceil((x1 - x0) / cell_m)
    rows = math.ceil((y1 - y0) / cell_m)

    gx = x0 + (np.arange(cols) + 0.5) * cell_m
    gy = y0 + (np.arange(rows) + 0.5) * cell_m
    mesh = np.stack(np.meshgrid(gx, gy), axis=-1).reshape(-1, 2)

    tree = cKDTree(np.stack([xs, ys], axis=-1))
    dist, idx = tree.query(mesh, k=1, workers=-1)
    lab = np.where(dist <= max_d_m, gids[idx], -1).reshape(rows, cols)
    return lab, {
        "cols": cols,
        "rows": rows,
        "x0": x0,
        "y0": y0,
        "cell": cell_m,
        "lat0": float(lats.mean()),
    }


def rasterise_polys(
    polys: list[tuple[int, list[list[tuple[float, float]]]]],
    cell_m: float = CELL_M,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Same raster, filled from real polygons instead of a point cloud.

    Where a city publishes its own boundaries we should use them; only Rio
    forced us to infer them. Each polygon is painted into an integer image by
    its group index — outer ring first, then its holes back to empty — which is
    both fast and exactly consistent with the point-derived raster, so one
    tracer serves both and the page cannot tell which city came from where.
    """
    from PIL import Image, ImageDraw

    lats = np.array([y for _, rings in polys for ring in rings for _, y in ring])
    lons = np.array([x for _, rings in polys for ring in rings for x, _ in ring])
    lat0 = float(lats.mean())
    xs, ys = _project(lats, lons, lat0)
    x0, y0 = xs.min() - cell_m, ys.min() - cell_m
    cols = math.ceil((xs.max() + cell_m - x0) / cell_m)
    rows = math.ceil((ys.max() + cell_m - y0) / cell_m)

    img = Image.new("I", (cols, rows), 0)
    draw = ImageDraw.Draw(img)
    for gid, rings in polys:
        for r, ring in enumerate(rings):
            px = [
                (
                    (lon * math.cos(math.radians(lat0)) * 111320.0 - x0) / cell_m,
                    (-lat * 110540.0 - y0) / cell_m,
                )
                for lon, lat in ring
            ]
            if len(px) >= 3:
                draw.polygon(px, fill=(gid + 1) if r == 0 else 0)

    lab = np.array(img, dtype=np.int32) - 1
    return lab, {"cols": cols, "rows": rows, "x0": x0, "y0": y0, "cell": cell_m, "lat0": lat0}


def locate(geo: dict[str, Any], lab: np.ndarray, lat: float, lon: float, search: int = 8) -> int:
    """Which region a coordinate falls in, or the nearest one within `search`.

    Assigning a lot to its district by name is a losing game — the auction feeds
    write GUAIANAZES where the city writes GUAIANASES, and half of São Paulo's
    lots carry a street-level neighbourhood the city has never heard of. The
    lot has coordinates; the raster has the answer under them.
    """
    j = int((lon * math.cos(math.radians(geo["lat0"])) * 111320.0 - geo["x0"]) / geo["cell"])
    i = int((-lat * 110540.0 - geo["y0"]) / geo["cell"])
    rows, cols = lab.shape
    if not (0 <= i < rows and 0 <= j < cols):
        return -1
    if lab[i, j] >= 0:
        return int(lab[i, j])
    for r in range(1, search + 1):
        i0, i1 = max(0, i - r), min(rows, i + r + 1)
        j0, j1 = max(0, j - r), min(cols, j + r + 1)
        win = lab[i0:i1, j0:j1]
        hit = win[win >= 0]
        if hit.size:
            vals, counts = np.unique(hit, return_counts=True)
            return int(vals[counts.argmax()])
    return -1


def _rings(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    """Closed rings around a boolean region, in grid-corner coordinates.

    Every cell contributes the edges it does not share with a neighbour in the
    region, wound so the outside is always on the same hand; the edges then
    stitch head-to-tail into loops. Holes come out as their own rings, wound
    the other way, which is exactly what an SVG even-odd fill wants.
    """
    rows, cols = mask.shape
    pad = np.zeros((rows + 2, cols + 2), dtype=bool)
    pad[1:-1, 1:-1] = mask

    nxt: dict[tuple[int, int], tuple[int, int]] = {}
    ii, jj = np.nonzero(mask)
    for i, j in zip(ii.tolist(), jj.tolist(), strict=False):
        pi, pj = i + 1, j + 1
        if not pad[pi - 1, pj]:
            nxt[(j, i)] = (j + 1, i)
        if not pad[pi, pj + 1]:
            nxt[(j + 1, i)] = (j + 1, i + 1)
        if not pad[pi + 1, pj]:
            nxt[(j + 1, i + 1)] = (j, i + 1)
        if not pad[pi, pj - 1]:
            nxt[(j, i + 1)] = (j, i)

    out = []
    while nxt:
        start = next(iter(nxt))
        ring, cur = [start], start
        while True:
            nx = nxt.pop(cur, None)
            if nx is None or nx == start:
                break
            ring.append(nx)
            cur = nx
        if len(ring) >= 4:
            out.append(ring)
    return out


def _area(ring: list[tuple[float, float]]) -> float:
    s = 0.0
    for k in range(len(ring)):
        x0, y0 = ring[k]
        x1, y1 = ring[(k + 1) % len(ring)]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2.0


def _rdp(pts: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
    """Douglas-Peucker, iteratively — a coastline ring is thousands of points
    deep and the recursive form blows the stack on the first big district."""
    n = len(pts)
    if n < 3:
        return pts
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        a, b = pts[lo], pts[hi]
        dx, dy = b[0] - a[0], b[1] - a[1]
        den = math.hypot(dx, dy)
        best, bi = -1.0, lo
        for k in range(lo + 1, hi):
            p = pts[k]
            d = (
                abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / den
                if den
                else math.hypot(p[0] - a[0], p[1] - a[1])
            )
            if d > best:
                best, bi = d, k
        if best > eps:
            keep[bi] = True
            stack.append((lo, bi))
            stack.append((bi, hi))
    return [p for p, k in zip(pts, keep, strict=False) if k]


def trace(
    lab: np.ndarray, groups: list[int], simplify: float = SIMPLIFY, min_cells: int = MIN_CELLS
) -> dict[int, dict[str, Any]]:
    """One SVG path per group, in grid-corner coordinates."""
    out: dict[int, dict[str, Any]] = {}
    for g in groups:
        mask = lab == g
        n = int(mask.sum())
        if n < min_cells:
            continue
        rings = _rings(mask)
        parts = []
        for ring in rings:
            fr = [(float(x), float(y)) for x, y in ring]
            if _area(fr) < MIN_RING_CELLS:
                continue
            # Close the loop before simplifying, or the two ends stay square.
            simp = _rdp(fr + [fr[0]], simplify)
            if len(simp) < 4:
                continue
            parts.append(simp[:-1])
        if not parts:
            continue
        d = []
        for p in parts:
            d.append("M" + " ".join(f"{x:.1f} {y:.1f}" for x, y in p) + "Z")
        ii, jj = np.nonzero(mask)
        out[g] = {
            "d": "".join(d),
            "cells": n,
            # Centre of mass of the region's own cells — a label anchor that
            # stays inside a horseshoe-shaped district, unlike a bbox centre.
            "cx": round(float(jj.mean()) + 0.5, 1),
            "cy": round(float(ii.mean()) + 0.5, 1),
            # The page decides from this whether a name fits before drawing it.
            "box": [int(jj.min()), int(ii.min()), int(jj.max()) + 1, int(ii.max()) + 1],
        }
    return out


def build(
    points: list[tuple[float, float, int]],
    groups: list[int],
    cell_m: float = CELL_M,
    max_d_m: float = MAX_D_M,
    simplify: float = SIMPLIFY,
) -> dict[str, Any]:
    """Outlines for one labelling of one city."""
    lab, geo = rasterise(points, cell_m, max_d_m)
    paths = trace(lab, groups, simplify)
    return {"geo": geo, "paths": paths, "lab": lab}
