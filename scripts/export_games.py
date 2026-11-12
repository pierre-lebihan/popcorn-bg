#!/usr/bin/env python3
"""
Génère docs/games.json : le catalogue Xbox Game Pass jouable en cloud (Xbox Cloud Gaming), avec pour
chaque jeu l'abonnement minimum qui l'inclut (Essential < Premium < Ultimate) et ses notes.

Sources (aucune clé obligatoire) :
- Catalogue Microsoft (endpoints publics, non documentés, ceux de xbox.com/play) :
    * catalog.gamepass.com/sigls/v2 « All games » + /subscriptions : la liste des jeux cloud ;
    * sigls « Jeux inclus » Essential / Premium / Ultimate : l'offre minimum de chaque jeu ;
    * catalog.gamepass.com/v3/products : jouable en cloud ou non, prix ;
    * displaycatalog.mp.microsoft.com : titre FR, résumé, genres, date de sortie, jaquette, note du Store ;
    * sigls « Leaving soon » : jeux qui quittent bientôt le Game Pass.
- Steam (public, sans clé) : jeu retrouvé par la recherche du Store, avis positifs / négatifs via SteamSpy,
  transformés en note SteamDB.
- IGDB (optionnel, si TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET) : note presse et durée de jeu.

Le marché est celui du VPN utilisé pour jouer (GAMEPASS_MARKET, PL par défaut : le cloud n'est pas
vendu en Bulgarie). Les avis Steam déjà récupérés sont réutilisés depuis le games.json publié
(rafraîchis au bout de 7 jours) pour que l'export nocturne reste court.

Les « joués » ne sont PAS ici : ils sont dans Supabase (colonne games de popcorn_user_state).

Usage :
  GAMEPASS_MARKET=PL python scripts/export_games.py [--out docs/games.json]
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import json
import math
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import requests

ROOT_DIR = Path(__file__).resolve().parent.parent
UA = "popcorn-bg/1.0 (https://github.com/pierre-lebihan/popcorn-bg)"
GP = "https://catalog.gamepass.com"
DISPLAY = "https://displaycatalog.mp.microsoft.com/v7.0/products"
PREV_URL = "https://pierre-lebihan.github.io/popcorn-bg/games.json"

ALL_GAMES_SIGLS = ["29a81209-df6f-41fd-a528-2ae6b91f719c", "1bf84c2b-0643-4591-893f-d9edb703f692"]
LEAVING_SIGLS = ["393f05bf-e596-4ef6-9487-6d4fa0eab987", "cc7fc951-d00f-410e-9e02-5e4628e04163"]

GENRES_FR = {
    "Action & adventure": "Action-aventure",
    "Card & board": "Cartes & plateau",
    "Classics": "Classiques",
    "Educational": "Éducatif",
    "Family & kids": "Famille",
    "Fighting": "Combat",
    "Multi-Player Online Battle Arena": "MOBA",
    "Music": "Musique",
    "Other": "Autre",
    "Platformer": "Plateforme",
    "Puzzle & trivia": "Réflexion",
    "Racing & flying": "Course",
    "Role playing": "RPG",
    "Shooter": "Tir",
    "Simulation": "Simulation",
    "Sports": "Sport",
    "Strategy": "Stratégie",
    "Word": "Lettres",
}

TIER_RANK = {"essential": 1, "premium": 2, "ultimate": 3, "free": 4, "buy": 5}

STEAM_TTL_DAYS = 7  # avis Steam rafraîchis au bout de 7 jours
STEAM_MISS_TTL_DAYS = 30  # jeu introuvable sur Steam : on réessaie au bout de 30 jours


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http(method: str, url: str, *, retries: int = 4, **kw) -> requests.Response:
    kw.setdefault("timeout", 30)
    headers = {"User-Agent": UA, "Accept": "application/json", **kw.pop("headers", {})}
    last = None
    for attempt in range(retries):
        try:
            r = requests.request(method, url, headers=headers, **kw)
        except requests.RequestException as e:
            last = e
            time.sleep(3 * (attempt + 1))
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last = RuntimeError(f"HTTP {r.status_code} {url[:80]}")
            log(f"  … HTTP {r.status_code} sur {url[:60]}, nouvel essai")
            time.sleep(min(60, 10 * (attempt + 1)))
            continue
        r.raise_for_status()
        return r
    raise last or RuntimeError("requête impossible")


# ---------- Catalogue Microsoft ----------

# Listes officielles « Jeux inclus dans ton abonnement » (celles de xbox.com/play), version console = cloud.
# PassMetadataByPassProductId ne suffit pas : il cite aussi les abonnements qui donnent une simple
# réduction (ex. Clair Obscur : Premium dans les métadonnées, mais absent des listes Premium et Ultimate).
TIER_SIGLS = [
    ("essential", "34031711-5a70-4196-bab7-45757dc2294e", "cfq7ttc0k5dj"),
    ("premium", "09a72c0d-c466-426a-9580-b78955d8173a", "cfq7ttc0p85b"),
    ("ultimate", "97c6c862-d28a-4907-a3d5-c401f2296a53", "cfq7ttc0khs0"),
]


def tier_lists(market: str) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for name, sigl, sub in TIER_SIGLS:
        r = http("GET", f"{GP}/sigls/v3", params={"id": sigl, "language": "en-us", "market": market,
                                                  "platformContext": "ConsoleGen8;ConsoleGen9",
                                                  "subscriptionContext": sub})
        out[name] = {x["id"].upper() for x in r.json() if isinstance(x, dict) and isinstance(x.get("id"), str)}
    return out


def sigl_ids(sigl: str, market: str) -> list[str]:
    r = http("GET", f"{GP}/sigls/v2", params={"id": sigl, "language": "en-us", "market": market})
    return [x["id"] for x in r.json() if isinstance(x, dict) and isinstance(x.get("id"), str)]


def subscription_ids(market: str) -> list[str]:
    r = http("GET", f"{GP}/subscriptions", params={"market": market, "subscription": "all", "language": "en-us"})
    out: list[str] = []

    def walk(v):
        if isinstance(v, str):
            out.append(v)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)

    walk(r.json())
    return [x for x in out if re.fullmatch(r"[0-9A-Z]{12}", x)]


def gp_products(ids: list[str], market: str, deadline: float = 0) -> dict[str, dict]:
    """Fiches catalogue (offre cloud, prix). Un lot en échec ou hors délai est simplement absent du résultat :
    l'appelant reprend alors ces jeux depuis l'export précédent au lieu de tout perdre."""
    url = f"{GP}/v3/products"
    params = {"market": market, "language": "en-us", "hydration": "RemoteHighSapphire0"}
    headers = {"ms-cv": "cv", "calling-app-name": "popcorn-bg", "calling-app-version": "1.0",
               "Content-Type": "application/json"}
    out: dict[str, dict] = {}
    batches = [ids[i:i + 50] for i in range(0, len(ids), 50)]

    def fetch(batch: list[str]) -> dict:
        if deadline and time.time() > deadline:
            return {}
        try:
            r = http("POST", url, params=params, headers=headers, json={"Products": batch})
            return (r.json() or {}).get("Products") or {}
        except Exception as e:  # noqa: BLE001
            log(f"  ⚠️ lot catalogue abandonné : {str(e)[:100]}")
            return {}

    # 4 lots en parallèle : en série, l'export dépasse parfois 25 min quand le serveur répond lentement (504)
    done = 0
    with ThreadPoolExecutor(max_workers=4) as pool:
        for res in pool.map(fetch, batches):
            out.update(res)
            done += 1
            if done % 10 == 0 or done == len(batches):
                log(f"  catalogue {min(done * 50, len(ids))}/{len(ids)}")
        time.sleep(0.3)
    return out


def display_products(ids: list[str], market: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for i in range(0, len(ids), 20):
        batch = ids[i:i + 20]
        r = http("GET", DISPLAY, params={"bigIds": ",".join(batch), "market": market,
                                         "languages": "fr-fr,en-us", "MS-CV": "popcorn.1"})
        for p in (r.json() or {}).get("Products") or []:
            out[p.get("ProductId")] = p
        if i % 200 == 0:
            log(f"  fiches {min(i + 20, len(ids))}/{len(ids)}")
        time.sleep(0.3)
    return out


def img_url(u: str, w: int = 300) -> str:
    if not u:
        return ""
    if u.startswith("//"):
        u = "https:" + u
    return u + ("&" if "?" in u else "?") + f"w={w}"


def pick_image(images: list[dict]) -> str:
    for purpose in ("Poster", "BoxArt", "FeaturePromotionalSquareArt", "Tile"):
        for im in images or []:
            if im.get("ImagePurpose") == purpose and im.get("Uri"):
                return img_url(im["Uri"], 300 if purpose == "Poster" else 260)
    return ""


def meta_from_display(p: dict | None) -> dict:
    if not p:
        return {}
    loc = (p.get("LocalizedProperties") or [{}])[0]
    props = p.get("Properties") or {}
    mkt = (p.get("MarketProperties") or [{}])[0]
    usage = next((u for u in mkt.get("UsageData") or [] if u.get("AggregateTimeSpan") == "AllTime"), {})
    cats = props.get("Categories") or ([props["Category"]] if props.get("Category") else [])
    release = (mkt.get("OriginalReleaseDate") or "")[:10]
    if release.startswith("0001") or release.startswith("1753"):
        release = ""
    return {
        "title": (loc.get("ProductTitle") or "").strip(),
        "overview": re.sub(r"\s+", " ", loc.get("ShortDescription") or loc.get("ProductDescription") or "").strip()[:420],
        "cover": pick_image(loc.get("Images") or []),
        "genres": [GENRES_FR.get(c, c) for c in cats if c][:3],
        "release": release,
        "developer": (loc.get("DeveloperName") or "").strip(),
        "publisher": (loc.get("PublisherName") or "").strip(),
        "xboxRating": round(float(usage.get("AverageRating") or 0), 1),
        "xboxVotes": int(usage.get("RatingCount") or 0),
        "mp": multiplayer_from_attrs(props.get("Attributes") or []),
    }


def _players(a: dict) -> int:
    try:
        return max(2, int(a.get("Maximum") or 0))
    except (TypeError, ValueError):
        return 2


def multiplayer_from_attrs(attrs: list[dict]) -> dict:
    """Modes multijoueur déclarés sur la fiche Xbox (XblLocalCoop, XblOnlineMultiPlayer, SharedSplitScreen…).

    local  : nombre max de joueurs sur la même console / le même écran
    online : nombre max de joueurs en ligne (chacun sur son compte, donc aussi en cloud)
    """
    mp: dict = {}
    for a in attrs:
        name = str(a.get("Name") or "")
        low = name.lower()
        if low.startswith("xblcrossplatform"):
            mp["cross"] = 1
            continue
        where = "local" if ("local" in low or low == "sharedsplitscreen") else "online" if "online" in low else ""
        if not where or not ("coop" in low or "multiplayer" in low or "splitscreen" in low):
            continue
        mp[where] = max(mp.get(where, 0), _players(a))
        if "coop" in low:
            mp[where + "Coop"] = 1
    return mp


def multiplayer_from_igdb(g: dict) -> dict:
    """Repli IGDB : multiplayer_modes (offlinecoop, onlinemax…) puis game_modes (2 multi, 3 coop, 4 écran partagé)."""
    mp: dict = {}
    for m in g.get("multiplayer_modes") or []:
        if not isinstance(m, dict):
            continue
        local = max(m.get("offlinemax") or 0, m.get("offlinecoopmax") or 0)
        if local >= 2 or m.get("offlinecoop") or m.get("splitscreen"):
            mp["local"] = max(mp.get("local", 0), local, 2)
        online = max(m.get("onlinemax") or 0, m.get("onlinecoopmax") or 0)
        if online >= 2 or m.get("onlinecoop"):
            mp["online"] = max(mp.get("online", 0), online, 2)
        if m.get("offlinecoop"):
            mp["localCoop"] = 1
        if m.get("onlinecoop"):
            mp["onlineCoop"] = 1
    if not mp:
        modes = set(g.get("game_modes") or [])
        if 4 in modes:
            mp["local"] = 2
        if modes & {2, 3, 5, 6}:
            mp["online"] = 2
        if 3 in modes:
            mp["onlineCoop"] = 1
    return mp


# ---------- Steam ----------

EDITION_WORDS = {"standard", "edition", "definitive", "complete", "deluxe", "goty", "ultimate", "enhanced",
                 "game", "of", "the", "year", "windows", "pc", "xbox", "series", "x", "s", "one", "10", "for",
                 "preview", "director", "s", "cut", "anniversary", "remastered"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[™®©]", "", s)
    s = s.replace("&", " and ")
    return " ".join(re.split(r"[^a-z0-9]+", s)).strip()


def core(s: str) -> str:
    toks = norm(s).split()
    kept = [t for t in toks if t not in EDITION_WORDS]
    return " ".join(kept or toks)


def steam_search(title: str) -> int | None:
    q = re.sub(r"\s*[\(\[].*?(preview|windows|xbox|pc).*?[\)\]]", "", title, flags=re.I)
    q = re.sub(r"[™®©]", "", q).strip()
    want_full, want_core = norm(q), core(q)
    # 2e recherche sans les mentions d'édition : « Gears 5 Game of the Year Edition » ne trouve rien sur Steam,
    # « gears 5 » trouve le jeu.
    terms = [q] + ([want_core] if want_core and want_core != want_full else [])
    for term in terms:
        r = http("GET", "https://store.steampowered.com/api/storesearch/", params={"term": term, "l": "english", "cc": "PL"})
        items = [x for x in (r.json() or {}).get("items") or [] if x.get("type") == "app"]
        for x in items:  # nom identique
            if norm(x.get("name", "")) == want_full:
                return int(x["id"])
        for x in items:  # identique aux mentions d'édition près
            if core(x.get("name", "")) == want_core and want_core:
                return int(x["id"])
    return None


def steam_reviews(appid: int) -> dict:
    # store.steampowered.com/appreviews renvoie la page HTML du Store aux serveurs GitHub Actions :
    # on passe par SteamSpy (mêmes compteurs d'avis positifs / négatifs, sans clé, 1 requête / s).
    r = http("GET", "https://steamspy.com/api.php", params={"request": "appdetails", "appid": appid})
    q = r.json() or {}
    pos, neg = int(q.get("positive") or 0), int(q.get("negative") or 0)
    return {"pos": pos, "total": pos + neg}


def steamdb_rating(pos: int, total: int) -> float:
    """Note SteamDB (0-100) : le % positif tiré vers 50 % quand il y a peu d'avis."""
    if total <= 0:
        return 0.0
    avg = pos / total
    return round(100 * (avg - (avg - 0.5) * 2 ** (-math.log10(total + 1))), 1)


