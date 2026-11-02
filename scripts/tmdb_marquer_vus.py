#!/usr/bin/env python3
"""
Script pour marquer (ou démarquer / verrouiller) des films et des saisons de séries sur TMDB.

Exemples :
  # Films
  python scripts/tmdb_marquer_vus.py "Dangal" "Parasite|2019"

  # Séries — toutes les saisons sorties à ce jour (les futures saisons remonteront toutes seules !)
  python scripts/tmdb_marquer_vus.py --series "Peaky Blinders|2013" "id:37854"

  # Séries — saisons précises uniquement
  python scripts/tmdb_marquer_vus.py --series "Stranger Things" --seasons 1-4
  python scripts/tmdb_marquer_vus.py --series "Stranger Things|1-4" "Better Call Saul|2015|1-3"

  # Séries — masquer définitivement (ne remontera JAMAIS, même si nouvelle saison : manga lu, abandon...)
  python scripts/tmdb_marquer_vus.py --series --lock "Vinland Saga" "Berserk|1997" "Monster|2004"

  # Retirer le statut "vu" ou "masqué"
  python scripts/tmdb_marquer_vus.py --series --unwatch "Rick and Morty" --seasons 8-9

  # Migrer les séries déjà notées globalement sur TMDB vers le suivi par saison
  python scripts/tmdb_marquer_vus.py --migrate-series
"""
import argparse
import os
from pathlib import Path
import re
import sys
import time

import requests

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
    EPISODE_MARKER_RATING,
    SEASON_MARKER_RATING,
    compute_tv_season_info,
    extract_tmdb_seasons_meta,
    format_season_ranges,
    get_account,
    get_rated_tv_episodes,
    load_imdb_seasons_for_shows,
    request_get,
)

KEY = os.environ.get("TMDB_API_KEY")
SID = os.environ.get("TMDB_SESSION_ID")
BASE = "https://api.themoviedb.org/3"
DEFAULT_RATING = SEASON_MARKER_RATING


def has_episode_syntax(spec: str | None) -> bool:
    return bool(spec and re.search(r"(?:[sS]?\s*\d+\s*[eExX]\s*\d+)", spec))


def parse_episodes_spec(spec: str | None) -> list[tuple[int, int]] | None:
    if not spec:
        return None
    pairs: set[tuple[int, int]] = set()
    cur_s: int | None = None
    for token in re.split(r"[,;\s]+", spec.strip()):
        tok = token.strip()
        if not tok:
            continue
        m = re.match(r"^[sS]?(\d+)[eExX](\d+)(?:[-–][eE]?(\d+))?$", tok)
        if m:
            cur_s = int(m.group(1))
            e1 = int(m.group(2))
            e2 = int(m.group(3)) if m.group(3) else e1
            for en in range(min(e1, e2), max(e1, e2) + 1):
                if cur_s >= 1 and en >= 1:
                    pairs.add((cur_s, en))
            continue
        m_e = re.match(r"^[eE]?(\d+)(?:[-–][eE]?(\d+))?$", tok)
        if m_e and cur_s is not None:
            e1 = int(m_e.group(1))
            e2 = int(m_e.group(2)) if m_e.group(2) else e1
            for en in range(min(e1, e2), max(e1, e2) + 1):
                if en >= 1:
                    pairs.add((cur_s, en))
    return sorted(pairs) if pairs else None


def parse_seasons_spec(spec: str | None) -> list[int] | None:
    if not spec:
        return None
    cleaned = spec.strip()
    if not cleaned:
        return None
    nums: set[int] = set()
    for part in cleaned.split(","):
        part = re.sub(r"^[sS]\s*", "", part.strip())
        if not part:
            continue
        if "-" in part or "–" in part:
            bounds = re.split(r"[-–]", part, maxsplit=1)
            a = int(re.sub(r"^[sS]\s*", "", bounds[0].strip()))
            b = int(re.sub(r"^[sS]\s*", "", bounds[1].strip()))
            lo, hi = min(a, b), max(a, b)
            nums.update(range(lo, hi + 1))
        else:
            nums.add(int(part))
    return sorted(n for n in nums if n >= 1)


def is_year_token(tok: str) -> bool:
    t = tok.strip()
    return len(t) == 4 and t.isdigit() and 1888 <= int(t) <= 2100


