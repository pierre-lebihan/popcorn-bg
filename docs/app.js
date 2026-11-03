(function () {
  "use strict";

  const IMG_SM = "https://image.tmdb.org/t/p/w185";
  const IMG_LG = "https://image.tmdb.org/t/p/w342";
  const EP_MARK = 8.5;
  const CACHE_KEY = "popcorn_household_v1";

  const CFG = window.POPCORN_CONFIG || {};
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

  function normalizeUser(raw) {
    const eps = new Map();
    Object.entries(raw.episodes || {}).forEach(([k, v]) => eps.set(Number(k), v));
    return {
      email: String(raw.email || "").toLowerCase(),
      name: raw.name || raw.email,
      tmdbLinked: Boolean(raw.tmdbLinked),
      movies: new Set(raw.movies || []),
      locked: new Set(raw.lockedTv || []),
      eps
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
      lockedTv: [...u.locked],
      episodes
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
        HH.users = raw.users.map(normalizeUser);
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

  function statusOf(user, item) {
    if (!user) return "unwatched";
    if (item.type === "movie") return user.movies.has(item.id) ? "watched" : "unwatched";
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
      HH.users = (res.users || []).map(normalizeUser);
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
      if (p.watched) u.movies.add(id);
      else u.movies.delete(id);
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
          const fresh = normalizeUser(res.user);
          HH.users = HH.users.map((x) => (x.email === fresh.email ? fresh : x));
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
    const dateTxt = formatGenDate(DATA.generatedAt);
    elHeaderSub.textContent =
      "Netflix · Prime · Apple TV (" + (DATA.region || "BG") + ")" + (dateTxt ? " · màj " + dateTxt : "");
    return prevGen !== DATA.generatedAt;
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

  function statusOptions() {
    if (!loggedIn()) return [["all", "Tout"]];
    const m = me();
    const o = other();
    const opts = [["todoBoth", o ? "👥 À voir ensemble" : "🍿 À voir"]];
    if (o) {
      opts.push(["todoMe", "🙋 Pas vu par moi"]);
      opts.push(["todoMeOnly", "🙋 Que moi (" + o.name + " l'a vu)"]);
      opts.push(["todoOtherOnly", "💁 Que " + o.name + " (je l'ai vu)"]);
    }
    if (state.tab === "series") opts.push(["catchup", "🔄 En cours"]);
    opts.push(["watched", "✅ Vus"]);
    if (state.tab === "series") opts.push(["locked", "🔒 Masquées"]);
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
        return !isFinished(m, item) && Boolean(o) && isFinished(o, item);
      case "todoOtherOnly":
        return Boolean(o) && !isFinished(o, item) && isFinished(m, item);
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
    if (state.preset !== "none") c++;
    if (state.sort !== "imdb") c++;
    if (state.showAllLimit) c++;
    return c;
  }

  function getFilteredList(forTab) {
    const tab = forTab || state.tab;
    const source = tab === "movies" ? DATA.movies : DATA.series;
    const qNorm = norm(state.q.trim());
    const validStatuses = statusOptions().map((o) => o[0]);
    const status = validStatuses.includes(state.status) ? state.status : validStatuses[0];

    const filtered = source.filter((item) => {
      if (!matchStatus(item, status)) return false;

      if (state.providers.size > 0 && !(item.providers || []).some((p) => state.providers.has(p))) return false;
      if (state.genre !== "all" && !(item.genres || []).includes(state.genre)) return false;

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
    const scoreOf = (x) => (tab === "series" && status === "catchup" && m ? unwatchedImdb(m, x) : x.imdb || 0);

    filtered.sort((a, b) => {
      if (state.sort === "votes") return (b.votes || 0) - (a.votes || 0) || (b.imdb || 0) - (a.imdb || 0);
      if (state.sort === "year") return Number(b.year || 0) - Number(a.year || 0) || (b.imdb || 0) - (a.imdb || 0);
      if (state.sort === "tmdb") return (b.tmdb || 0) - (a.tmdb || 0) || (b.imdb || 0) - (a.imdb || 0);
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
    document.getElementById("badgeMovies").textContent = DATA.movies.filter((x) => matchStatus(x, st)).length;
    document.getElementById("badgeSeries").textContent = DATA.series.filter((x) => matchStatus(x, st)).length;
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

  function renderToolbar() {
    if (state.tab === "catchup") {
      elMainToolbar.style.display = "none";
      return;
    }
    elMainToolbar.style.display = "flex";

    if (state.tab === "episodes") {
      elSearchInput.placeholder = "Filtrer un épisode (ex: Callister, S3E7, Cornichon…)";
      elBtnAdvToggle.style.display = "none";
      elQuickChips.style.display = "none";
      elAdvPanel.classList.remove("open");
      return;
    }

    elSearchInput.placeholder =
      state.tab === "movies" ? "Rechercher un film VF/VO, genre, année…" : "Rechercher une série VF/VO, genre, année…";
    elBtnAdvToggle.style.display = "inline-flex";
    elQuickChips.style.display = "flex";

    const advCount = getActiveAdvancedCount();
    elAdvCount.textContent = advCount > 0 ? "· " + advCount : "";
    elBtnAdvToggle.classList.toggle("active", state.advOpen || advCount > 0);
    elAdvPanel.classList.toggle("open", state.advOpen);

    const opts = statusOptions();
    const curStatus = opts.some((o) => o[0] === state.status) ? state.status : opts[0][0];
    let chipsHtml = "";
    if (opts.length > 1) {
      opts.forEach(([val, lbl]) => (chipsHtml += chip("set-status", val, esc(lbl), curStatus === val)));
      chipsHtml += '<span class="chip-sep"></span>';
    }
    chipsHtml += chip("prov-all", "", "Toutes plateformes", state.providers.size === 0);
    [
      ["Netflix", "prov-netflix", "dot-netflix"],
      ["Prime Video", "prov-prime", "dot-prime"],
      ["Apple TV", "prov-apple", "dot-apple"]
    ].forEach(([pName, cls, dotCls]) => {
      chipsHtml += chip(
        "prov-toggle",
        pName,
        '<span class="dot ' + dotCls + '"></span>' + esc(pName),
        state.providers.has(pName),
        cls
      );
    });
    elQuickChips.innerHTML = chipsHtml;

    if (!state.advOpen) return;

    const items = state.tab === "movies" ? DATA.movies : DATA.series;
    const genreCounts = {};
    items.forEach((it) => (it.genres || []).forEach((g) => (genreCounts[g] = (genreCounts[g] || 0) + 1)));
    const sortedGenres = Object.keys(genreCounts).sort((a, b) => genreCounts[b] - genreCounts[a]);

    const presets = [
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

    let advHtml = '<div class="adv-group"><div class="adv-label-row"><span>Tri &amp; Portée</span>';
    if (advCount > 0 || state.providers.size > 0) {
      advHtml += '<button type="button" class="btn-reset" data-action="reset-filters">Réinitialiser tout</button>';
    }
    advHtml += '</div><div class="chip-scroll">';
    [
      ["imdb", "⭐ Note IMDb"],
      ["votes", "🔥 Popularité (votes)"],
      ["year", "📅 Plus récents"],
      ["tmdb", "💙 Note TMDB"]
    ].forEach(([val, lbl]) => (advHtml += chip("set-sort", val, lbl, state.sort === val)));
    advHtml += '<span class="chip-sep"></span>';
    advHtml += chip("set-limit", "top50", "Top 50", !state.showAllLimit);
    advHtml += chip("set-limit", "all", "Catalogue complet (300)", state.showAllLimit);
    advHtml += "</div></div>";

    advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Sélections rapides</span></div><div class="chip-scroll">';
    presets.forEach(([val, lbl]) => (advHtml += chip("set-preset", val, lbl, state.preset === val)));
    advHtml += "</div></div>";

    advHtml += '<div class="adv-group"><div class="adv-label-row"><span>Genres</span></div><div class="chip-scroll">';
    advHtml += chip("set-genre", "all", "Tous", state.genre === "all");
    sortedGenres.forEach((g) => (advHtml += chip("set-genre", g, esc(g) + " (" + genreCounts[g] + ")", state.genre === g)));
    advHtml += "</div></div>";

    elAdvPanel.innerHTML = advHtml;
  }

  function whoPill(user, item) {
    const st = statusOf(user, item);
    let txt = "–";
    if (st === "watched") txt = "✅";
    else if (st === "locked") txt = "🔒";
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

  function renderCard(item, idx) {
    const posterHtml = item.poster
      ? '<img src="' + IMG_SM + esc(item.poster) + '" alt="' + esc(item.title) + '" loading="lazy" />'
      : '<div class="poster-fallback">' + (item.type === "movie" ? "🎬" : "📺") + "</div>";

    const m = me();
    const myStatus = statusOf(m, item);
    let cornerHtml = "";
    if (m) {
      if (myStatus === "watched") cornerHtml = '<div class="status-corner vu">✅ Vu</div>';
      else if (myStatus === "locked") cornerHtml = '<div class="status-corner locked">🔒 Masqué</div>';
      else if (myStatus === "catchup") {
        const p = progress(m, item);
        const todo = (item.releasedSeasons || []).filter((s) => !p.ws.has(s));
        cornerHtml = '<div class="status-corner catchup">🔄 ' + esc(seasonRangeLabel(todo) || "En cours") + "</div>";
      }
    }

    const isMuted = m && (myStatus === "watched" || myStatus === "locked") && state.status === "all";
    const showUnw = item.type === "tv" && m && myStatus === "catchup";
    const displayImdb = showUnw ? unwatchedImdb(m, item) : item.imdb;

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
      '<div class="scores-row"><span class="badge-imdb">★ ' +
      fmt1(displayImdb) +
      (item.votes ? ' <span class="votes">(' + fmtVotes(item.votes) + ")</span>" : "") +
      "</span>" +
      (showUnw && displayImdb !== item.imdb ? '<span class="badge-tmdb">Global ' + fmt1(item.imdb) + "</span>" : "") +
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
    const limit = state.showAllLimit || isSearching ? 300 : 50;
    const visible = list.slice(0, limit);

    let html = loginHint();

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
    html += '<div class="adv-label-row"><span>Séries à épisodes indépendants / Sitcoms / En cours</span></div><div class="chip-scroll">';
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
    html += '<div class="chip-scroll">';
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
      html += '<div class="chip-scroll">' + chip("ep-season", "all", "Toutes saisons", state.epSeason === "all");
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
    if (state.tab === "movies" || state.tab === "series") renderMoviesOrSeries();
    else if (state.tab === "catchup") renderCatchupTab();
    else renderEpisodesTab();
  }

  /* ---------------- Fiche détail / compte ---------------- */

  function openModal(key, fromRandom) {
    if (key !== "__account__" && !ITEM_MAP.get(key)) return;
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
              " en cours"
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
    html += '<button type="button" class="btn-action" data-action="logout">🚪 Se déconnecter</button>';
    html += "</div>";
    if (o) {
      html +=
        '<p class="sheet-overview" style="margin-top:14px;font-size:12.5px;color:var(--text-muted)">Tu peux voir les vus de ' +
        esc(o.name) +
        " mais seuls les tiens sont modifiables. Tout est enregistré directement sur ton compte TMDB.</p>";
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
      html +=
        '<div class="toggle-row"><button type="button" class="btn-toggle ' +
        (seen ? "on" : "") +
        '" data-action="toggle-movie" data-key="' +
        k +
        '">' +
        (seen ? "✅ Vu — toucher pour annuler" : "👁️ Marquer comme vu") +
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
      html += '<div class="adv-label-row" style="margin:12px 0 6px"><span>Saisons — touche pour cocher / décocher</span></div>';
      html += '<div class="chip-scroll">';
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

  function renderModalContent() {
    if (state.modalKey === "__account__") {
      renderAccountSheet();
      return;
    }
    const item = ITEM_MAP.get(state.modalKey);
    if (!item) return;
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
    html +=
      '<div class="scores-row" style="margin-top:2px"><span class="badge-imdb">★ ' +
      fmt1(item.imdb) +
      ' <span class="votes">(' +
      fmtVotes(item.votes) +
      ")</span></span>" +
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
      html += '<div class="sheet-section"><div class="sheet-section-title"><span>Épisodes notés IMDb</span>';
      html += '<button type="button" class="btn-reset" data-action="jump-episodes" data-id="' + item.id + '">Ouvrir dans 🎯 Épisodes →</button></div>';
      html += '<div class="chip-scroll">' + chip("modal-season", "all", "Toutes (" + item.releasedSeasons.length + ")", state.modalSeasonFilter === "all");
      (item.releasedSeasons || []).forEach((sn) => {
        const sc = (item.seasonScores || {})[String(sn)];
        html += chip(
          "modal-season",
          sn,
          "S" + sn + (sc ? " · " + sc.toFixed(1) : "") + (p && p.ws.has(sn) ? " ✓" : ""),
          String(state.modalSeasonFilter) === String(sn)
        );
      });
      html += '</div><div class="chip-scroll" style="margin-top:9px;margin-bottom:8px">';
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
    state.status = loggedIn() ? "todoBoth" : "all";
    state.providers.clear();
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
    state.tab = btn.dataset.tab;
    if (state.tab === "movies" && (state.preset === "miniseries" || state.preset === "episodic")) state.preset = "none";
    window.scrollTo({ top: 0, behavior: "instant" });
    renderAll();
  });

  elSearchInput.addEventListener("input", () => {
    state.q = elSearchInput.value;
    elSearchClear.classList.toggle("visible", state.q.length > 0);
    if (state.tab === "episodes") renderEpisodesTab();
    else renderMoviesOrSeries();
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

  elBtnRandom.addEventListener("click", pickRandom);
  $("btnReload").addEventListener("click", reloadAll);
  setupPullToRefresh();

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
      case "set-status":
        state.status = val;
        state.statusTouched = true;
        renderAll();
        break;
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
    if (e.key === "Escape") closeModal(false);
  });
  window.addEventListener("popstate", () => {
    if (elModalBackdrop.classList.contains("open")) closeModal(true);
  });

  init();
})();
