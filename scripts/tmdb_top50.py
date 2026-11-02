#!/usr/bin/env python3
"""
Script pour afficher le TOP 50 films/séries en streaming abonnement (flatrate), non vus, triés par IMDb.

Sources :
  - Catalogue & statut "vu" (par film, ou saison par saison pour les séries) : API TMDB v3.
  - Notes & votes IMDb globaux + saison par saison : datasets officiels quotidiens d'IMDb
    (title.ratings.tsv.gz + title.episode.tsv.gz, mis en cache 24h dans .cache/).

Usage:
  python scripts/tmdb_top50.py [--film] [--serie] [--all] [--markdown] [--min-imdb-votes 3000]
  Par défaut : films uniquement. --film et --serie pour afficher les deux.

Variables d'environnement (.env):
  TMDB_API_KEY            — Clé API TMDB (requis)
  TMDB_SESSION_ID         — Session TMDB pour filtrer les films/séries déjà notés/vus (requis)
  TMDB_WATCH_REGION       — Forcer le pays catalogue ISO (ex. BG, FR). Sinon = pays du compte TMDB.
  TMDB_WATCH_PROVIDER_IDS — IDs TMDB séparés par ',' ou '|' (défaut: 8 = Netflix).
                            Voir: python scripts/tmdb_top50.py --list-providers
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import gzip
import json
import os
from pathlib import Path
import re
import sys
import threading
import time

import requests

ROOT_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT_DIR / ".cache"
IMDB_CACHE_FILE = CACHE_DIR / "imdb_ratings.tsv.gz"
IMDB_EPISODES_CACHE_FILE = CACHE_DIR / "imdb_episodes.tsv.gz"
IMDB_SEASON_CACHE_FILE = CACHE_DIR / "imdb_seasons_parsed.json"
TMDB_CACHE_FILE = CACHE_DIR / "tmdb_details.json"

IMDB_DATASET_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz"
IMDB_EPISODES_URL = "https://datasets.imdbws.com/title.episode.tsv.gz"
CACHE_TTL_SECONDS = 86400  # 24h

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT_DIR / ".env")
except ImportError:
    pass

KEY = os.environ.get("TMDB_API_KEY")
SID = os.environ.get("TMDB_SESSION_ID")
BASE = "https://api.themoviedb.org/3"

DEFAULT_PROVIDER_IDS = "8"
DEFAULT_MIN_IMDB_VOTES = 3000
SEASON_MARKER_RATING = 8.0
EPISODE_MARKER_RATING = 8.5
IMDB_SEASON_CACHE_SCHEMA = 2

DISCOVER_CONFIG = {
    "movie": {"min_tmdb_votes": 100, "pages": 22},
    "tv": {"min_tmdb_votes": 50, "pages": 25},
}

SHORT_PROVIDER_NAMES = {
    "Amazon Prime Video": "Prime Video",
    "Amazon Prime Video with Ads": "Prime Video",
    "Netflix Standard with Ads": "Netflix",
}

_thread_local = threading.local()


def get_session() -> requests.Session:
    sess = getattr(_thread_local, "session", None)
    if sess is None:
        sess = requests.Session()
        _thread_local.session = sess
    return sess


def request_get(url: str, params: dict | None = None, timeout: int = 20) -> requests.Response:
    last: Exception | None = None
    sess = get_session()
    for attempt in range(5):
        try:
            r = sess.get(url, params=params, timeout=timeout)
            if r.status_code == 429:
                wait = float(r.headers.get("Retry-After", 1.5 * (attempt + 1)))
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code in (400, 401, 403, 404):
                raise
            last = e
            time.sleep(1.0 * (attempt + 1))
        except requests.RequestException as e:
            last = e
            time.sleep(1.0 * (attempt + 1))
    assert last is not None
    raise last


def ensure_imdb_file(url: str, path: Path, label: str, force_refresh: bool = False) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    need_download = force_refresh or not path.exists()
    if not need_download:
        age = time.time() - path.stat().st_mtime
        need_download = age > CACHE_TTL_SECONDS

    if need_download:
        print(f"⬇️  Téléchargement du dataset quotidien IMDb ({label})...", file=sys.stderr)
        tmp = path.with_suffix(".tmp")
        try:
            with requests.get(url, stream=True, timeout=90) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(chunk_size=262144):
                        if chunk:
                            f.write(chunk)
            tmp.replace(path)
        except Exception as e:
            if tmp.exists():
                tmp.unlink(missing_ok=True)
            if not path.exists():
                raise RuntimeError(f"Impossible de télécharger {label} : {e}") from e
            print(f"⚠️  Échec rafraîchissement {label} ({e}), utilisation du cache existant.", file=sys.stderr)


def load_imdb_ratings(min_votes: int = DEFAULT_MIN_IMDB_VOTES, force_refresh: bool = False) -> dict[str, tuple[float, int]]:
    ensure_imdb_file(IMDB_DATASET_URL, IMDB_CACHE_FILE, "title.ratings.tsv.gz", force_refresh=force_refresh)
    min_len = len(str(max(1, min_votes)))
    ratings: dict[str, tuple[float, int]] = {}
    with gzip.open(IMDB_CACHE_FILE, "rt", encoding="utf-8") as f:
        next(f, None)  # en-tête : tconst	averageRating	numVotes
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 3:
                continue
            tconst, rating_s, votes_s = parts
            if len(votes_s) < min_len:
                continue
            votes = int(votes_s)
            if votes >= min_votes:
                ratings[tconst] = (float(rating_s), votes)
    return ratings


def load_imdb_seasons_for_shows(
    target_imdb_ids: set[str],
    force_refresh: bool = False,
) -> dict[str, list[list]]:
    """
    Retourne pour chaque parent_tconst demandé la liste [[season_num, ep_num, rating, votes, ep_tconst], ...]
    extraite de title.episode.tsv.gz + title.ratings.tsv.gz, avec cache JSON incrémental 24h.
    """
    clean_ids = {t for t in target_imdb_ids if t}
    if not clean_ids:
        return {}

    ensure_imdb_file(IMDB_DATASET_URL, IMDB_CACHE_FILE, "title.ratings.tsv.gz", force_refresh=force_refresh)
    ensure_imdb_file(IMDB_EPISODES_URL, IMDB_EPISODES_CACHE_FILE, "title.episode.tsv.gz", force_refresh=force_refresh)

    mtime_r = round(IMDB_CACHE_FILE.stat().st_mtime, 2)
    mtime_e = round(IMDB_EPISODES_CACHE_FILE.stat().st_mtime, 2)

    cached_shows: dict[str, list[list]] = {}
    if not force_refresh and IMDB_SEASON_CACHE_FILE.exists():
        try:
            payload = json.loads(IMDB_SEASON_CACHE_FILE.read_text(encoding="utf-8"))
            if (
                payload.get("schema") == IMDB_SEASON_CACHE_SCHEMA
                and payload.get("mtime_ratings") == mtime_r
                and payload.get("mtime_episodes") == mtime_e
            ):
                cached_shows = payload.get("shows") or {}
        except Exception:
            cached_shows = {}

    missing_ids = clean_ids - set(cached_shows.keys())
    if missing_ids:
        print(
            f"  → Extraction des notes IMDb par épisode/saison ({len(missing_ids)} série(s))...",
            file=sys.stderr,
        )
        for tt in missing_ids:
            cached_shows[tt] = []

        ep_map: dict[str, tuple[str, int, int]] = {}
        with gzip.open(IMDB_EPISODES_CACHE_FILE, "rt", encoding="utf-8") as f:
            next(f, None)  # tconst	parentTconst	seasonNumber	episodeNumber
            for line in f:
                t1 = line.find("\t")
                if t1 < 0:
                    continue
                t2 = line.find("\t", t1 + 1)
                if t2 < 0:
                    continue
                parent = line[t1 + 1 : t2]
                if parent in missing_ids:
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) == 4 and parts[2].isdigit():
                        s_num = int(parts[2])
                        if s_num >= 1:
                            ep_num = int(parts[3]) if parts[3].isdigit() else 0
                            ep_map[parts[0]] = (parent, s_num, ep_num)

        if ep_map:
            with gzip.open(IMDB_CACHE_FILE, "rt", encoding="utf-8") as f:
                next(f, None)
                for line in f:
                    t1 = line.find("\t")
                    if t1 < 0:
                        continue
                    tc = line[:t1]
                    if tc in ep_map:
                        parts = line.rstrip("\n").split("\t")
                        if len(parts) == 3:
                            parent, s_num, ep_num = ep_map[tc]
                            cached_shows[parent].append([s_num, ep_num, float(parts[1]), int(parts[2]), tc])

        tmp = IMDB_SEASON_CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(
                {
                    "schema": IMDB_SEASON_CACHE_SCHEMA,
                    "mtime_ratings": mtime_r,
                    "mtime_episodes": mtime_e,
                    "shows": cached_shows,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        tmp.replace(IMDB_SEASON_CACHE_FILE)

    return {tt: cached_shows.get(tt, []) for tt in clean_ids}


def extract_tmdb_seasons_meta(tv_detail: dict) -> list[dict]:
    out = []
    for s in tv_detail.get("seasons") or []:
        s_num = s.get("season_number") or 0
        if s_num >= 1:
            out.append({
                "s": s_num,
                "ep_count": s.get("episode_count") or 0,
                "air_date": s.get("air_date"),
                "tmdb_rating": s.get("vote_average") or 0.0,
            })
    out.sort(key=lambda x: x["s"])
    return out


def compute_tv_season_info(
    tmdb_seasons: list[dict],
    imdb_eps: list[list],
    today_iso: str | None = None,
) -> dict:
    """
    Aligne les saisons sorties entre TMDB et IMDb et calcule la note IMDb de chaque saison :
      - mode="tmdb_seasons" (cas général) : chaque saison correspond à une saison TMDB.
        Si IMDb regroupe tout en S1 (ex. Hunter x Hunter, One Piece 1999), découpe S1 par ep_count TMDB.
      - mode="tmdb_single_split" (ex. Jujutsu Kaisen, Frieren où TMDB met tout en S1 alors qu'IMDb a S1, S2...) :
        les saisons canoniques sont celles d'IMDb, stockées sur TMDB via les épisodes 1..N de la saison 1.
    """
    if today_iso is None:
        today_iso = datetime.date.today().isoformat()

    tmdb_released = [
        s for s in sorted(tmdb_seasons, key=lambda x: x["s"])
        if s["s"] >= 1
        and (s.get("ep_count") or 0) > 0
        and (
            (s.get("air_date") and s["air_date"] <= today_iso)
            or (s.get("air_date") is None and (s.get("tmdb_rating") or 0) > 0)
        )
    ]
    if not tmdb_released and tmdb_seasons:
        s1 = [s for s in tmdb_seasons if s["s"] == 1 and (s.get("ep_count") or 0) > 0]
        if s1:
            tmdb_released = s1

    # Filtre les épisodes non sortis / bruit (< 20 votes, repli >= 5 si série confidentielle)
    filtered_eps = [e for e in imdb_eps if e[3] >= 20]
    if not filtered_eps:
        filtered_eps = [e for e in imdb_eps if e[3] >= 5]

    by_imdb_s: dict[int, list[tuple[int, float, int, str | None]]] = {}
    for row in filtered_eps:
        s_num, ep_num, rating, votes = row[0], row[1], row[2], row[3]
        ep_tc = row[4] if len(row) > 4 else None
        if s_num >= 1:
            by_imdb_s.setdefault(s_num, []).append((ep_num, rating, votes, ep_tc))

    imdb_multi_seasons = sorted(
        s for s, eps in by_imdb_s.items() if len(eps) >= 2 and any(v >= 25 for _, _, v, _ in eps)
    )

    season_ep_ratings: dict[int, list[tuple[float, int]]] = {}
    season_episodes: dict[int, list[dict]] = {}
    if (
        len(tmdb_released) == 1
        and len(imdb_multi_seasons) >= 2
        and imdb_multi_seasons[0] == 1
        and (tmdb_released[0].get("ep_count") or 0) >= len(imdb_multi_seasons)
    ):
        mode = "tmdb_single_split"
        released_seasons = imdb_multi_seasons
        for s in released_seasons:
            eps_s = sorted(by_imdb_s[s], key=lambda x: x[0])
            season_ep_ratings[s] = [(r, v) for _, r, v, _ in eps_s]
            season_episodes[s] = [
                {"s": s, "ep": ep_n, "rating": r, "votes": v, "tconst": tc}
                for ep_n, r, v, tc in eps_s
            ]
    else:
        mode = "tmdb_seasons"
        released_seasons = [s["s"] for s in tmdb_released]
        if len(tmdb_released) > 1 and list(by_imdb_s.keys()) == [1]:
            # Découpe l'unique saison IMDb selon le nombre d'épisodes par saison TMDB
            s1_eps = sorted(by_imdb_s[1], key=lambda x: x[0])
            start_ep = 1
            for ts in tmdb_released:
                cnt = ts.get("ep_count") or 0
                end_ep = start_ep + cnt - 1
                sliced_full = [
                    (ep_n, r, v, tc) for ep_n, r, v, tc in s1_eps if start_ep <= ep_n <= end_ep
                ]
                if sliced_full:
                    season_ep_ratings[ts["s"]] = [(r, v) for _, r, v, _ in sliced_full]
                    season_episodes[ts["s"]] = [
                        {"s": ts["s"], "ep": ep_n, "rating": r, "votes": v, "tconst": tc}
                        for ep_n, r, v, tc in sliced_full
                    ]
                start_ep = end_ep + 1
        else:
            for s in released_seasons:
                if s in by_imdb_s:
                    eps_s = sorted(by_imdb_s[s], key=lambda x: x[0])
                    season_ep_ratings[s] = [(r, v) for _, r, v, _ in eps_s]
                    season_episodes[s] = [
                        {"s": s, "ep": ep_n, "rating": r, "votes": v, "tconst": tc}
                        for ep_n, r, v, tc in eps_s
                    ]

    season_scores: dict[int, float] = {}
    for s, pairs in season_ep_ratings.items():
        if pairs:
            season_scores[s] = round(sum(r for r, _ in pairs) / len(pairs), 1)

    return {
        "mode": mode,
        "released_seasons": released_seasons,
        "season_scores": season_scores,
        "season_ep_ratings": season_ep_ratings,
        "season_episodes": season_episodes,
    }


def decode_tv_progress(
    mid: int,
    mode: str,
    released_seasons: list[int],
    season_episodes: dict[int, list[dict]],
    rated_tv_ids: set[int],
    rated_episodes: dict[int, dict[tuple[int, int], float]] | dict[int, set[tuple[int, int]]],
) -> tuple[set[int], set[tuple[int, int]]]:
    """
    Décode depuis TMDB :
      - watched_seasons : saisons entièrement vues (marqueur rating != 8.5, ou tous épisodes cochés à 8.5)
      - watched_indiv_eps : épisodes individuels vus (rating == 8.5) dans les saisons partiellement picorées
    """
    if mid in rated_tv_ids:
        return set(released_seasons), set()
    raw_eps = rated_episodes.get(mid)
    if not raw_eps:
        return set(), set()

    if isinstance(raw_eps, dict):
        eps_map = raw_eps
    else:
        eps_map = {pair: SEASON_MARKER_RATING for pair in raw_eps}

    rel_set = set(released_seasons)
    season_markers = {
        (s, e) for (s, e), r in eps_map.items() if abs(float(r) - EPISODE_MARKER_RATING) > 0.01
    }
    indiv_markers = {
        (s, e) for (s, e), r in eps_map.items() if abs(float(r) - EPISODE_MARKER_RATING) <= 0.01
    }

    if mode == "tmdb_single_split":
        watched_seasons = {ep_num for (s_num, ep_num) in season_markers if s_num == 1 and ep_num in rel_set}
        return watched_seasons, set()

    watched_seasons = {s_num for (s_num, _ep_num) in season_markers if s_num in rel_set}
    for s in rel_set - watched_seasons:
        ep_nums = {ep["ep"] for ep in (season_episodes.get(s) or []) if ep.get("ep")}
        if ep_nums and all((s, ep_n) in indiv_markers for ep_n in ep_nums):
            watched_seasons.add(s)

    watched_indiv_eps = {
        (s, e) for (s, e) in indiv_markers if s in rel_set and s not in watched_seasons
    }
    return watched_seasons, watched_indiv_eps


def decode_watched_seasons(
    mid: int,
    mode: str,
    released_seasons: list[int],
    rated_tv_ids: set[int],
    rated_episodes: dict[int, dict[tuple[int, int], float]] | dict[int, set[tuple[int, int]]],
) -> set[int]:
    ws, _ = decode_tv_progress(mid, mode, released_seasons, {}, rated_tv_ids, rated_episodes)
    return ws


def format_season_ranges(seasons: list[int] | set[int]) -> str:
    nums = sorted(set(seasons))
    if not nums:
        return ""
    ranges: list[str] = []
    start = prev = nums[0]
    for n in nums[1:]:
        if n == prev + 1:
            prev = n
        else:
            ranges.append(f"S{start}" if start == prev else f"S{start}–S{prev}")
            start = prev = n
    ranges.append(f"S{start}" if start == prev else f"S{start}–S{prev}")
    return ", ".join(ranges)


def format_season_breakdown(
    released: list[int],
    watched: set[int],
    season_scores: dict[int, float],
) -> str:
    if not released or not season_scores:
        return ""
    show_check = 0 < len(watched) < len(released)

    def fmt(s: int) -> str:
        sc = f"{season_scores[s]:.1f}" if s in season_scores else "—"
        chk = "✓" if (show_check and s in watched) else ""
        return f"S{s}:{sc}{chk}"

    if len(released) <= 10:
        return " · ".join(fmt(s) for s in released)

    if show_check:
        watched_list = [s for s in released if s in watched]
        unwatched_list = [s for s in released if s not in watched]
        parts: list[str] = []
        if watched_list:
            parts.append(fmt(watched_list[0]))
            if len(watched_list) > 2:
                parts.append("…")
            if len(watched_list) > 1:
                parts.append(fmt(watched_list[-1]))
        if len(unwatched_list) <= 6:
            parts.extend(fmt(s) for s in unwatched_list)
        else:
            parts.extend(fmt(s) for s in unwatched_list[:3])
            parts.append("…")
            parts.extend(fmt(s) for s in unwatched_list[-2:])
        return " · ".join(parts)

    head = [fmt(s) for s in released[:3]]
    tail = [fmt(s) for s in released[-3:]]
    return " · ".join([*head, "…", *tail])


def load_tmdb_cache(force_refresh: bool = False) -> dict:
    if force_refresh or not TMDB_CACHE_FILE.exists():
        return {}
    try:
        data = json.loads(TMDB_CACHE_FILE.read_text(encoding="utf-8"))
        now = time.time()
        return {k: v for k, v in data.items() if now - v.get("ts", 0) < CACHE_TTL_SECONDS}
    except Exception:
        return {}


def save_tmdb_cache(cache: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = TMDB_CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    tmp.replace(TMDB_CACHE_FILE)


def get_account() -> dict:
    r = request_get(f"{BASE}/account", params={"api_key": KEY, "session_id": SID})
    data = r.json()
    if "id" not in data:
        raise RuntimeError(f"Réponse account invalide: {data}")
    return data


def resolve_watch_region(account: dict, override: str | None) -> str:
    if override:
        return override.upper()
    env = (os.environ.get("TMDB_WATCH_REGION") or "").strip()
    if env:
        return env.upper()
    return (account.get("iso_3166_1") or "US").upper()


def resolve_provider_ids(override: str | None) -> str:
    raw = override if override else (os.environ.get("TMDB_WATCH_PROVIDER_IDS") or DEFAULT_PROVIDER_IDS)
    # L'API TMDB utilise '|' pour un OU logique entre fournisseurs (',' ferait un ET).
    parts = [p.strip() for p in raw.replace("|", ",").split(",") if p.strip()]
    return "|".join(parts) or DEFAULT_PROVIDER_IDS


def get_rated_ids(account_id: int, mt: str) -> set[int]:
    ids, page = set(), 1
    while True:
        r = request_get(
            f"{BASE}/account/{account_id}/rated/{mt}",
            params={"api_key": KEY, "session_id": SID, "page": page},
        ).json()
        for m in r.get("results", []):
            ids.add(m["id"])
        if page >= r.get("total_pages", 1):
            break
        page += 1
    return ids


def get_rated_tv_episodes(account_id: int) -> dict[int, dict[tuple[int, int], float]]:
    by_show: dict[int, dict[tuple[int, int], float]] = {}
    page = 1
    while True:
        r = request_get(
            f"{BASE}/account/{account_id}/rated/tv/episodes",
            params={"api_key": KEY, "session_id": SID, "page": page},
        ).json()
        for ep in r.get("results", []):
            sid = ep.get("show_id")
            s_num = ep.get("season_number")
            e_num = ep.get("episode_number")
            val = float(ep.get("rating") or SEASON_MARKER_RATING)
            if sid and s_num is not None and e_num is not None:
                by_show.setdefault(sid, {})[(int(s_num), int(e_num))] = val
        if page >= r.get("total_pages", 1):
            break
        page += 1
    return by_show


def fetch_discover(
    mt: str,
    watch_region: str,
    provider_ids: str,
    pages: int,
    min_tmdb_votes: int,
) -> list[dict]:
    def fetch_page(p: int) -> list[dict]:
        r = request_get(
            f"{BASE}/discover/{mt}",
            params={
                "api_key": KEY,
                "language": "fr-FR",
                "watch_region": watch_region,
                "with_watch_providers": provider_ids,
                "with_watch_monetization_types": "flatrate",
                "sort_by": "vote_average.desc",
                "vote_count.gte": min_tmdb_votes,
                "page": p,
            },
        )
        payload = r.json()
        if payload.get("status_message"):
            raise RuntimeError(payload.get("status_message", str(payload)))
        return payload.get("results", [])

    first = request_get(
        f"{BASE}/discover/{mt}",
        params={
            "api_key": KEY,
            "language": "fr-FR",
            "watch_region": watch_region,
            "with_watch_providers": provider_ids,
            "with_watch_monetization_types": "flatrate",
            "sort_by": "vote_average.desc",
            "vote_count.gte": min_tmdb_votes,
            "page": 1,
        },
    ).json()
    max_page = min(pages, first.get("total_pages", 1))
    out = list(first.get("results", []))
    if max_page > 1:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for page_items in pool.map(fetch_page, range(2, max_page + 1)):
                out.extend(page_items)

    seen: set[int] = set()
    unique: list[dict] = []
    for item in out:
        mid = item["id"]
        if mid not in seen:
            seen.add(mid)
            unique.append(item)
    return unique


def list_flatrate_providers(watch_region: str) -> None:
    for endpoint, label in (("movie", "Films"), ("tv", "Séries")):
        r = request_get(f"{BASE}/watch/providers/{endpoint}", params={"api_key": KEY})
        providers = r.json().get("results", [])
        flat = []
        for p in providers:
            pr = p.get("display_priorities", {}).get(watch_region)
            if pr is not None:
                flat.append((pr, p["provider_id"], p["provider_name"]))
        flat.sort(key=lambda x: x[0])
        print(f"\n── {label} — flatrate / abonnement en {watch_region} (priorité TMDB) ──")
        for _prio, pid, name in flat:
            print(f"  {pid:5}  {name}")


def fetch_tmdb_detail_entry(mt: str, mid: int, watch_region: str) -> dict:
    seasons_meta: list[dict] | None = None
    if mt == "movie":
        d = request_get(
            f"{BASE}/movie/{mid}",
            params={"api_key": KEY, "append_to_response": "watch/providers"},
        ).json()
        imdb_id = d.get("imdb_id")
    else:
        d = request_get(
            f"{BASE}/tv/{mid}",
            params={"api_key": KEY, "append_to_response": "external_ids,watch/providers"},
        ).json()
        imdb_id = (d.get("external_ids") or {}).get("imdb_id")
        seasons_meta = extract_tmdb_seasons_meta(d)

    region_data = (
        (d.get("watch/providers") or {}).get("results", {}).get(watch_region) or {}
    )
    watch_url = region_data.get("link") or f"https://www.themoviedb.org/{mt}/{mid}/watch?locale={watch_region}"
    flatrate = [
        [p.get("provider_id"), p.get("provider_name")]
        for p in (region_data.get("flatrate") or [])
        if p.get("provider_id") and p.get("provider_name")
    ]
    entry = {
        "ts": time.time(),
        "imdb_id": imdb_id,
        "watch_url": watch_url,
        "flatrate": flatrate,
    }
    if seasons_meta is not None:
        entry["seasons"] = seasons_meta
    return entry


def extract_providers(entry: dict, selected_ids: set[int]) -> list[str]:
    flatrate = entry.get("flatrate") or []
    matched = [p for p in flatrate if p[0] in selected_ids] if selected_ids else flatrate
    names: list[str] = []
    for _pid, raw_name in matched:
        label = SHORT_PROVIDER_NAMES.get(raw_name, raw_name)
        if label not in names:
            names.append(label)
    return names


def format_votes(votes: int | None) -> str:
    if not votes:
        return ""
    if votes >= 1_000_000:
        return f"{votes / 1_000_000:.1f}M"
    if votes >= 10_000:
        return f"{round(votes / 1_000)}k"
    if votes >= 1_000:
        return f"{votes / 1_000:.1f}k"
    return str(votes)


def build_list(
    mt: str,
    account_id: int | None,
    watch_region: str,
    provider_ids: str,
    imdb_ratings: dict[str, tuple[float, int]],
    tmdb_cache: dict,
    limit: int = 50,
    filter_vus: bool = True,
    force_refresh: bool = False,
    split_catchup: bool = False,
) -> list[dict] | tuple[list[dict], list[dict]]:
    cfg = DISCOVER_CONFIG[mt]
    candidates = fetch_discover(
        mt,
        watch_region,
        provider_ids,
        pages=cfg["pages"],
        min_tmdb_votes=cfg["min_tmdb_votes"],
    )
    rated_ids: set[int] = set()
    rated_tv_episodes: dict[int, dict[tuple[int, int], float]] = {}
    if account_id is not None:
        if mt == "movie":
            rated_ids = get_rated_ids(account_id, "movies")
            if filter_vus:
                candidates = [m for m in candidates if m["id"] not in rated_ids]
        else:
            rated_ids = get_rated_ids(account_id, "tv")
            rated_tv_episodes = get_rated_tv_episodes(account_id)
            seen_cand = {m["id"] for m in candidates}
            extra_tracked = [
                sid
                for sid in rated_tv_episodes.keys()
                if sid not in seen_cand and (not filter_vus or sid not in rated_ids)
            ]
            if extra_tracked:
                def fetch_tv_summary(sid: int) -> dict | None:
                    try:
                        d = request_get(f"{BASE}/tv/{sid}", params={"api_key": KEY, "language": "fr-FR"}).json()
                        if "id" in d:
                            return {
                                "id": d["id"],
                                "name": d.get("name", "?"),
                                "original_name": d.get("original_name"),
                                "first_air_date": d.get("first_air_date"),
                                "vote_average": d.get("vote_average", 0.0),
                                "poster_path": d.get("poster_path"),
                                "backdrop_path": d.get("backdrop_path"),
                                "overview": d.get("overview"),
                                "genre_ids": [g["id"] for g in (d.get("genres") or []) if "id" in g],
                            }
                    except Exception:
                        return None
                    return None

                with ThreadPoolExecutor(max_workers=6) as pool:
                    for item in pool.map(fetch_tv_summary, extra_tracked):
                        if item:
                            candidates.append(item)

    selected_ids = {int(x) for x in provider_ids.split("|") if x.isdigit()}
    missing = [
        m["id"]
        for m in candidates
        if (
            f"{mt}:{m['id']}:{watch_region}" not in tmdb_cache
            or (mt == "tv" and "seasons" not in tmdb_cache[f"{mt}:{m['id']}:{watch_region}"])
        )
    ]
    print(
        f"  → {len(candidates)} candidats TMDB ({len(missing)} à interroger, "
        f"{len(candidates) - len(missing)} en cache)...",
        file=sys.stderr,
    )

    if missing:
        def fetch_one(mid: int) -> tuple[str, dict]:
            return f"{mt}:{mid}:{watch_region}", fetch_tmdb_detail_entry(mt, mid, watch_region)

        with ThreadPoolExecutor(max_workers=10) as pool:
            for cache_key, entry in pool.map(fetch_one, missing):
                tmdb_cache[cache_key] = entry
        save_tmdb_cache(tmdb_cache)

    imdb_seasons_by_show: dict[str, list[list]] = {}
    today_iso = datetime.date.today().isoformat()
    if mt == "tv":
        tv_imdb_ids = {
            (tmdb_cache.get(f"tv:{m['id']}:{watch_region}") or {}).get("imdb_id")
            for m in candidates
        }
        imdb_seasons_by_show = load_imdb_seasons_for_shows(
            {t for t in tv_imdb_ids if t and t in imdb_ratings},
            force_refresh=force_refresh,
        )

    enriched: list[dict] = []
    for m in candidates:
        entry = tmdb_cache.get(f"{mt}:{m['id']}:{watch_region}")
        if not entry:
            continue
        providers = extract_providers(entry, selected_ids)
        if selected_ids and not providers:
            continue
        imdb_id = entry.get("imdb_id")
        imdb_info = imdb_ratings.get(imdb_id) if imdb_id else None
        if not imdb_info:
            continue
        global_imdb, imdb_votes = imdb_info

        if mt == "movie":
            enriched.append({
                **m,
                "media_type": "movie",
                "vu": m["id"] in rated_ids,
                "imdb_id": imdb_id,
                "imdb_rating": global_imdb,
                "global_imdb_rating": global_imdb,
                "imdb_votes": imdb_votes,
                "providers": providers,
                "tmdb_url": f"https://www.themoviedb.org/movie/{m['id']}?language=fr-FR",
                "watch_url": entry.get("watch_url"),
                "imdb_url": f"https://www.imdb.com/title/{imdb_id}/",
            })
        else:
            s_info = compute_tv_season_info(
                entry.get("seasons") or [],
                imdb_seasons_by_show.get(imdb_id, []),
                today_iso=today_iso,
            )
            released = s_info["released_seasons"]
            watched, watched_indiv_eps = decode_tv_progress(
                m["id"],
                s_info["mode"],
                released,
                s_info["season_episodes"],
                rated_ids,
                rated_tv_episodes,
            )
            unwatched = [s for s in released if s not in watched]
            locked = m["id"] in rated_ids
            fully_watched = locked or (len(released) > 0 and len(unwatched) == 0)
            if filter_vus and fully_watched:
                continue

            has_started = len(watched) > 0 or len(watched_indiv_eps) > 0
            partially_watched = (not locked) and has_started and len(unwatched) > 0
            uw_eps = [
                ep
                for s in unwatched
                for ep in (s_info["season_episodes"].get(s) or [])
                if (s, ep["ep"]) not in watched_indiv_eps
            ]
            unwatched_imdb = global_imdb
            if partially_watched and uw_eps:
                raw_mean = sum(e["rating"] for e in uw_eps) / len(uw_eps)
                avg_ep_votes = sum(e["votes"] for e in uw_eps) / len(uw_eps)
                if avg_ep_votes < 100:
                    raw_mean = min(raw_mean, global_imdb + 0.4)
                unwatched_imdb = round(raw_mean, 1)

            top_uw_eps = sorted(uw_eps, key=lambda e: (e["rating"], e["votes"]), reverse=True)[:5]
            sort_imdb = unwatched_imdb if (partially_watched and filter_vus) else global_imdb

            enriched.append({
                **m,
                "media_type": "tv",
                "vu": fully_watched,
                "locked": locked,
                "partially_watched": partially_watched,
                "released_seasons": released,
                "watched_seasons": watched,
                "watched_indiv_eps": watched_indiv_eps,
                "unwatched_seasons": unwatched,
                "season_mode": s_info["mode"],
                "season_scores": s_info["season_scores"],
                "season_episodes": s_info["season_episodes"],
                "top_unwatched_episodes": top_uw_eps,
                "imdb_id": imdb_id,
                "imdb_rating": sort_imdb,
                "unwatched_imdb_rating": unwatched_imdb,
                "global_imdb_rating": global_imdb,
                "imdb_votes": imdb_votes,
                "providers": providers,
                "tmdb_url": f"https://www.themoviedb.org/tv/{m['id']}?language=fr-FR",
                "watch_url": entry.get("watch_url"),
                "imdb_url": f"https://www.imdb.com/title/{imdb_id}/",
            })

    enriched.sort(
        key=lambda x: (x["imdb_rating"] or 0, x["imdb_votes"] or 0, x.get("vote_average") or 0),
        reverse=True,
    )
    if split_catchup and mt == "tv":
        catchup = [x for x in enriched if x.get("partially_watched")]
        discover_top = [x for x in enriched if not x.get("partially_watched")][:limit]
        return discover_top, catchup
    return enriched[:limit]


def osc8(url: str | None, text: str) -> str:
    if not url or not sys.stdout.isatty():
        return text
    return f"\033]8;;{url}\033\\{text}\033]8;;\033\\"


def format_watched_progress_label(watched_seasons: set[int], watched_indiv_eps: set[tuple[int, int]]) -> str:
    s_part = format_season_ranges(watched_seasons)
    n_indiv = len(watched_indiv_eps)
    if s_part and n_indiv:
        return f"{s_part} + {n_indiv} ép."
    if s_part:
        return s_part
    if n_indiv:
        return f"{n_indiv} ép."
    return ""


def print_list(
    title: str,
    items: list[dict],
    key: str,
    limit: int = 50,
    markdown: bool = False,
    show_top_episodes: bool = False,
) -> None:
    if markdown:
        print(f"\n### {title}\n")
    else:
        sep = "═" * 74
        print(f"\n{sep}\n  {title}\n{sep}\n")

    for i, m in enumerate(items[:limit]):
        name = m.get(key, "?")
        tmdb = round(m.get("vote_average", 0), 1)
        imdb = m.get("imdb_rating")
        imdb_str = f"{imdb:.1f}" if imdb else "—"
        votes_str = format_votes(m.get("imdb_votes"))
        votes_suffix = f" ({votes_str})" if votes_str else ""
        date = (m.get("release_date") or m.get("first_air_date") or "N/A")[:4]
        provs = ", ".join(m.get("providers") or [])
        tmdb_url = m.get("tmdb_url")
        watch_url = m.get("watch_url")
        imdb_url = m.get("imdb_url")
        is_tv = m.get("media_type") == "tv"

        if not is_tv:
            vu_badge = " ✅" if m.get("vu") else ""
            if markdown:
                title_md = f"**[{name}]({tmdb_url})**" if tmdb_url else f"**{name}**"
                prov_md = f" · [{provs}]({watch_url})" if (provs and watch_url) else (f" · {provs}" if provs else "")
                imdb_md = f"[IMDb ⭐ {imdb_str}/10{votes_suffix}]({imdb_url})" if imdb_url else f"IMDb ⭐ {imdb_str}/10{votes_suffix}"
                print(f"{i+1}. {title_md} ({date}){vu_badge}{prov_md} — {imdb_md} | TMDB ⭐ {tmdb}/10")
            else:
                title_tty = osc8(tmdb_url, name)
                prov_tty = f" [{osc8(watch_url, provs)}]" if provs else ""
                imdb_tty = osc8(imdb_url, f"IMDb ⭐ {imdb_str}/10{votes_suffix}")
                print(f"{i+1:2}. {title_tty} ({date}){vu_badge}{prov_tty}  —  {imdb_tty}  |  TMDB ⭐ {tmdb}/10")
            continue

        # Affichage enrichi par saison pour les séries
        released = m.get("released_seasons") or []
        watched = m.get("watched_seasons") or set()
        watched_indiv = m.get("watched_indiv_eps") or set()
        unwatched = m.get("unwatched_seasons") or []
        season_scores = m.get("season_scores") or {}
        partially_watched = bool(m.get("partially_watched"))
        breakdown = format_season_breakdown(released, watched, season_scores)
        glob_val = m.get("global_imdb_rating", imdb or 0)
        glob_str = f"{glob_val:.1f}"
        uw_val = m.get("unwatched_imdb_rating", imdb or 0)
        uw_str = f"{uw_val:.1f}"

        if partially_watched:
            uw_lbl = format_season_ranges(unwatched)
            w_lbl = format_watched_progress_label(watched, watched_indiv)
            status_md = f" · 🆕 **{uw_lbl} à voir** *(vu {w_lbl})*"
            status_tty = f" [🆕 {uw_lbl} à voir | vu {w_lbl}]"
            glob_meta = f"{glob_str} · {votes_str}" if votes_str else glob_str
            if abs((imdb or 0) - glob_val) < 0.01 and abs(uw_val - glob_val) >= 0.05:
                # Mode --all (trié sur la note globale)
                imdb_label_md = (
                    f"[IMDb ⭐ {glob_str}/10{votes_suffix}]({imdb_url}) *({uw_lbl} : {uw_str})*"
                    if imdb_url
                    else f"IMDb ⭐ {glob_str}/10{votes_suffix} *({uw_lbl} : {uw_str})*"
                )
                imdb_label_tty = osc8(imdb_url, f"IMDb ⭐ {glob_str}/10{votes_suffix}") + f" ({uw_lbl}: {uw_str})"
            else:
                imdb_label_md = (
                    f"[IMDb {uw_lbl} ⭐ {uw_str}/10]({imdb_url}) *(global {glob_meta})*"
                    if imdb_url
                    else f"IMDb {uw_lbl} ⭐ {uw_str}/10 *(global {glob_meta})*"
                )
                imdb_label_tty = osc8(imdb_url, f"IMDb {uw_lbl} ⭐ {uw_str}/10") + f" (global {glob_meta})"
        else:
            if m.get("locked"):
                status_md = " 🔒 *(masqué)*"
                status_tty = " 🔒 (masqué)"
            elif m.get("vu"):
                s_lbl = format_season_ranges(released) if len(released) > 1 else ("1 saison" if released else "vu")
                status_md = f" ✅ *({s_lbl})*"
                status_tty = f" ✅ ({s_lbl})"
            else:
                n_s = len(released)
                s_lbl = f"{n_s} saison{'s' if n_s > 1 else ''}" if n_s else ""
                status_md = f" · {s_lbl}" if s_lbl else ""
                status_tty = f" ({s_lbl})" if s_lbl else ""
            imdb_label_md = (
                f"[IMDb ⭐ {imdb_str}/10{votes_suffix}]({imdb_url})"
                if imdb_url
                else f"IMDb ⭐ {imdb_str}/10{votes_suffix}"
            )
            imdb_label_tty = osc8(imdb_url, f"IMDb ⭐ {imdb_str}/10{votes_suffix}")

        breakdown_md = f" · `{breakdown}`" if breakdown else ""
        breakdown_tty = f"  [{breakdown}]" if breakdown else ""

        if markdown:
            title_md = f"**[{name}]({tmdb_url})**" if tmdb_url else f"**{name}**"
            prov_md = f" · [{provs}]({watch_url})" if (provs and watch_url) else (f" · {provs}" if provs else "")
            print(f"{i+1}. {title_md} ({date}){status_md}{prov_md} — {imdb_label_md}{breakdown_md} | TMDB ⭐ {tmdb}/10")
        else:
            title_tty = osc8(tmdb_url, name)
            prov_tty = f" [{osc8(watch_url, provs)}]" if provs else ""
            print(f"{i+1:2}. {title_tty} ({date}){status_tty}{prov_tty}  —  {imdb_label_tty}{breakdown_tty}  |  TMDB ⭐ {tmdb}/10")

        top_eps = m.get("top_unwatched_episodes") or []
        if show_top_episodes and top_eps:
            if markdown:
                chips = []
                for ep in top_eps:
                    code = f"S{ep['s']:02d}E{ep['ep']:02d} ({ep['rating']:.1f})"
                    ep_url = f"https://www.imdb.com/title/{ep['tconst']}/" if ep.get("tconst") else imdb_url
                    chips.append(f"[{code}]({ep_url})" if ep_url else f"`{code}`")
                print(f"   - 🔥 **Meilleurs épisodes restants :** {' · '.join(chips)}")
            else:
                chips = []
                for ep in top_eps:
                    code = f"S{ep['s']:02d}E{ep['ep']:02d} ({ep['rating']:.1f})"
                    ep_url = f"https://www.imdb.com/title/{ep['tconst']}/" if ep.get("tconst") else imdb_url
                    chips.append(osc8(ep_url, code))
                print(f"      ↳ 🔥 Meilleurs épisodes restants : {' · '.join(chips)}")


def episode_tier_badge(rating: float) -> str:
    if rating >= 8.8:
        return "🔥"
    if rating >= 8.0:
        return "⭐"
    if rating >= 7.4:
        return "👍"
    if rating >= 6.5:
        return "😐"
    return "💤"


def resolve_tv_query(raw: str) -> int | None:
    parts = [p.strip() for p in raw.strip().split("|")]
    head = parts[0]
    m_id = re.match(r"^id:(\d+)$", head, flags=re.IGNORECASE)
    if m_id:
        return int(m_id.group(1))
    m_url = re.search(r"themoviedb\.org/tv/(\d+)", head)
    if m_url:
        return int(m_url.group(1))
    params: dict = {"api_key": KEY, "query": head, "language": "fr-FR"}
    if len(parts) > 1 and parts[1].isdigit() and len(parts[1]) == 4:
        params["first_air_date_year"] = int(parts[1])
    res = request_get(f"{BASE}/search/tv", params=params).json().get("results", [])
    return int(res[0]["id"]) if res else None


def show_series_episodes(
    queries: list[str],
    account_id: int | None,
    watch_region: str,
    provider_ids: str,
    by_season: bool = False,
    include_watched: bool = False,
    markdown: bool = False,
    force_refresh: bool = False,
) -> None:
    rated_tv_ids = get_rated_ids(account_id, "tv") if account_id else set()
    rated_tv_eps = get_rated_tv_episodes(account_id) if account_id else {}
    selected_ids = {int(x) for x in provider_ids.split("|") if x.isdigit()}

    for raw in queries:
        mid = resolve_tv_query(raw)
        if not mid:
            print(f"❌ Série introuvable sur TMDB : {raw}", file=sys.stderr)
            continue

        d = request_get(
            f"{BASE}/tv/{mid}",
            params={"api_key": KEY, "language": "fr-FR", "append_to_response": "external_ids,watch/providers"},
        ).json()
        name = d.get("name") or str(mid)
        year = (d.get("first_air_date") or "N/A")[:4]
        imdb_id = (d.get("external_ids") or {}).get("imdb_id")
        if not imdb_id:
            print(f"⚠️  Aucun identifiant IMDb trouvé pour {name} (ID:{mid}).", file=sys.stderr)
            continue

        region_data = (d.get("watch/providers") or {}).get("results", {}).get(watch_region) or {}
        watch_url = region_data.get("link") or f"https://www.themoviedb.org/tv/{mid}/watch?locale={watch_region}"
        flatrate = [
            [p.get("provider_id"), p.get("provider_name")]
            for p in (region_data.get("flatrate") or [])
            if p.get("provider_id") and p.get("provider_name")
        ]
        provs = extract_providers({"flatrate": flatrate}, selected_ids)

        imdb_eps_map = load_imdb_seasons_for_shows({imdb_id}, force_refresh=force_refresh)
        s_info = compute_tv_season_info(extract_tmdb_seasons_meta(d), imdb_eps_map.get(imdb_id, []))
        released = s_info["released_seasons"]
        watched_seasons, watched_indiv_eps = decode_tv_progress(
            mid,
            s_info["mode"],
            released,
            s_info["season_episodes"],
            rated_tv_ids,
            rated_tv_eps,
        )

        target_seasons = released if include_watched else [s for s in released if s not in watched_seasons]
        if not target_seasons:
            print(f"\n✅ {name} ({year}) : toutes les saisons sorties ({format_season_ranges(released)}) sont déjà vues ! (ajoute --all pour tout revoir)")
            continue

        # Récupération des titres VF d'épisodes depuis TMDB pour les saisons affichées
        tmdb_ep_titles: dict[tuple[int, int], tuple[str, str]] = {}
        if s_info["mode"] == "tmdb_seasons":
            def fetch_season_titles(s_num: int) -> list[tuple[tuple[int, int], tuple[str, str]]]:
                try:
                    sd = request_get(f"{BASE}/tv/{mid}/season/{s_num}", params={"api_key": KEY, "language": "fr-FR"}).json()
                    out_t = []
                    for ep_obj in sd.get("episodes") or []:
                        en = ep_obj.get("episode_number")
                        if en is not None:
                            out_t.append((
                                (s_num, int(en)),
                                (ep_obj.get("name") or f"Épisode {en}", (ep_obj.get("air_date") or "")[:4]),
                            ))
                    return out_t
                except Exception:
                    return []

            with ThreadPoolExecutor(max_workers=6) as pool:
                for rows_t in pool.map(fetch_season_titles, target_seasons):
                    for k_ep, v_ep in rows_t:
                        tmdb_ep_titles[k_ep] = v_ep

        ep_rows: list[dict] = []
        for s in target_seasons:
            for ep in s_info["season_episodes"].get(s) or []:
                is_ep_vu = (s in watched_seasons) or ((s, ep["ep"]) in watched_indiv_eps)
                if not include_watched and is_ep_vu:
                    continue
                ep_title, ep_year = tmdb_ep_titles.get((s, ep["ep"]), (f"Épisode {ep['ep']}", ""))
                ep_rows.append({
                    **ep,
                    "title": ep_title,
                    "year": ep_year,
                    "vu": is_ep_vu,
                })

        if not by_season:
            ep_rows.sort(key=lambda e: (e["rating"], e["votes"]), reverse=True)
        else:
            ep_rows.sort(key=lambda e: (e["s"], e["ep"]))

        tmdb_url = f"https://www.themoviedb.org/tv/{mid}?language=fr-FR"
        imdb_url = f"https://www.imdb.com/title/{imdb_id}/"
        scope_lbl = format_season_ranges(target_seasons)
        sort_lbl = "ordre des saisons" if by_season else "triés par note IMDb"
        w_lbl = format_watched_progress_label(watched_seasons, watched_indiv_eps)
        w_note = f" · vu {w_lbl}" if w_lbl else ""
        prov_str = ", ".join(provs)

        if markdown:
            prov_md = f" · [{prov_str}]({watch_url})" if prov_str else ""
            print(
                f"\n### 🎯 [{name}]({tmdb_url}) ({year}){prov_md} — "
                f"[IMDb]({imdb_url}) · {scope_lbl} ({len(ep_rows)} ép., {sort_lbl}{w_note})\n"
            )
            cur_s: int | None = None
            for idx, e in enumerate(ep_rows, 1):
                if by_season and e["s"] != cur_s:
                    cur_s = e["s"]
                    sc = s_info["season_scores"].get(cur_s)
                    sc_s = f" — moyenne IMDb ⭐ {sc:.1f}/10" if sc else ""
                    print(f"\n#### Saison {cur_s}{sc_s}\n")
                badge = episode_tier_badge(e["rating"])
                vu_s = " ✅" if e["vu"] else ""
                yr_s = f" ({e['year']})" if e["year"] else ""
                v_s = format_votes(e["votes"])
                v_part = f" ({v_s})" if v_s else ""
                ep_imdb_url = f"https://www.imdb.com/title/{e['tconst']}/" if e.get("tconst") else imdb_url
                prefix = f"- " if by_season else f"{idx}. "
                print(
                    f"{prefix}{badge} **S{e['s']:02d}E{e['ep']:02d} — {e['title']}**{yr_s}{vu_s} — "
                    f"[IMDb ⭐ {e['rating']:.1f}/10{v_part}]({ep_imdb_url})"
                )
        else:
            sep = "═" * 74
            prov_tty = f" [{osc8(watch_url, prov_str)}]" if prov_str else ""
            print(f"\n{sep}\n  🎯 {osc8(tmdb_url, name)} ({year}){prov_tty} — {scope_lbl} ({len(ep_rows)} ép., {sort_lbl}{w_note})\n{sep}\n")
            cur_s = None
            for idx, e in enumerate(ep_rows, 1):
                if by_season and e["s"] != cur_s:
                    cur_s = e["s"]
                    sc = s_info["season_scores"].get(cur_s)
                    sc_s = f" (moy. IMDb ⭐ {sc:.1f}/10)" if sc else ""
                    print(f"\n  ── Saison {cur_s}{sc_s} ──")
                badge = episode_tier_badge(e["rating"])
                vu_s = " ✅" if e["vu"] else ""
                yr_s = f" ({e['year']})" if e["year"] else ""
                v_s = format_votes(e["votes"])
                v_part = f" ({v_s})" if v_s else ""
                ep_imdb_url = f"https://www.imdb.com/title/{e['tconst']}/" if e.get("tconst") else imdb_url
                num_p = "  •" if by_season else f"{idx:2}."
                ep_imdb_txt = f"IMDb ⭐ {e['rating']:.1f}/10{v_part}"
                print(
                    f"{num_p} {badge} S{e['s']:02d}E{e['ep']:02d} — {e['title']}{yr_s}{vu_s}  —  "
                    f"{osc8(ep_imdb_url, ep_imdb_txt)}"
                )


def main():
    parser = argparse.ArgumentParser(
        description="TOP 50 films/séries streaming abonnement (trié sur IMDb avec suivi par saison et par épisode)"
    )
    parser.add_argument("--film", action="store_true", help="Afficher les films")
    parser.add_argument("--serie", action="store_true", help="Afficher les séries (inclut la section 'Saisons à rattraper')")
    parser.add_argument(
        "--episodes",
        "-e",
        nargs="+",
        metavar="SERIE",
        help="Afficher le guide des épisodes non vus avec notes IMDb (ex. --episodes 'Rick et Morty' 'Black Mirror')",
    )
    parser.add_argument(
        "--by-season",
        action="store_true",
        help="Avec --episodes : afficher dans l'ordre chronologique des saisons (par défaut: trié par note IMDb)",
    )
    parser.add_argument("--all", action="store_true", help="Inclure les films/séries/épisodes déjà vus (marqués ✅)")
    parser.add_argument("--region", type=str, default=None, help="Pays catalogue ISO (ex. BG, FR), sinon .env / compte")
    parser.add_argument(
        "--providers",
        type=str,
        default=None,
        help="IDs TMDB séparés par ',' ou '|' (ex. 8,119,350). Sinon TMDB_WATCH_PROVIDER_IDS ou 8 (Netflix)",
    )
    parser.add_argument(
        "--min-imdb-votes",
        type=int,
        default=DEFAULT_MIN_IMDB_VOTES,
        help=f"Nombre minimum de votes sur IMDb (défaut: {DEFAULT_MIN_IMDB_VOTES})",
    )
    parser.add_argument(
        "--refresh-cache",
        action="store_true",
        help="Forcer le re-téléchargement des datasets IMDb et du cache TMDB",
    )
    parser.add_argument(
        "--list-providers",
        action="store_true",
        help="Lister les services flatrate disponibles pour --region / pays compte, puis quitter",
    )
    parser.add_argument(
        "--markdown",
        action="store_true",
        help="Afficher les résultats en Markdown avec liens cliquables (TMDB, Watch, IMDb)",
    )
    args = parser.parse_args()

    if not KEY or not SID:
        print("Erreur: TMDB_API_KEY et TMDB_SESSION_ID doivent être définis.", file=sys.stderr)
        sys.exit(1)

    account = get_account()
    watch_region = resolve_watch_region(account, args.region)
    provider_ids = resolve_provider_ids(args.providers)
    account_id = account["id"]

    if args.list_providers:
        print(f"Région: {watch_region}  |  Fournisseurs discover actuels: {provider_ids}")
        list_flatrate_providers(watch_region)
        return

    if args.episodes:
        show_series_episodes(
            args.episodes,
            account_id,
            watch_region,
            provider_ids,
            by_season=args.by_season,
            include_watched=args.all,
            markdown=args.markdown,
            force_refresh=args.refresh_cache,
        )
        return

    show_films = args.film or (not args.film and not args.serie)
    show_series = args.serie
    filter_vus = not args.all

    imdb_ratings = load_imdb_ratings(min_votes=args.min_imdb_votes, force_refresh=args.refresh_cache)
    tmdb_cache = load_tmdb_cache(force_refresh=args.refresh_cache)

    blurb = f"région {watch_region}, flatrate, fournisseurs [{provider_ids}], min {args.min_imdb_votes} votes IMDb"
    if show_films:
        print(f"🎬 Films ({blurb})...", file=sys.stderr)
        movies = build_list(
            "movie",
            account_id,
            watch_region,
            provider_ids,
            imdb_ratings,
            tmdb_cache,
            filter_vus=filter_vus,
            force_refresh=args.refresh_cache,
        )
        assert isinstance(movies, list)
        title = f"🎬 TOP 50 FILMS — {blurb} — triés par IMDb"
        if filter_vus:
            title = f"🎬 TOP 50 FILMS — {blurb} (non vus) — triés par IMDb"
        print_list(title, movies, "title", markdown=args.markdown)

    if show_series:
        print(f"📺 Séries ({blurb})...", file=sys.stderr)
        if filter_vus:
            series, catchup = build_list(
                "tv",
                account_id,
                watch_region,
                provider_ids,
                imdb_ratings,
                tmdb_cache,
                filter_vus=True,
                force_refresh=args.refresh_cache,
                split_catchup=True,
            )
            assert isinstance(series, list) and isinstance(catchup, list)
            if catchup:
                print_list(
                    f"🔄 SAISONS À RATTRAPER (séries commencées — {watch_region})",
                    catchup,
                    "name",
                    limit=len(catchup),
                    markdown=args.markdown,
                    show_top_episodes=True,
                )
            print_list(
                f"📺 TOP 50 SÉRIES — {blurb} (non vues) — triées par IMDb",
                series,
                "name",
                markdown=args.markdown,
            )
        else:
            series = build_list(
                "tv",
                account_id,
                watch_region,
                provider_ids,
                imdb_ratings,
                tmdb_cache,
                filter_vus=False,
                force_refresh=args.refresh_cache,
            )
            assert isinstance(series, list)
            print_list(
                f"📺 TOP 50 SÉRIES — {blurb} — triées par IMDb (saisons à voir)",
                series,
                "name",
                markdown=args.markdown,
            )


if __name__ == "__main__":
    main()