def parse_title(
    raw: str,
) -> tuple[str, int | None, list[int] | None, list[tuple[int, int]] | None, int | None]:
    """
    Supporte :
      - "Titre"
      - "Titre|2019"
      - "Titre|1-4" ou "Titre|S1-S4"
      - "Titre|S7E5,S7E10" (épisodes précis pour anthologies / sitcoms)
      - "Titre|2016|1-4"
      - "id:37854" ou URL themoviedb.org/tv/37854
    """
    parts = [p.strip() for p in raw.strip().split("|")]
    head = parts[0]
    explicit_id: int | None = None
    m_id = re.match(r"^id:(\d+)$", head, flags=re.IGNORECASE)
    if m_id:
        explicit_id = int(m_id.group(1))
    else:
        m_url = re.search(r"themoviedb\.org/(?:tv|movie)/(\d+)", head)
        if m_url:
            explicit_id = int(m_url.group(1))

    year: int | None = None
    seasons: list[int] | None = None
    episodes: list[tuple[int, int]] | None = None
    for extra in parts[1:]:
        if not extra:
            continue
        if year is None and is_year_token(extra):
            year = int(extra)
        elif has_episode_syntax(extra):
            episodes = parse_episodes_spec(extra)
        else:
            seasons = parse_seasons_spec(extra)
    return head, year, seasons, episodes, explicit_id


def search(media_type: str, title: str, year: int | None = None) -> tuple[int | None, str | None]:
    params: dict = {"api_key": KEY, "query": title, "language": "fr-FR"}
    if year is not None and media_type == "movie":
        params["primary_release_year"] = year
    elif year is not None and media_type == "tv":
        params["first_air_date_year"] = year
    r = request_get(f"{BASE}/search/{media_type}", params=params)
    res = r.json().get("results", [])
    if res:
        return res[0]["id"], res[0].get("title") or res[0].get("name")
    return None, None


def fetch_title_by_id(media_type: str, mid: int) -> str | None:
    d = request_get(f"{BASE}/{media_type}/{mid}", params={"api_key": KEY, "language": "fr-FR"}).json()
    return d.get("title") or d.get("name")


def rate_item(path: str, value: float = DEFAULT_RATING) -> bool:
    r = requests.post(
        f"{BASE}/{path}/rating",
        params={"api_key": KEY, "session_id": SID},
        json={"value": value},
        timeout=20,
    )
    return r.status_code in (200, 201)


def unrate_item(path: str) -> bool:
    r = requests.delete(
        f"{BASE}/{path}/rating",
        params={"api_key": KEY, "session_id": SID},
        timeout=20,
    )
    return r.status_code in (200, 201, 204, 404)


def get_tv_season_plan(mid: int) -> tuple[str, list[int], str | None]:
    d = request_get(
        f"{BASE}/tv/{mid}",
        params={"api_key": KEY, "language": "fr-FR", "append_to_response": "external_ids"},
    ).json()
    name = d.get("name")
    imdb_id = (d.get("external_ids") or {}).get("imdb_id")
    seasons_meta = extract_tmdb_seasons_meta(d)
    imdb_eps = load_imdb_seasons_for_shows({imdb_id} if imdb_id else set()).get(imdb_id or "", [])
    s_info = compute_tv_season_info(seasons_meta, imdb_eps)
    return s_info["mode"], s_info["released_seasons"], name


def get_season_marker_episode(mid: int, mode: str, season_num: int) -> tuple[int, int]:
    if mode == "tmdb_single_split":
        return 1, season_num
    r = request_get(f"{BASE}/tv/{mid}/season/{season_num}", params={"api_key": KEY}).json()
    eps = r.get("episodes") or []
    first_ep = int(eps[0]["episode_number"]) if eps else 1
    return season_num, first_ep


def mark_tv_episodes(
    mid: int,
    target_episodes: list[tuple[int, int]],
    unwatch: bool = False,
) -> tuple[bool, str, list[tuple[int, int]]]:
    resolved_name = fetch_title_by_id("tv", mid) or str(mid)
    ok_all = True
    for s_num, ep_num in target_episodes:
        path = f"tv/{mid}/season/{s_num}/episode/{ep_num}"
        ok = unrate_item(path) if unwatch else rate_item(path, EPISODE_MARKER_RATING)
        ok_all = ok_all and ok
        time.sleep(0.08)
    if ok_all and not unwatch:
        unrate_item(f"tv/{mid}")
    return ok_all, resolved_name, target_episodes