# ---------- IGDB (optionnel) ----------

class Igdb:
    def __init__(self, cid: str, secret: str):
        r = http("POST", "https://id.twitch.tv/oauth2/token",
                 params={"client_id": cid, "client_secret": secret, "grant_type": "client_credentials"})
        self.h = {"Client-ID": cid, "Authorization": "Bearer " + r.json()["access_token"]}

    def q(self, endpoint: str, body: str) -> list[dict]:
        r = http("POST", f"https://api.igdb.com/v4/{endpoint}", data=body, headers=self.h)
        time.sleep(0.3)  # 4 requêtes / s
        return r.json()

    @staticmethod
    def src(x: dict) -> int:
        v = x.get("external_game_source", x.get("category"))
        return int(v.get("id") if isinstance(v, dict) else v or 0)

    def enrich(self, product_ids: list[str]) -> dict[str, dict]:
        """{productId: {igdb, steam, press, pressVotes, hours, mp, slug, parent}}

        Une édition (GOTY, Definitive, Standard…) a souvent sa propre fiche IGDB, vide : pas de note presse,
        pas de lien Steam. On remonte alors au jeu d'origine (version_parent) et on lui emprunte ce qui manque.
        """
        pid_game: dict[str, int] = {}
        for i in range(0, len(product_ids), 200):
            ids = ",".join(f'"{p}"' for p in product_ids[i:i + 200])
            for x in self.q("external_games", f"fields game,uid,category,external_game_source; where uid = ({ids}); limit 500;"):
                if self.src(x) == 11 and x.get("game"):
                    pid_game[x["uid"].upper()] = int(x["game"])
        own = sorted(set(pid_game.values()))
        parent: dict[int, int] = {}
        for i in range(0, len(own), 200):
            ids = ",".join(map(str, own[i:i + 200]))
            try:
                for g in self.q("games", f"fields id,version_parent; where id = ({ids}) & version_parent != null; limit 500;"):
                    if g.get("version_parent"):
                        parent[g["id"]] = int(g["version_parent"])
            except Exception as e:  # noqa: BLE001
                log(f"  ⚠️ IGDB version_parent : {str(e)[:160]}")
        games = sorted(set(own) | set(parent.values()))
        info: dict[int, dict] = {g: {} for g in games}
        for i in range(0, len(games), 200):
            ids = ",".join(map(str, games[i:i + 200]))
            for g in self.q("games", f"fields id,aggregated_rating,aggregated_rating_count,slug; where id = ({ids}); limit 500;"):
                info[g["id"]].update(press=round(g.get("aggregated_rating") or 0),
                                     pressVotes=g.get("aggregated_rating_count") or 0, slug=g.get("slug") or "")
            try:
                for g in self.q("games", "fields id,game_modes,multiplayer_modes.offlinecoop,multiplayer_modes.offlinecoopmax,"
                                         "multiplayer_modes.offlinemax,multiplayer_modes.onlinecoop,multiplayer_modes.onlinecoopmax,"
                                         f"multiplayer_modes.onlinemax,multiplayer_modes.splitscreen; where id = ({ids}); limit 500;"):
                    mp = multiplayer_from_igdb(g)
                    if mp and g.get("id") in info:
                        info[g["id"]]["mp"] = mp
            except Exception as e:  # noqa: BLE001
                log(f"  ⚠️ IGDB multijoueur : {str(e)[:160]}")
            for t in self.q("game_time_to_beats", f"fields game_id,hastily,normally,completely; where game_id = ({ids}); limit 500;"):
                sec = t.get("normally") or t.get("hastily") or 0
                if sec and t.get("game_id") in info:
                    info[t["game_id"]]["hours"] = max(1, round(sec / 3600))
            for x in self.q("external_games", f"fields game,uid,category,external_game_source; where game = ({ids}); limit 500;"):
                if self.src(x) == 1 and str(x.get("uid", "")).isdigit() and x.get("game") in info:
                    info[x["game"]].setdefault("steam", int(x["uid"]))
        out: dict[str, dict] = {}
        inherited = 0
        for pid, g in pid_game.items():
            d = {"igdb": g, **info.get(g, {})}
            par = info.get(parent.get(g, 0))
            if par:
                took = False
                if not (d.get("press") and d.get("pressVotes", 0) >= 3) and par.get("press") and par.get("pressVotes", 0) >= 3:
                    d["press"], d["pressVotes"], took = par["press"], par["pressVotes"], True
                for k in ("steam", "hours", "mp"):
                    if not d.get(k) and par.get(k):
                        d[k], took = par[k], True
                if took:
                    d["parent"] = par.get("slug", "")
                    inherited += 1
            out[pid] = d
        log(f"  IGDB : {len(parent)} éditions rattachées à leur jeu d'origine, {inherited} complétées par lui")
        return out


