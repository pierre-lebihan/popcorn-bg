#!/usr/bin/env python3
"""
Génère le fichier statique docs/data.json pour l'application web GitHub Pages (lecture seule, sans exposer de clés API).

Usage :
  python scripts/export_web.py [--refresh-cache] [--out docs/data.json]
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT_DIR / ".env")
except ImportError:
    pass

from tmdb_top50 import (  # noqa: E402
    BASE,
    CACHE_DIR,
    CACHE_TTL_SECONDS,
    DEFAULT_MIN_IMDB_VOTES,
    KEY,
    SID,
    build_list,
    get_account,
    load_imdb_ratings,
    load_tmdb_cache,
    request_get,
    resolve_provider_ids,
    resolve_watch_region,
)
import time  # noqa: E402

EP_TITLES_CACHE_FILE = CACHE_DIR / "tmdb_ep_titles.json"

GENRE_RENAME = {
    "Action & Adventure": "Action & Aventure",
    "Sci-Fi & Fantasy": "SF & Fantastique",
    "Science-Fiction & Fantastique": "SF & Fantastique",
    "Science-Fiction": "SF & Fantastique",
    "Fantastique": "SF & Fantastique",
    "War & Politics": "Guerre & Politique",
    "Guerre": "Guerre & Politique",
    "Kids": "Jeunesse",
    "Reality": "Télé-réalité",
    "Talk": "Talk-show",
    "Soap": "Drame",
    "Téléfilm": "Drame",
}

# Séries sitcoms / anthologies / procédurales célèbres pour lesquelles le tri par épisode est particulièrement utile
EPISODIC_HIGHLIGHT_IDS = {
    42009,   # Black Mirror
    60625,   # Rick et Morty
    86831,   # Love, Death & Robots
    2316,    # The Office (US)
    1668,    # Friends
    1400,    # Seinfeld
    60622,   # Fargo
    1408,    # Dr. House
    4087,    # X-Files
    61222,   # BoJack Horseman
    67557,   # The Grand Tour
    117648,  # Clarkson à la ferme
    456,     # Les Simpson
    2190,    # South Park
    48891,   # Brooklyn Nine-Nine
    2710,    # It's Always Sunny
    105248,  # Cyberpunk: Edgerunners
}


def fetch_genres_map() -> dict[int, str]:
    gmap: dict[int, str] = {}
    for mt in ("movie", "tv"):
        try:
            r = request_get(f"{BASE}/genre/{mt}/list", params={"api_key": KEY, "language": "fr-FR"}).json()
            for g in r.get("genres") or []:
                gid = g.get("id")
                gname = g.get("name")
                if gid and gname:
                    gmap[int(gid)] = GENRE_RENAME.get(gname, gname)
        except Exception:
            pass
    return gmap


def load_ep_titles_cache(force_refresh: bool = False) -> dict:
    if force_refresh or not EP_TITLES_CACHE_FILE.exists():
        return {}
    try:
        raw = json.loads(EP_TITLES_CACHE_FILE.read_text(encoding="utf-8"))
        now = time.time()
        return {k: v for k, v in raw.items() if now - v.get("ts", 0) < CACHE_TTL_SECONDS * 7}
    except Exception:
        return {}


def save_ep_titles_cache(cache: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = EP_TITLES_CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    tmp.replace(EP_TITLES_CACHE_FILE)


def enrich_episode_titles_for_shows(series_list: list[dict], force_refresh: bool = False) -> dict[str, str]:
    """
    Récupère les titres VF des épisodes sur TMDB pour :
      - toutes les séries commencées (partially_watched)
      - les sitcoms / anthologies / comédies majeures
      - le Top 35 des séries
    """
    cache = load_ep_titles_cache(force_refresh=force_refresh)
    tasks: list[tuple[int, int]] = []

    for idx, s in enumerate(series_list):
        mid = s["id"]
        if s.get("season_mode") != "tmdb_seasons":
            continue
        gids = set(s.get("genre_ids") or [])
        is_comedy_or_episodic = (
            mid in EPISODIC_HIGHLIGHT_IDS
            or bool(s.get("partially_watched"))
            or (35 in gids and idx < 90)  # Comédies / Sitcoms
            or idx < 35
        )
        if not is_comedy_or_episodic:
            continue
        rel = s.get("released_seasons") or []
        if len(rel) > 15:
            continue
        for s_num in rel:
            ck = f"{mid}:{s_num}"
            if ck not in cache:
                tasks.append((mid, s_num))

    if tasks:
        print(f"  → Récupération des titres VF d'épisodes ({len(tasks)} saisons)...", file=sys.stderr)

        def fetch_one(pair: tuple[int, int]) -> tuple[str, dict]:
            mid, s_num = pair
            titles: dict[str, str] = {}
            try:
                sd = request_get(
                    f"{BASE}/tv/{mid}/season/{s_num}",
                    params={"api_key": KEY, "language": "fr-FR"},
                ).json()
                for ep_obj in sd.get("episodes") or []:
                    en = ep_obj.get("episode_number")
                    nm = ep_obj.get("name")
                    if en is not None and nm:
                        titles[str(int(en))] = nm
            except Exception:
                pass
            return f"{mid}:{s_num}", {"ts": time.time(), "titles": titles}

        with ThreadPoolExecutor(max_workers=10) as pool:
            for ck, val in pool.map(fetch_one, tasks):
                cache[ck] = val
        save_ep_titles_cache(cache)

    flat_titles: dict[str, str] = {}
    for ck, entry in cache.items():
        for en_s, nm in (entry.get("titles") or {}).items():
            flat_titles[f"{ck}:{en_s}"] = nm
    return flat_titles


def unique_genres(gids: list[int], gmap: dict[int, str]) -> list[str]:
    out: list[str] = []
    for gid in gids:
        lbl = gmap.get(gid)
        if lbl and lbl not in out:
            out.append(lbl)
    return out


# ---------- Titres anglais + titres originaux en alphabet latin ----------

TITLES_CACHE_FILE = CACHE_DIR / "tmdb_titles.json"
LANG_COUNTRY = {
    # Pas de langues indiennes : les titres alternatifs « IN » sont surtout des titres de doublage / de travail
    "ja": "JP", "ko": "KR", "zh": "CN", "cn": "CN", "ru": "RU", "th": "TH", "uk": "UA", "el": "GR",
    "he": "IL", "ar": "EG", "fa": "IR", "bg": "BG", "sr": "RS",
}


def is_latin(s: str) -> bool:
    has_alpha = False
    for c in s or "":
        if c.isalpha():
            has_alpha = True
            if not (ord(c) < 0x0250 or 0x1E00 <= ord(c) <= 0x1EFF):
                return False
    return has_alpha


def pick_latin_original(orig: str, lang: str, en: str, alts: list[dict]) -> str:
    """Titre original s'il est déjà en alphabet latin, sinon sa romanisation (romaji, etc.) si TMDB la connaît."""
    if is_latin(orig):
        return orig
    country = LANG_COUNTRY.get(lang, "")
    for a in alts:
        t = (a.get("title") or "").strip()
        tp = (a.get("type") or "").lower()
        if country:
            ok_countries = {country, "TW", "HK"} if lang in ("zh", "cn") else {country}
            if a.get("iso_3166_1") not in ok_countries:
                continue
        if is_latin(t) and any(k in tp for k in ("romaji", "roman", "hepburn", "translit")):
            return t
    if country:
        for a in alts:
            t = (a.get("title") or "").strip()
            # Évite les sigles (ZNMD, SNK…) et les titres anglais
            if (
                is_latin(t)
                and a.get("iso_3166_1") == country
                and t.lower() != (en or "").lower()
                and not (t.isupper() and " " not in t)
                and not (a.get("type") or "").lower().startswith("initial")
            ):
                return t
    return ""