def mark_tv_seasons(
    mid: int,
    target_seasons: list[int] | None,
    rating: float = DEFAULT_RATING,
    unwatch: bool = False,
    lock: bool = False,
    rated_episodes_cache: dict[int, dict[tuple[int, int], float]] | None = None,
) -> tuple[bool, str, list[int]]:
    mode, released_seasons, resolved_name = get_tv_season_plan(mid)
    existing_eps = (rated_episodes_cache or {}).get(mid, {})
    season_rating = SEASON_MARKER_RATING if abs(rating - EPISODE_MARKER_RATING) <= 0.01 else rating

    if lock and not unwatch:
        ok = rate_item(f"tv/{mid}", season_rating)
        if ok and existing_eps:
            for s_num, ep_num in sorted(existing_eps):
                unrate_item(f"tv/{mid}/season/{s_num}/episode/{ep_num}")
        return ok, resolved_name or str(mid), released_seasons

    seasons = target_seasons if target_seasons is not None else released_seasons

    if unwatch:
        ok_all = True
        if target_seasons is None:
            for s_num, ep_num in sorted(existing_eps):
                ok_all = unrate_item(f"tv/{mid}/season/{s_num}/episode/{ep_num}") and ok_all
            ok_all = unrate_item(f"tv/{mid}") and ok_all
            return ok_all, resolved_name or str(mid), released_seasons

        for s in seasons:
            if mode == "tmdb_single_split":
                ok_all = unrate_item(f"tv/{mid}/season/1/episode/{s}") and ok_all
            else:
                matched = [(sn, en) for (sn, en) in existing_eps if sn == s]
                if matched:
                    for sn, en in matched:
                        ok_all = unrate_item(f"tv/{mid}/season/{sn}/episode/{en}") and ok_all
                else:
                    ts, tep = get_season_marker_episode(mid, mode, s)
                    ok_all = unrate_item(f"tv/{mid}/season/{ts}/episode/{tep}") and ok_all
        ok_all = unrate_item(f"tv/{mid}") and ok_all
        return ok_all, resolved_name or str(mid), seasons

    if not seasons:
        ok = rate_item(f"tv/{mid}", season_rating)
        return ok, resolved_name or str(mid), []

    ok_all = True
    for s in seasons:
        ts, tep = get_season_marker_episode(mid, mode, s)
        ok = rate_item(f"tv/{mid}/season/{ts}/episode/{tep}", season_rating)
        ok_all = ok_all and ok
        if ok and mode == "tmdb_seasons" and existing_eps:
            for sn, en in sorted(existing_eps):
                if sn == s and (sn, en) != (ts, tep):
                    unrate_item(f"tv/{mid}/season/{sn}/episode/{en}")
        time.sleep(0.08)

    if ok_all:
        # Supprime l'éventuel verrou global /tv/{mid}/rating pour que les futures saisons remontent
        unrate_item(f"tv/{mid}")

    return ok_all, resolved_name or str(mid), seasons


def migrate_all_rated_series() -> None:
    account = get_account()
    account_id = account["id"]
    rated_shows: list[dict] = []
    page = 1
    while True:
        r = request_get(
            f"{BASE}/account/{account_id}/rated/tv",
            params={"api_key": KEY, "session_id": SID, "page": page, "language": "fr-FR"},
        ).json()
        rated_shows.extend(r.get("results", []))
        if page >= r.get("total_pages", 1):
            break
        page += 1

    if not rated_shows:
        print("ℹ️  Aucune série notée globalement à migrer.")
        return

    print(f"🔄 Migration de {len(rated_shows)} série(s) vers le suivi par saison sur TMDB...\n")
    details: dict[int, tuple[dict, str | None]] = {}
    imdb_ids: set[str] = set()
    for s in rated_shows:
        d = request_get(
            f"{BASE}/tv/{s['id']}",
            params={"api_key": KEY, "language": "fr-FR", "append_to_response": "external_ids"},
        ).json()
        tt = (d.get("external_ids") or {}).get("imdb_id")
        details[s["id"]] = (d, tt)
        if tt:
            imdb_ids.add(tt)
    imdb_map = load_imdb_seasons_for_shows(imdb_ids)

    for s in rated_shows:
        mid = s["id"]
        val = float(s.get("rating") or DEFAULT_RATING)
        d, tt = details[mid]
        name = d.get("name") or s.get("name") or str(mid)
        s_info = compute_tv_season_info(
            extract_tmdb_seasons_meta(d),
            imdb_map.get(tt or "", []),
        )
        mode = s_info["mode"]
        seasons = s_info["released_seasons"]
        ok_all = True
        for sn in seasons:
            ts, tep = get_season_marker_episode(mid, mode, sn)
            ok_all = rate_item(f"tv/{mid}/season/{ts}/episode/{tep}", val) and ok_all
            time.sleep(0.08)
        if ok_all and seasons:
            unrate_item(f"tv/{mid}")
        s_lbl = format_season_ranges(seasons) if seasons else "global"
        print(f"  {'✅' if ok_all else '⚠️'} {name} (ID:{mid}) → {s_lbl}")

    print("\n⏳ Attente indexation TMDB (~4s)...")
    time.sleep(4)
    print("✅ Migration terminée.")


