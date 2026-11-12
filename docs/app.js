(function () {
  "use strict";

  const IMG_SM = "https://image.tmdb.org/t/p/w185";
  const IMG_LG = "https://image.tmdb.org/t/p/w342";
  const EP_MARK = 8.5;
  const CACHE_KEY = "popcorn_household_v1";

  const CFG = window.POPCORN_CONFIG || {};

  // Retour de la connexion AniList (OAuth implicite) : le jeton arrive dans le hash de l'URL.
  // On le récupère et on nettoie l'URL AVANT que Supabase n'essaie d'interpréter ce hash comme sa propre session.
  let pendingAnilistToken = null;
  (function captureAnilistToken() {
    let pending = false;
    try {
      pending = sessionStorage.getItem("popcorn_anilist_pending") === "1";
    } catch (_) {
      /* ignore */
    }
    if (!pending || !location.hash.includes("access_token=")) return;
    const params = new URLSearchParams(location.hash.slice(1));
    pendingAnilistToken = params.get("access_token");
    try {
      sessionStorage.removeItem("popcorn_anilist_pending");
    } catch (_) {
      /* ignore */
    }
    history.replaceState(null, "", location.pathname + location.search);
  })();
  const AUTH_ENABLED = Boolean(
    CFG.supabaseUrl && !String(CFG.supabaseUrl).startsWith("__") && window.supabase && window.supabase.createClient
  );
  const sb = AUTH_ENABLED
    ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      })
    : null;
  const FN_URL = AUTH_ENABLED ? CFG.supabaseUrl.replace(/\/$/, "") + "/functions/v1/popcorn" : null;

  let DATA = { movies: [], series: [], providers: [], region: "BG", generatedAt: "" };
  let BOOKS = { manga: [], generatedAt: "" };
  let BD = { bd: [], sources: {}, generatedAt: "", referentialUpdatedAt: "" };
  let GAMES = { games: [], generatedAt: "", market: "PL" };
  const ITEM_MAP = new Map();

  /* ---------------- Household state (vus TMDB de chacun) ---------------- */

  const HH = {
    session: null,
    meEmail: null,
    users: [], // {email, name, movies:Set, locked:Set, eps:Map<tvId, [s,e,rating][]>}
    loading: false,
    loadedAt: 0,
    pending: 0,
    recent: [] // écritures récentes {key, p, at}
  };
  let writeQueue = Promise.resolve();
  const progCache = new Map();

  // prev : état précédent du même utilisateur, pour garder la partie Lecture (AniList)
  // quand le serveur ne renvoie que la partie films / séries.
  function normalizeUser(raw, prev) {
    const eps = new Map();
    Object.entries(raw.episodes || {}).forEach(([k, v]) => eps.set(Number(k), v));
    const manga = new Map();
    if (raw.manga) Object.entries(raw.manga).forEach(([k, v]) => manga.set(Number(k), v));
    const keepManga = !raw.manga && prev;
    const bd = new Map();
    if (raw.bd) Object.entries(raw.bd).forEach(([k, v]) => bd.set(String(k), v));
    const games = new Map();
    if (raw.games) Object.entries(raw.games).forEach(([k, v]) => games.set(String(k), v));
    return {
      email: String(raw.email || "").toLowerCase(),
      name: raw.name || raw.email,
      tmdbLinked: Boolean(raw.tmdbLinked),
      movies: new Set(raw.movies || []),
      hidden: new Set(raw.hiddenMovies || []),
      locked: new Set(raw.lockedTv || []),
      eps,
      anilistLinked: keepManga ? prev.anilistLinked : Boolean(raw.anilistLinked),
      anilistName: keepManga ? prev.anilistName : raw.anilistName || "",
      anilistError: keepManga ? prev.anilistError : raw.anilistError || "",
      manga: keepManga ? prev.manga : manga, // Map<mediaId, [statut, tome]>
      bd: !raw.bd && prev ? prev.bd : bd, // Map<id référentiel, [statut, tome, albums lus]>
      games: !raw.games && prev ? prev.games : games // Map<productId Xbox, "played"|"playing"|"hidden">
    };
  }

  function serializeUser(u) {
    const episodes = {};
    u.eps.forEach((v, k) => (episodes[k] = v));
    return {
      email: u.email,
      name: u.name,
      tmdbLinked: Boolean(u.tmdbLinked),
      movies: [...u.movies],
      hiddenMovies: [...(u.hidden || [])],
      lockedTv: [...u.locked],
      episodes,
      anilistLinked: Boolean(u.anilistLinked),
      anilistName: u.anilistName || "",
      manga: Object.fromEntries(u.manga || new Map()),
      bd: Object.fromEntries(u.bd || new Map()),
      games: Object.fromEntries(u.games || new Map())
    };
  }

  function saveCache() {
    try {
      localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ me: HH.meEmail, users: HH.users.map(serializeUser), at: Date.now() })
      );
    } catch (_) {
      /* quota / mode privé */
    }
  }

  function canonEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    if (e === "naustra246@gmail.com" || e === "le.bihan.pierre@gmail.com" || e === "lbihanpierre@gmail.com") {
      return "l.bihan.pierre@gmail.com";
    }
    if (e === "krstevskavilma95@gmail.com") return "krstevska.vilma95@gmail.com";
    return e;
  }

  function loadCache(email) {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (raw && raw.me === canonEmail(email) && Array.isArray(raw.users)) {
        HH.meEmail = raw.me;
        HH.users = raw.users.map((x) => normalizeUser(x));
        progCache.clear();
        return true;
      }
    } catch (_) {
      /* ignore */
    }
    return false;
  }

  function me() {
    return HH.users.find((u) => u.email === HH.meEmail) || null;
  }

  function other() {
    return HH.users.find((u) => u.email !== HH.meEmail) || null;
  }

  function loggedIn() {
    return Boolean(me());
  }

  const isEpMark = (r) => Math.abs(Number(r) - EP_MARK) <= 0.01;

  function seasonOffset(series, s) {
    return (series._off && series._off.get(s)) || 0;
  }

  function progress(user, series) {
    const key = user.email + "|" + series.id;
    const hit = progCache.get(key);
    if (hit) return hit;

    const rel = series.releasedSeasons || [];
    let ws = new Set();
    const we = new Set();
    let status = "unwatched";

    if (user.locked.has(series.id)) {
      ws = new Set(rel);
      status = "locked";
    } else {
      const raw = user.eps.get(series.id) || [];
      if (raw.length) {
        const relSet = new Set(rel);
        if (series.seasonMode === "tmdb_single_split") {
          raw.forEach(([s, e, r]) => {
            if (s === 1 && !isEpMark(r) && relSet.has(e)) ws.add(e);
          });
        } else {
          const indiv = new Set();
          raw.forEach(([s, e, r]) => {
            if (!relSet.has(s)) return;
            if (isEpMark(r)) indiv.add(s + ":" + (e + seasonOffset(series, s)));
            else ws.add(s);
          });
          rel.forEach((s) => {
            if (ws.has(s)) return;
            const eps = series._bySeason.get(s) || [];
            if (eps.length && eps.every((ep) => indiv.has(s + ":" + ep[1]))) ws.add(s);
          });
          indiv.forEach((k) => {
            if (!ws.has(Number(k.split(":")[0]))) we.add(k);
          });
        }
      }
      if (rel.length && rel.every((s) => ws.has(s))) status = "watched";
      else if (ws.size || we.size) status = "catchup";
    }

    const res = { ws, we, status };
    progCache.set(key, res);
    return res;
  }

  // Lecture : [statut AniList simplifié, dernier tome lu] ou null
  function mangaEntry(user, item) {
    return (user && user.manga && user.manga.get(item.id)) || null;
  }

  // BD : [statut, dernier tome lu, indices des albums lus] ou null
  function bdEntry(user, item) {
    return (user && user.bd && user.bd.get(item.id)) || null;
  }

  function readEntry(user, item) {
    return item.type === "bd" ? bdEntry(user, item) : mangaEntry(user, item);
  }

  // Jeux : "played" | "playing" | "hidden" ou null
  function gameEntry(user, item) {
    return (user && user.games && user.games.get(item.id)) || null;
  }

  function statusOf(user, item) {
    if (!user) return "unwatched";
    if (item.type === "game") {
      const g = gameEntry(user, item);
      if (!g) return "unwatched";
      return g === "played" ? "watched" : g === "hidden" ? "locked" : "catchup";
    }
    if (item.type === "manga" || item.type === "bd") {
      const e = readEntry(user, item);
      if (!e) return "unwatched";
      if (e[0] === "read") return "watched";
      if (e[0] === "hidden") return "locked";
      return "catchup";
    }
    if (item.type === "movie") {
      if (user.hidden && user.hidden.has(item.id)) return "locked";
      if (user.movies.has(item.id)) return "watched";
      return "unwatched";
    }
    return progress(user, item).status;
  }

  const isFinished = (user, item) => {
    const st = statusOf(user, item);
    return st === "watched" || st === "locked";
  };

  function isEpWatched(user, series, s, e) {
    if (!user) return false;
    const p = progress(user, series);
    return p.ws.has(s) || p.we.has(s + ":" + e);
  }

  function hasUnwatchedEpisodes(user, series) {
    return (series.episodes || []).some((ep) => !isEpWatched(user, series, ep[0], ep[1]));
  }

  function unwatchedImdb(user, series) {
    if (!user) return series.imdb || 0;
    const p = progress(user, series);
    if (series.episodes && series.episodes.length) {
      const unwEps = series.episodes.filter((ep) => !isEpWatched(user, series, ep[0], ep[1]));
      if (unwEps.length) {
        const sum = unwEps.reduce((acc, ep) => acc + (ep[2] || 0), 0);
        return Math.round((sum / unwEps.length) * 10) / 10;
      }
    }
    const scores = (series.releasedSeasons || [])
      .filter((s) => !p.ws.has(s))
      .map((s) => (series.seasonScores || {})[String(s)])
      .filter((x) => typeof x === "number");
    if (!scores.length) return series.imdb || 0;
    return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  }

  /* ---------------- UI state ---------------- */

  const state = {
    tab: "movies",
    q: "",
    status: "all",
    statusTouched: false,
    providers: new Set(),
    genre: "all",
    preset: "none",
    sort: "imdb",
    showAllLimit: false,
    advOpen: false,
    catchupWho: "me",
    bookKind: "all",
    bdAward: "all",
    shelf: "manga",
    gameTier: loadGameTier(),

    epSeriesId: null,
    epFilter: "unwatched",
    epSort: "rating",
    epSeason: "all",
    epMinScore: 0,

    modalKey: null,
    modalFromRandom: false,
    modalSeasonFilter: "all",
    modalEpSort: "rating",
    modalEpFilter: "unwatched",
    modalEpShowAll: false
  };

  function loadGameTier() {
    try {
      return localStorage.getItem("popcorn_game_tier") || "all";
    } catch (_) {
      return "all";
    }
  }

  const $ = (id) => document.getElementById(id);
  const elHeaderSub = $("headerSub");
  const elMainTabs = $("mainTabs");
  const elMainToolbar = $("mainToolbar");
  const elSearchInput = $("searchInput");
  const elSearchClear = $("searchClear");
  const elBtnAdvToggle = $("btnAdvToggle");
  const elAdvCount = $("advCount");
  const elQuickChips = $("quickChips");
  const elAdvPanel = $("advPanel");
  const elAdvBackdrop = $("advBackdrop");
  const elMainContent = $("mainContent");
  const elModalBackdrop = $("modalBackdrop");
  const elModalSheet = $("modalSheet");
  const elBtnRandom = $("btnRandom");
  const elBtnAccount = $("btnAccount");

  function esc(val) {
    if (val === null || val === undefined) return "";
    return String(val)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function norm(str) {
    return (str || "")
      .toString()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function fmtVotes(n) {
    if (!n) return "";
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(".0", "") + "M";
    if (n >= 1000) return Math.round(n / 1000) + "k";
    return String(n);
  }

  const pad2 = (n) => (n < 10 ? "0" + n : String(n));
  const fmt1 = (x) => (typeof x === "number" ? x.toFixed(1) : "–");

  function provClass(p) {
    const lp = p.toLowerCase();
    if (lp.includes("netflix")) return "netflix";
    if (lp.includes("prime")) return "prime";
    return "apple";
  }

  function epTier(score) {
    if (score >= 8.8) return { cls: "tier-fire", icon: "🔥" };
    if (score >= 8.0) return { cls: "tier-good", icon: "⭐" };
    if (score >= 7.4) return { cls: "tier-ok", icon: "👍" };
    if (score >= 6.5) return { cls: "tier-meh", icon: "😐" };
    return { cls: "tier-low", icon: "💤" };
  }

  function seasonRangeLabel(list) {
    if (!list.length) return "";
    return list.length > 1 ? "S" + list[0] + "–S" + list[list.length - 1] : "S" + list[0];
  }

  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle("error", Boolean(isError));
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.display = "none"), isError ? 4500 : 2200);
  }

  // Ligne grisée sous le titre FR : titre anglais · titre original (alphabet latin)
  function altTitles(item) {
    return [item.en, item.orig].filter(Boolean).join(" · ");
  }

  function prepareItem(item) {
    item._key = item.type + ":" + item.id;
    if (item.type === "game") {
      item._search = norm(
        [item.title, item.en, item.developer, item.publisher, item.year, (item.genres || []).join(" "), item.overview].join(" ")
      );
      ITEM_MAP.set(item._key, item);
      return;
    }
    if (item.type === "manga" || item.type === "bd") {
      const citeTxt = (item.cites || []).map((c) => citeLabel(c)).join(" ");
      item._search = norm(
        [item.title, item.alt, item.authors, item.year, (item.genres || []).join(" "), citeTxt, item.overview].join(" ")
      );
      ITEM_MAP.set(item._key, item);
      return;
    }
    item._search = norm(
      [item.title, item.en, item.orig, item.year, (item.genres || []).join(" "), item.overview].join(" ")
    );
    if (item.type === "tv") {
      item._bySeason = new Map();
      (item.episodes || []).forEach((ep) => {
        if (!item._bySeason.has(ep[0])) item._bySeason.set(ep[0], []);
        item._bySeason.get(ep[0]).push(ep);
      });
      // IMDb numérote parfois en absolu (ex. One Piece S2E62) alors que TMDB repart à E1
      item._off = new Map();
      item._bySeason.forEach((eps, s) => {
        const minEp = Math.min(...eps.map((e) => e[1]));
        if (minEp > 3) item._off.set(s, minEp - 1);
      });
    }
    ITEM_MAP.set(item._key, item);
  }

  function formatGenDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
    } catch (_) {
      return iso.slice(0, 10);
    }
  }

  /* ---------------- Backend (Edge Function) ---------------- */

  async function callFn(method, body) {
    if (!sb) throw new Error("Connexion indisponible");
    const {
      data: { session }
    } = await sb.auth.getSession();
    if (!session) throw Object.assign(new Error("Non connecté"), { status: 401 });
    const r = await fetch(FN_URL, {
      method,
      headers: {
        Authorization: "Bearer " + session.access_token,
        apikey: CFG.supabaseKey,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || "HTTP " + r.status), { status: r.status });
    return j;
  }

  async function refreshState(silent) {
    if (!HH.session) return;
    HH.loading = true;
    renderAccountButton();
    try {
      const res = await callFn("GET");
      HH.meEmail = String(res.me || "").toLowerCase();
      HH.users = (res.users || []).map((x) => normalizeUser(x));
      const mine = me();
      if (mine && mine.anilistError && !silent) toast("⚠️ AniList : " + mine.anilistError, true);
      if (HH.pending > 0 || HH.recent.length) reapplyRecent();
      HH.loadedAt = Date.now();
      progCache.clear();
      saveCache();
      if (!state.statusTouched) state.status = "todoBoth";
      if (!silent) toast("✅ Vus synchronisés depuis TMDB");
    } catch (err) {
      if (err.status === 403) {
        toast("⛔ Ce compte Google n'est pas autorisé.", true);
        await sb.auth.signOut();
      } else {
        toast("⚠️ Synchro impossible : " + err.message, true);
      }
    } finally {
      HH.loading = false;
      renderAll();
      if (state.modalKey) renderModalContent();
    }
  }

  function mkSeasonMarker(series, s) {
    return series.seasonMode === "tmdb_single_split" ? [1, s, 8] : [s, 1, 8];
  }

  // Simulation locale (optimiste) de l'écriture côté TMDB — l'état serveur remplace ensuite ce calcul.
  function applyLocal(u, series, p) {
    const id = p.id;
    if (p.kind === "movie") {
      if (p.watched) {
        u.movies.add(id);
        if (u.hidden) u.hidden.delete(id);
      } else {
        u.movies.delete(id);
      }
      return;
    }
    if (p.kind === "hide_movie") {
      if (!u.hidden) u.hidden = new Set();
      if (p.watched) u.hidden.add(id);
      else u.hidden.delete(id);
      return;
    }
    if (p.kind === "lock") {
      if (p.watched) u.locked.add(id);
      else u.locked.delete(id);
      return;
    }
    const rel = series.releasedSeasons || [];
    const wasLocked = u.locked.has(id);
    let arr = (u.eps.get(id) || []).slice();

    if (p.kind === "series") {
      u.locked.delete(id);
      if (p.watched) u.eps.set(id, rel.map((s) => mkSeasonMarker(series, s)));
      else u.eps.delete(id);
      return;
    }

    if (p.kind === "season") {
      const s = p.season;
      if (!p.watched && wasLocked) arr = rel.filter((x) => x !== s).map((x) => mkSeasonMarker(series, x));
      u.locked.delete(id);
      if (series.seasonMode === "tmdb_single_split") {
        arr = arr.filter(([a, b]) => !(a === 1 && b === s));
      } else {
        arr = arr.filter(([a]) => a !== s);
      }
      if (p.watched) arr.push(mkSeasonMarker(series, s));
      u.eps.set(id, arr);
      return;
    }

    if (p.kind === "episode") {
      const s = p.season;
      const off = seasonOffset(series, s);
      const te = p.dataEpisode - off;
      if (!p.watched && wasLocked) arr = rel.map((x) => mkSeasonMarker(series, x));
      u.locked.delete(id);
      const seasonMarked = arr.some(([a, , r]) => a === s && !isEpMark(r));
      if (p.watched) {
        if (!seasonMarked) arr.push([s, te, EP_MARK]);
      } else if (seasonMarked) {
        arr = arr.filter(([a]) => a !== s);
        (series._bySeason.get(s) || []).forEach((ep) => {
          if (ep[1] !== p.dataEpisode) arr.push([s, ep[1] - off, EP_MARK]);
        });
      } else {
        arr = arr.filter(([a, b]) => !(a === s && b === te));
      }
      u.eps.set(id, arr);
    }
  }

  function doSet(item, p) {
    const u = me();
    if (!u) {
      toast("Connecte-toi pour cocher tes vus", true);
      return;
    }
    const payload = {
      action: "set",
      kind: p.kind,
      id: item.id,
      watched: p.watched
    };
    if (item.type === "tv") {
      payload.mode = item.seasonMode;
      payload.seasons = item.releasedSeasons || [];
      if (p.season) payload.season = p.season;
      if (p.dataEpisode) payload.episode = p.dataEpisode - seasonOffset(item, p.season);
    }

    applyLocal(u, item, { ...p, id: item.id });
    HH.recent.push({ key: item._key, p: { ...p, id: item.id }, at: Date.now() });
    progCache.clear();
    saveCache();
    renderAll();
    if (state.modalKey) renderModalContent();

    HH.pending++;
    renderAccountButton();
    writeQueue = writeQueue
      .then(() => callFn("POST", payload))
      .then((res) => {
        HH.pending--;
        if (HH.pending === 0 && res && res.user) {
          HH.users = HH.users.map((x) => (x.email === String(res.user.email || "").toLowerCase() ? normalizeUser(res.user, x) : x));
          reapplyRecent();
          progCache.clear();
          saveCache();
          renderAll();
          if (state.modalKey) renderModalContent();
        } else {
          renderAccountButton();
        }
      })
      .catch((err) => {
        HH.pending--;
        HH.recent = HH.recent.filter((r) => r.key !== item._key);
        toast("⚠️ Échec de l'enregistrement TMDB : " + err.message, true);
        if (HH.pending === 0) refreshState(true);
      });
  }

  // TMDB met ses listes « rated » en cache quelques minutes : on ré-applique nos écritures
  // récentes par-dessus tout état venant du serveur pour éviter que le « vu » ne saute.
  const RECENT_TTL = 10 * 60 * 1000;
  function reapplyRecent() {
    const now = Date.now();
    HH.recent = HH.recent.filter((r) => now - r.at < RECENT_TTL);
    const u = me();
    if (!u) return;
    HH.recent.forEach((r) => {
      const it = ITEM_MAP.get(r.key);
      if (it) applyLocal(u, it, r.p);
    });
  }

  /* ---------------- Lecture (AniList) ---------------- */

  function doSetManga(item, status, volume) {
    const u = me();
    if (!u) {
      toast("Connecte-toi pour cocher tes lectures", true);
      return;
    }
    if (!u.anilistLinked) {
      toast("Relie d'abord ton compte AniList (menu compte)", true);
      return;
    }
    const vol = Math.max(0, Math.floor(Number(volume) || 0));
    if (status) u.manga.set(item.id, [status, vol]);
    else u.manga.delete(item.id);
    saveCache();
    renderAll();
    if (state.modalKey) renderModalContent();

    HH.pending++;
    renderAccountButton();
    writeQueue = writeQueue
      .then(() => callFn("POST", { action: "set_manga", id: item.id, status: status || null, volume: vol }))
      .then((res) => {
        HH.pending--;
        if (HH.pending === 0 && res && res.user) {
          HH.users = HH.users.map((x) =>
            x.email === String(res.user.email || "").toLowerCase() ? normalizeUser(res.user, x) : x
          );
          saveCache();
          renderAll();
          if (state.modalKey) renderModalContent();
        } else {
          renderAccountButton();
        }
      })
      .catch((err) => {
        HH.pending--;
        toast("⚠️ Échec de l'enregistrement AniList : " + err.message, true);
        if (HH.pending === 0) refreshState(true);
      });
  }

  function startAnilistLink() {
    if (!CFG.anilistClientId) {
      toast("Client AniList non configuré (config.js)", true);
      return;
    }
    try {
      sessionStorage.setItem("popcorn_anilist_pending", "1");
    } catch (_) {
      /* ignore */
    }
    location.href =
      "https://anilist.co/api/v2/oauth/authorize?client_id=" +
      encodeURIComponent(CFG.anilistClientId) +
      "&response_type=token";
  }

  function finishAnilistLink() {
    if (!pendingAnilistToken) return false;
    const token = pendingAnilistToken;
    pendingAnilistToken = null;
    state.tab = "reading";
    callFn("POST", { action: "anilist_link", token })
      .then((res) => {
        toast("✅ Compte AniList relié" + (res.user && res.user.anilistName ? " (" + res.user.anilistName + ")" : ""));
        return refreshState(true);
      })
      .catch((err) => toast("⚠️ Liaison AniList échouée : " + err.message, true));
    return true;
  }

  // Onglet Lecture : configuration du classement affiché
  function readingSource() {
    return state.shelf === "bd" ? BD.bd || [] : BOOKS.manga || [];
  }
  function readingShelfRow() {
    return (
      '<div class="chip-scroll">' +
      chip("set-shelf", "manga", "🇯🇵 Mangas &amp; webtoons", state.shelf !== "bd") +
      chip("set-shelf", "bd", "🇪🇺 BD &amp; comics", state.shelf === "bd") +
      "</div>"
    );
  }
  function readingKinds() {
    if (state.shelf === "bd") {
      return [
        ["all", "📚 Tous"],
        ["bd", "🇪🇺 BD franco-belge"],
        ["comics", "🇺🇸 Comics & romans graphiques"]
      ];
    }
    return [
      ["all", "📚 Tous"],
      ["manga", "🇯🇵 Mangas"],
      ["webtoon", "🇰🇷 Webtoons"],
      ["manhua", "🇨🇳 Manhua"]
    ];
  }
  function readingSorts() {
    if (state.shelf === "bd") {
      return [
        ["imdb", "🏆 Score critique"],
        ["hc", "⭐ Note Hardcover"],
        ["votes", "🔥 Nombre de notes"],
        ["volumes", "⚡ Plus courts (tomes)"],
        ["year", "📅 Plus récents"],
        ["year_asc", "🏛️ Plus anciens"]
      ];
    }
    return [
      ["imdb", "⭐ Note AniList"],
      ["votes", "🔥 Nombre de notes"],
      ["members", "👥 Lecteurs AniList"],
      ["volumes", "⚡ Plus courts (tomes)"],
      ["year", "📅 Plus récents"]
    ];
  }
  function readingPresets() {
    if (state.shelf === "bd") {
      return [
        ["none", "Tous"],
        ["masterpiece", "🏆 Chefs-d'œuvre"],
        ["incontournable", "⭐ Incontournables & +"],
        ["prized", "🥇 Primés en festival"],
        ["oneshot", "📕 One-shots (1 tome)"],
        ["short", "⚡ Séries courtes (2–5 tomes)"],
        ["albums", "📖 Albums indépendants"],
        ["series", "📚 Séries à suivre"],
        ["recent", "🆕 Depuis 2015"],
        ["classic_era", "🏛️ Avant 2000"]
      ];
    }
    return [
      ["none", "Tous"],
      ["masterpiece", "⭐ Chefs-d'œuvre (8.8+)"],
      ["classic", "🏛️ Incontournables (30k+ notes)"],
      ["gem", "💎 Pépites (< 5k notes)"],
      ["finished", "🏁 Terminés"],
      ["short", "⚡ Courts (≤ 10 tomes)"],
      ["releasing", "📡 En cours de parution"],
      ["recent", "🆕 Depuis 2020"]
    ];
  }

  const BD_AWARDS = [
    ["all", "Tous"],
    ["fauve", "🐾 Fauve d'or Angoulême"],
    ["serie", "🏅 Prix de la série Angoulême"],
    ["acbd", "📰 Grand Prix ACBD"],
    ["eisner", "🇺🇸 Prix Eisner"],
    ["moustique", "🇧🇪 Top 100 Moustique"],
    ["classique", "🏛️ Classiques"]
  ];
  const BD_AWARD_MAP = Object.fromEntries(BD_AWARDS);

  function matchBdAward(item, award) {
    if (!award || award === "all") return true;
    const cites = item.cites || [];
    if (award === "eisner") return cites.some((c) => String(c.src || "").startsWith("eisner"));
    return cites.some((c) => c.src === award);
  }

  function kindLabel(item) {
    if (item.kind === "manga") return "🇯🇵 Manga";
    if (item.country === "CN" || item.country === "TW") return "🇨🇳 Manhua";
    return "🇰🇷 Webtoon";
  }

  function bookStatusLabel(item) {
    if (item.status === "FINISHED") return item.volumes ? "Terminé · " + item.volumes + " tomes" : "Terminé";
    if (item.status === "RELEASING") return "En cours de parution";
    if (item.status === "HIATUS") return "En pause";
    if (item.status === "CANCELLED") return "Arrêté";
    return "";
  }

  function readingLabel(user, item) {
    const e = readEntry(user, item);
    if (!e) return "";
    if (e[0] === "read") return "✅ Lu";
    if (e[0] === "hidden") return "🙈 Masqué";
    if (item.type === "bd" && item.mode === "albums") {
      const n = (e[2] || []).length;
      return "📖 " + n + (bdAlbumCount(item) ? "/" + bdAlbumCount(item) : "") + " album" + (n > 1 ? "s" : "");
    }
    return "📖 " + (e[1] ? "Tome " + e[1] : "En cours");
  }

  const ptsLabel = (n) => n + (n > 1 ? " pts" : " pt");
  const TIER_LABEL = { chef: "🏆 Chef-d'œuvre", incontournable: "⭐ Incontournable", recommande: "👍 Recommandé" };

  function bdAlbumCount(item) {
    return (item.albums && item.albums.length) || item.volumes || 0;
  }

  function bdKindLabel(item) {
    return item.kind === "comics" ? "🇺🇸 Comics" : "🇪🇺 BD";
  }

  function bdModeLabel(item) {
    if (item.mode === "oneshot") return "One-shot";
    if (item.mode === "albums") return (bdAlbumCount(item) ? bdAlbumCount(item) + " albums" : "Albums") + " indépendants";
    return item.volumes ? "Série · " + item.volumes + " tomes" : "Série à suivre";
  }

  function citeLabel(c) {
    const src = (BD.sources || {})[c.src] || {};
    return (src.short || c.src) + (c.year && c.src !== "moustique" ? " " + c.year : "") + (c.note ? " (" + c.note + ")" : "");
  }

  function fmtDateFr(iso) {
    if (!iso) return "";
    const d = new Date(String(iso).length <= 10 ? iso + "T12:00:00" : iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  }

  /* ---------------- Jeux (Game Pass cloud) ---------------- */

  const GP_TIERS = [
    ["essential", "Essential"],
    ["premium", "Premium"],
    ["ultimate", "Ultimate"]
  ];
  // Hors Game Pass, mais jouables en cloud : free-to-play, ou si on possède le jeu
  const GP_EXTRA = [
    ["free", "🆓 Gratuits"],
    ["buy", "🛒 À acheter"]
  ];
  const GP_RANK = { essential: 1, premium: 2, ultimate: 3 };
  const GP_LABEL = Object.fromEntries(GP_TIERS);
  const isGamePass = (item) => Boolean(GP_RANK[item.tier]);
  // Heures de cloud incluses par mois (Xbox, à partir de novembre 2026)
  const GP_CLOUD_HOURS = { essential: 5, premium: 10, ultimate: 15 };
  const NEW_DAYS = 30;

  function gpPill(item) {
    if (item.tier === "buy") return '<span class="gp-pill buy">🛒 ' + esc(item.price || "À acheter") + "</span>";
    if (item.tier === "free") return '<span class="gp-pill free">🆓 Gratuit</span>';
    return '<span class="gp-pill ' + esc(item.tier) + '">' + esc(GP_LABEL[item.tier] || item.tier) + "</span>";
  }

  function isNewGame(item) {
    if (!item.addedAt) return false;
    const d = new Date(item.addedAt + "T12:00:00");
    return !isNaN(d) && Date.now() - d.getTime() < NEW_DAYS * 86400000;
  }

  function steamPct(item) {
    const st = item.steam || {};
    return st.total ? Math.round((100 * (st.pos || 0)) / st.total) : 0;
  }

  // Badge de note principal : Steam, sinon presse (IGDB), sinon Store Xbox
  function gameScoreBadge(item, long) {
    if (item.scoreSrc === "steam") {
      return (
        '<span class="badge-imdb">👍 ' + steamPct(item) + " %" + (long ? " sur Steam" : " Steam") +
        ' <span class="votes">(' + fmtVotes(item.votes) + " avis)</span></span>"
      );
    }
    if (item.scoreSrc === "presse") return '<span class="badge-imdb">📰 ' + Math.round(item.press) + "/100 presse</span>";
    if (item.scoreSrc === "xbox") {
      return (
        '<span class="badge-imdb">★ ' + fmt1(item.xboxRating) + "/5 Xbox" +
        ' <span class="votes">(' + fmtVotes(item.xboxVotes) + ")</span></span>"
      );
    }
    return '<span class="badge-tmdb">Pas encore de note</span>';
  }

  function gameLabel(user, item) {
    const g = gameEntry(user, item);
    if (g === "played") return "✅ Joué";
    if (g === "playing") return "🎮 En cours";
    if (g === "hidden") return "🙈 Masqué";
    return "";
  }

  function gameSlug(item) {
    return norm(item.en || item.title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game";
  }

  // Tris et sélections proposés seulement quand le catalogue a les données (avis Steam, durées IGDB, ajouts)
  function gameHas(field) {
    const list = GAMES.games || [];
    if (field === "votes") return list.some((g) => g.votes > 0);
    if (field === "hours") return list.some((g) => g.hours > 0);
    if (field === "new") return list.some(isNewGame);
    if (field === "leaving") return list.some((g) => g.leaving);
    return true;
  }

  function gameSorts() {
    return [
      ["imdb", "⭐ Meilleure note"],
      ["votes", "🔥 Nombre d'avis Steam"],
      ["hours", "⏱️ Plus courts"],
      ["added", "🆕 Derniers ajouts"],
      ["year", "📅 Plus récents"]
    ].filter(([v]) => (v === "added" ? gameHas("new") : gameHas(v)));
  }

  function gamePresets() {
    return [
      ["none", "Tous"],
      ["masterpiece", "⭐ Chefs-d'œuvre (90 %+)"],
      ["short", "⏱️ Courts (≤ 10 h)"],
      ["new", "🆕 Ajoutés ce mois-ci"],
      ["leaving", "⏳ Quittent bientôt"],
      ["recent", "📅 Sortis depuis 2023"]
    ].filter(([v]) => (v === "short" ? gameHas("hours") : gameHas(v)));
  }

  // Part des jeux affichés qui ont déjà leur note Steam (récupérée par lots chaque nuit)
  function steamCoverage() {
    const list = (GAMES.games || []).filter((g) => (GP_RANK[state.gameTier] || state.gameTier === "all" ? isGamePass(g) : g.tier === state.gameTier));
    const done = list.filter((g) => g.scoreSrc === "steam" || (g.steam && g.steam.at)).length;
    return { done, total: list.length };
  }

  /* ---------------- Init ---------------- */

  async function loadCatalog() {
    const res = await fetch("./data.json?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const fresh = await res.json();
    const prevGen = DATA.generatedAt;
    DATA = fresh;
    ITEM_MAP.clear();
    progCache.clear();
    (DATA.movies || []).forEach(prepareItem);
    (DATA.series || []).forEach(prepareItem);
    await loadBooks();
    const dateTxt = formatGenDate(DATA.generatedAt);
    elHeaderSub.textContent =
      "Netflix · Prime · Apple TV (" + (DATA.region || "BG") + ")" + (dateTxt ? " · màj " + dateTxt : "");
    return prevGen !== DATA.generatedAt;
  }

  async function loadBooks() {
    try {
      const res = await fetch("./books.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      BOOKS = await res.json();
    } catch (_) {
      BOOKS = { manga: [], generatedAt: "" }; // pas encore généré : l'onglet Lecture sera vide
    }
    (BOOKS.manga || []).forEach(prepareItem);
    try {
      const res = await fetch("./bd.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      BD = await res.json();
    } catch (_) {
      BD = { bd: [], sources: {}, generatedAt: "", referentialUpdatedAt: "" };
    }
    (BD.bd || []).forEach(prepareItem);
    try {
      const res = await fetch("./games.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      GAMES = await res.json();
    } catch (_) {
      GAMES = { games: [], generatedAt: "", market: "PL" }; // pas encore généré : l'onglet Jeux sera vide
    }
    (GAMES.games || []).forEach(prepareItem);
  }

  let reloading = false;
  async function reloadAll() {
    if (reloading) return;
    reloading = true;
    document.body.classList.add("is-reloading");
    try {
      const changed = await loadCatalog();
      if (HH.session) await refreshState(true);
      renderAll();
      if (state.modalKey) renderModalContent();
      toast(changed ? "✅ Catalogue mis à jour" : "✅ À jour" + (HH.session ? " (vus resynchronisés)" : ""));
    } catch (err) {
      toast("⚠️ Rechargement impossible : " + err.message, true);
    } finally {
      reloading = false;
      document.body.classList.remove("is-reloading");
    }
  }

  // Pull-to-refresh mobile : tirer vers le bas quand on est tout en haut de la page
  function setupPullToRefresh() {
    const ind = document.createElement("div");
    ind.className = "ptr-indicator";
    ind.textContent = "↓";
    document.body.appendChild(ind);
    const THRESHOLD = 70;
    let startY = null;
    let dist = 0;

    window.addEventListener(
      "touchstart",
      (e) => {
        if (window.scrollY > 0 || document.body.classList.contains("modal-open") || reloading) return;
        startY = e.touches[0].clientY;
        dist = 0;
      },
      { passive: true }
    );
    window.addEventListener(
      "touchmove",
      (e) => {
        if (startY === null) return;
        dist = e.touches[0].clientY - startY;
        if (dist <= 0 || window.scrollY > 0) {
          ind.style.opacity = "0";
          return;
        }
        const d = Math.min(dist, 120);
        ind.style.opacity = String(Math.min(1, d / THRESHOLD));
        ind.style.transform = "translate(-50%, " + (d * 0.6) + "px) rotate(" + d * 2 + "deg)";
        ind.textContent = d >= THRESHOLD ? "↻" : "↓";
      },
      { passive: true }
    );
    window.addEventListener("touchend", () => {
      if (startY === null) return;
      const trigger = dist >= THRESHOLD && window.scrollY <= 0;
      startY = null;
      ind.style.transform = "translate(-50%, 0)";
      ind.style.opacity = "0";
      if (trigger) reloadAll();
    });
  }

  // Défilement fluide des chips et saisons sur PC (drag-to-slide, molette souris, flèches)
  function setupChipScroller() {
    window.addEventListener(
      "wheel",
      (e) => {
        const target = e.target.closest(".chip-scroll");
        if (!target) return;
        if (target.scrollWidth <= target.clientWidth) return;
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        if (e.deltaY !== 0) {
          e.preventDefault();
          target.scrollLeft += e.deltaY * 0.9;
        }
      },
      { passive: false }
    );

    let activeTarget = null;
    let startX = 0;
    let startScrollLeft = 0;
    let hasDragged = false;

    document.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const target = e.target.closest(".chip-scroll");
      if (!target) return;
      if (target.scrollWidth <= target.clientWidth) return;

      activeTarget = target;
      startX = e.pageX;
      startScrollLeft = target.scrollLeft;
      hasDragged = false;
    });

    document.addEventListener("mousemove", (e) => {
      if (!activeTarget) return;
      const dx = e.pageX - startX;
      if (Math.abs(dx) > 5) {
        hasDragged = true;
        activeTarget.classList.add("is-dragging");
      }
      if (hasDragged) {
        e.preventDefault();
        activeTarget.scrollLeft = startScrollLeft - dx;
      }
    });

    const endDrag = () => {
      if (!activeTarget) return;
      activeTarget.classList.remove("is-dragging");
      if (hasDragged) {
        const swallowClick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          window.removeEventListener("click", swallowClick, true);
        };
        window.addEventListener("click", swallowClick, true);
        setTimeout(() => window.removeEventListener("click", swallowClick, true), 80);
      }
      activeTarget = null;
      hasDragged = false;
    };

    document.addEventListener("mouseup", endDrag);
    document.addEventListener("mouseleave", endDrag);

    document.addEventListener("click", (e) => {
      const arrow = e.target.closest(".btn-scroll-arrow");
      if (!arrow) return;
      e.preventDefault();
      e.stopPropagation();
      const dir = Number(arrow.dataset.scrollDir || 1);
      const container =
        arrow.closest(".adv-group") ||
        arrow.closest(".sheet-section") ||
        arrow.closest(".ep-selector-box") ||
        (arrow.parentElement && arrow.parentElement.parentElement);
      if (container) {
        const row = container.querySelector(".chip-scroll");
        if (row) {
          row.scrollBy({ left: dir * 260, behavior: "smooth" });
        }
      }
    });
  }

  async function init() {
    try {
      await loadCatalog();

      const preferredIds = [60625, 42009, 105248, 2316, 86831];
      let defSeries = null;
      for (const pid of preferredIds) {
        defSeries = DATA.series.find((s) => s.id === pid && s.episodes && s.episodes.length > 0);
        if (defSeries) break;
      }
      if (!defSeries) defSeries = DATA.series.find((s) => s.episodes && s.episodes.length > 0);
      if (defSeries) state.epSeriesId = defSeries.id;
    } catch (err) {
      elMainContent.innerHTML =
        '<div class="empty-state"><div class="emoji">⚠️</div><div>Impossible de charger <code>data.json</code> (' +
        esc(err.message) +
        ").<br/>Lance un petit serveur HTTP local (ex. <code>python3 -m http.server -d docs 8080</code>).</div></div>";
      return;
    }

    renderAll();

    if (sb) {
      sb.auth.onAuthStateChange((event, session) => {
        HH.session = session;
        if (session) {
          const email = String(session.user && session.user.email ? session.user.email : "").toLowerCase();
          if (!HH.users.length && loadCache(email)) {
            if (!state.statusTouched) state.status = "todoBoth";
            renderAll();
          }
          if (finishAnilistLink()) {
            renderAll();
            return;
          }
          const params = new URLSearchParams(location.search);
          const reqToken = params.get("request_token");
          if (reqToken && params.get("approved") === "true") {
            history.replaceState(null, "", location.pathname + location.hash);
            callFn("POST", { action: "tmdb_link_session", requestToken: reqToken })
              .then(() => {
                toast("✅ Compte TMDB relié avec succès !");
                return refreshState(true);
              })
              .catch((err) => toast("⚠️ Liaison TMDB échouée : " + err.message, true));
            return;
          }
          const stale = Date.now() - HH.loadedAt > 60000;
          if ((event === "INITIAL_SESSION" || event === "SIGNED_IN") && stale) {
            setTimeout(() => refreshState(true), 0);
          }
        } else {
          HH.users = [];
          HH.meEmail = null;
          HH.loadedAt = 0;
          progCache.clear();
          state.status = "all";
          renderAll();
        }
        renderAccountButton();
      });
    }
    renderAccountButton();
  }

  /* ---------------- Filtres ---------------- */

  function statusOptions(forTab) {
    if (!loggedIn()) return [["all", "Tout"]];
    const tab = forTab || state.tab;
    const m = me();
    const o = other();
    const reading = tab === "reading";
    if (reading) {
      const opts = [
        ["todoMe", "📚 À lire"],
        ["catchup", "📖 En cours"],
        ["watched", "✅ Lus"]
      ];
      if (o) {
        opts.push(["recoOther", "💡 Lus par " + o.name + " (à découvrir)"]);
        opts.push(["readOther", "💁 Lus par " + o.name]);
        opts.push(["readBoth", "🤝 Lus tous les deux"]);
      }
      opts.push(["locked", "🙈 Masqués"]);
      opts.push(["all", "Tout"]);
      void m;
      return opts;
    }
    const opts = [["todoBoth", o ? "👥 À voir ensemble" : "🍿 À voir"]];
    if (o) {
      opts.push(["todoMe", "🙋 Pas vu par moi"]);
      opts.push(["todoMeOnly", "🙋 Que moi (" + o.name + " l'a vu)"]);
      opts.push(["todoOtherOnly", "💁 Que " + o.name + " (je l'ai vu)"]);
    }
    const games = tab === "games";
    if (games) {
      opts[0][1] = o ? "👥 À jouer (ni l'un ni l'autre)" : "🎮 À jouer";
      if (o) {
        opts[1][1] = "🙋 Pas joué par moi";
        opts[2][1] = "🙋 Que moi (" + o.name + " y a joué)";
        opts[3][1] = "💁 Que " + o.name + " (j'y ai joué)";
      }
    }
    if (tab === "series" || games) opts.push(["catchup", games ? "🎮 En cours" : "🔄 En cours"]);
    opts.push(["watched", games ? "✅ Joués" : "✅ Vus"]);
    opts.push(["locked", tab === "series" ? "🔒 Masquées" : "🙈 Masqués"]);
    opts.push(["all", "Tout"]);
    void m;
    return opts;
  }

  function matchStatus(item, status) {
    if (!loggedIn()) return true;
    const m = me();
    const o = other();
    switch (status) {
      case "todoBoth":
        return !isFinished(m, item) && (!o || !isFinished(o, item));
      case "todoMe":
        return !isFinished(m, item);
      case "todoMeOnly":
        return !isFinished(m, item) && Boolean(o) && statusOf(o, item) === "watched";
      case "todoOtherOnly":
        return Boolean(o) && !isFinished(o, item) && statusOf(m, item) === "watched";
      case "recoOther":
        return !isFinished(m, item) && Boolean(o) && (statusOf(o, item) === "watched" || statusOf(o, item) === "catchup");
      case "readOther":
        return Boolean(o) && (statusOf(o, item) === "watched" || statusOf(o, item) === "catchup");
      case "readBoth":
        return statusOf(m, item) === "watched" && Boolean(o) && statusOf(o, item) === "watched";
      case "catchup":
        return statusOf(m, item) === "catchup";
      case "watched":
        return statusOf(m, item) === "watched";
      case "locked":
        return statusOf(m, item) === "locked";
      default:
        return true;
    }
  }

  function getActiveAdvancedCount() {
    let c = 0;
    if (state.genre !== "all") c++;
    if (state.tab === "reading" && state.shelf === "bd" && state.bdAward !== "all") c++;
    if (state.preset !== "none") c++;
    if (state.sort !== "imdb") c++;
    if (state.showAllLimit) c++;
    return c;
  }

  function getFilteredList(forTab) {
    const tab = forTab || state.tab;
    const reading = tab === "reading";
    const games = tab === "games";
    const source = games ? GAMES.games || [] : reading ? readingSource() : tab === "movies" ? DATA.movies : DATA.series;
    const bdShelf = reading && state.shelf === "bd";
    const qNorm = norm(state.q.trim());
    const validStatuses = statusOptions(tab).map((o) => o[0]);
    const status = validStatuses.includes(state.status) ? state.status : validStatuses[0];

    const filtered = source.filter((item) => {
      if (!matchStatus(item, status)) return false;

      if (state.genre !== "all" && !(item.genres || []).includes(state.genre)) return false;
      if (games) {
        if (GP_RANK[state.gameTier]) {
          if (!isGamePass(item) || GP_RANK[item.tier] > GP_RANK[state.gameTier]) return false;
        } else if (state.gameTier === "free" || state.gameTier === "buy") {
          if (item.tier !== state.gameTier) return false;
        } else if (!isGamePass(item)) return false;
        if (state.preset === "masterpiece" && (item.score || 0) < 90) return false;
        if (state.preset === "short" && !(item.hours > 0 && item.hours <= 10)) return false;
        if (state.preset === "new" && !isNewGame(item)) return false;
        if (state.preset === "leaving" && !item.leaving) return false;
        if (state.preset === "recent" && Number(item.year || 0) < 2023) return false;
        if (qNorm && !item._search.includes(qNorm)) return false;
        return true;
      }
      if (bdShelf) {
        if (state.bookKind !== "all" && item.kind !== state.bookKind) return false;
        if (state.bdAward !== "all" && !matchBdAward(item, state.bdAward)) return false;
        if (state.preset === "masterpiece" && item.tier !== "chef") return false;
        if (state.preset === "incontournable" && item.tier !== "chef" && item.tier !== "incontournable") return false;
        if (state.preset === "prized" && !(item.cites || []).some((c) => c.src !== "classique" && c.src !== "moustique")) return false;
        if (state.preset === "oneshot" && item.mode !== "oneshot") return false;
        if (state.preset === "short") {
          const n = bdAlbumCount(item);
          if (!(item.mode !== "oneshot" && n >= 2 && n <= 5)) return false;
        }
        if (state.preset === "albums" && item.mode !== "albums") return false;
        if (state.preset === "series" && item.mode !== "series") return false;
        if (state.preset === "recent" && Number(item.year || 0) < 2015) return false;
        if (state.preset === "classic_era" && !(Number(item.year || 0) > 0 && Number(item.year) < 2000)) return false;
        if (qNorm && !item._search.includes(qNorm)) return false;
        return true;
      }
      if (reading) {
        if (state.bookKind !== "all") {
          const isManhua = item.country === "CN" || item.country === "TW";
          if (state.bookKind === "manga" && item.kind !== "manga") return false;
          if (state.bookKind === "webtoon" && (item.kind !== "webtoon" || isManhua)) return false;
          if (state.bookKind === "manhua" && !isManhua) return false;
        }
        if (state.preset === "masterpiece" && (item.score || 0) < 8.8) return false;
        if (state.preset === "gem" && (item.votes || 0) >= 5000) return false;
        if (state.preset === "classic" && (item.votes || 0) < 30000) return false;
        if (state.preset === "finished" && item.status !== "FINISHED") return false;
        if (state.preset === "short" && !(item.status === "FINISHED" && item.volumes > 0 && item.volumes <= 10)) return false;
        if (state.preset === "releasing" && item.status !== "RELEASING") return false;
        if (state.preset === "recent" && Number(item.year || 0) < 2020) return false;
        if (qNorm && !item._search.includes(qNorm)) return false;
        return true;
      }
      if (state.providers.size > 0 && !(item.providers || []).some((p) => state.providers.has(p))) return false;

      if (state.preset === "masterpiece" && (item.imdb || 0) < 8.5) return false;
      if (state.preset === "gem" && (item.votes || 0) >= 50000) return false;
      if (state.preset === "classic" && (item.votes || 0) < 200000) return false;
      if (state.preset === "recent" && Number(item.year || 0) < 2023) return false;
      if (tab === "series") {
        if (state.preset === "miniseries" && (item.releasedSeasons || []).length !== 1) return false;
        if (state.preset === "episodic" && !item.episodic) return false;
      }

      if (qNorm && !item._search.includes(qNorm)) return false;
      return true;
    });

    const m = me();
    const o = other();
    const targetUser = (status === "todoOtherOnly" && o) ? o : m;
    const scoreOf = (x) => {
      if (reading || games) return x.score || 0;
      if (tab === "series" && targetUser && statusOf(targetUser, x) === "catchup") {
        return unwatchedImdb(targetUser, x);
      }
      return x.imdb || 0;
    };

    filtered.sort((a, b) => {
      if (state.sort === "votes") return (b.votes || 0) - (a.votes || 0) || (scoreOf(b) - scoreOf(a));
      if (state.sort === "year") return Number(b.year || 0) - Number(a.year || 0) || (scoreOf(b) - scoreOf(a));
      if (state.sort === "year_asc") return (Number(a.year || 9999) - Number(b.year || 9999)) || (scoreOf(b) - scoreOf(a));
      if (state.sort === "volumes") {
        const va = (bdShelf ? bdAlbumCount(a) : a.volumes) || 9999;
        const vb = (bdShelf ? bdAlbumCount(b) : b.volumes) || 9999;
        return va - vb || (scoreOf(b) - scoreOf(a));
      }
      if (state.sort === "hours") return (a.hours || 9999) - (b.hours || 9999) || (scoreOf(b) - scoreOf(a));
      if (state.sort === "added") return String(b.addedAt || "").localeCompare(String(a.addedAt || "")) || (scoreOf(b) - scoreOf(a));
      if (state.sort === "hc") return (b.hcRating || 0) - (a.hcRating || 0) || (b.votes || 0) - (a.votes || 0);
      if (state.sort === "members") return (b.members || 0) - (a.members || 0) || (scoreOf(b) - scoreOf(a));
      if (state.sort === "tmdb") return (b.tmdb || 0) - (a.tmdb || 0) || (scoreOf(b) - scoreOf(a));
      return scoreOf(b) - scoreOf(a) || (b.votes || 0) - (a.votes || 0);
    });

    return filtered;
  }

  function catchupList(user) {
    if (!user) return [];
    return (DATA.series || [])
      .filter((s) => statusOf(user, s) === "catchup")
      .sort((a, b) => unwatchedImdb(user, b) - unwatchedImdb(user, a));
  }

  /* ---------------- Rendu ---------------- */

  function renderAccountButton() {
    if (!AUTH_ENABLED) {
      elBtnAccount.style.display = "none";
      return;
    }
    const m = me();
    if (HH.session && m) {
      elBtnAccount.classList.add("logged");
      elBtnAccount.textContent = (HH.loading || HH.pending ? "⏳ " : "👤 ") + m.name;
    } else if (HH.session) {
      elBtnAccount.classList.add("logged");
      elBtnAccount.textContent = "⏳ Synchro…";
    } else {
      elBtnAccount.classList.remove("logged");
      elBtnAccount.textContent = "🔑 Connexion";
    }
  }

  function updateBadges() {
    const st = loggedIn() ? "todoBoth" : "all";
    const stRead = loggedIn() ? "todoMe" : "all";
    document.getElementById("badgeMovies").textContent = DATA.movies.filter((x) => matchStatus(x, st)).length;
    document.getElementById("badgeSeries").textContent = DATA.series.filter((x) => matchStatus(x, st)).length;
    document.getElementById("badgeReading").textContent =
      [...(BOOKS.manga || []), ...(BD.bd || [])].filter((x) => matchStatus(x, stRead)).length || "–";
    document.getElementById("badgeGames").textContent =
      (GAMES.games || []).filter((x) => isGamePass(x) && matchStatus(x, st)).length || "–";
    document.getElementById("badgeCatchup").textContent = loggedIn() ? catchupList(me()).length : "–";
    document.querySelectorAll("#mainTabs .tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === state.tab);
    });
  }

  function chip(action, val, label, active, extraCls) {
    return (
      '<button type="button" class="chip ' +
      (extraCls || "") +
      (active ? " active" : "") +
      '" data-action="' +
      action +
      '" data-val="' +
      esc(val) +
      '">' +
      label +
      "</button>"
    );
  }

  function syncAdvOverlay(open) {
    elAdvPanel.classList.toggle("open", open);
    if (elAdvBackdrop) elAdvBackdrop.classList.toggle("open", open);
    document.body.classList.toggle("adv-open", open);
  }

  function renderToolbar() {
    if (state.tab === "catchup") {
      elMainToolbar.style.display = "none";
      syncAdvOverlay(false);
      return;
    }
    elMainToolbar.style.display = "flex";

    if (state.tab === "episodes") {
      elSearchInput.placeholder = "Filtrer un épisode (ex: Callister, S3E7, Cornichon…)";
      elBtnAdvToggle.style.display = "none";
      elQuickChips.style.display = "none";
      syncAdvOverlay(false);
      return;
    }

    const reading = state.tab === "reading";
    const games = state.tab === "games";
    elSearchInput.placeholder = games
      ? "Rechercher un jeu, un studio, un genre…"
      : reading
      ? state.shelf === "bd"
        ? "Rechercher une BD, un comics, un auteur…"
        : "Rechercher un manga, un webtoon, un genre…"
      : state.tab === "movies"
      ? "Rechercher un film VF/VO, genre, année…"
      : "Rechercher une série VF/VO, genre, année…";
    elBtnAdvToggle.style.display = "inline-flex";

    const advCount = getActiveAdvancedCount();
    elAdvCount.textContent = advCount > 0 ? "· " + advCount : "";
    elBtnAdvToggle.classList.toggle("active", state.advOpen || advCount > 0);
    syncAdvOverlay(state.advOpen);
    elQuickChips.style.display = state.advOpen ? "none" : "flex";

    const opts = statusOptions();
    const curStatus = opts.some((o) => o[0] === state.status) ? state.status : opts[0][0];
    const items = games
      ? GAMES.games || []
      : reading
      ? readingSource()
      : state.tab === "movies"
      ? DATA.movies || []
      : DATA.series || [];
    const totalCount = items.length;
    const allLabel = totalCount ? "Catalogue complet (" + totalCount + ")" : "Catalogue complet";

    const sortOpts = games
      ? gameSorts()
      : reading
      ? readingSorts()
      : [
          ["imdb", "⭐ Note IMDb"],
          ["votes", "🔥 Popularité (votes)"],
          ["year", "📅 Plus récents"],
          ["tmdb", "💙 Note TMDB"]
        ];
    const sortMap = Object.fromEntries(sortOpts);
    const presets = games
      ? gamePresets()
      : reading
      ? readingPresets()
      : [
          ["none", "Tous"],
          ["masterpiece", "⭐ Chefs-d'œuvre (8.5+)"],
          ["gem", "💎 Pépites (< 50k votes)"],
          ["classic", "🏛️ Classiques (200k+)"],
          ["recent", "🆕 Sorties 2023+"]
        ];
    if (state.tab === "series") {
      presets.push(["miniseries", "⚡ Format court (1 saison)"]);
      presets.push(["episodic", "🎭 Sitcoms & Anthologies"]);
    }
    const presetMap = Object.fromEntries(presets);

    // Ligne 1 : Plateformes (ou type de lecture) + filtres avancés actifs (supprimables en 1 toucher) + bouton Tous les filtres
    let row1 = '<div class="chip-scroll">';
    if (games) {
      row1 += chip("set-game-tier", "all", "🎮 Toutes offres", state.gameTier === "all");
      GP_TIERS.forEach(([val, lbl]) => (row1 += chip("set-game-tier", val, esc(lbl), state.gameTier === val, "gp-chip " + val)));
      GP_EXTRA.forEach(([val, lbl]) => (row1 += chip("set-game-tier", val, lbl, state.gameTier === val, "gp-chip " + val)));
    } else if (reading) {
      readingKinds().forEach(([val, lbl]) => (row1 += chip("set-book-kind", val, lbl, state.bookKind === val)));
    } else {
      row1 += chip("prov-all", "", "Toutes", state.providers.size === 0);
      [
        ["Netflix", "prov-netflix", "dot-netflix"],
        ["Prime Video", "prov-prime", "dot-prime"],
        ["Apple TV", "prov-apple", "dot-apple"]
      ].forEach(([pName, cls, dotCls]) => {
        row1 += chip(
          "prov-toggle",
          pName,
          '<span class="dot ' + dotCls + '"></span>' + esc(pName),
          state.providers.has(pName),
          cls
        );
      });
    }

    if (reading && state.shelf === "bd" && state.bdAward !== "all" && BD_AWARD_MAP[state.bdAward]) {
      row1 += chip("set-bd-award", "all", esc(BD_AWARD_MAP[state.bdAward]) + " ✕", false, "active-pill");
    }
    if (state.genre !== "all") {
      row1 += chip("set-genre", "all", "🎭 " + esc(state.genre) + " ✕", false, "active-pill");
    }
    if (state.preset !== "none" && presetMap[state.preset]) {
      row1 += chip("set-preset", state.preset, esc(presetMap[state.preset]) + " ✕", false, "active-pill");
    }
    if (state.sort !== "imdb" && sortMap[state.sort]) {
      row1 += chip("set-sort", "imdb", esc(sortMap[state.sort]) + " ✕", false, "active-pill");
    }
    if (state.showAllLimit) {
      row1 += chip("set-limit", "top50", "📋 Tout (" + totalCount + ") ✕", false, "active-pill");
    }
    row1 += chip("toggle-adv", "", reading && state.shelf === "bd" ? "⚙️ Prix & Tri…" : "⚙️ Genres & Tri…", false, "more-filters");
    row1 += "</div>";

    // Ligne 2 : Statut (« Qui a vu ? » / « Qui a lu ? »)
    let row2 = "";
    if (opts.length > 1) {
      row2 = '<div class="chip-scroll">';
      opts.forEach(([val, lbl]) => (row2 += chip("set-status", val, esc(lbl), curStatus === val)));
      row2 += "</div>";
    }
    elQuickChips.innerHTML = (reading ? readingShelfRow() : "") + row1 + row2;

    if (!state.advOpen) return;

    const genreCounts = {};
    items.forEach((it) => (it.genres || []).forEach((g) => (genreCounts[g] = (genreCounts[g] || 0) + 1)));
    const sortedGenres = Object.keys(genreCounts).sort((a, b) => genreCounts[b] - genreCounts[a]);

    const defStatus = !loggedIn() ? "all" : reading ? "todoMe" : "todoBoth";
    const hasAnyFilter =
      advCount > 0 ||
      state.providers.size > 0 ||
      (reading && state.bookKind !== "all") ||
      curStatus !== defStatus ||
      state.q.trim().length > 0;
    const matchCount = getFilteredList(state.tab).length;

    let advHtml = "";

    if (opts.length > 1) {
      advHtml +=
        '<div class="adv-group"><div class="adv-label-row"><span>' +
        (reading ? "Mes lectures & découvertes (Statut)" : games ? "Qui a joué ? (Statut)" : "Qui a vu ? (Statut)") +
        '</span></div><div class="chip-wrap">';
      opts.forEach(([val, lbl]) => (advHtml += chip("set-status", val, esc(lbl), curStatus === val)));
      advHtml += "</div></div>";
    }

    if (games) {
      advHtml +=
        '<div class="adv-group"><div class="adv-label-row"><span>Mon abonnement (jeux inclus)</span></div><div class="chip-wrap">';
      advHtml += chip("set-game-tier", "all", "Toutes offres", state.gameTier === "all");
      GP_TIERS.forEach(([val, lbl]) => (advHtml += chip("set-game-tier", val, esc(lbl), state.gameTier === val, "gp-chip " + val)));
      GP_EXTRA.forEach(([val, lbl]) => (advHtml += chip("set-game-tier", val, lbl, state.gameTier === val, "gp-chip " + val)));
      advHtml += "</div></div>";
    } else if (reading) {
      advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Type</span></div><div class="chip-wrap">';
      readingKinds().forEach(([val, lbl]) => (advHtml += chip("set-book-kind", val, lbl, state.bookKind === val)));
      advHtml += "</div></div>";
    } else {
      advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Plateformes</span></div><div class="chip-wrap">';
      advHtml += chip("prov-all", "", "Toutes plateformes", state.providers.size === 0);
      [
        ["Netflix", "prov-netflix", "dot-netflix"],
        ["Prime Video", "prov-prime", "dot-prime"],
        ["Apple TV", "prov-apple", "dot-apple"]
      ].forEach(([pName, cls, dotCls]) => {
        advHtml += chip(
          "prov-toggle",
          pName,
          '<span class="dot ' + dotCls + '"></span>' + esc(pName),
          state.providers.has(pName),
          cls
        );
      });
      advHtml += "</div></div>";
    }

    advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Tri &amp; Portée</span></div><div class="chip-wrap">';
    sortOpts.forEach(([val, lbl]) => (advHtml += chip("set-sort", val, lbl, state.sort === val)));
    advHtml += '<span class="chip-sep"></span>';
    advHtml += chip("set-limit", "top50", "Top 50", !state.showAllLimit);
    advHtml += chip("set-limit", "all", allLabel, state.showAllLimit);
    advHtml += "</div></div>";

    advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Sélections rapides</span></div><div class="chip-wrap">';
    presets.forEach(([val, lbl]) => (advHtml += chip("set-preset", val, lbl, state.preset === val)));
    advHtml += "</div></div>";

    if (reading && state.shelf === "bd") {
      advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Prix &amp; Palmarès</span></div><div class="chip-wrap">';
      BD_AWARDS.forEach(([val, lbl]) => {
        const cnt = val === "all" ? items.length : items.filter((it) => matchBdAward(it, val)).length;
        const suffix = val === "all" ? "" : " (" + cnt + ")";
        advHtml += chip("set-bd-award", val, esc(lbl) + suffix, state.bdAward === val);
      });
      advHtml += "</div></div>";
    }

    if (sortedGenres.length > 0) {
      advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Genres</span></div><div class="chip-wrap">';
      advHtml += chip("set-genre", "all", "Tous", state.genre === "all");
      sortedGenres.forEach((g) => (advHtml += chip("set-genre", g, esc(g) + " (" + genreCounts[g] + ")", state.genre === g)));
      advHtml += "</div></div>";
    }

    advHtml += '<div class="adv-footer">';
    if (hasAnyFilter) {
      advHtml += '<button type="button" class="btn-reset" data-action="reset-filters">↺ Réinitialiser tout</button>';
    } else {
      advHtml += '<span></span>';
    }
    advHtml +=
      '<button type="button" class="btn-adv-apply" data-action="close-adv">Voir les ' +
      matchCount +
      " " +
      (matchCount > 1 ? "résultats" : "résultat") +
      " ✓</button></div>";

    elAdvPanel.innerHTML = advHtml;
  }

  function whoPill(user, item) {
    const st = statusOf(user, item);
    if (item.type === "game") {
      return '<span class="who-pill ' + st + '">' + esc(user.name) + " " + esc(gameLabel(user, item) || "–") + "</span>";
    }
    if (item.type === "manga" || item.type === "bd") {
      return (
        '<span class="who-pill ' + st + '">' + esc(user.name) + " " + esc(readingLabel(user, item) || "–") + "</span>"
      );
    }
    let txt = "–";
    if (st === "watched") txt = "✅";
    else if (st === "locked") txt = item.type === "movie" ? "🙈" : "🔒";
    else if (st === "catchup") {
      const p = progress(user, item);
      const todo = (item.releasedSeasons || []).filter((s) => !p.ws.has(s));
      txt = "🔄 " + seasonRangeLabel(todo);
    }
    return '<span class="who-pill ' + st + '">' + esc(user.name) + " " + esc(txt) + "</span>";
  }

  function whoRow(item) {
    if (!loggedIn()) return "";
    return '<div class="who-row">' + HH.users.map((u) => whoPill(u, item)).join("") + "</div>";
  }

  function renderBdCard(item, idx) {
    const m = me();
    const myStatus = statusOf(m, item);
    const posterHtml = item.cover
      ? '<img src="' + esc(item.cover) + '" alt="' + esc(item.title) + '" loading="lazy" />'
      : '<div class="poster-fallback">' + (item.kind === "comics" ? "🦸" : "📖") + "</div>";
    let cornerHtml = "";
    if (m && myStatus !== "unwatched") {
      const cls = myStatus === "watched" ? "vu" : myStatus === "locked" ? "locked" : "catchup";
      cornerHtml = '<div class="status-corner ' + cls + '">' + esc(readingLabel(m, item)) + "</div>";
    }
    const isMuted = m && (myStatus === "watched" || myStatus === "locked") && state.status === "all";
    const cites = (item.cites || []).filter((c) => c.src !== "classique");
    const citeTxt = cites.length
      ? cites.slice(0, 2).map(citeLabel).join(" · ") + (cites.length > 2 ? " · +" + (cites.length - 2) : "")
      : "Classique (sans prix recensé)";
    return (
      '<article class="media-card ' +
      (isMuted ? "is-vu" : "") +
      '" data-action="open-modal" data-key="' +
      esc(item._key) +
      '"><div class="poster-wrap">' +
      posterHtml +
      '<div class="rank-badge">#' +
      (idx + 1) +
      "</div>" +
      cornerHtml +
      '</div><div class="card-body"><div class="card-title-row"><span class="card-title">' +
      esc(item.title) +
      '</span><span class="card-year">' +
      esc(item.year) +
      "</span></div>" +
      '<div class="card-orig">' + esc(item.authors) + "</div>" +
      '<div class="scores-row"><span class="tier-pill ' + esc(item.tier) + '">' + esc(TIER_LABEL[item.tier] || "") + " · " + ptsLabel(item.score) + "</span>" +
      (item.hcRating ? '<span class="badge-tmdb">★ ' + fmt1(item.hcRating) + "/5" + (item.votes ? " (" + fmtVotes(item.votes) + ")" : "") + "</span>" : "") +
      "</div>" +
      '<div class="meta-tags"><span class="kind-pill ' + esc(item.kind) + '">' + esc(bdKindLabel(item)) + "</span>" +
      '<span class="genre-pill">' + esc(bdModeLabel(item)) + "</span></div>" +
      '<div class="cite-line">' + esc(citeTxt) + "</div>" +
      whoRow(item) +
      "</div></article>"
    );
  }

  function renderBookCard(item, idx) {
    if (item.type === "bd") return renderBdCard(item, idx);
    const m = me();
    const myStatus = statusOf(m, item);
    const posterHtml = item.cover
      ? '<img src="' + esc(item.cover) + '" alt="' + esc(item.title) + '" loading="lazy" />'
      : '<div class="poster-fallback">📚</div>';
    let cornerHtml = "";
    if (m && myStatus !== "unwatched") {
      const cls = myStatus === "watched" ? "vu" : myStatus === "locked" ? "locked" : "catchup";
      cornerHtml = '<div class="status-corner ' + cls + '">' + esc(readingLabel(m, item)) + "</div>";
    }
    const isMuted = m && (myStatus === "watched" || myStatus === "locked") && state.status === "all";
    const genrePills = (item.genres || [])
      .slice(0, 2)
      .map((g) => '<span class="genre-pill">' + esc(g) + "</span>")
      .join("");
    const st = bookStatusLabel(item);
    return (
      '<article class="media-card ' +
      (isMuted ? "is-vu" : "") +
      '" data-action="open-modal" data-key="' +
      esc(item._key) +
      '"><div class="poster-wrap">' +
      posterHtml +
      '<div class="rank-badge">#' +
      (idx + 1) +
      "</div>" +
      cornerHtml +
      '</div><div class="card-body"><div class="card-title-row"><span class="card-title">' +
      esc(item.title) +
      '</span><span class="card-year">' +
      esc(item.year) +
      "</span></div>" +
      (item.alt ? '<div class="card-orig">' + esc(item.alt) + "</div>" : "") +
      '<div class="scores-row"><span class="badge-imdb">★ ' +
      fmt1(item.score) +
      (item.votes ? ' <span class="votes">(' + fmtVotes(item.votes) + " notes)</span>" : "") +
      "</span></div>" +
      '<div class="meta-tags"><span class="kind-pill ' +
      esc(item.kind) +
      '">' +
      esc(kindLabel(item)) +
      "</span>" +
      genrePills +
      (st ? '<span class="genre-pill">' + esc(st) + "</span>" : "") +
      "</div>" +
      whoRow(item) +
      (item.overview ? '<div class="card-overview">' + esc(item.overview) + "</div>" : "") +
      "</div></article>"
    );
  }

  function renderGameCard(item, idx) {
    const m = me();
    const myStatus = statusOf(m, item);
    const posterHtml = item.cover
      ? '<img src="' + esc(item.cover) + '" alt="' + esc(item.title) + '" loading="lazy" />'
      : '<div class="poster-fallback">🎮</div>';
    let cornerHtml = "";
    if (m && myStatus !== "unwatched") {
      const cls = myStatus === "watched" ? "vu" : myStatus === "locked" ? "locked" : "catchup";
      cornerHtml = '<div class="status-corner ' + cls + '">' + esc(gameLabel(m, item)) + "</div>";
    }
    const isMuted = m && (myStatus === "watched" || myStatus === "locked") && state.status === "all";
    const genrePills = (item.genres || [])
      .slice(0, 2)
      .map((g) => '<span class="genre-pill">' + esc(g) + "</span>")
      .join("");
    return (
      '<article class="media-card ' +
      (isMuted ? "is-vu" : "") +
      '" data-action="open-modal" data-key="' +
      esc(item._key) +
      '"><div class="poster-wrap">' +
      posterHtml +
      '<div class="rank-badge">#' +
      (idx + 1) +
      "</div>" +
      cornerHtml +
      '</div><div class="card-body"><div class="card-title-row"><span class="card-title">' +
      esc(item.title) +
      '</span><span class="card-year">' +
      esc(item.year) +
      "</span></div>" +
      '<div class="card-orig">' + esc(item.developer || item.publisher || item.en) + "</div>" +
      '<div class="scores-row">' + gameScoreBadge(item) +
      (item.hours ? '<span class="badge-tmdb">⏱️ ~' + item.hours + " h</span>" : "") +
      "</div>" +
      '<div class="meta-tags">' + gpPill(item) +
      (item.leaving ? '<span class="genre-pill warn-pill">⏳ Quitte bientôt</span>' : "") +
      (isNewGame(item) ? '<span class="genre-pill new-pill">🆕 Nouveau</span>' : "") +
      genrePills +
      "</div>" +
      whoRow(item) +
      (item.overview ? '<div class="card-overview">' + esc(item.overview) + "</div>" : "") +
      "</div></article>"
    );
  }

  function renderCard(item, idx) {
    if (item.type === "game") return renderGameCard(item, idx);
    if (item.type === "manga" || item.type === "bd") return renderBookCard(item, idx);
    const posterHtml = item.poster
      ? '<img src="' + IMG_SM + esc(item.poster) + '" alt="' + esc(item.title) + '" loading="lazy" />'
      : '<div class="poster-fallback">' + (item.type === "movie" ? "🎬" : "📺") + "</div>";

    const m = me();
    const myStatus = statusOf(m, item);
    let cornerHtml = "";
    if (m) {
      if (myStatus === "watched") cornerHtml = '<div class="status-corner vu">✅ Vu</div>';
      else if (myStatus === "locked")
        cornerHtml = '<div class="status-corner locked">' + (item.type === "movie" ? "🙈" : "🔒") + " Masqué</div>";
      else if (myStatus === "catchup") {
        const p = progress(m, item);
        const todo = (item.releasedSeasons || []).filter((s) => !p.ws.has(s));
        cornerHtml = '<div class="status-corner catchup">🔄 ' + esc(seasonRangeLabel(todo) || "En cours") + "</div>";
      }
    }

    const isMuted = m && (myStatus === "watched" || myStatus === "locked") && state.status === "all";
    const targetUser = (state.status === "todoOtherOnly" && other()) ? other() : m;
    const targetStatus = statusOf(targetUser, item);
    const showUnw = item.type === "tv" && targetUser && targetStatus === "catchup";
    const displayImdb = showUnw ? unwatchedImdb(targetUser, item) : item.imdb;
    const hasDiff = showUnw && Math.abs(displayImdb - (item.imdb || 0)) > 0.05;

    const provPills = (item.providers || [])
      .map((p) => '<span class="prov-pill ' + provClass(p) + '">' + esc(p) + "</span>")
      .join("");
    let genrePills = (item.genres || [])
      .slice(0, 2)
      .map((g) => '<span class="genre-pill">' + esc(g) + "</span>")
      .join("");
    if (item.type === "tv" && (item.releasedSeasons || []).length > 0) {
      const sc = item.releasedSeasons.length;
      genrePills += '<span class="genre-pill">' + sc + (sc > 1 ? " saisons" : " saison") + "</span>";
    }

    let seasonsRow = "";
    if (item.type === "tv" && item.seasonScores) {
      const rel = item.releasedSeasons || [];
      const p = m ? progress(m, item) : null;
      let list = rel;
      if (rel.length > 6) list = rel.slice(0, 3).concat(["…"], rel.slice(-2));
      const pills = list.map((sn) => {
        if (sn === "…") return '<span class="s-pill">…</span>';
        const sc = item.seasonScores[String(sn)];
        const watched = p && p.ws.has(sn);
        let cls = "s-pill";
        if (watched) cls += " watched";
        else if (p && p.status === "catchup") cls += " todo";
        else if (sc >= 8.5) cls += " high";
        return '<span class="' + cls + '">S' + sn + (sc ? ":" + sc.toFixed(1) : "") + (watched ? "✓" : "") + "</span>";
      });
      if (pills.length) seasonsRow = '<div class="seasons-mini">' + pills.join("") + "</div>";
    }

    return (
      '<article class="media-card ' +
      (isMuted ? "is-vu" : "") +
      '" data-action="open-modal" data-key="' +
      esc(item._key) +
      '">' +
      '<div class="poster-wrap">' +
      posterHtml +
      '<div class="rank-badge">#' +
      (idx + 1) +
      "</div>" +
      cornerHtml +
      "</div>" +
      '<div class="card-body">' +
      '<div class="card-title-row"><span class="card-title">' +
      esc(item.title) +
      '</span><span class="card-year">' +
      esc(item.year) +
      "</span></div>" +
      (altTitles(item) ? '<div class="card-orig">' + esc(altTitles(item)) + "</div>" : "") +
      '<div class="scores-row"><span class="badge-imdb">' +
      (hasDiff ? "★ Restant " : "★ ") +
      fmt1(displayImdb) +
      (item.votes ? ' <span class="votes">(' + fmtVotes(item.votes) + ")</span>" : "") +
      "</span>" +
      (hasDiff ? '<span class="badge-tmdb">Global ' + fmt1(item.imdb) + "</span>" : "") +
      (item.tmdb ? '<span class="badge-tmdb">TMDB ' + fmt1(item.tmdb) + "</span>" : "") +
      "</div>" +
      '<div class="meta-tags">' +
      provPills +
      genrePills +
      "</div>" +
      whoRow(item) +
      (item.overview ? '<div class="card-overview">' + esc(item.overview) + "</div>" : "") +
      seasonsRow +
      "</div></article>"
    );
  }

  function loginHint() {
    if (!AUTH_ENABLED || loggedIn() || HH.session) return "";
    return (
      '<div class="login-hint"><span>🔑 Connecte-toi avec Google pour voir et cocher tes vus (et ceux de ton/ta partenaire).</span>' +
      '<button type="button" class="chip active" data-action="login">Connexion</button></div>'
    );
  }

  function renderMoviesOrSeries() {
    const list = getFilteredList(state.tab);
    const isSearching = state.q.trim().length > 0;
    const limit = state.showAllLimit || isSearching ? list.length : 50;
    const visible = list.slice(0, limit);

    let html = loginHint();

    if (state.tab === "games") {
      if (!(GAMES.games || []).length) {
        elMainContent.innerHTML =
          html +
          '<div class="empty-state"><div class="emoji">🎮</div><div>Le catalogue Game Pass n\'est pas encore généré (<code>games.json</code>).</div></div>';
        return;
      }
      const t = GP_RANK[state.gameTier] ? state.gameTier : "";
      const extra =
        state.gameTier === "buy"
          ? " · <strong>hors Game Pass</strong> : jouables en cloud une fois achetés (heures de cloud payantes sans abonnement)"
          : state.gameTier === "free"
          ? " · <strong>free-to-play</strong> : jouables en cloud sans acheter le jeu"
          : "";
      html +=
        '<div class="ref-banner" data-action="games-info">☁️ Catalogue <strong>' +
        (extra ? "Xbox Cloud Gaming" : "Game Pass jouable en cloud") +
        "</strong> · marché " +
        esc(GAMES.market || "PL") +
        (GAMES.generatedAt ? " · màj du " + esc(fmtDateFr(GAMES.generatedAt)) : "") +
        (extra ||
          (t
            ? " · <strong>" + esc(GP_LABEL[t]) + "</strong> : " + GP_CLOUD_HOURS[t] + " h de cloud par mois"
            : " · cloud limité à 5 h / 10 h / 15 h par mois")) +
        ' <span class="ref-more">Infos →</span></div>';
      const cov = steamCoverage();
      if (cov.total && cov.done < cov.total) {
        html +=
          '<div class="ref-banner">⏳ Notes Steam en cours de récupération : ' + cov.done + " / " + cov.total +
          " jeux vérifiés. Le reste arrive au fil des exports de nuit (Steam limite le rythme des requêtes).</div>";
      }
    } else if (state.tab === "reading" && state.shelf === "bd") {
      if (!(BD.bd || []).length) {
        elMainContent.innerHTML =
          html +
          '<div class="empty-state"><div class="emoji">📚</div><div>Le classement BD &amp; comics n\'est pas encore généré (<code>bd.json</code>).</div></div>';
        return;
      }
      html +=
        '<div class="ref-banner" data-action="bd-sources">🏆 Référentiel critiques mis à jour le <strong>' +
        esc(fmtDateFr(BD.referentialUpdatedAt)) +
        "</strong> · prix d'Angoulême, Eisner, ACBD, palmarès de presse" +
        (BD.generatedAt && (BD.bd || []).some((x) => x.hcRating) ? " · notes Hardcover du " + esc(fmtDateFr(BD.generatedAt)) : "") +
        ' <span class="ref-more">Sources →</span></div>';
    } else if (state.tab === "reading") {
      const m = me();
      if (m && !m.anilistLinked) {
        html +=
          '<div class="login-hint"><span>📚 Relie ton compte AniList pour cocher tes mangas et webtoons lus (ils sont enregistrés sur AniList).</span>' +
          '<button type="button" class="chip active" data-action="link-anilist">Relier AniList</button></div>';
      }
      if (!(BOOKS.manga || []).length) {
        elMainContent.innerHTML =
          html +
          '<div class="empty-state"><div class="emoji">📚</div><div>Le classement des mangas &amp; webtoons n\'est pas encore généré (<code>books.json</code>).</div></div>';
        return;
      }
    }

    if (state.tab === "series" && loggedIn() && !isSearching && state.status !== "catchup") {
      const catchups = catchupList(me());
      if (catchups.length > 0) {
        const names = catchups
          .slice(0, 6)
          .map((s) => {
            const p = progress(me(), s);
            const todo = (s.releasedSeasons || []).filter((x) => !p.ws.has(x));
            return s.title + (todo.length ? " " + seasonRangeLabel(todo) : "");
          })
          .join(" · ");
        html +=
          '<div class="catchup-banner" data-action="go-catchup"><div class="catchup-banner-text">🔄 <strong>' +
          catchups.length +
          " séries commencées :</strong> " +
          esc(names) +
          '</div><div class="catchup-banner-arrow">Voir →</div></div>';
      }
    }

    if (state.tab === "reading" && loggedIn() && !isSearching && state.status !== "catchup") {
      const ongoingReads = readingSource().filter((it) => statusOf(me(), it) === "catchup");
      if (ongoingReads.length > 0) {
        const names = ongoingReads
          .slice(0, 6)
          .map((it) => {
            const lbl = readingLabel(me(), it).replace(/^📖\s*/, "");
            return it.title + (lbl && lbl !== "En cours" ? " (" + lbl + ")" : "");
          })
          .join(" · ");
        html +=
          '<div class="catchup-banner" data-action="set-status" data-val="catchup"><div class="catchup-banner-text">📖 <strong>' +
          ongoingReads.length +
          (ongoingReads.length > 1 ? " lectures en cours :" : " lecture en cours :") +
          "</strong> " +
          esc(names) +
          '</div><div class="catchup-banner-arrow">Filtrer →</div></div>';
      }
    }

    html +=
      '<div class="results-meta"><span>' +
      (visible.length < list.length
        ? "Affichage du <strong>Top " + visible.length + "</strong> sur " + list.length + " résultats"
        : "<strong>" + list.length + "</strong> " + (list.length > 1 ? "titres trouvés" : "titre trouvé")) +
      "</span><span>Touche une fiche pour les détails</span></div>";

    if (visible.length === 0) {
      html +=
        '<div class="empty-state"><div class="emoji">🔎</div><div>Aucun résultat avec ces filtres.</div>' +
        '<button type="button" class="btn-load-more" data-action="reset-filters" style="margin-top:12px">Réinitialiser les filtres</button></div>';
      elMainContent.innerHTML = html;
      return;
    }

    html += '<div class="cards-grid">' + visible.map((it, i) => renderCard(it, i)).join("") + "</div>";
    if (visible.length < list.length) {
      html +=
        '<button type="button" class="btn-load-more" data-action="expand-limit">Afficher les ' +
        list.length +
        " titres correspondants</button>";
    }
    elMainContent.innerHTML = html;
  }

  function epRow(user, series, ep, opts) {
    const watched = isEpWatched(user, series, ep[0], ep[1]);
    const tier = epTier(ep[2]);
    const code = "S" + pad2(ep[0]) + "E" + pad2(ep[1]);
    const epUrl = ep[4] ? "https://www.imdb.com/title/" + ep[4] + "/" : series.imdbUrl;
    const canToggle = opts.toggle && user && user === me() && series.seasonMode !== "tmdb_single_split";
    return (
      '<div class="ep-row ' +
      (watched ? "ep-watched" : "") +
      '"><div class="ep-left">' +
      (canToggle
        ? '<button type="button" class="ep-check ' +
          (watched ? "on" : "") +
          '" data-action="toggle-ep" data-key="' +
          esc(series._key) +
          '" data-s="' +
          ep[0] +
          '" data-e="' +
          ep[1] +
          '" aria-label="Marquer vu">✓</button>'
        : "") +
      (opts.rank ? '<span style="font-size:11.5px;color:var(--text-muted);min-width:24px">#' + opts.rank + "</span>" : "") +
      '<span class="ep-code">' +
      code +
      '</span><span class="ep-name">' +
      esc(ep[5] || "Épisode " + ep[1]) +
      (watched && !canToggle ? " ✓" : "") +
      '</span></div><div class="ep-right"><span class="ep-score ' +
      tier.cls +
      '">' +
      tier.icon +
      " " +
      ep[2].toFixed(1) +
      '</span><span class="ep-votes">' +
      fmtVotes(ep[3]) +
      '</span><a class="ep-link" href="' +
      esc(epUrl) +
      '" target="_blank" rel="noopener" aria-label="Fiche IMDb">↗</a></div></div>'
    );
  }

  function renderCatchupTab() {
    if (!loggedIn()) {
      elMainContent.innerHTML =
        loginHint() +
        '<div class="empty-state"><div class="emoji">🔄</div><div>Connecte-toi pour voir les séries que tu as commencées.</div></div>';
      return;
    }
    const o = other();
    const who = state.catchupWho === "other" && o ? o : me();
    const catchups = catchupList(who);

    let html = "";
    if (o) {
      html +=
        '<div class="chip-scroll" style="margin-bottom:10px">' +
        chip("catchup-who", "me", "🙋 Mes séries en cours (" + catchupList(me()).length + ")", who === me()) +
        chip("catchup-who", "other", "💁 Celles de " + esc(o.name) + " (" + catchupList(o).length + ")", who === o) +
        "</div>";
    }

    if (!catchups.length) {
      elMainContent.innerHTML =
        html + '<div class="empty-state"><div class="emoji">🎉</div><div>Aucune saison en retard pour le moment !</div></div>';
      return;
    }

    html +=
      '<div class="results-meta"><span><strong>' +
      catchups.length +
      " séries commencées</strong> par " +
      esc(who.name) +
      "</span><span>Triées par note des saisons restantes</span></div><div class=\"catchup-list\">";

    catchups.forEach((s) => {
      const p = progress(who, s);
      const posterHtml = s.poster
        ? '<img src="' + IMG_SM + esc(s.poster) + '" alt="' + esc(s.title) + '" loading="lazy" />'
        : '<div class="poster-fallback">📺</div>';
      const seasonPills = (s.releasedSeasons || [])
        .map((sn) => {
          const sc = (s.seasonScores || {})[String(sn)];
          const isW = p.ws.has(sn);
          return (
            '<span class="s-pill ' + (isW ? "watched" : "todo") + '">S' + sn + (sc ? " · " + sc.toFixed(1) : "") + (isW ? " ✓" : " 🆕") + "</span>"
          );
        })
        .join("");
      const unwatchedEps = (s.episodes || [])
        .filter((ep) => !isEpWatched(who, s, ep[0], ep[1]))
        .sort((a, b) => b[2] - a[2] || b[3] - a[3]);
      let epsHtml = "";
      if (unwatchedEps.length) {
        epsHtml +=
          '<div class="catchup-eps-box"><div class="catchup-eps-title"><span>🔥 Meilleurs épisodes restants (' +
          unwatchedEps.length +
          ' à voir)</span><button type="button" class="btn-reset" data-action="jump-episodes" data-id="' +
          s.id +
          '">Tout voir →</button></div><div class="ep-list">' +
          unwatchedEps
            .slice(0, 5)
            .map((ep) => epRow(who, s, ep, { toggle: true }))
            .join("") +
          "</div></div>";
      }
      const provPills = (s.providers || [])
        .map((pp) => '<span class="prov-pill ' + provClass(pp) + '">' + esc(pp) + "</span>")
        .join("");
      html +=
        '<section class="catchup-card"><div class="catchup-top" data-action="open-modal" data-key="' +
        esc(s._key) +
        '"><div class="poster-wrap">' +
        posterHtml +
        '</div><div class="card-body"><div class="card-title-row"><span class="card-title">' +
        esc(s.title) +
        '</span><span class="card-year">' +
        esc(s.year) +
        '</span></div><div class="scores-row"><span class="badge-imdb">★ Restant ' +
        fmt1(unwatchedImdb(who, s)) +
        '</span><span class="badge-tmdb">Global IMDb ' +
        fmt1(s.imdb) +
        " (" +
        fmtVotes(s.votes) +
        ')</span></div><div class="meta-tags">' +
        provPills +
        "</div>" +
        whoRow(s) +
        '<div class="seasons-mini" style="margin-top:4px">' +
        seasonPills +
        "</div></div></div>" +
        epsHtml +
        "</section>";
    });
    html += "</div>";
    elMainContent.innerHTML = html;
  }

  function renderEpisodesTab() {
    const seriesWithEps = (DATA.series || []).filter((s) => s.episodes && s.episodes.length > 0);
    if (!seriesWithEps.length) {
      elMainContent.innerHTML = '<div class="empty-state">Aucune donnée d\'épisode disponible.</div>';
      return;
    }
    const m = me();
    const current = seriesWithEps.find((s) => s.id === state.epSeriesId) || seriesWithEps[0];
    state.epSeriesId = current.id;

    const quickIds = [60625, 42009, 105248, 86831, 2316, 1668, 60622, 1400, 61222, 117648, 1408];
    const quickShows = quickIds.map((id) => seriesWithEps.find((s) => s.id === id)).filter(Boolean);
    if (m) {
      catchupList(m).forEach((s) => {
        if (s.episodes && s.episodes.length && !quickShows.some((q) => q.id === s.id)) quickShows.unshift(s);
      });
    }

    let html = loginHint() + '<div class="ep-selector-box">';
    html +=
      '<div class="adv-label-row"><span>Séries à épisodes indépendants / Sitcoms / En cours</span><div class="scroll-arrows"><button type="button" class="btn-scroll-arrow" data-scroll-dir="-1" title="Défiler à gauche">‹</button><button type="button" class="btn-scroll-arrow" data-scroll-dir="1" title="Défiler à droite">›</button></div></div><div class="chip-scroll">';
    quickShows.forEach((s) => {
      const inProgress = m && statusOf(m, s) === "catchup";
      html +=
        '<button type="button" class="chip ' +
        (s.id === current.id ? "active" : "") +
        '" data-action="pick-ep-series" data-id="' +
        s.id +
        '">' +
        (inProgress ? "🔄 " : "") +
        esc(s.title) +
        "</button>";
    });
    html += '</div><div class="ep-select-row"><select class="series-select" id="epSeriesSelect">';
    seriesWithEps
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title, "fr"))
      .forEach((s) => {
        html +=
          '<option value="' +
          s.id +
          '" ' +
          (s.id === current.id ? "selected" : "") +
          ">" +
          esc(s.title) +
          " (" +
          s.episodes.length +
          " ép. · ★ " +
          fmt1(s.imdb) +
          ")</option>";
      });
    html +=
      '</select><button type="button" class="chip" data-action="open-modal" data-key="' +
      esc(current._key) +
      '">Fiche série ↗</button></div>';

    const p = m ? progress(m, current) : null;
    html += '<div class="chip-scroll chip-mobile-wrap">';
    if (m) {
      html += chip("ep-filter", "unwatched", "À voir", state.epFilter === "unwatched");
      html += chip("ep-filter", "all", "Tous (" + current.episodes.length + ")", state.epFilter === "all");
      html += '<span class="chip-sep"></span>';
    }
    html += chip("ep-sort", "rating", "🔥 Par note IMDb", state.epSort === "rating");
    html += chip("ep-sort", "chrono", "📅 Ordre saisons", state.epSort === "chrono");
    html += '<span class="chip-sep"></span>';
    [
      [0, "Tous scores"],
      [8.5, "🔥 8.5+"],
      [8.0, "⭐ 8.0+"]
    ].forEach(([sc, lbl]) => (html += chip("ep-minscore", sc, lbl, state.epMinScore === sc)));
    html += "</div>";

    if ((current.releasedSeasons || []).length > 1) {
      html +=
        '<div class="adv-label-row" style="margin:8px 0 3px"><span>Saisons</span><div class="scroll-arrows"><button type="button" class="btn-scroll-arrow" data-scroll-dir="-1" title="Défiler à gauche">‹</button><button type="button" class="btn-scroll-arrow" data-scroll-dir="1" title="Défiler à droite">›</button></div></div>';
      html += '<div class="chip-scroll chip-mobile-wrap">' + chip("ep-season", "all", "Toutes saisons", state.epSeason === "all");
      current.releasedSeasons.forEach((sn) => {
        const sc = (current.seasonScores || {})[String(sn)];
        html += chip(
          "ep-season",
          sn,
          "S" + sn + (sc ? " (" + sc.toFixed(1) + ")" : "") + (p && p.ws.has(sn) ? " ✓" : ""),
          String(state.epSeason) === String(sn)
        );
      });
      html += "</div>";
    }
    html += "</div>";

    const qNorm = norm(state.q.trim());
    const filterUnw = m && state.epFilter === "unwatched";
    const eps = (current.episodes || []).filter((ep) => {
      if (filterUnw && isEpWatched(m, current, ep[0], ep[1])) return false;
      if (state.epSeason !== "all" && Number(state.epSeason) !== ep[0]) return false;
      if (state.epMinScore > 0 && ep[2] < state.epMinScore) return false;
      if (qNorm) {
        const hay = "s" + ep[0] + "e" + ep[1] + " s" + pad2(ep[0]) + "e" + pad2(ep[1]) + " " + norm(ep[5] || "");
        if (!hay.includes(qNorm)) return false;
      }
      return true;
    });
    if (state.epSort === "rating") eps.sort((a, b) => b[2] - a[2] || b[3] - a[3]);
    else eps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    html +=
      '<div class="results-meta"><span><strong>' +
      eps.length +
      "</strong> " +
      (eps.length > 1 ? "épisodes" : "épisode") +
      " pour <strong>" +
      esc(current.title) +
      "</strong></span><span>" +
      (m ? "✓ = marquer vu · ↗ = IMDb" : "↗ = fiche IMDb") +
      "</span></div>";

    if (!eps.length) {
      const allWatched = filterUnw && !hasUnwatchedEpisodes(m, current);
      html +=
        '<div class="empty-state"><div class="emoji">📺</div><div>' +
        (allWatched ? "Tous les épisodes sont marqués vus ✅." : "Aucun épisode ne correspond à ces filtres.") +
        "</div>" +
        (filterUnw
          ? '<button type="button" class="btn-load-more" data-action="ep-filter" data-val="all" style="margin-top:12px">Voir tous les épisodes</button>'
          : "") +
        "</div>";
    } else {
      html +=
        '<div class="ep-list">' +
        eps
          .slice(0, 250)
          .map((ep, i) => epRow(m, current, ep, { toggle: true, rank: state.epSort === "rating" ? i + 1 : 0 }))
          .join("") +
        "</div>";
    }

    elMainContent.innerHTML = html;
    const sel = document.getElementById("epSeriesSelect");
    if (sel) {
      sel.addEventListener("change", () => {
        state.epSeriesId = Number(sel.value);
        state.epSeason = "all";
        renderEpisodesTab();
      });
    }
  }

  function renderAll() {
    updateBadges();
    renderToolbar();
    renderAccountButton();
    if (state.tab === "movies" || state.tab === "series" || state.tab === "reading" || state.tab === "games") renderMoviesOrSeries();
    else if (state.tab === "catchup") renderCatchupTab();
    else renderEpisodesTab();
  }

  /* ---------------- Fiche détail / compte ---------------- */

  function openModal(key, fromRandom) {
    if (key !== "__account__" && key !== "__bdsources__" && key !== "__gamesinfo__" && !ITEM_MAP.get(key)) return;
    const item = ITEM_MAP.get(key);
    state.modalKey = key;
    state.modalFromRandom = Boolean(fromRandom);
    state.modalSeasonFilter = "all";
    state.modalEpSort = "rating";
    state.modalEpFilter = item && item.type === "tv" && me() && hasUnwatchedEpisodes(me(), item) ? "unwatched" : "all";
    state.modalEpShowAll = false;

    renderModalContent();
    elModalSheet.scrollTop = 0;
    elModalBackdrop.classList.add("open");
    document.body.classList.add("modal-open");
    if (!history.state || !history.state.modal) history.pushState({ modal: true }, "");
  }

  function closeModal(fromPopState) {
    if (!elModalBackdrop.classList.contains("open")) return;
    elModalBackdrop.classList.remove("open");
    document.body.classList.remove("modal-open");
    state.modalKey = null;
    if (!fromPopState && history.state && history.state.modal) history.back();
  }

  function renderAccountSheet() {
    const m = me();
    const o = other();
    let html = '<div class="sheet-handle"></div><div class="sheet-top"><div class="sheet-info" style="padding-right:34px">';
    html += '<div class="sheet-title">👤 ' + esc(m ? m.name : "Compte") + "</div>";
    html += '<div class="card-orig" style="white-space:normal">' + esc(HH.session && HH.session.user ? HH.session.user.email : "") + "</div>";
    html += '</div><button type="button" class="sheet-close" data-action="close-modal" aria-label="Fermer">✕</button></div>';
    if (m) {
      html +=
        '<div class="sheet-section"><div class="sheet-section-title"><span>Foyer</span></div><p class="sheet-overview">' +
        HH.users
          .map(
            (u) =>
              "<strong>" +
              esc(u.name) +
              "</strong> : " +
              u.movies.size +
              " films vus · " +
              DATA.series.filter((s) => isFinished(u, s)).length +
              " séries finies · " +
              catchupList(u).length +
              " en cours · " +
              (u.anilistLinked
                ? [...(u.manga || new Map()).values()].filter((x) => x[0] === "read").length + " mangas lus"
                : "AniList non relié") +
              " · " +
              [...(u.bd || new Map()).values()].filter((x) => x[0] === "read").length +
              " BD lues · " +
              [...(u.games || new Map()).values()].filter((x) => x === "played").length +
              " jeux joués"
          )
          .join("<br/>") +
        "</p></div>";
    }
    html += '<div class="sheet-actions">';
    html += '<button type="button" class="btn-action" data-action="refresh-state">🔄 Resynchroniser TMDB</button>';
    html +=
      '<button type="button" class="btn-action" data-action="link-tmdb">' +
      (m && m.tmdbLinked ? "🔗 Changer de compte TMDB" : "🔗 Relier mon compte TMDB") +
      "</button>";
    html +=
      '<button type="button" class="btn-action" data-action="link-anilist">' +
      (m && m.anilistLinked ? "📚 Changer de compte AniList (" + esc(m.anilistName) + ")" : "📚 Relier mon compte AniList") +
      "</button>";
    if (m && m.anilistLinked) {
      html += '<button type="button" class="btn-action" data-action="unlink-anilist">📚 Délier AniList</button>';
    }
    html += '<button type="button" class="btn-action" data-action="logout">🚪 Se déconnecter</button>';
    html += "</div>";
    if (o) {
      html +=
        '<p class="sheet-overview" style="margin-top:14px;font-size:12.5px;color:var(--text-muted)">Tu peux voir les vus de ' +
        esc(o.name) +
        " mais seuls les tiens sont modifiables. Films et séries sont enregistrés sur ton compte TMDB, mangas et webtoons sur ton compte AniList.</p>";
    }
    elModalSheet.innerHTML = html;
  }

  function renderTrackingSection(item) {
    const m = me();
    if (!m) {
      return AUTH_ENABLED
        ? '<div class="sheet-section"><button type="button" class="btn-toggle" data-action="login" style="width:100%">🔑 Connexion Google pour cocher « vu »</button></div>'
        : "";
    }
    const o = other();
    const k = esc(item._key);
    let html = '<div class="sheet-section"><div class="sheet-section-title"><span>Mon suivi (' + esc(m.name) + ")</span>";
    if (o) html += whoPill(o, item);
    html += "</div>";

    if (item.type === "movie") {
      const seen = m.movies.has(item.id);
      const hidden = Boolean(m.hidden && m.hidden.has(item.id));
      html +=
        '<div class="toggle-row"><button type="button" class="btn-toggle ' +
        (seen ? "on" : "") +
        '" data-action="toggle-movie" data-key="' +
        k +
        '">' +
        (seen ? "✅ Vu — toucher pour annuler" : "👁️ Marquer comme vu") +
        "</button>" +
        '<button type="button" class="btn-toggle warn ' +
        (hidden ? "on" : "") +
        '" data-action="toggle-hide-movie" data-key="' +
        k +
        '">' +
        (hidden ? "🙉 Ne plus masquer" : "🙈 Masquer (pas prévu de le voir)") +
        "</button></div></div>";
      return html;
    }

    const p = progress(m, item);
    const rel = item.releasedSeasons || [];
    const allSeen = p.status === "watched";
    const locked = p.status === "locked";
    html += '<div class="toggle-row">';
    html +=
      '<button type="button" class="btn-toggle ' +
      (allSeen || locked ? "on" : "") +
      '" data-action="toggle-series" data-key="' +
      k +
      '">' +
      (allSeen || locked ? "✅ Tout vu — tout démarquer" : "👁️ Tout marquer vu") +
      "</button>";
    html +=
      '<button type="button" class="btn-toggle warn ' +
      (locked ? "on" : "") +
      '" data-action="toggle-lock" data-key="' +
      k +
      '">' +
      (locked ? "🔓 Ne plus masquer" : "🔒 Masquer (manga lu, abandon…)") +
      "</button></div>";

    if (rel.length) {
      const op = o ? progress(o, item) : null;
      html +=
        '<div class="adv-label-row" style="margin:12px 0 6px"><span>Saisons — touche pour cocher / décocher</span><div class="scroll-arrows"><button type="button" class="btn-scroll-arrow" data-scroll-dir="-1" title="Défiler à gauche">‹</button><button type="button" class="btn-scroll-arrow" data-scroll-dir="1" title="Défiler à droite">›</button></div></div>';
      html += '<div class="chip-scroll chip-mobile-wrap">';
      rel.forEach((sn) => {
        const sc = (item.seasonScores || {})[String(sn)];
        const on = p.ws.has(sn);
        const partial = !on && [...p.we].some((x) => x.startsWith(sn + ":"));
        html +=
          '<button type="button" class="season-toggle ' +
          (on ? "on" : partial ? "partial" : "") +
          '" data-action="toggle-season" data-key="' +
          k +
          '" data-s="' +
          sn +
          '">' +
          (on ? "✓ " : "") +
          "S" +
          sn +
          "<small>" +
          (sc ? "★ " + sc.toFixed(1) : "") +
          (op && op.ws.has(sn) ? " · " + esc(o.name.charAt(0)) + "✓" : "") +
          "</small></button>";
      });
      html += "</div>";
    }
    html += "</div>";
    return html;
  }

  function renderMangaTracking(item) {
    const m = me();
    if (!m) {
      return AUTH_ENABLED
        ? '<div class="sheet-section"><button type="button" class="btn-toggle" data-action="login" style="width:100%">🔑 Connexion Google pour cocher « lu »</button></div>'
        : "";
    }
    const o = other();
    let html = '<div class="sheet-section"><div class="sheet-section-title"><span>Ma lecture (' + esc(m.name) + ")</span>";
    if (o) html += whoPill(o, item);
    html += "</div>";
    if (!m.anilistLinked) {
      html +=
        '<p class="sheet-overview" style="font-size:12.5px;color:var(--text-muted)">Tes lectures sont enregistrées sur ton compte AniList.</p>' +
        '<button type="button" class="btn-toggle" data-action="link-anilist" style="width:100%">🔗 Relier mon compte AniList</button></div>';
      return html;
    }
    const e = mangaEntry(m, item);
    const st = e ? e[0] : null;
    const k = esc(item._key);
    html +=
      '<div class="toggle-row">' +
      '<button type="button" class="btn-toggle ' + (st === "read" ? "on" : "") + '" data-action="manga-set" data-st="read" data-key="' + k + '">' +
      (st === "read" ? "✅ Lu — toucher pour annuler" : "✅ Tout lu") +
      "</button>" +
      '<button type="button" class="btn-toggle ' + (st === "reading" ? "on" : "") + '" data-action="manga-set" data-st="reading" data-key="' + k + '">' +
      (st === "reading" ? "📖 En cours — annuler" : "📖 En cours") +
      "</button>" +
      '<button type="button" class="btn-toggle warn ' + (st === "hidden" ? "on" : "") + '" data-action="manga-set" data-st="hidden" data-key="' + k + '">' +
      (st === "hidden" ? "🙉 Ne plus masquer" : "🙈 Masquer (pas pour moi)") +
      "</button></div>";
    if (st === "reading") {
      html +=
        '<div class="tome-row"><span>Lu jusqu\'au tome</span><input type="number" min="0" inputmode="numeric" class="tome-input" id="tomeInput" value="' +
        (e[1] || "") +
        '" placeholder="–" />' +
        (item.volumes ? "<span>/ " + item.volumes + "</span>" : "") +
        '<button type="button" class="chip active" data-action="manga-tome" data-key="' + k + '">Enregistrer</button></div>';
    }
    html += "</div>";
    return html;
  }

  function renderBdTracking(item) {
    const m = me();
    if (!m) {
      return AUTH_ENABLED
        ? '<div class="sheet-section"><button type="button" class="btn-toggle" data-action="login" style="width:100%">🔑 Connexion Google pour cocher « lu »</button></div>'
        : "";
    }
    const o = other();
    let html = '<div class="sheet-section"><div class="sheet-section-title"><span>Ma lecture (' + esc(m.name) + ")</span>";
    if (o) html += whoPill(o, item);
    html += "</div>";
    const e = bdEntry(m, item);
    const st = e ? e[0] : null;
    const k = esc(item._key);
    html += '<div class="toggle-row">';
    html +=
      '<button type="button" class="btn-toggle ' + (st === "read" ? "on" : "") + '" data-action="bd-set" data-st="read" data-key="' + k + '">' +
      (st === "read" ? "✅ Lu — toucher pour annuler" : item.mode === "oneshot" ? "✅ Lu" : "✅ Tout lu") +
      "</button>";
    if (item.mode === "series") {
      html +=
        '<button type="button" class="btn-toggle ' + (st === "reading" ? "on" : "") + '" data-action="bd-set" data-st="reading" data-key="' + k + '">' +
        (st === "reading" ? "📖 En cours — annuler" : "📖 En cours") +
        "</button>";
    }
    html +=
      '<button type="button" class="btn-toggle warn ' + (st === "hidden" ? "on" : "") + '" data-action="bd-set" data-st="hidden" data-key="' + k + '">' +
      (st === "hidden" ? "🙉 Ne plus masquer" : "🙈 Masquer (pas pour moi)") +
      "</button></div>";
    if (item.mode === "series" && st === "reading") {
      html +=
        '<div class="tome-row"><span>Lu jusqu\'au tome</span><input type="number" min="0" inputmode="numeric" class="tome-input" id="tomeInput" value="' +
        (e[1] || "") +
        '" placeholder="–" />' +
        (item.volumes ? "<span>/ " + item.volumes + "</span>" : "") +
        '<button type="button" class="chip active" data-action="bd-tome" data-key="' + k + '">Enregistrer</button></div>';
    }
    if (item.mode === "albums" && st !== "hidden") {
      const n = bdAlbumCount(item);
      const done = new Set(st === "read" ? Array.from({ length: n }, (_, i) => i) : (e && e[2]) || []);
      if (n) {
        html +=
          '<div class="sheet-section-title" style="margin-top:12px"><span>Albums lus (' + done.size + "/" + n + ")</span></div>" +
          '<div class="album-list">';
        for (let i = 0; i < n; i++) {
          const name = (item.albums && item.albums[i]) || "Album " + (i + 1);
          html +=
            '<button type="button" class="album-row ' + (done.has(i) ? "on" : "") + '" data-action="bd-album" data-idx="' + i + '" data-key="' + k + '">' +
            '<span class="album-check">' + (done.has(i) ? "✅" : "⬜") + "</span>" +
            '<span class="album-num">' + (i + 1) + "</span><span>" + esc(name) + "</span></button>";
        }
        html += "</div>";
      }
    }
    html += "</div>";
    return html;
  }

  function renderBdModal(item) {
    const posterHtml = item.cover
      ? '<img src="' + esc(item.cover) + '" alt="' + esc(item.title) + '" />'
      : '<div class="poster-fallback">' + (item.kind === "comics" ? "🦸" : "📖") + "</div>";
    let html = '<div class="sheet-handle"></div>';
    if (state.modalFromRandom) {
      html +=
        '<div class="random-bar"><span>🎲 Tiré au sort dans ta sélection</span>' +
        '<button type="button" class="btn-random" data-action="reroll-random" style="padding:4px 10px;font-size:12px">🎲 Relancer</button></div>';
    }
    html += '<div class="sheet-top"><div class="sheet-poster">' + posterHtml + "</div>";
    html += '<button type="button" class="sheet-close" data-action="close-modal" aria-label="Fermer">✕</button>';
    html += '<div class="sheet-info"><div class="sheet-title">' + esc(item.title) + "</div>";
    html += '<div class="card-orig" style="white-space:normal">' + esc(item.authors) + "</div>";
    html +=
      '<div class="scores-row" style="margin-top:2px"><span class="tier-pill ' + esc(item.tier) + '">' + esc(TIER_LABEL[item.tier] || "") + " · " + ptsLabel(item.score) + "</span>" +
      (item.hcRating ? '<span class="badge-tmdb">★ ' + fmt1(item.hcRating) + "/5 Hardcover" + (item.votes ? " (" + fmtVotes(item.votes) + ")" : "") + "</span>" : "") +
      '<span class="card-year">' + esc(item.year) + "</span></div>";
    html +=
      '<div class="meta-tags"><span class="kind-pill ' + esc(item.kind) + '">' + esc(bdKindLabel(item)) + "</span>" +
      '<span class="genre-pill">' + esc(bdModeLabel(item)) + "</span>" +
      (item.genres || []).map((g) => '<span class="genre-pill">' + esc(g) + "</span>").join("") +
      "</div>";
    html += whoRow(item);
    html += "</div></div>";
    if (item.hcUrl) {
      html += '<div class="sheet-actions"><a class="btn-action" href="' + esc(item.hcUrl) + '" target="_blank" rel="noopener">📚 Hardcover</a></div>';
    }
    html += renderBdTracking(item);
    const srcs = BD.sources || {};
    html += '<div class="sheet-section"><div class="sheet-section-title"><span>Pourquoi ce score</span></div><ul class="cite-list">';
    const seen = {};
    (item.cites || []).forEach((c) => {
      const src = srcs[c.src] || {};
      seen[c.src] = (seen[c.src] || 0) + 1;
      const pts = seen[c.src] > 2 ? 0 : src.points || 0;
      html +=
        "<li>" +
        (src.url ? '<a href="' + esc(src.url) + '" target="_blank" rel="noopener">' + esc(citeLabel(c)) + "</a>" : esc(citeLabel(c))) +
        ' <span class="cite-pts">+' + pts + "</span>" + (seen[c.src] > 2 ? ' <span class="cite-line" style="display:inline">(plafond : 2 par source)</span>' : "") + "</li>";
    });
    if (item.bonus) {
      html += "<li>Note des lecteurs Hardcover " + fmt1(item.hcRating) + '/5 <span class="cite-pts">+' + item.bonus + "</span></li>";
    }
    html += "</ul></div>";
    if (item.overview) {
      html +=
        '<div class="sheet-section"><div class="sheet-section-title"><span>Résumé (Hardcover)</span></div><p class="sheet-overview" style="white-space:pre-line">' +
        esc(item.overview) +
        "</p></div>";
    }
    elModalSheet.innerHTML = html;
  }

  function renderBdSources() {
    const srcs = BD.sources || {};
    let html = '<div class="sheet-handle"></div><div class="sheet-top"><div class="sheet-info"><div class="sheet-title">🏆 Référentiel BD &amp; comics</div>';
    html += '<div class="card-orig" style="white-space:normal">Mis à jour le ' + esc(fmtDateFr(BD.referentialUpdatedAt)) + " · " + (BD.bd || []).length + " titres</div></div>";
    html += '<button type="button" class="sheet-close" data-action="close-modal" aria-label="Fermer">✕</button></div>';
    html +=
      '<div class="sheet-section"><p class="sheet-overview">Aucun site de notes BD fiable n\'a d\'API ouverte. Ce classement repose donc sur un référentiel figé : les prix et palmarès ci-dessous, relevés à la main et rafraîchis de temps en temps. Chaque citation rapporte des points (une même source compte au plus 2 fois par titre) ; la note des lecteurs Hardcover ajoute jusqu\'à 2 points. Paliers : Chef-d\'œuvre dès 8 points, Incontournable dès 4.</p><ul class="cite-list">';
    Object.values(srcs).forEach((src) => {
      html +=
        "<li>" + (src.url ? '<a href="' + esc(src.url) + '" target="_blank" rel="noopener">' + esc(src.label) + "</a>" : esc(src.label)) +
        ' <span class="cite-pts">+' + src.points + "</span></li>";
    });
    html += "</ul></div>";
    elModalSheet.innerHTML = html;
  }

  function doSetBd(item, status, volume, albums) {
    const u = me();
    if (!u) {
      toast("Connecte-toi pour cocher tes lectures", true);
      return;
    }
    const vol = Math.max(0, Math.floor(Number(volume) || 0));
    let alb = [...new Set((albums || []).map((x) => Math.floor(Number(x))))].filter((x) => x >= 0).sort((a, b) => a - b);
    if (status === "reading" && item.mode === "albums" && bdAlbumCount(item) && alb.length >= bdAlbumCount(item)) {
      status = "read";
      alb = [];
    }
    if (status === "reading" && item.mode === "albums" && !alb.length) status = null;
    if (status) u.bd.set(item.id, [status, vol, alb]);
    else u.bd.delete(item.id);
    saveCache();
    renderAll();
    if (state.modalKey) renderModalContent();

    HH.pending++;
    renderAccountButton();
    writeQueue = writeQueue
      .then(() => callFn("POST", { action: "set_bd", id: item.id, status: status || null, volume: vol, albums: alb }))
      .then((res) => {
        HH.pending--;
        if (HH.pending === 0 && res && res.user) {
          HH.users = HH.users.map((x) =>
            x.email === String(res.user.email || "").toLowerCase() ? normalizeUser(res.user, x) : x
          );
          saveCache();
          renderAll();
          if (state.modalKey) renderModalContent();
        } else {
          renderAccountButton();
        }
      })
      .catch((err) => {
        HH.pending--;
        toast("⚠️ Échec de l'enregistrement : " + err.message, true);
        if (HH.pending === 0) refreshState(true);
      });
  }

  function renderMangaModal(item) {
    const posterHtml = item.cover
      ? '<img src="' + esc(item.cover) + '" alt="' + esc(item.title) + '" />'
      : '<div class="poster-fallback">📚</div>';
    const genrePills = (item.genres || []).map((g) => '<span class="genre-pill">' + esc(g) + "</span>").join("");
    const st = bookStatusLabel(item);
    let html = '<div class="sheet-handle"></div>';
    if (state.modalFromRandom) {
      html +=
        '<div class="random-bar"><span>🎲 Tiré au sort dans ta sélection</span>' +
        '<button type="button" class="btn-random" data-action="reroll-random" style="padding:4px 10px;font-size:12px">🎲 Relancer</button></div>';
    }
    html += '<div class="sheet-top"><div class="sheet-poster">' + posterHtml + "</div>";
    html += '<button type="button" class="sheet-close" data-action="close-modal" aria-label="Fermer">✕</button>';
    html += '<div class="sheet-info"><div class="sheet-title">' + esc(item.title) + "</div>";
    if (item.alt) html += '<div class="card-orig" style="white-space:normal">' + esc(item.alt) + "</div>";
    html +=
      '<div class="scores-row" style="margin-top:2px"><span class="badge-imdb">★ ' +
      fmt1(item.score) +
      ' <span class="votes">(' +
      fmtVotes(item.votes) +
      " notes)</span></span>" +
      '<span class="badge-tmdb">' +
      fmtVotes(item.members) +
      ' lecteurs</span><span class="card-year">' +
      esc(item.year) +
      "</span></div>";
    html +=
      '<div class="meta-tags"><span class="kind-pill ' + esc(item.kind) + '">' + esc(kindLabel(item)) + "</span>" +
      (st ? '<span class="genre-pill">' + esc(st) + "</span>" : "") +
      "</div>";
    html += '<div class="meta-tags">' + genrePills + "</div>";
    html += whoRow(item);
    html += "</div></div>";
    html += '<div class="sheet-actions"><a class="btn-action" href="' + esc(item.url) + '" target="_blank" rel="noopener">📚 AniList</a></div>';
    html += renderMangaTracking(item);
    if (item.overview) {
      html +=
        '<div class="sheet-section"><div class="sheet-section-title"><span>Synopsis (EN)</span></div><p class="sheet-overview" style="white-space:pre-line">' +
        esc(item.overview) +
        "</p></div>";
    }
    elModalSheet.innerHTML = html;
  }

  function renderGameTracking(item) {
    const m = me();
    if (!m) {
      return AUTH_ENABLED
        ? '<div class="sheet-section"><button type="button" class="btn-toggle" data-action="login" style="width:100%">🔑 Connexion Google pour cocher « joué »</button></div>'
        : "";
    }
    const o = other();
    const st = gameEntry(m, item);
    const k = esc(item._key);
    let html = '<div class="sheet-section"><div class="sheet-section-title"><span>Ma partie (' + esc(m.name) + ")</span>";
    if (o) html += whoPill(o, item);
    html += '</div><div class="toggle-row">';
    html +=
      '<button type="button" class="btn-toggle ' + (st === "played" ? "on" : "") + '" data-action="game-set" data-st="played" data-key="' + k + '">' +
      (st === "played" ? "✅ Joué — annuler" : "✅ Joué / fini") +
      "</button>";
    html +=
      '<button type="button" class="btn-toggle ' + (st === "playing" ? "on" : "") + '" data-action="game-set" data-st="playing" data-key="' + k + '">' +
      (st === "playing" ? "🎮 En cours — annuler" : "🎮 En cours") +
      "</button>";
    html +=
      '<button type="button" class="btn-toggle warn ' + (st === "hidden" ? "on" : "") + '" data-action="game-set" data-st="hidden" data-key="' + k + '">' +
      (st === "hidden" ? "🙉 Ne plus masquer" : "🙈 Masquer (pas pour moi)") +
      "</button></div></div>";
    return html;
  }

  function renderGameModal(item) {
    const posterHtml = item.cover
      ? '<img src="' + esc(item.cover) + '" alt="' + esc(item.title) + '" />'
      : '<div class="poster-fallback">🎮</div>';
    let html = '<div class="sheet-handle"></div>';
    if (state.modalFromRandom) {
      html +=
        '<div class="random-bar"><span>🎲 Tiré au sort dans ta sélection</span>' +
        '<button type="button" class="btn-random" data-action="reroll-random" style="padding:4px 10px;font-size:12px">🎲 Relancer</button></div>';
    }
    html += '<div class="sheet-top"><div class="sheet-poster">' + posterHtml + "</div>";
    html += '<button type="button" class="sheet-close" data-action="close-modal" aria-label="Fermer">✕</button>';
    html += '<div class="sheet-info"><div class="sheet-title">' + esc(item.title) + "</div>";
    const by = [item.developer, item.publisher && item.publisher !== item.developer ? item.publisher : ""].filter(Boolean).join(" · ");
    if (item.en || by) html += '<div class="card-orig" style="white-space:normal">' + esc([item.en, by].filter(Boolean).join(" — ")) + "</div>";
    html += '<div class="scores-row" style="margin-top:2px">' + gameScoreBadge(item, true);
    if (item.scoreSrc !== "presse" && item.press) html += '<span class="badge-tmdb">📰 ' + Math.round(item.press) + "/100 presse</span>";
    if (item.scoreSrc !== "xbox" && item.xboxVotes >= 20) html += '<span class="badge-tmdb">★ ' + fmt1(item.xboxRating) + "/5 Xbox</span>";
    html += '<span class="card-year">' + esc(item.year) + "</span></div>";
    html +=
      '<div class="meta-tags">' + gpPill(item) +
      (item.hours ? '<span class="genre-pill">⏱️ ~' + item.hours + " h pour le finir</span>" : "") +
      (item.leaving ? '<span class="genre-pill warn-pill">⏳ Quitte bientôt le Game Pass</span>' : "") +
      (isNewGame(item) ? '<span class="genre-pill new-pill">🆕 Ajouté le ' + esc(fmtDateFr(item.addedAt)) + "</span>" : "") +
      (item.genres || []).map((g) => '<span class="genre-pill">' + esc(g) + "</span>").join("") +
      "</div>";
    html += whoRow(item);
    html += "</div></div>";
    const slug = gameSlug(item);
    html += '<div class="sheet-actions">';
    html +=
      '<a class="btn-action primary" href="https://www.xbox.com/fr-FR/play/games/' + esc(slug) + "/" + esc(item.id) +
      '" target="_blank" rel="noopener">☁️ Jouer en cloud</a>';
    html +=
      '<a class="btn-action" href="https://www.xbox.com/fr-FR/games/store/' + esc(slug) + "/" + esc(item.id) +
      '" target="_blank" rel="noopener">🛒 Fiche Xbox</a>';
    if (item.steam && item.steam.appid) {
      html +=
        '<a class="btn-action" href="https://store.steampowered.com/app/' + esc(item.steam.appid) +
        '/#app_reviews_hash" target="_blank" rel="noopener">💬 Avis Steam</a>';
    }
    if (item.igdbSlug) {
      html += '<a class="btn-action" href="https://www.igdb.com/games/' + esc(item.igdbSlug) + '" target="_blank" rel="noopener">📰 IGDB</a>';
    }
    html += "</div>";
    html += renderGameTracking(item);
    if (item.overview) {
      html +=
        '<div class="sheet-section"><div class="sheet-section-title"><span>Résumé</span></div><p class="sheet-overview">' +
        esc(item.overview) +
        "</p></div>";
    }
    elModalSheet.innerHTML = html;
  }

  function renderGamesInfo() {
    const counts = GP_TIERS.map(([t, lbl]) => {
      const n = (GAMES.games || []).filter((g) => isGamePass(g) && GP_RANK[g.tier] <= GP_RANK[t]).length;
      return "<li><strong>" + esc(lbl) + "</strong> : " + n + " jeux · " + GP_CLOUD_HOURS[t] + " h de cloud par mois</li>";
    }).join("") +
      "<li><strong>🆓 Gratuits</strong> : " + (GAMES.games || []).filter((g) => g.tier === "free").length +
      " jeux free-to-play jouables en cloud</li>" +
      "<li><strong>🛒 À acheter</strong> : " + (GAMES.games || []).filter((g) => g.tier === "buy").length +
      " jeux jouables en cloud une fois achetés (hors Game Pass)</li>";
    let html = '<div class="sheet-handle"></div><div class="sheet-top"><div class="sheet-info"><div class="sheet-title">☁️ Game Pass en cloud</div>';
    html +=
      '<div class="card-orig" style="white-space:normal">Marché ' + esc(GAMES.market || "PL") +
      (GAMES.generatedAt ? " · mis à jour le " + esc(fmtDateFr(GAMES.generatedAt)) : "") + "</div></div>";
    html += '<button type="button" class="sheet-close" data-action="close-modal" aria-label="Fermer">✕</button></div>';
    html +=
      '<div class="sheet-section"><div class="sheet-section-title"><span>Ce que donne chaque offre</span></div><ul class="cite-list">' +
      counts +
      "</ul><p class=\"sheet-overview\" style=\"margin-top:8px\">Chaque jeu affiche l'offre la moins chère qui l'inclut (Essential ⊂ Premium ⊂ Ultimate). Depuis novembre 2026, Xbox plafonne le cloud par mois ; des packs d'heures sont vendus au-delà.</p></div>";
    html +=
      '<div class="sheet-section"><div class="sheet-section-title"><span>Sources</span></div><ul class="cite-list">' +
      "<li>Catalogue : listes publiques de xbox.com/play (jeux cloud du marché " + esc(GAMES.market || "PL") + ", celui de ton VPN), rafraîchies chaque nuit.</li>" +
      "<li>Note : % d'avis positifs Steam (classement pondéré par le nombre d'avis, façon SteamDB). Sans version Steam : note presse IGDB, sinon note du Store Xbox.</li>" +
      (GAMES.igdb ? "<li>Durée : temps moyen pour finir le jeu (IGDB).</li>" : "<li>Durée : pas encore disponible (IGDB non configuré).</li>") +
      "</ul></div>";
    elModalSheet.innerHTML = html;
  }

  function doSetGame(item, status) {
    const u = me();
    if (!u) {
      toast("Connecte-toi pour cocher tes jeux", true);
      return;
    }
    if (!u.games) u.games = new Map();
    if (status) u.games.set(item.id, status);
    else u.games.delete(item.id);
    saveCache();
    renderAll();
    if (state.modalKey) renderModalContent();

    HH.pending++;
    renderAccountButton();
    writeQueue = writeQueue
      .then(() => callFn("POST", { action: "set_game", id: item.id, status: status || null }))
      .then((res) => {
        HH.pending--;
        if (HH.pending === 0 && res && res.user) {
          HH.users = HH.users.map((x) =>
            x.email === String(res.user.email || "").toLowerCase() ? normalizeUser(res.user, x) : x
          );
          saveCache();
          renderAll();
          if (state.modalKey) renderModalContent();
        } else {
          renderAccountButton();
        }
      })
      .catch((err) => {
        HH.pending--;
        toast("⚠️ Échec de l'enregistrement : " + err.message, true);
        if (HH.pending === 0) refreshState(true);
      });
  }

  function renderModalContent() {
    if (state.modalKey === "__account__") {
      renderAccountSheet();
      return;
    }
    if (state.modalKey === "__gamesinfo__") {
      renderGamesInfo();
      return;
    }
    if (state.modalKey === "__bdsources__") {
      renderBdSources();
      return;
    }
    const item = ITEM_MAP.get(state.modalKey);
    if (!item) return;
    if (item.type === "manga") {
      renderMangaModal(item);
      return;
    }
    if (item.type === "bd") {
      renderBdModal(item);
      return;
    }
    if (item.type === "game") {
      renderGameModal(item);
      return;
    }
    const m = me();

    const posterHtml = item.poster
      ? '<img src="' + IMG_LG + esc(item.poster) + '" alt="' + esc(item.title) + '" />'
      : '<div class="poster-fallback">' + (item.type === "movie" ? "🎬" : "📺") + "</div>";
    const provPills = (item.providers || [])
      .map((pp) => '<span class="prov-pill ' + provClass(pp) + '">' + esc(pp) + "</span>")
      .join("");
    const genrePills = (item.genres || []).map((g) => '<span class="genre-pill">' + esc(g) + "</span>").join("");

    let html = '<div class="sheet-handle"></div>';
    if (state.modalFromRandom) {
      html +=
        '<div class="random-bar"><span>🎲 Tiré au sort dans ta sélection</span>' +
        '<button type="button" class="btn-random" data-action="reroll-random" style="padding:4px 10px;font-size:12px">🎲 Relancer</button></div>';
    }
    html += '<div class="sheet-top"><div class="sheet-poster">' + posterHtml + "</div>";
    html += '<button type="button" class="sheet-close" data-action="close-modal" aria-label="Fermer">✕</button>';
    html += '<div class="sheet-info"><div class="sheet-title">' + esc(item.title) + "</div>";
    if (altTitles(item)) html += '<div class="card-orig" style="white-space:normal">' + esc(altTitles(item)) + "</div>";

    const targetUser = (state.status === "todoOtherOnly" && other()) ? other() : m;
    const isCatchup = item.type === "tv" && targetUser && statusOf(targetUser, item) === "catchup";
    const remScore = isCatchup ? unwatchedImdb(targetUser, item) : null;
    const hasDiff = remScore !== null && Math.abs(remScore - (item.imdb || 0)) > 0.05;

    html +=
      '<div class="scores-row" style="margin-top:2px"><span class="badge-imdb">' +
      (hasDiff ? "★ Restant " + fmt1(remScore) : "★ " + fmt1(item.imdb)) +
      ' <span class="votes">(' +
      fmtVotes(item.votes) +
      ")</span></span>" +
      (hasDiff ? '<span class="badge-tmdb">Global IMDb ' + fmt1(item.imdb) + "</span>" : "") +
      (item.tmdb ? '<span class="badge-tmdb">TMDB ' + fmt1(item.tmdb) + "</span>" : "") +
      '<span class="card-year">' +
      esc(item.year) +
      "</span></div>";
    html += '<div class="meta-tags">' + provPills + "</div>";
    html += '<div class="meta-tags">' + genrePills + "</div>";
    html += whoRow(item);
    html += "</div></div>";

    const provLabel = (item.providers || []).join(" / ") || "Streaming";
    html += '<div class="sheet-actions">';
    if (item.watchUrl) html += '<a class="btn-action primary" href="' + esc(item.watchUrl) + '" target="_blank" rel="noopener">▶️ ' + esc(provLabel) + "</a>";
    if (item.imdbUrl) html += '<a class="btn-action imdb" href="' + esc(item.imdbUrl) + '" target="_blank" rel="noopener">⭐ IMDb</a>';
    if (item.tmdbUrl) html += '<a class="btn-action" href="' + esc(item.tmdbUrl) + '" target="_blank" rel="noopener">🎬 TMDB</a>';
    html += "</div>";

    html += renderTrackingSection(item);

    if (item.overview) {
      html +=
        '<div class="sheet-section"><div class="sheet-section-title"><span>Synopsis</span></div><p class="sheet-overview">' +
        esc(item.overview) +
        "</p></div>";
    }

    if (item.type === "tv" && item.episodes && item.episodes.length) {
      const p = m ? progress(m, item) : null;
      html +=
        '<div class="sheet-section"><div class="sheet-section-title"><span>Épisodes notés IMDb</span><div class="scroll-arrows"><button type="button" class="btn-scroll-arrow" data-scroll-dir="-1" title="Défiler à gauche">‹</button><button type="button" class="btn-scroll-arrow" data-scroll-dir="1" title="Défiler à droite">›</button></div>';
      html += '<button type="button" class="btn-reset" data-action="jump-episodes" data-id="' + item.id + '">Ouvrir dans 🎯 Épisodes →</button></div>';
      html += '<div class="chip-scroll chip-mobile-wrap">' + chip("modal-season", "all", "Toutes (" + item.releasedSeasons.length + ")", state.modalSeasonFilter === "all");
      (item.releasedSeasons || []).forEach((sn) => {
        const sc = (item.seasonScores || {})[String(sn)];
        html += chip(
          "modal-season",
          sn,
          "S" + sn + (sc ? " · " + sc.toFixed(1) : "") + (p && p.ws.has(sn) ? " ✓" : ""),
          String(state.modalSeasonFilter) === String(sn)
        );
      });
      html += '</div><div class="chip-scroll chip-mobile-wrap" style="margin-top:9px;margin-bottom:8px">';
      if (m) {
        html += chip("modal-ep-filter", "unwatched", "À voir", state.modalEpFilter === "unwatched");
        html += chip("modal-ep-filter", "all", "Tous (" + item.episodes.length + ")", state.modalEpFilter === "all");
        html += '<span class="chip-sep"></span>';
      }
      html += chip("modal-ep-sort", "rating", "🔥 Meilleurs", state.modalEpSort === "rating");
      html += chip("modal-ep-sort", "chrono", "📅 Chrono", state.modalEpSort === "chrono");
      html += "</div>";

      const mEps = item.episodes.filter((ep) => {
        if (m && state.modalEpFilter === "unwatched" && isEpWatched(m, item, ep[0], ep[1])) return false;
        if (state.modalSeasonFilter !== "all" && Number(state.modalSeasonFilter) !== ep[0]) return false;
        return true;
      });
      if (state.modalEpSort === "rating") mEps.sort((a, b) => b[2] - a[2] || b[3] - a[3]);
      else mEps.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const shown = mEps.slice(0, state.modalEpShowAll ? 300 : 15);

      if (item.seasonMode === "tmdb_single_split" && m) {
        html +=
          '<p class="sheet-overview" style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Sur TMDB cette série est en une seule saison : suivi par saison uniquement.</p>';
      }
      html += '<div class="ep-list">' + shown.map((ep) => epRow(m, item, ep, { toggle: true })).join("") + "</div>";
      if (mEps.length > shown.length) {
        html +=
          '<button type="button" class="btn-load-more" data-action="modal-ep-more" style="margin-top:10px">Afficher les ' +
          mEps.length +
          " épisodes</button>";
      }
      if (!mEps.length) {
        html += '<div class="empty-state" style="padding:20px">Tous les épisodes sont vus ✅</div>';
      }
      html += "</div>";
    }

    elModalSheet.innerHTML = html;
  }

  function pickRandom() {
    let pool;
    if (state.tab === "catchup") pool = catchupList(me());
    else if (state.tab === "episodes") pool = getFilteredList("series");
    else pool = getFilteredList(state.tab);
    if (!pool.length) return;
    const sub = pool.slice(0, state.showAllLimit ? pool.length : Math.min(pool.length, 50));
    const chosen = sub[Math.floor(Math.random() * sub.length)];
    if (chosen) openModal(chosen._key, true);
  }

  function resetFilters() {
    state.q = "";
    elSearchInput.value = "";
    elSearchClear.classList.remove("visible");
    state.status = !loggedIn() ? "all" : state.tab === "reading" ? "todoMe" : "todoBoth";
    state.providers.clear();
    state.bookKind = "all";
    state.bdAward = "all";
    state.genre = "all";
    state.preset = "none";
    state.sort = "imdb";
    state.showAllLimit = false;
    renderAll();
  }

  async function login() {
    if (!sb) return;
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: location.origin + location.pathname,
        queryParams: { prompt: "select_account" }
      }
    });
    if (error) toast("Connexion impossible : " + error.message, true);
  }

  /* ---------------- Événements ---------------- */

  elMainTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn || btn.dataset.tab === state.tab) return;
    const family = (t) => (t === "reading" ? "r" : t === "games" ? "g" : "v");
    if (family(btn.dataset.tab) !== family(state.tab)) {
      state.genre = "all";
      state.bdAward = "all";
      state.preset = "none";
      state.sort = "imdb";
      if (btn.dataset.tab === "reading" && state.status === "todoBoth") {
        state.status = "todoMe";
      } else if (
        state.tab === "reading" &&
        (state.status === "todoMe" || state.status === "recoOther" || state.status === "readOther" || state.status === "readBoth")
      ) {
        state.status = loggedIn() ? "todoBoth" : "all";
      }
    }
    state.tab = btn.dataset.tab;
    btn.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    state.advOpen = false;
    if (state.tab === "movies" && (state.preset === "miniseries" || state.preset === "episodic")) state.preset = "none";
    window.scrollTo({ top: 0, behavior: "instant" });
    renderAll();
  });

  elSearchInput.addEventListener("input", () => {
    state.q = elSearchInput.value;
    elSearchClear.classList.toggle("visible", state.q.length > 0);
    if (state.tab === "episodes") renderEpisodesTab();
    else {
      renderMoviesOrSeries();
      if (state.advOpen) renderToolbar();
    }
  });

  elSearchClear.addEventListener("click", () => {
    state.q = "";
    elSearchInput.value = "";
    elSearchClear.classList.remove("visible");
    elSearchInput.focus();
    renderAll();
  });

  elBtnAdvToggle.addEventListener("click", () => {
    state.advOpen = !state.advOpen;
    renderToolbar();
  });

  if (elAdvBackdrop) {
    elAdvBackdrop.addEventListener("click", () => {
      state.advOpen = false;
      renderToolbar();
    });
  }

  window.addEventListener(
    "scroll",
    () => {
      const y = window.scrollY;
      if (y > 48) document.body.classList.add("is-scrolled");
      else if (y < 14) document.body.classList.remove("is-scrolled");
    },
    { passive: true }
  );

  elBtnRandom.addEventListener("click", pickRandom);
  $("btnReload").addEventListener("click", reloadAll);
  setupPullToRefresh();
  setupChipScroller();

  elBtnAccount.addEventListener("click", () => {
    if (HH.session) openModal("__account__", false);
    else login();
  });

  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const val = target.dataset.val;
    const item = target.dataset.key ? ITEM_MAP.get(target.dataset.key) : null;

    switch (action) {
      case "toggle-adv":
        state.advOpen = !state.advOpen;
        renderToolbar();
        break;
      case "close-adv":
        state.advOpen = false;
        renderToolbar();
        break;
      case "set-status":
        state.status = val;
        state.statusTouched = true;
        renderAll();
        break;
      case "set-book-kind":
        state.bookKind = val;
        renderAll();
        break;
      case "set-bd-award":
        state.bdAward = state.bdAward === val ? "all" : val;
        renderAll();
        break;
      case "set-shelf":
        if (state.shelf === val) break;
        state.shelf = val;
        state.bookKind = "all";
        state.bdAward = "all";
        state.genre = "all";
        state.preset = "none";
        state.sort = "imdb";
        state.showAllLimit = false;
        renderAll();
        break;
      case "bd-sources":
        openModal("__bdsources__");
        break;
      case "games-info":
        openModal("__gamesinfo__");
        break;
      case "set-game-tier":
        state.gameTier = val;
        try {
          localStorage.setItem("popcorn_game_tier", val);
        } catch (_) {
          /* ignore */
        }
        renderAll();
        break;
      case "game-set": {
        if (!item) break;
        const want = target.dataset.st;
        doSetGame(item, gameEntry(me(), item) === want ? null : want);
        break;
      }
      case "bd-set": {
        if (!item) break;
        const want = target.dataset.st;
        const cur = bdEntry(me(), item);
        if (cur && cur[0] === want) doSetBd(item, null, 0, []);
        else doSetBd(item, want, want === "reading" && cur ? cur[1] : 0, []);
        break;
      }
      case "bd-tome": {
        if (!item) break;
        const inp = document.getElementById("tomeInput");
        doSetBd(item, "reading", inp ? inp.value : 0, []);
        break;
      }
      case "bd-album": {
        if (!item) break;
        const idx = Number(target.dataset.idx);
        const cur = bdEntry(me(), item);
        const n = bdAlbumCount(item);
        const done = new Set(cur && cur[0] === "read" ? Array.from({ length: n }, (_, i) => i) : (cur && cur[2]) || []);
        if (done.has(idx)) done.delete(idx);
        else done.add(idx);
        doSetBd(item, "reading", 0, [...done]);
        break;
      }
      case "link-anilist":
        startAnilistLink();
        break;
      case "unlink-anilist":
        if (!confirm("Délier ton compte AniList ? Tes lectures restent sur AniList.")) break;
        callFn("POST", { action: "anilist_unlink" })
          .then(() => refreshState(true))
          .catch((err) => toast("⚠️ " + err.message, true));
        break;
      case "manga-set": {
        if (!item) break;
        const want = target.dataset.st;
        const cur = mangaEntry(me(), item);
        if (cur && cur[0] === want) doSetManga(item, null, 0);
        else doSetManga(item, want, want === "reading" && cur ? cur[1] : 0);
        break;
      }
      case "manga-tome": {
        if (!item) break;
        const inp = document.getElementById("tomeInput");
        doSetManga(item, "reading", inp ? inp.value : 0);
        break;
      }
      case "prov-all":
        state.providers.clear();
        renderAll();
        break;
      case "prov-toggle":
        if (state.providers.has(val)) state.providers.delete(val);
        else state.providers.add(val);
        renderAll();
        break;
      case "set-sort":
        state.sort = val;
        renderAll();
        break;
      case "set-limit":
        state.showAllLimit = val === "all";
        renderAll();
        break;
      case "expand-limit":
        state.showAllLimit = true;
        renderAll();
        break;
      case "set-preset":
        state.preset = state.preset === val ? "none" : val;
        renderAll();
        break;
      case "set-genre":
        state.genre = val;
        renderAll();
        break;
      case "reset-filters":
        resetFilters();
        break;
      case "go-catchup":
        state.tab = "catchup";
        window.scrollTo({ top: 0, behavior: "instant" });
        renderAll();
        break;
      case "catchup-who":
        state.catchupWho = val;
        renderCatchupTab();
        break;
      case "open-modal":
        openModal(target.dataset.key, false);
        break;
      case "close-modal":
        closeModal(false);
        break;
      case "reroll-random":
        pickRandom();
        break;
      case "login":
        login();
        break;
      case "logout":
        closeModal(false);
        if (sb) sb.auth.signOut();
        try {
          localStorage.removeItem(CACHE_KEY);
        } catch (_) {
          /* ignore */
        }
        break;
      case "refresh-state":
        refreshState(false);
        break;
      case "link-tmdb":
        callFn("POST", { action: "tmdb_auth_url", redirectTo: location.origin + location.pathname })
          .then((res) => {
            if (res && res.url) location.href = res.url;
          })
          .catch((err) => toast("⚠️ Impossible d'initier la liaison TMDB : " + err.message, true));
        break;
      case "jump-episodes": {
        closeModal(false);
        state.tab = "episodes";
        state.epSeriesId = Number(target.dataset.id);
        state.epSeason = "all";
        window.scrollTo({ top: 0, behavior: "instant" });
        renderAll();
        break;
      }
      case "pick-ep-series":
        state.epSeriesId = Number(target.dataset.id);
        state.epSeason = "all";
        renderEpisodesTab();
        break;
      case "ep-filter":
        state.epFilter = val;
        renderEpisodesTab();
        break;
      case "ep-sort":
        state.epSort = val;
        renderEpisodesTab();
        break;
      case "ep-minscore":
        state.epMinScore = Number(val);
        renderEpisodesTab();
        break;
      case "ep-season":
        state.epSeason = val;
        renderEpisodesTab();
        break;
      case "modal-season":
        state.modalSeasonFilter = val;
        state.modalEpShowAll = false;
        renderModalContent();
        break;
      case "modal-ep-filter":
        state.modalEpFilter = val;
        state.modalEpShowAll = false;
        renderModalContent();
        break;
      case "modal-ep-sort":
        state.modalEpSort = val;
        renderModalContent();
        break;
      case "modal-ep-more":
        state.modalEpShowAll = true;
        renderModalContent();
        break;

      /* --- Écritures « vu » --- */
      case "toggle-movie":
        if (item) doSet(item, { kind: "movie", watched: !me().movies.has(item.id) });
        break;
      case "toggle-hide-movie":
        if (item) doSet(item, { kind: "hide_movie", watched: !(me().hidden && me().hidden.has(item.id)) });
        break;
      case "toggle-lock":
        if (item) doSet(item, { kind: "lock", watched: statusOf(me(), item) !== "locked" });
        break;
      case "toggle-series": {
        if (!item) break;
        const done = isFinished(me(), item);
        if (done && !confirm("Démarquer toutes les saisons de « " + item.title + " » ?")) break;
        doSet(item, { kind: done && statusOf(me(), item) === "locked" ? "lock" : "series", watched: !done });
        if (done && statusOf(me(), item) !== "unwatched") doSet(item, { kind: "series", watched: false });
        break;
      }
      case "toggle-season": {
        if (!item) break;
        const s = Number(target.dataset.s);
        doSet(item, { kind: "season", season: s, watched: !progress(me(), item).ws.has(s) });
        break;
      }
      case "toggle-ep": {
        if (!item) break;
        e.preventDefault();
        e.stopPropagation();
        const s = Number(target.dataset.s);
        const ep = Number(target.dataset.e);
        doSet(item, { kind: "episode", season: s, dataEpisode: ep, watched: !isEpWatched(me(), item, s, ep) });
        break;
      }
      default:
        break;
    }
  });

  elModalBackdrop.addEventListener("click", (e) => {
    if (e.target === elModalBackdrop) closeModal(false);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (elModalBackdrop.classList.contains("open")) closeModal(false);
      else if (state.advOpen) {
        state.advOpen = false;
        renderToolbar();
      }
    }
  });
  window.addEventListener("popstate", () => {
    if (elModalBackdrop.classList.contains("open")) closeModal(true);
  });

  init();
})();