# ---------- Note de classement ----------

STEAM_SURE = 50  # avis Steam à partir desquels la note Steam fait foi
PRESS_MIN_VOTES = 3
XBOX_MIN_VOTES = 50
# Recalage par défaut sur l'échelle Steam (régression mesurée le 12/11/2026 sur 235 jeux ayant ≥ 500 avis Steam),
# utilisé si l'export n'a pas assez de jeux notés des deux côtés pour refaire la régression.
DEFAULT_FIT = {"presse": (0.45, 47.9, 10.2), "xbox": (12.5, 34.5, 8.6)}


def _fit(pairs: list[tuple[float, float]], default: tuple[float, float, float]) -> tuple[float, float, float]:
    """Régression linéaire y = a·x + b (+ écart-type résiduel). Le coefficient < 1 tire naturellement
    les notes extrêmes d'une source peu fiable vers la moyenne, comme le fait la note SteamDB."""
    n = len(pairs)
    if n < 40:
        return default
    sx = sum(x for x, _ in pairs); sy = sum(y for _, y in pairs)
    sxx = sum(x * x for x, _ in pairs); sxy = sum(x * y for x, y in pairs)
    den = n * sxx - sx * sx
    if not den:
        return default
    a = (n * sxy - sx * sy) / den
    b = (sy - a * sx) / n
    sd = math.sqrt(sum((a * x + b - y) ** 2 for x, y in pairs) / n) or default[2]
    if a <= 0:
        return default
    return a, b, sd