def main():
    parser = argparse.ArgumentParser(
        description="Marquer / démarquer / verrouiller des films, saisons ou épisodes de séries sur TMDB"
    )
    parser.add_argument(
        "titles",
        nargs="*",
        help="Titres à traiter (ex. 'Fight Club', 'Stranger Things|1-4', 'Black Mirror|S7E1,S7E5', 'id:37854')",
    )
    parser.add_argument("--series", action="store_true", help="Traiter comme séries (suivi par saison ou épisode)")
    parser.add_argument(
        "--seasons",
        "-s",
        type=str,
        default=None,
        help="Saisons ciblées pour --series (ex. '1-4', '1,2,5', 'S3'). Par défaut: toutes les saisons sorties.",
    )
    parser.add_argument(
        "--episodes",
        "-e",
        type=str,
        default=None,
        help="Épisodes individuels ciblés pour --series (ex. 'S7E5,S7E10', 'S7E1,5,6'). Idéal pour sitcoms/anthologies.",
    )
    parser.add_argument(
        "--lock",
        action="store_true",
        help="Verrouiller définitivement la série (ne remontera jamais, même futures saisons : manga lu, abandon...)",
    )
    parser.add_argument("--unwatch", action="store_true", help="Retirer le statut 'vu' / 'masqué'")
    parser.add_argument(
        "--migrate-series",
        action="store_true",
        help="Migrer les séries cochées globalement sur TMDB vers leurs saisons actuellement sorties",
    )
    parser.add_argument(
        "--rating",
        type=float,
        default=DEFAULT_RATING,
        help=f"Note TMDB à attribuer aux éléments vus (défaut: {DEFAULT_RATING})",
    )
    args = parser.parse_args()

    if not KEY or not SID:
        print("Erreur: TMDB_API_KEY et TMDB_SESSION_ID doivent être définis.", file=sys.stderr)
        sys.exit(1)

    if args.migrate_series:
        migrate_all_rated_series()
        if not args.titles:
            return

    if not args.titles:
        parser.error("Indique au moins un titre ou utilise --migrate-series.")

    default_seasons = parse_seasons_spec(args.seasons)
    default_episodes = parse_episodes_spec(args.episodes)
    is_series_mode = args.series or bool(default_episodes) or bool(default_seasons)
    media_type = "tv" if is_series_mode else "movie"
    mt_label = "Séries" if is_series_mode else "Films"
    if args.unwatch:
        action_label = "Démarquer"
    elif args.lock and is_series_mode:
        action_label = "Masquer définitivement"
    else:
        action_label = "Marquer"

    rated_eps_cache: dict[int, dict[tuple[int, int], float]] = {}
    if is_series_mode:
        acc = get_account()
        rated_eps_cache = get_rated_tv_episodes(acc["id"])

    print(f"🎬 {action_label} {len(args.titles)} titre(s) ({mt_label})...\n")
    for raw_title in args.titles:
        q, year, inline_seasons, inline_episodes, explicit_id = parse_title(raw_title)
        target_episodes = inline_episodes if inline_episodes is not None else default_episodes
        target_seasons = inline_seasons if inline_seasons is not None else default_seasons
        item_mt = "tv" if (is_series_mode or target_episodes or target_seasons) else media_type

        if explicit_id is not None:
            mid = explicit_id
            name = fetch_title_by_id(item_mt, mid) or str(mid)
        else:
            mid, name = search(item_mt, q, year)
        if not mid:
            print(f"  ❌ Introuvable : {raw_title}")
            continue

        if item_mt == "movie":
            ok = unrate_item(f"movie/{mid}") if args.unwatch else rate_item(f"movie/{mid}", args.rating)
            print(f"  {'✅' if ok else '⚠️'} {name} (ID:{mid})")
        elif target_episodes and not args.lock:
            ok, resolved_name, ep_touched = mark_tv_episodes(
                mid,
                target_episodes,
                unwatch=args.unwatch,
            )
            ep_lbl = ", ".join(f"S{s:02d}E{e:02d}" for s, e in ep_touched)
            verb = "retiré" if args.unwatch else "vu"
            print(f"  {'✅' if ok else '⚠️'} {resolved_name or name} (ID:{mid}) — {ep_lbl} ({verb})")
        else:
            ok, resolved_name, touched = mark_tv_seasons(
                mid,
                target_seasons,
                rating=args.rating,
                unwatch=args.unwatch,
                lock=args.lock,
                rated_episodes_cache=rated_eps_cache,
            )
            if args.lock and not args.unwatch:
                print(f"  {'🔒' if ok else '⚠️'} {resolved_name or name} (ID:{mid}) — masqué définitivement (futures saisons incluses)")
            else:
                s_lbl = format_season_ranges(touched) if touched else "toutes saisons"
                verb = "retiré" if args.unwatch else "vu"
                print(f"  {'✅' if ok else '⚠️'} {resolved_name or name} (ID:{mid}) — {s_lbl} ({verb})")
        time.sleep(0.15)

    print("\n⏳ Attente indexation TMDB (~4s)...")
    time.sleep(4)
    print("✅ Terminé.")


if __name__ == "__main__":
    main()