def load_titles(items: list[tuple[str, int]], force_refresh: bool = False) -> dict[str, dict]:
    cache: dict[str, dict] = {}
    if not force_refresh and TITLES_CACHE_FILE.exists():
        try:
            raw = json.loads(TITLES_CACHE_FILE.read_text(encoding="utf-8"))
            now = time.time()
            cache = {k: v for k, v in raw.items() if now - v.get("ts", 0) < CACHE_TTL_SECONDS * 30}
        except Exception:
            cache = {}

    todo = [(mt, mid) for mt, mid in items if f"{mt}:{mid}" not in cache]
    if todo:
        print(f"  → Récupération des titres anglais / originaux latins ({len(todo)} titres)...", file=sys.stderr)

        def fetch_one(pair: tuple[str, int]) -> tuple[str, dict | None]:
            mt, mid = pair
            try:
                d = request_get(
                    f"{BASE}/{mt}/{mid}",
                    params={"api_key": KEY, "language": "en-US", "append_to_response": "alternative_titles"},
                ).json()
            except Exception:
                return f"{mt}:{mid}", None
            en = d.get("title") or d.get("name") or ""
            orig = d.get("original_title") or d.get("original_name") or ""
            alt_block = d.get("alternative_titles") or {}
            alts = alt_block.get("titles") or alt_block.get("results") or []
            latin = pick_latin_original(orig, d.get("original_language") or "", en, alts)
            return f"{mt}:{mid}", {"ts": time.time(), "en": en, "origLatin": latin}

        with ThreadPoolExecutor(max_workers=10) as pool:
            for ck, val in pool.map(fetch_one, todo):
                if val:
                    cache[ck] = val
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = TITLES_CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        tmp.replace(TITLES_CACHE_FILE)
    return cache


