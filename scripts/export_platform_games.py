#!/usr/bin/env python3
"""Construit les catalogues installables et rattache les versions Xbox connues."""
import argparse
import hashlib
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup
import requests

from export_games import Igdb, ROOT_DIR, UA, log, norm

MARKET = "BG"
WIKI = "https://www.pcgamingwiki.com"
PLAY = "https://play.google.com/store/apps/details"
APPLE = "https://itunes.apple.com"
PUBLISHED = "https://pierre-lebihan.github.io/popcorn-bg/platform-catalog.json"


def request(url, **params):
    response = requests.get(url, timeout=10, params=params, headers={"User-Agent": UA})
    response.raise_for_status()
    return response


def mac_games():
    page = request(WIKI + "/w/api.php", action="parse", page="List_of_macOS_ARM_games",
                   prop="text", format="json").json()["parse"]["text"]["*"]
    soup = BeautifulSoup(page, "html.parser")
    games = []
    for section in ("Native_support_for_ARM_and_Intel_64-bit", "ARM-only_games"):
        heading = soup.find(id=section)
        if not heading:
            raise ValueError(f"Section PCGamingWiki absente : {section}")
        for row in heading.find_next("table").select("tr.template-infotable-body"):
            title = row.select_one("th a[href^='/wiki/']")
            cells = row.find_all("td", recursive=False)
            if title and len(cells) >= 4:
                link = urljoin(WIKI, title["href"])
                games.append({"title": title.get_text(strip=True), "developer": cells[1].get_text(" ", strip=True),
                              "year": cells[3].get_text(strip=True)[:4], "platforms": {"macWiki": link}})
    return games


def igdb_candidates():
    credentials = (os.getenv("TWITCH_CLIENT_ID"), os.getenv("TWITCH_CLIENT_SECRET"))
    if not all(credentials):
        return {"ios": {}, "android": {}}
    client = Igdb(*credentials)
    candidates = {"ios": {}, "android": {}}
    for platform in (34, 39):  # Android, iOS
        for g in client.q("games", "fields slug,websites.url; "
                          f"where platforms = ({platform}) & rating_count >= 8 & websites != null; "
                          "sort total_rating desc; limit 250;"):
            for website in g.get("websites", []):
                url = urlparse(website["url"])
                if url.hostname == "play.google.com" and url.path == "/store/apps/details":
                    for package in parse_qs(url.query).get("id", []):
                        candidates["android"][package] = g["slug"]
                if url.hostname in {"apps.apple.com", "itunes.apple.com"}:
                    match = re.search(r"/id(\d+)(?:/|$)", url.path)
                    if match:
                        candidates["ios"][match[1]] = g["slug"]
    return candidates


def ios_games(candidates):
    ids = dict.fromkeys(candidates)
    for chart in ("toppaidapplications", "topfreeapplications"):
        feed = request(f"{APPLE}/bg/rss/{chart}/limit=100/genre=6014/json").json()["feed"]
        ids.update((item["id"]["attributes"]["im:id"], None) for item in feed.get("entry", []))
    games = []
    ids = list(ids)
    for start in range(0, len(ids), 40):
        data = request(APPLE + "/lookup", country=MARKET, id=",".join(ids[start:start + 40])).json()
        for g in data["results"]:
            if g.get("kind") != "software" or "6014" not in map(str, g.get("genreIds", [])):
                continue
            games.append({"title": g["trackName"], "developer": g.get("artistName", ""),
                          "cover": g.get("artworkUrl512", ""), "year": g.get("releaseDate", "")[:4],
                          "overview": g.get("description", "")[:450],
                          "genres": [genre for genre in g.get("genres", []) if genre != "Games"],
                          "storeRating": g.get("averageUserRating", 0), "storeVotes": g.get("userRatingCount", 0),
                          "storeRatingLabel": "App Store", "igdbSlug": candidates.get(str(g["trackId"]), ""),
                          "platforms": {"ios": f"https://apps.apple.com/bg/app/id{g['trackId']}"}})
    return games


def android_game(package, slug):
    url = f"{PLAY}?id={package}&gl={MARKET}&hl=en"
    try:
        page = request(url).text
        for raw in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', page, flags=re.S):
            g = json.loads(raw)
            category = g.get("applicationCategory", "") if isinstance(g, dict) else ""
            if not category.startswith("GAME"):
                continue
            ratings = g.get("aggregateRating", {})
            seller = g.get("author") or {}
            return {"title": g["name"], "developer": seller.get("name", ""),
                    "cover": g.get("image", ""), "overview": g.get("description", "")[:450],
                    "genres": [category.removeprefix("GAME_").replace("_", " ").title()] if category != "GAME" else [],
                    "storeRating": float(ratings.get("ratingValue", 0)), "storeVotes": int(ratings.get("ratingCount", 0)),
                    "storeRatingLabel": "Google Play", "igdbSlug": slug, "platforms": {"android": url}}
    except (ValueError, KeyError, OSError) as error:
        log(f"Google Play {package}: {error}")
    return None


