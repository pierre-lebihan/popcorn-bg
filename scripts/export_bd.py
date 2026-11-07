#!/usr/bin/env python3
"""
Génère docs/bd.json : classement BD & comics à partir du référentiel figé data/bd_referentiel.json.

- Le référentiel (prix et palmarès de critiques) est mis à jour à la main de temps en temps
  (scripts/build_bd_referentiel.py). Sa date est affichée dans l'app.
- Score de consensus = somme des points des citations (Fauve d'or 5, Prix de la série / ACBD / Eisner série 4,
  autres 3, classique ajouté à la main 1) + bonus selon la note des lecteurs Hardcover (si HARDCOVER_TOKEN).
- Paliers : Chef-d'œuvre (≥ 8), Incontournable (≥ 4), Recommandé.
- Les « lus » ne sont PAS ici : ils sont dans Supabase (colonne bd de popcorn_user_state).

Usage :
  HARDCOVER_TOKEN=... python scripts/export_bd.py [--out docs/bd.json]
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests

ROOT_DIR = Path(__file__).resolve().parent.parent
REF = ROOT_DIR / "data" / "bd_referentiel.json"
HARDCOVER = "https://api.hardcover.app/v1/graphql"
STOP = {"le", "la", "les", "l", "de", "des", "du", "d", "et", "the", "of", "a", "an", "un", "une", "and"}

SEARCH = """
query ($q: String!) {
  search(query: $q, query_type: "Book", per_page: 8, page: 1) { results }
}
"""


def norm_tokens(s: str) -> set[str]:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return {t for t in re.split(r"[^a-z0-9]+", s) if t and t not in STOP}


def hc_search(token: str, q: str) -> list[dict]:
    auth = token if token.lower().startswith("bearer ") else "Bearer " + token
    headers = {"Content-Type": "application/json", "authorization": auth,
               "User-Agent": "popcorn-bg/1.0 (https://github.com/pierre-lebihan/popcorn-bg)"}
    for attempt in range(4):
        r = requests.post(HARDCOVER, json={"query": SEARCH, "variables": {"q": q}}, headers=headers, timeout=30)
        if r.status_code == 429:
            time.sleep(15 * (attempt + 1))
            continue
        if r.status_code >= 500:
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            raise RuntimeError(str(body["errors"])[:300])
        res = (body.get("data") or {}).get("search") or {}
        results = res.get("results") or {}
        if isinstance(results, str):
            results = json.loads(results)
        return [h.get("document") or {} for h in (results.get("hits") or [])]
    return []


def best_match(item: dict, docs: list[dict]) -> dict | None:
    want = norm_tokens(item.get("hc") or item["title"])
    authors = norm_tokens(item.get("authors", ""))
    best, best_key = None, None
    for d in docs:
        hay = norm_tokens(" ".join([d.get("title") or "", " ".join(d.get("series_names") or [])]))
        overlap = len(want & hay)
        if overlap == 0:
            continue
        auth_ok = len(authors & norm_tokens(" ".join(d.get("author_names") or []))) > 0
        key = (auth_ok, overlap, d.get("ratings_count") or 0)
        if best_key is None or key > best_key:
            best, best_key = d, key
    if best is None or (not best_key[0] and best_key[1] < len(want)):
        return None
    return best


def clean(desc: str | None) -> str:
    if not desc:
        return ""
    txt = re.sub(r"<[^>]+>", "", desc)
    return re.sub(r"\s+\n", "\n", txt).strip()[:900]


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporte le classement BD & comics")
    parser.add_argument("--out", default=str(ROOT_DIR / "docs" / "bd.json"))
    args = parser.parse_args()

    ref = json.loads(REF.read_text(encoding="utf-8"))
    sources = ref["sources"]
    token = os.environ.get("HARDCOVER_TOKEN", "").strip()
    print(f"📚 Export BD & comics ({len(ref['titles'])} titres, Hardcover {'oui' if token else 'non'})…", file=sys.stderr)

    out = []
    hc_ok = 0
    for it in ref["titles"]:
        points = sum(sources[c["src"]]["points"] for c in it["cites"])
        hc = None
        if token:
            try:
                q = it.get("hc") or (it["title"] + " " + it["authors"].split(",")[0])
                doc = best_match(it, hc_search(token, q))
                if doc:
                    hc = doc
                    hc_ok += 1
                print(f"  {it['title']!r} → {(doc or {}).get('title')!r} "
                      f"{(doc or {}).get('rating')} ({(doc or {}).get('ratings_count')})", file=sys.stderr)
            except Exception as e:  # noqa: BLE001
                print(f"  ⚠️ Hardcover {it['title']!r}: {e}", file=sys.stderr)
            time.sleep(1.1)  # 60 requêtes / min

        rating = round(float(hc.get("rating") or 0), 2) if hc else 0
        count = int(hc.get("ratings_count") or 0) if hc else 0
        bonus = 0
        if count >= 20 and rating >= 4.3:
            bonus = 2
        elif count >= 10 and rating >= 4.0:
            bonus = 1
        score = points + bonus
        tier = "chef" if score >= 8 else "incontournable" if score >= 4 else "recommande"
        image = (hc or {}).get("image") or {}
        entry = {
            "id": it["id"],
            "type": "bd",
            "kind": it["kind"],
            "mode": it["mode"],
            "title": it["title"],
            "authors": it["authors"],
            "year": str(it.get("year") or ""),
            "volumes": it.get("volumes"),
            "cites": it["cites"],
            "points": points,
            "bonus": bonus,
            "score": score,
            "tier": tier,
            "hcRating": rating,
            "votes": count,
            "hcUrl": f"https://hardcover.app/books/{hc['slug']}" if hc and hc.get("slug") else "",
            "cover": image.get("url") or "",
            "genres": [g for g in ((hc or {}).get("genres") or [])][:4],
            "overview": clean((hc or {}).get("description")),
        }
        if it.get("albums"):
            entry["albums"] = it["albums"]
        out.append(entry)

    out.sort(key=lambda x: (-x["score"], -x["hcRating"], -x["votes"]))
    payload = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds"),
        "referentialUpdatedAt": ref["updatedAt"],
        "sources": sources,
        "bd": out,
    }
    p = Path(args.out)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tiers = {t: sum(1 for x in out if x["tier"] == t) for t in ("chef", "incontournable", "recommande")}
    print(f"✅ {len(out)} titres ({tiers}), Hardcover trouvé pour {hc_ok} → {p} ({p.stat().st_size / 1024:.0f} Ko)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
