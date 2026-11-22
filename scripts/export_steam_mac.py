#!/usr/bin/env python3
"""Vérifie les exigences Mac Steam des jeux Xbox Cloud déjà associés à une fiche."""
import argparse
import datetime as dt
import html
import json
import re
import sys
import time
from pathlib import Path

import requests

from export_games import PREV_URL, ROOT_DIR, core

NATIVE_CPU = re.compile(r"\b(?:Apple Silicon|Apple M[1-9]\d*|M[1-9]\d*)\b", re.I)


def native_mac(data: dict) -> bool:
    if data.get("type") != "game" or not data.get("platforms", {}).get("mac"):
        return False
    requirements = data.get("mac_requirements")
    if not isinstance(requirements, dict):
        return False
    minimum = requirements.get("minimum") or ""
    entries = re.findall(r"<li\b[^>]*>(.*?)</li>", minimum, flags=re.I | re.S)
    for entry in entries:
        text = html.unescape(re.sub(r"<[^>]*>", " ", entry))
        if re.search(r"\brequires an Apple processor\b", text, re.I):
            return True
        if re.match(r"^\s*(?:Processor|CPU)\s*:", text, re.I) and NATIVE_CPU.search(text):
            if not re.search(r"\b(?:Intel|Rosetta)\b", text, re.I):
                return True
    return False


def app_details(session: requests.Session, appid: str) -> dict:
    response = session.get(
        "https://store.steampowered.com/api/appdetails",
        params={"appids": appid, "cc": "bg", "l": "english"},
        timeout=6,
    )
    response.raise_for_status()
    result = response.json()[appid]
    return result["data"] if result["success"] else {}


def previous_cache(session: requests.Session, output: Path) -> dict:
    if output.exists():
        return json.loads(output.read_text()).get("checked", {})
    try:
        response = session.get(PREV_URL.replace("games.json", "steam-mac.json"), timeout=8)
        response.raise_for_status()
        return response.json().get("checked", {})
    except (requests.RequestException, ValueError):
        return {}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", type=Path, default=ROOT_DIR / "docs/games.json")
    parser.add_argument("--out", type=Path, default=ROOT_DIR / "docs/steam-mac.json")
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()
    games = json.loads(args.games.read_text())["games"]
    app_ids = list(dict.fromkeys(str(g["steam"]["appid"]) for g in games if (g.get("steam") or {}).get("appid")))
    today = dt.date.today()
    with requests.Session() as session:
        cache = previous_cache(session, args.out)
        due = [appid for appid in app_ids if
               (today - dt.date.fromisoformat(cache.get(appid, {}).get("at", "1970-01-01"))).days >= 45]
        deadline = time.monotonic() + 120
        for appid in due[:args.limit]:
            if time.monotonic() >= deadline:
                break
            try:
                data = app_details(session, appid)
            except (requests.RequestException, ValueError, KeyError) as exc:
                print(f"Steam {appid}: {exc}", file=sys.stderr)
                break  # Réessai à la prochaine exécution, notamment après une limitation Steam.
            cache[appid] = {"at": today.isoformat(), "title": data.get("name", ""), "native": native_mac(data)}

    confirmed = {}
    for game in games:
        appid = str((game.get("steam") or {}).get("appid", ""))
        result = cache.get(appid, {})
        if result.get("native") and core(result["title"]) in {core(game.get("en")), core(game["title"])}:
            confirmed[game["id"]] = int(appid)
    checked = {appid: cache[appid] for appid in app_ids if appid in cache}
    args.out.write_text(json.dumps({"checked": checked, "confirmed": confirmed}, separators=(",", ":")))
    print(f"Steam Mac : {len(checked)}/{len(app_ids)} fiches vérifiées, {len(confirmed)} jeux confirmés")


if __name__ == "__main__":
    main()
