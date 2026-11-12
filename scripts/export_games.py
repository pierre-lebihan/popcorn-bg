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


def gp_products(ids: list[str], market: str) -> dict[str, dict]:
    url = f"{GP}/v3/products"
    params = {"market": market, "language": "en-us", "hydration": "RemoteHighSapphire0"}
    headers = {"ms-cv": "cv", "calling-app-name": "popcorn-bg", "calling-app-version": "1.0",
               "Content-Type": "application/json"}
    out: dict[str, dict] = {}
    batches = [ids[i:i + 50] for i in range(0, len(ids), 50)]

    def fetch(batch: list[str]) -> dict:
        r = http("POST", url, params=params, headers=headers, json={"Products": batch})
        return (r.json() or {}).get("Products") or {}

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
    r = http("GET", "https://store.steampowered.com/api/storesearch/", params={"term": q, "l": "english", "cc": "PL"})
    items = [x for x in (r.json() or {}).get("items") or [] if x.get("type") == "app"]
    want_full, want_core = norm(q), core(q)
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
        """{productId: {igdb, steam, press, pressVotes, hours}}"""
        pid_game: dict[str, int] = {}
        for i in range(0, len(product_ids), 200):
            ids = ",".join(f'"{p}"' for p in product_ids[i:i + 200])
            for x in self.q("external_games", f"fields game,uid,category,external_game_source; where uid = ({ids}); limit 500;"):
                if self.src(x) == 11 and x.get("game"):
                    pid_game[x["uid"].upper()] = int(x["game"])
        games = sorted(set(pid_game.values()))
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
        return {pid: {"igdb": g, **info.get(g, {})} for pid, g in pid_game.items()}


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
    prods = gp_products(ids, market)
    log(f"🎮 {len(prods)} fiches catalogue")
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
    prev = load_previous(out_path)
    prev_by_id = {g["id"]: g for g in prev.get("games") or [] if g.get("id")}
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
        fresh = st.get("at") and (today - datetime.date.fromisoformat(st["at"])).days < (
            STEAM_TTL_DAYS if st.get("appid") else STEAM_MISS_TTL_DAYS)
        if not fresh and time.time() < deadline and steam_fail < 15:
            try:
                appid = ig.get("steam") or st.get("appid") or steam_search(g["titleEn"] or m.get("title", ""))
                steam_calls += 1
                st = {"appid": appid or 0, "at": today.isoformat()}
                if appid:
                    time.sleep(1.0)  # SteamSpy : 1 requête / s
                    st.update(steam_reviews(appid))
                    steam_calls += 1
                time.sleep(0.5)
                steam_fail = 0
            except Exception as e:  # noqa: BLE001
                steam_fail += 1  # 15 échecs d'affilée : Steam bloqué pour ce soir, on réessaiera demain
                log(f"  ⚠️ Steam {g['titleEn']!r}: {str(e)[:120]}")
        if st.get("appid"):
            steam_found += 1
        sdb = steamdb_rating(st.get("pos", 0), st.get("total", 0)) if st.get("total", 0) >= 20 else 0
        # Note de classement (0-100) : SteamDB, sinon presse IGDB, sinon Store Xbox (sur 5)
        if sdb:
            score, score_src = sdb, "steam"
        elif ig.get("press") and ig.get("pressVotes", 0) >= 3:
            score, score_src = float(ig["press"]), "presse"
        elif m.get("xboxVotes", 0) >= 50:
            score, score_src = round(m["xboxRating"] * 20 * 0.95, 1), "xbox"  # léger malus : notes Store gonflées
        else:
            score, score_src = 0.0, ""
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
            "score": score,
            "scoreSrc": score_src,
            "steam": st,
            "steamRating": sdb,
            "votes": st.get("total", 0),
            "press": ig.get("press", 0),
            "hours": ig.get("hours", 0),
            "mp": m.get("mp") or ig.get("mp") or {},
            "igdbSlug": ig.get("slug", ""),
            "xboxRating": m.get("xboxRating", 0),
            "xboxVotes": m.get("xboxVotes", 0),
            "leaving": pid in leaving,
            "addedAt": added_at(old, g["tier"]),
        })

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