def title_fields(title: str, raw_orig: str, info: dict | None) -> dict:
    """en = titre anglais (si différent du titre FR) ; orig = original en alphabet latin (si différent des deux)."""
    info = info or {}
    en = (info.get("en") or "").strip()
    orig = (info.get("origLatin") or "").strip()
    if not info and is_latin(raw_orig):
        orig = raw_orig
    seen = {title.strip().lower()}
    out_en = en if en and en.lower() not in seen else ""
    if out_en:
        seen.add(out_en.lower())
    out_orig = orig if orig and orig.lower() not in seen else ""
    return {"en": out_en, "orig": out_orig}


def serialize_movie(m: dict, global_rank: int, gmap: dict[int, str], titles: dict[str, dict]) -> dict:
    title = m.get("title") or "?"
    orig = m.get("original_title") or ""
    return {
        "id": m["id"],
        "type": "movie",
        "title": title,
        **title_fields(title, orig, titles.get(f"movie:{m['id']}")),
        "year": (m.get("release_date") or "")[:4],
        "poster": m.get("poster_path") or "",
        "overview": (m.get("overview") or "").strip(),
        "genres": unique_genres(m.get("genre_ids") or [], gmap),
        "providers": m.get("providers") or [],
        "imdb": m.get("global_imdb_rating"),
        "votes": m.get("imdb_votes") or 0,
        "tmdb": round(m.get("vote_average") or 0, 1),
        "rankAll": global_rank,
        "tmdbUrl": m.get("tmdb_url"),
        "watchUrl": m.get("watch_url"),
        "imdbUrl": m.get("imdb_url"),
    }