def android_games(candidates):
    page = request("https://play.google.com/store/games", gl=MARKET, hl="en").text
    ranked = dict.fromkeys(re.findall(r"/store/apps/details\?id=([a-zA-Z0-9_.]+)", page))
    ranked.update(candidates)
    with ThreadPoolExecutor(max_workers=6) as pool:
        return [game for game in pool.map(android_game, ranked, ranked.values()) if game]


def store_key(url):
    if "play.google.com/" in url:
        return "android:" + parse_qs(urlparse(url).query)["id"][0]
    if "apps.apple.com/" in url:
        match = re.search(r"/id(\d+)(?:/|$)", urlparse(url).path)
        if match:
            return "apple:" + match[1]
    return url.split("?", 1)[0].rstrip("/")


def merge(sources, curated, cloud, previous):
    rows = {g["id"]: dict(g, platforms=dict(g["platforms"])) for g in curated}
    known = {store_key(url): g["id"] for g in previous for url in g["platforms"].values()}
    indexed = {store_key(url): g["id"] for g in curated for url in g["platforms"].values()}
    xbox = {}
    cloud_ids = {g["id"] for g in cloud}
    for g in cloud:
        for key in {norm(g["title"]), norm(g.get("en")), g.get("igdbSlug"), g.get("igdbParent")} - {"", None}:
            xbox.setdefault(key, {})[g["id"]] = g
    identities = {}
    for game_id, row in rows.items():
        if row.get("developer"):
            identities[(norm(row["title"]), norm(row["developer"]))] = game_id
    for source in sources.values():
        for g in source:
            if not g["title"].strip():
                continue
            platform, url = next(iter(g["platforms"].items()))
            key = store_key(url)
            matches = xbox.get(g.get("igdbSlug")) or xbox.get(norm(g["title"]), {})
            cloud_id = next(iter(matches)) if len(matches) == 1 else None
            identity = (norm(g["title"]), norm(g.get("developer")))
            # Pour une fiche mobile hors IGDB, confirme aussi le studio ou l’éditeur.
            if cloud_id and platform != "macWiki" and not g.get("igdbSlug"):
                match = matches[cloud_id]
                publishers = {norm(match.get("developer")), norm(match.get("publisher"))} - {""}
                if identity[1] not in publishers:
                    cloud_id = None
            slug = g.get("igdbSlug")
            existing_id = identities.get(slug) or (identities.get(identity) if identity[1] else None)
            game_id = indexed.get(key) or known.get(key) or cloud_id or existing_id
            if not game_id:
                game_id = "STORE" + hashlib.sha256(key.encode()).hexdigest()[:15].upper()
            if game_id not in rows:
                rows[game_id] = {**g, "id": game_id, "type": "game", "platforms": {}}
            row = rows[game_id]
            row["platforms"][platform] = url
            if cloud_id and cloud_id != game_id and game_id not in cloud_ids:
                row["cloudId"] = cloud_id
            if not row.get("cover") and g.get("cover"):
                row["cover"] = g["cover"]
            if g.get("storeVotes", 0) > row.get("storeVotes", 0):
                for field in ("storeRating", "storeVotes", "storeRatingLabel"):
                    row[field] = g[field]
            indexed[key] = game_id
            if slug:
                identities.setdefault(slug, game_id)
            if identity[1]:
                identities.setdefault(identity, game_id)
    return list(rows.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=Path, default=ROOT_DIR / "docs/games.json")
    parser.add_argument("--out", type=Path, default=ROOT_DIR / "docs/platform-catalog.json")
    args = parser.parse_args()
    curated = json.loads((ROOT_DIR / "docs/platform-games.json").read_text())
    cloud = json.loads(args.games.read_text())["games"] if args.games.exists() else []
    try:
        previous = json.loads(args.out.read_text()) if args.out.exists() else request(PUBLISHED).json()
    except (ValueError, OSError):
        previous = {}
    try:
        candidates = igdb_candidates()
    except (ValueError, OSError, KeyError, RuntimeError) as error:
        log(f"IGDB mobile : {error}")
        candidates = {"ios": {}, "android": {}}
    sources = {}
    for key, load in (("mac", mac_games), ("ios", lambda: ios_games(candidates["ios"])),
                      ("android", lambda: android_games(candidates["android"]))):
        old = previous.get("sources", {}).get(key, [])
        try:
            fresh = load()
        except (ValueError, OSError, KeyError) as error:
            log(f"Catalogue {key} : {error}")
            fresh = []
        # Les classements changent tous les jours. Conserve aussi les jeux déjà découverts.
        by_link = {store_key(next(iter(g["platforms"].values()))): g for g in old}
        for game in fresh:
            link = store_key(next(iter(game["platforms"].values())))
            if not game.get("igdbSlug") and by_link.get(link, {}).get("igdbSlug"):
                game["igdbSlug"] = by_link[link]["igdbSlug"]
            by_link[link] = game
        sources[key] = list(by_link.values())
        log(f"Catalogue {key} : {len(fresh)} jeux vérifiés, {len(by_link)} au total")
    if not all(sources.values()):
        log("Une source est vide, les fiches éditoriales restent disponibles.")
    games = merge(sources, curated, cloud, previous.get("games", []))
    args.out.write_text(json.dumps({"sources": sources, "games": games}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