def apply_scores(games: list[dict]) -> None:
    """Note de classement 0-100 sur l'échelle Steam (SteamDB).

    - Steam fait foi dès STEAM_SURE avis (note SteamDB, déjà tirée vers 50 % quand il y a peu d'avis).
    - Sinon, presse IGDB et Store Xbox sont recalés sur l'échelle Steam (régression sur les jeux notés des deux
      côtés) puis combinés selon leur fiabilité. Avant, un 97 presse fondé sur 3 critiques passait devant
      un 96,7 % Steam sur 140 000 avis (Gears of War 3 premier du classement).
    - Peu de critiques ou de votes Xbox : la note est en plus tirée vers la moyenne Steam.
    """
    sure = [g for g in games if g["steam"].get("total", 0) >= 500 and g["steamRating"]]
    mean = sum(g["steamRating"] for g in sure) / len(sure) if len(sure) >= 40 else 80.0
    fits = {
        "presse": _fit([(g["press"], g["steamRating"]) for g in sure if g["press"] and g["pressVotes"] >= PRESS_MIN_VOTES],
                       DEFAULT_FIT["presse"]),
        "xbox": _fit([(g["xboxRating"], g["steamRating"]) for g in sure if g["xboxVotes"] >= XBOX_MIN_VOTES],
                     DEFAULT_FIT["xbox"]),
    }
    log("🎯 Recalage sur l'échelle Steam : " + ", ".join(f"{k} ×{a:.2f} {b:+.1f} (±{sd:.1f})" for k, (a, b, sd) in fits.items())
        + f", moyenne Steam {mean:.1f}")
    for g in games:
        if g["steamRating"] and g["steam"].get("total", 0) >= STEAM_SURE:
            g["score"], g["scoreSrc"] = g["steamRating"], "steam"
            continue
        parts = []  # (valeur recalée, poids = 1 / variance), poids réduit quand il y a peu de critiques / votes
        if g["press"] and g["pressVotes"] >= PRESS_MIN_VOTES:
            a, b, sd = fits["presse"]
            parts.append(("presse", a * g["press"] + b, 1 / sd ** 2 * g["pressVotes"] / (g["pressVotes"] + 5)))
        if g["xboxVotes"] >= XBOX_MIN_VOTES:
            a, b, sd = fits["xbox"]
            parts.append(("xbox", a * g["xboxRating"] + b, 1 / sd ** 2 * g["xboxVotes"] / (g["xboxVotes"] + 300)))
        if g["steamRating"]:  # quelques avis Steam (20 à STEAM_SURE) : pris en compte, avec peu de poids
            n = g["steam"]["total"]
            parts.append(("steam", g["steamRating"], 1 / 12 ** 2 * n / (n + 50)))
        if not parts:
            continue
        prior = 1 / 12 ** 2 * 0.15  # « moyenne Steam » : pèse peu, seulement quand les sources sont maigres
        w = sum(p[2] for p in parts) + prior
        g["score"] = round(min(100.0, (sum(p[1] * p[2] for p in parts) + mean * prior) / w), 1)
        g["scoreSrc"] = max(parts, key=lambda p: p[2])[0]


