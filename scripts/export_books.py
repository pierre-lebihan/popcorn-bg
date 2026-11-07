#!/usr/bin/env python3
"""
Génère docs/books.json : classement des mangas & webtoons les mieux notés sur AniList.

- Aucune clé nécessaire (lecture publique de l'API GraphQL AniList).
- Un seul classement « Mangas & webtoons » ; le sous-type sert de filtre dans l'app :
    * manga   = countryOfOrigin JP
    * webtoon = countryOfOrigin KR (manhwa / webtoons) ou CN/TW (manhua)
- Seuil de popularité (nombre de membres AniList) différent par sous-type : les webtoons ont
  moins de membres, un seuil unique les noierait sous les gros mangas japonais.
- Les « lus » ne sont PAS ici : ils vivent sur le compte AniList de chacun (lu par l'Edge Function).

Usage :
  python scripts/export_books.py [--out docs/books.json]
"""
import argparse
import datetime
import json
import re
from pathlib import Path
import sys
import time

import requests

ROOT_DIR = Path(__file__).resolve().parent.parent
ANILIST = "https://graphql.anilist.co"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "popcorn-bg/1.0 (https://github.com/pierre-lebihan/popcorn-bg)",
}

# (sous-type, pays d'origine, seuil de membres, nombre max de titres)
SEGMENTS = [
    ("manga", "JP", 15000, 200),
    ("webtoon", "KR", 5000, 150),
    ("webtoon", "CN", 5000, 50),
]

GENRES_FR = {
    "Action": "Action",
    "Adventure": "Aventure",
    "Comedy": "Comédie",
    "Drama": "Drame",
    "Ecchi": "Ecchi",
    "Fantasy": "Fantasy",
    "Horror": "Horreur",
    "Mahou Shoujo": "Magical girl",
    "Mecha": "Mecha",
    "Music": "Musique",
    "Mystery": "Mystère",
    "Psychological": "Psychologique",
    "Romance": "Romance",
    "Sci-Fi": "SF",
    "Slice of Life": "Tranche de vie",
    "Sports": "Sport",
    "Supernatural": "Surnaturel",
    "Thriller": "Thriller",
}

QUERY = """
query ($page: Int, $country: CountryCode, $minPop: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(type: MANGA, format_in: [MANGA, ONE_SHOT], countryOfOrigin: $country, isAdult: false,
          popularity_greater: $minPop, sort: SCORE_DESC) {
      id
      title { romaji english native }
      averageScore
      popularity
      status
      volumes
      chapters
      countryOfOrigin
      genres
      startDate { year }
      coverImage { large }
      description(asHtml: false)
      siteUrl
      stats { scoreDistribution { amount } }
    }
  }
}
"""


def gql(query: str, variables: dict) -> dict:
    for attempt in range(6):
        r = requests.post(ANILIST, json={"query": query, "variables": variables}, headers=HEADERS, timeout=40)
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "60"))
            print(f"  ⏳ AniList rate limit, pause {wait}s", file=sys.stderr)
            time.sleep(wait + 1)
            continue
        if r.status_code >= 500:
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            raise RuntimeError(f"AniList: {body['errors']}")
        return body["data"]
    raise RuntimeError("AniList indisponible après plusieurs essais")


def clean_description(desc: str | None) -> str:
    if not desc:
        return ""
    txt = re.sub(r"<br\s*/?>", "\n", desc)
    txt = re.sub(r"<[^>]+>", "", txt)
    txt = re.sub(r"\(Source:[^)]*\)", "", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt).strip()
    return txt[:900]


def serialize(m: dict, kind: str) -> dict:
    t = m.get("title") or {}
    en = (t.get("english") or "").strip()
    romaji = (t.get("romaji") or "").strip()
    title = en or romaji
    scorers = sum(int(x.get("amount") or 0) for x in ((m.get("stats") or {}).get("scoreDistribution") or []))
    return {
        "id": m["id"],
        "type": "manga",
        "kind": kind,
        "country": m.get("countryOfOrigin") or "",
        "title": title,
        "alt": romaji if romaji and romaji != title else "",
        "year": str(((m.get("startDate") or {}).get("year")) or ""),
        "cover": ((m.get("coverImage") or {}).get("large")) or "",
        "genres": [GENRES_FR.get(g, g) for g in (m.get("genres") or [])],
        "score": round((m.get("averageScore") or 0) / 10, 1),
        "votes": scorers,
        "members": m.get("popularity") or 0,
        "status": m.get("status") or "",
        "volumes": m.get("volumes"),
        "chapters": m.get("chapters"),
        "overview": clean_description(m.get("description")),
        "url": m.get("siteUrl") or f"https://anilist.co/manga/{m['id']}",
    }


def fetch_segment(kind: str, country: str, min_pop: int, limit: int) -> list[dict]:
    out: list[dict] = []
    page = 1
    while len(out) < limit:
        data = gql(QUERY, {"page": page, "country": country, "minPop": min_pop})
        media = data["Page"]["media"]
        out.extend(serialize(m, kind) for m in media if m.get("averageScore"))
        print(f"  {kind}/{country} page {page}: {len(media)} titres", file=sys.stderr)
        if not data["Page"]["pageInfo"]["hasNextPage"]:
            break
        page += 1
        time.sleep(2.5)  # API en mode dégradé : 30 req/min
    return out[:limit]


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporte le classement mangas & webtoons (AniList)")
    parser.add_argument("--out", default=str(ROOT_DIR / "docs" / "books.json"))
    args = parser.parse_args()

    print("📚 Export AniList (mangas & webtoons)…", file=sys.stderr)
    seen: set[int] = set()
    manga: list[dict] = []
    for kind, country, min_pop, limit in SEGMENTS:
        for it in fetch_segment(kind, country, min_pop, limit):
            if it["id"] not in seen:
                seen.add(it["id"])
                manga.append(it)
        time.sleep(2.5)

    manga.sort(key=lambda x: (-x["score"], -x["votes"]))

    payload = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds"),
        "source": "AniList",
        "manga": manga,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n_m = sum(1 for x in manga if x["kind"] == "manga")
    print(
        f"✅ {len(manga)} titres ({n_m} mangas, {len(manga) - n_m} webtoons) → {out} "
        f"({out.stat().st_size / 1024:.0f} Ko)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
