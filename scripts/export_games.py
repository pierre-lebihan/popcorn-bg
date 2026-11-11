#!/usr/bin/env python3
"""
Génère docs/games.json : le catalogue Xbox Game Pass jouable en cloud (Xbox Cloud Gaming), avec pour
chaque jeu l'abonnement minimum qui l'inclut (Essential < Premium < Ultimate) et ses notes.

Sources (aucune clé obligatoire) :
- Catalogue Microsoft (endpoints publics, non documentés, ceux de xbox.com/play) :
    * catalog.gamepass.com/sigls/v2 « All games » + /subscriptions : la liste des jeux cloud ;
    * catalog.gamepass.com/v3/products : programmes cloud et abonnements qui incluent chaque jeu ;
    * displaycatalog.mp.microsoft.com : titre FR, résumé, genres, date de sortie, jaquette, note du Store ;
    * sigls « Leaving soon » : jeux qui quittent bientôt le Game Pass.
- Steam (public, sans clé) : % d'avis positifs et nombre d'avis, transformés en note SteamDB.
- IGDB (optionnel, si TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET) : note presse et durée de jeu.

Le marché est celui du VPN utilisé pour jouer (GAMEPASS_MARKET, PL par défaut : le cloud n'est pas
vendu en Bulgarie). Les avis Steam déjà récupérés sont réutilisés depuis le games.json publié
(rafraîchis au bout de 7 jours) pour que l'export nocturne reste court.

Les « joués » ne sont PAS ici : ils sont dans Supabase (colonne games de popcorn_user_state).

Usage :
  GAMEPASS_MARKET=PL python scripts/export_games.py [--out docs/games.json]
"""
import argparse
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

# Abonnements Game Pass (ProductId Microsoft). Un jeu est « inclus » dans une offre si l'un de ces
# identifiants apparaît dans ses PassMetadataByPassProductId (hiérarchie Essential ⊂ Premium ⊂ Ultimate,
# Ultimate inclut aussi EA Play ; Starter = l'édition Discord Nitro, incluse dès Essential).
STARTER, ESSENTIAL, PREMIUM, ULTIMATE, EA_PLAY = (
    "CFQ7TTC10QFD", "CFQ7TTC0K5DJ", "CFQ7TTC0P85B", "CFQ7TTC0KHS0", "CFQ7TTC0K5DH")
TIERS = [
    ("essential", {ESSENTIAL, STARTER}),
    ("premium", {PREMIUM, ESSENTIAL, STARTER}),
    ("ultimate", {ULTIMATE, PREMIUM, ESSENTIAL, STARTER, EA_PLAY}),
]

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
            time.sleep(min(60, 10 * (attempt + 1)))
            continue
        r.raise_for_status()
        return r
    raise last or RuntimeError("requête impossible")


# ---------- Catalogue Microsoft ----------

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
    for i in range(0, len(ids), 50):
        batch = ids[i:i + 50]
        r = http("POST", url, params=params, headers=headers, json={"Products": batch})
        out.update((r.json() or {}).get("Products") or {})
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
        time.sleep(0.3)
    return out


def tiers_of(sub_ids: set[str]) -> list[str]:
    return [name for name, skus in TIERS if sub_ids & skus]


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
    }


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
    r = http("GET", f"https://store.steampowered.com/appreviews/{appid}",
             params={"json": 1, "language": "all", "purchase_type": "all", "num_per_page": 0, "filter": "all"})
    q = (r.json() or {}).get("query_summary") or {}
    return {"pos": int(q.get("total_positive") or 0), "total": int(q.get("total_reviews") or 0),
            "desc": q.get("review_score_desc") or ""}


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
    parser.add_argument("--limit", type=int, default=0, help="(test) ne traiter que N jeux")
    args = parser.parse_args()
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
        subs = set((p.get("PassMetadataByPassProductId") or {}).keys())
        tiers = tiers_of(subs)
        if not tiers:
            continue  # jouable en cloud seulement si on l'achète, ou free-to-play : hors Game Pass
        key = p.get("XCloudTitleId") or pid
        cand = {"pid": pid, "titleEn": (p.get("ProductTitle") or "").strip(), "tiers": tiers,
                "xcloud": p.get("XCloudTitleId") or ""}
        cur = by_title.get(key)
        # plusieurs éditions pour un même jeu cloud : on garde celle incluse dans l'offre la moins chère
        if not cur or (len(cand["tiers"]), -len(cand["titleEn"])) > (len(cur["tiers"]), -len(cur["titleEn"])):
            by_title[key] = cand
    games = list(by_title.values())
    if args.limit:
        games = games[: args.limit]
    log(f"🎮 {len(games)} jeux Game Pass jouables en cloud ({market})")
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

    # 5. Steam (avec cache depuis le games.json publié)
    prev = load_previous(out_path)
    prev_by_id = {g["id"]: g for g in prev.get("games") or [] if g.get("id")}
    deadline = time.time() + args.steam_budget * 60
    steam_calls = steam_found = 0
    out = []
    for g in games:
        pid = g["pid"]
        m = meta_from_display(disp.get(pid))
        old = prev_by_id.get(pid) or {}
        ig = igdb.get(pid, {})
        st = old.get("steam") or {}
        fresh = st.get("at") and (today - datetime.date.fromisoformat(st["at"])).days < (
            STEAM_TTL_DAYS if st.get("appid") else STEAM_MISS_TTL_DAYS)
        if not fresh and time.time() < deadline:
            try:
                appid = ig.get("steam") or st.get("appid") or steam_search(g["titleEn"] or m.get("title", ""))
                steam_calls += 1
                st = {"appid": appid or 0, "at": today.isoformat()}
                if appid:
                    st.update(steam_reviews(appid))
                    steam_calls += 1
                time.sleep(0.8)
            except Exception as e:  # noqa: BLE001
                log(f"  ⚠️ Steam {g['titleEn']!r}: {e}")
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
            "tier": g["tiers"][0],
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
            "igdbSlug": ig.get("slug", ""),
            "xboxRating": m.get("xboxRating", 0),
            "xboxVotes": m.get("xboxVotes", 0),
            "leaving": pid in leaving,
            "addedAt": old.get("addedAt") or (today.isoformat() if prev_by_id else ""),
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
    tiers = {t: sum(1 for x in out if x["tier"] == t) for t, _ in TIERS}
    log(f"✅ {len(out)} jeux {tiers}, Steam {steam_found} ({steam_calls} requêtes), "
        f"{sum(1 for x in out if x['leaving'])} sur le départ → {out_path} ({out_path.stat().st_size / 1024:.0f} Ko)")


if __name__ == "__main__":
    main()