# ---------- Export ----------

def load_previous(path: Path) -> dict:
    try:
        r = requests.get(PREV_URL, headers={"User-Agent": UA}, timeout=30)
        if r.ok:
            return r.json()
    except Exception:  # noqa: BLE001
        pass
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporte le catalogue Game Pass cloud")
    parser.add_argument("--out", default=str(ROOT_DIR / "docs" / "games.json"))
    parser.add_argument("--steam-budget", type=float, default=float(os.environ.get("STEAM_BUDGET_MIN", "25")),
                        help="minutes max passées à interroger Steam (le reste est complété les nuits suivantes)")
    parser.add_argument("--max-minutes", type=float, default=float(os.environ.get("EXPORT_MAX_MIN", "0")),
                        help="durée totale max du script : la collecte Steam s'arrête à temps pour écrire le fichier")
    parser.add_argument("--limit", type=int, default=0, help="(test) ne traiter que N jeux")
    args = parser.parse_args()
    started = time.time()
    market = os.environ.get("GAMEPASS_MARKET", "PL").strip().upper() or "PL"
    out_path = Path(args.out)
    today = datetime.date.today()

    # 1. Tous les jeux jouables en cloud dans ce marché
    ids: list[str] = []
    for s in ALL_GAMES_SIGLS:
        try:
            got = sigl_ids(s, market)
            log(f"🎮 sigl {s[:8]} : {len(got)} jeux")
            ids += got
        except Exception as e:  # noqa: BLE001
            log(f"  ⚠️ sigl {s[:8]} : {e}")
    try:
        subs = subscription_ids(market)
        log(f"🎮 /subscriptions : {len(subs)} identifiants")
        ids += subs
    except Exception as e:  # noqa: BLE001
        log(f"  ⚠️ /subscriptions : {e}")
    ids = list(dict.fromkeys(ids))
    if not ids:
        raise SystemExit("Catalogue Game Pass vide : on garde le games.json existant")

    try:
        included = tier_lists(market)
        log("🎮 listes officielles : " + ", ".join(f"{k} {len(v)}" for k, v in included.items()))
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"Listes Game Pass indisponibles ({e}) : on garde le games.json existant")
    if not all(included.values()):
        raise SystemExit("Une liste Game Pass est vide : on garde le games.json existant")

    leaving: set[str] = set()
    for s in LEAVING_SIGLS:
        try:
            leaving |= set(sigl_ids(s, market))
        except Exception as e:  # noqa: BLE001
            log(f"  ⚠️ leaving soon {s[:8]} : {e}")

    # 2. Abonnements qui incluent chaque jeu + programme cloud
    # Le serveur du catalogue répond parfois très lentement (504 en série : 28 min le 12/11, export tué par le
    # timeout, games.json jamais republié). On interroge d'abord les jeux déjà connus comme jouables en cloud et
    # ceux des listes Game Pass, avec un budget de temps ; ce qui manque est repris de l'export précédent.
    prev = load_previous(out_path)
    prev_by_id = {g["id"]: g for g in prev.get("games") or [] if g.get("id")}
    in_lists = set().union(*included.values())
    ids.sort(key=lambda i: (0 if i.upper() in in_lists else 1 if i in prev_by_id else 2))
    cat_budget = float(os.environ.get("CATALOG_BUDGET_MIN", "12"))
    cat_deadline = time.time() + cat_budget * 60
    if args.max_minutes:
        cat_deadline = min(cat_deadline, started + args.max_minutes * 60 * 0.6)
    prods = gp_products(ids, market, cat_deadline)
    missing = [i for i in ids if i not in prods]
    log(f"🎮 {len(prods)} fiches catalogue" + (f", {len(missing)} manquantes (délai ou erreurs)" if missing else ""))
    by_title: dict[str, dict] = {}
    for pid, p in prods.items():
        cloud = ((p.get("XCloudOfferings") or {}).get("CLOUDGAMING"))
        if not isinstance(cloud, dict):
            continue  # pas jouable en cloud (version PC uniquement, pack, édition…)
        tiers = [name for name, _, _ in TIER_SIGLS if pid.upper() in included[name]]
        msrp = ((p.get("AnonymousPrice") or {}).get("MSRP")) or {}
        programs = set(cloud.get("Programs") or [])
        if tiers:
            tier = tiers[0]
        elif "F2P" in programs or (msrp.get("value") == 0):
            tier = "free"  # free-to-play : jouable en cloud sans abonnement
        else:
            tier = "buy"  # hors Game Pass : jouable en cloud si on possède le jeu
        key = p.get("XCloudTitleId") or pid
        cand = {"pid": pid, "titleEn": (p.get("ProductTitle") or "").strip(), "tier": tier,
                "xcloud": p.get("XCloudTitleId") or "",
                "price": msrp.get("formattedValue") or "" if tier == "buy" else "",
                "priceValue": float(msrp.get("value") or 0) if tier == "buy" else 0}
        cur = by_title.get(key)
        # plusieurs éditions pour un même jeu cloud : on garde celle de l'offre la moins chère
        # (puis, à offre égale, l'édition au titre le plus court = l'édition de base)
        if not cur or (TIER_RANK[tier], len(cand["titleEn"])) < (TIER_RANK[cur["tier"]], len(cur["titleEn"])):
            by_title[key] = cand
    # Jeux dont la fiche catalogue n'a pas pu être lue : repris de l'export précédent, offre recalculée
    reused = 0
    for pid in missing:
        old = prev_by_id.get(pid)
        if not old or old.get("tier") not in TIER_RANK:
            continue
        key = old.get("xcloud") or pid
        if key in by_title:
            continue
        tiers = [name for name, _, _ in TIER_SIGLS if pid.upper() in included[name]]
        tier = tiers[0] if tiers else (old["tier"] if old["tier"] in ("free", "buy") else "buy")
        by_title[key] = {"pid": pid, "titleEn": old.get("en") or old.get("title") or "", "tier": tier,
                         "xcloud": old.get("xcloud") or "", "price": old.get("price") or "" if tier == "buy" else "",
                         "priceValue": float(old.get("priceValue") or 0) if tier == "buy" else 0}
        reused += 1
    if reused:
        log(f"🎮 {reused} jeux repris de l'export précédent (fiche catalogue indisponible)")
    # Game Pass d'abord (pour que le budget Steam serve en priorité à ces jeux), puis gratuits, puis à acheter
    games = sorted(by_title.values(), key=lambda g: TIER_RANK[g["tier"]])
    if args.limit:
        games = games[: args.limit]
    log(f"🎮 {len(games)} jeux jouables en cloud ({market}), dont "
        f"{sum(1 for g in games if TIER_RANK[g['tier']] <= 3)} inclus dans le Game Pass")
    if not games:
        raise SystemExit("Aucun jeu Game Pass cloud trouvé : on garde le games.json existant")

    # 3. Fiches détaillées (titre FR, résumé, genres, jaquette, note Store)
    disp = display_products([g["pid"] for g in games], market)

    # 4. IGDB (optionnel)
    igdb: dict[str, dict] = {}
    cid, secret = os.environ.get("TWITCH_CLIENT_ID", "").strip(), os.environ.get("TWITCH_CLIENT_SECRET", "").strip()
    if cid and secret:
        try:
            igdb = Igdb(cid, secret).enrich([g["pid"] for g in games])
            log(f"🎮 IGDB : {len(igdb)} jeux reconnus, {sum(1 for x in igdb.values() if x.get('hours'))} avec durée")
        except Exception as e:  # noqa: BLE001
            log(f"  ⚠️ IGDB : {e}")
    else:
        missing = [n for n, v in (("TWITCH_CLIENT_ID", cid), ("TWITCH_CLIENT_SECRET", secret)) if not v]
        log(f"🎮 IGDB ignoré : secret(s) GitHub Actions absent(s) ou vide(s) : {', '.join(missing)}")

    # 5. Steam (avec cache depuis le games.json publié)
    prev_gp = any(TIER_RANK.get(x.get("tier"), 9) <= 3 for x in prev_by_id.values())

    def added_at(old: dict, tier: str) -> str:
        """Date d'arrivée dans le Game Pass : connue seulement pour les jeux apparus depuis un export précédent."""
        if TIER_RANK[tier] > 3:
            return ""
        if old and TIER_RANK.get(old.get("tier"), 9) <= 3:
            return old.get("addedAt") or ""
        return today.isoformat() if prev_gp else ""

    deadline = time.time() + args.steam_budget * 60
    if args.max_minutes:
        deadline = min(deadline, started + args.max_minutes * 60)
    log(f"🎮 Steam : {max(0, int(deadline - time.time()))} s de collecte disponibles")
    steam_calls = steam_found = steam_fail = 0
    out = []
    for g in games:
        pid = g["pid"]
        m = meta_from_display(disp.get(pid))
        old = prev_by_id.get(pid) or {}
        ig = igdb.get(pid, {})
        st = old.get("steam") or {}
        # Un jeu trouvé sur Steam mais sans compteurs d'avis (SteamSpy en échec) n'est jamais « à jour » :
        # avant, la date était posée avant l'appel qui échouait et le jeu restait 7 jours sans avis.
        fresh = st.get("at") and (st.get("appid") is not None) and (not st.get("appid") or "pos" in st) and (
            today - datetime.date.fromisoformat(st["at"])).days < (STEAM_TTL_DAYS if st.get("appid") else STEAM_MISS_TTL_DAYS)
        # Le lien Steam d'IGDB (ou du jeu parent pour une édition) prime sur une recherche par nom ratée
        if not st.get("appid") and ig.get("steam") and st.get("appid") != ig["steam"]:
            fresh = False
        if not fresh and time.time() < deadline and steam_fail < 15:
            try:
                appid = ig.get("steam") or st.get("appid") or steam_search(g["titleEn"] or m.get("title", ""))
                steam_calls += 1
                new_st = {"appid": appid or 0, "at": today.isoformat()}
                if appid:
                    time.sleep(1.0)  # SteamSpy : 1 requête / s
                    new_st.update(steam_reviews(appid))
                    steam_calls += 1
                st = new_st  # mis en cache seulement si tout a réussi
                time.sleep(0.5)
                steam_fail = 0
            except Exception as e:  # noqa: BLE001
                steam_fail += 1  # 15 échecs d'affilée : Steam bloqué pour ce soir, on réessaiera demain
                log(f"  ⚠️ Steam {g['titleEn']!r}: {str(e)[:120]}")
        if st.get("appid"):
            steam_found += 1
        sdb = steamdb_rating(st.get("pos", 0), st.get("total", 0)) if st.get("total", 0) >= 20 else 0
        title = m.get("title") or g["titleEn"]
        out.append({
            "id": pid,
            "type": "game",
            "title": title,
            "en": g["titleEn"] if norm(g["titleEn"]) != norm(title) else "",
            "tier": g["tier"],
            "price": g["price"],
            "priceValue": g["priceValue"],
            "xcloud": g["xcloud"],
            "year": (m.get("release") or "")[:4],
            "release": m.get("release", ""),
            "developer": m.get("developer", ""),
            "publisher": m.get("publisher", ""),
            "genres": m.get("genres", []),
            "overview": m.get("overview", ""),
            "cover": m.get("cover", ""),
            "score": 0.0,  # calculé plus bas (apply_scores), une fois les échelles recalées
            "scoreSrc": "",
            "steam": st,
            "steamRating": sdb,
            "votes": st.get("total", 0),
            "press": ig.get("press", 0),
            "pressVotes": ig.get("pressVotes", 0),
            "igdbParent": ig.get("parent", ""),
            "hours": ig.get("hours", 0),
            "mp": m.get("mp") or ig.get("mp") or {},
            "igdbSlug": ig.get("slug", ""),
            "xboxRating": m.get("xboxRating", 0),
            "xboxVotes": m.get("xboxVotes", 0),
            "leaving": pid in leaving,
            "addedAt": added_at(old, g["tier"]),
        })

    apply_scores(out)
    out.sort(key=lambda x: (-x["score"], -x["votes"]))
    payload = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).astimezone().isoformat(timespec="seconds"),
        "market": market,
        "igdb": bool(igdb),
        "games": out,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tiers = {t: sum(1 for x in out if x["tier"] == t) for t in TIER_RANK}
    log(f"✅ {len(out)} jeux {tiers}, Steam {steam_found} ({steam_calls} requêtes), "
        f"{sum(1 for x in out if x['leaving'])} sur le départ → {out_path} ({out_path.stat().st_size / 1024:.0f} Ko)")
    log(f"👥 Multijoueur : {sum(1 for x in out if x['mp'])} jeux, dont {sum(1 for x in out if x['mp'].get('local'))} en local "
        f"et {sum(1 for x in out if x['mp'].get('online'))} en ligne")


if __name__ == "__main__":
    main()