def serialize_series(
    s: dict,
    global_rank: int,
    gmap: dict[int, str],
    ep_titles: dict[str, str],
    titles: dict[str, dict],
) -> dict:
    """Catalogue public uniquement : aucun état « vu » (chargé après connexion via l'Edge Function)."""
    mid = s["id"]
    name = s.get("name") or "?"
    orig = s.get("original_name") or ""
    released = s.get("released_seasons") or []
    season_scores = {str(k): v for k, v in (s.get("season_scores") or {}).items()}

    # Compact episode list: [season, ep, rating, votes, tconst, title]
    compact_eps: list[list] = []
    season_eps = s.get("season_episodes") or {}
    for sn in released:
        for ep in season_eps.get(sn) or []:
            en = ep["ep"]
            t_vf = ep_titles.get(f"{mid}:{sn}:{en}", "")
            compact_eps.append([
                sn,
                en,
                ep["rating"],
                ep["votes"],
                ep.get("tconst") or "",
                t_vf,
            ])

    gnames = unique_genres(s.get("genre_ids") or [], gmap)
    return {
        "id": mid,
        "type": "tv",
        "title": name,
        **title_fields(name, orig, titles.get(f"tv:{mid}")),
        "year": (s.get("first_air_date") or "")[:4],
        "poster": s.get("poster_path") or "",
        "overview": (s.get("overview") or "").strip(),
        "genres": gnames,
        "providers": s.get("providers") or [],
        "imdb": s.get("global_imdb_rating"),
        "votes": s.get("imdb_votes") or 0,
        "tmdb": round(s.get("vote_average") or 0, 1),
        "episodic": mid in EPISODIC_HIGHLIGHT_IDS or ("Comédie" in gnames),
        "seasonMode": s.get("season_mode") or "tmdb_seasons",
        "releasedSeasons": released,
        "seasonScores": season_scores,
        "episodes": compact_eps,
        "rankAll": global_rank,
        "tmdbUrl": s.get("tmdb_url"),
        "watchUrl": s.get("watch_url"),
        "imdbUrl": s.get("imdb_url"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporte les données statiques JSON pour GitHub Pages")
    parser.add_argument("--out", type=str, default=str(ROOT_DIR / "docs" / "data.json"), help="Fichier JSON de sortie")
    parser.add_argument("--limit", type=int, default=500, help="Nombre max de films / séries à exporter (défaut: 500)")
    parser.add_argument("--min-imdb-votes", type=int, default=DEFAULT_MIN_IMDB_VOTES)
    parser.add_argument("--refresh-cache", action="store_true")
    args = parser.parse_args()

    if not KEY or not SID:
        print("Erreur: TMDB_API_KEY et TMDB_SESSION_ID doivent être définis.", file=sys.stderr)
        sys.exit(1)

    account = get_account()
    watch_region = resolve_watch_region(account, None)
    provider_ids = resolve_provider_ids(None)
    account_id = account["id"]

    print(f"📦 Export Web JSON (région {watch_region}, fournisseurs [{provider_ids}])...", file=sys.stderr)
    gmap = fetch_genres_map()
    imdb_ratings = load_imdb_ratings(min_votes=args.min_imdb_votes, force_refresh=args.refresh_cache)
    tmdb_cache = load_tmdb_cache(force_refresh=args.refresh_cache)

    movies_all = build_list(
        "movie",
        account_id,
        watch_region,
        provider_ids,
        imdb_ratings,
        tmdb_cache,
        limit=args.limit,
        filter_vus=False,
        force_refresh=args.refresh_cache,
    )
    assert isinstance(movies_all, list)

    series_all = build_list(
        "tv",
        account_id,
        watch_region,
        provider_ids,
        imdb_ratings,
        tmdb_cache,
        limit=args.limit,
        filter_vus=False,
        force_refresh=args.refresh_cache,
    )
    assert isinstance(series_all, list)

    ep_titles = enrich_episode_titles_for_shows(series_all, force_refresh=args.refresh_cache)
    titles = load_titles(
        [("movie", m["id"]) for m in movies_all] + [("tv", s["id"]) for s in series_all],
        force_refresh=args.refresh_cache,
    )

    movies_out = [serialize_movie(m, idx, gmap, titles) for idx, m in enumerate(movies_all, 1)]
    series_out = [serialize_series(s, idx, gmap, ep_titles, titles) for idx, s in enumerate(series_all, 1)]

    now_utc = datetime.datetime.now(datetime.timezone.utc).astimezone()
    payload = {
        "generatedAt": now_utc.isoformat(timespec="seconds"),
        "region": watch_region,
        "minImdbVotes": args.min_imdb_votes,
        "providers": ["Netflix", "Prime Video", "Apple TV"],
        "movies": movies_out,
        "series": series_out,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(
        f"✅ Exporté {len(movies_out)} films + {len(series_out)} séries (catalogue public, sans « vus ») "
        f"→ {out_path} ({size_kb:.0f} Ko)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
