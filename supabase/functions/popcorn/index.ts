// Edge Function « popcorn » : passerelle sécurisée entre la web-app GitHub Pages, Supabase et TMDB.
//
// - Vérifie le JWT Supabase (connexion Google) et n'autorise que Pierre (l.bihan.pierre@gmail.com)
//   et Vilma (krstevska.vilma95@gmail.com).
// - Si l'utilisateur a un session_id TMDB (Pierre via TMDB_SESSION_ID, et Vilma dès que son compte TMDB
//   est relié), lit et écrit directement sur TMDB (et met en cache dans public.popcorn_user_state).
// - Si l'utilisateur n'a pas encore de session_id TMDB (Vilma par défaut : 0 vu au départ), lit et écrit
//   dans public.popcorn_user_state, avec possibilité de relier un compte TMDB en 1 clic depuis l'app.
// - Section Lecture : les mangas / webtoons lus sont lus et écrits sur le compte AniList de chacun
//   (jeton OAuth AniList stocké dans public.popcorn_user_state, relié en 1 clic depuis l'app).
// - Section Lecture : les BD & comics lus sont stockés dans public.popcorn_user_state (colonne bd).
// - Section Jeux : les jeux Game Pass joués / en cours / masqués sont stockés dans popcorn_user_state (colonne games).

import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB = "https://api.themoviedb.org/3";
const SEASON_MARKER = 8.0;
const EPISODE_MARKER = 8.5;
const MOVIE_RATING = 8.0;

let cachedTmdbApiKey = Deno.env.get("TMDB_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED_ORIGINS = [
  "https://pierre-lebihan.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

type HouseholdMember = {
  email: string;
  name: string;
  sessionId: string;
  anilistToken: string;
  anilistUserId: number | null;
  anilistName: string;
};

const DEFAULT_MEMBERS: { email: string; name: string; envKey: string }[] = [
  { email: "l.bihan.pierre@gmail.com", name: "Pierre", envKey: "TMDB_SESSION_ID" },
  { email: "krstevska.vilma95@gmail.com", name: "Vilma", envKey: "TMDB_SESSION_ID_VILMA" },
];

const adminSb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function loadHouseholdMembers(): Promise<HouseholdMember[]> {
  const { data: rows } = await adminSb
    .from("popcorn_user_state")
    .select("email, name, tmdb_session_id, anilist_token, anilist_user_id, anilist_name");

  const dbMap = new Map<
    string,
    { name?: string; tmdb_session_id?: string; anilist_token?: string; anilist_user_id?: number; anilist_name?: string }
  >();
  for (const r of rows ?? []) {
    if (r?.email) dbMap.set(String(r.email).toLowerCase(), r);
  }

  let customUsers: { email: string; name: string; sessionId?: string }[] = [];
  try {
    const raw = JSON.parse(Deno.env.get("POPCORN_USERS") ?? "[]");
    if (Array.isArray(raw)) customUsers = raw;
  } catch {
    /* ignore */
  }

  return DEFAULT_MEMBERS.map((m) => {
    const email = m.email.toLowerCase();
    const dbRow = dbMap.get(email);
    const custom = customUsers.find((u) => String(u?.email ?? "").toLowerCase() === email);
    const sessionId = (
      dbRow?.tmdb_session_id ||
      custom?.sessionId ||
      Deno.env.get(m.envKey) ||
      ""
    ).trim();
    return {
      email,
      name: dbRow?.name || custom?.name || m.name,
      sessionId,
      anilistToken: String(dbRow?.anilist_token ?? "").trim(),
      anilistUserId: dbRow?.anilist_user_id ? Number(dbRow.anilist_user_id) : null,
      anilistName: String(dbRow?.anilist_name ?? ""),
    };
  });
}

async function ensureTmdbApiKey(): Promise<string> {
  if (cachedTmdbApiKey) return cachedTmdbApiKey;
  const { data } = await adminSb
    .from("popcorn_config")
    .select("value")
    .eq("key", "tmdb_api_key")
    .maybeSingle();
  if (data?.value) {
    cachedTmdbApiKey = String(data.value).trim();
  }
  if (!cachedTmdbApiKey) throw new HttpError(500, "TMDB_API_KEY manquant");
  return cachedTmdbApiKey;
}

const EMAIL_ALIASES: Record<string, string> = {
  "l.bihan.pierre@gmail.com": "l.bihan.pierre@gmail.com",
  "le.bihan.pierre@gmail.com": "l.bihan.pierre@gmail.com",
  "lbihanpierre@gmail.com": "l.bihan.pierre@gmail.com",
  "naustra246@gmail.com": "l.bihan.pierre@gmail.com",
  "krstevska.vilma95@gmail.com": "krstevska.vilma95@gmail.com",
  "krstevskavilma95@gmail.com": "krstevska.vilma95@gmail.com",
};

async function authenticate(req: Request, members: HouseholdMember[]): Promise<HouseholdMember> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "Connexion requise");

  const { data, error } = await adminSb.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Session invalide ou expirée");
  const rawEmail = String(data.user.email ?? "").trim().toLowerCase();
  const canonicalEmail = EMAIL_ALIASES[rawEmail] ?? rawEmail;
  const me = members.find((u) => u.email === canonicalEmail);
  if (!me) throw new HttpError(403, `Compte ${rawEmail} non autorisé`);
  return me;
}

// ---------- TMDB API helpers ----------

async function tmdb(
  method: "GET" | "POST" | "DELETE",
  path: string,
  sessionId?: string,
  params: Record<string, string | number> = {},
  body?: unknown,
): Promise<any> {
  const apiKey = await ensureTmdbApiKey();
  const url = new URL(`${TMDB}${path}`);
  url.searchParams.set("api_key", apiKey);
  if (sessionId) url.searchParams.set("session_id", sessionId);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json;charset=utf-8" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      continue;
    }
    if (method === "DELETE" && r.status === 404) return null;
    if (!r.ok) {
      const txt = await r.text();
      throw new HttpError(502, `TMDB ${method} ${path} → ${r.status} ${txt.slice(0, 160)}`);
    }
    return r.status === 204 ? null : await r.json();
  }
  throw new HttpError(503, "TMDB surchargé, réessaie dans un instant");
}

const accountIdCache = new Map<string, number>();

async function getAccountId(sessionId: string): Promise<number> {
  const cached = accountIdCache.get(sessionId);
  if (cached) return cached;
  const acc = await tmdb("GET", "/account", sessionId);
  if (!acc?.id) throw new HttpError(502, "Compte TMDB introuvable");
  accountIdCache.set(sessionId, acc.id);
  return acc.id;
}

async function fetchAllPages(path: string, sessionId: string): Promise<any[]> {
  const first = await tmdb("GET", path, sessionId, { page: 1, sort_by: "created_at.asc" });
  const total = Math.min(first?.total_pages ?? 1, 100);
  const results: any[] = [...(first?.results ?? [])];
  if (total > 1) {
    const pages = await Promise.all(
      Array.from({ length: total - 1 }, (_, i) =>
        tmdb("GET", path, sessionId, { page: i + 2, sort_by: "created_at.asc" })
      ),
    );
    for (const p of pages) results.push(...(p?.results ?? []));
  }
  return results;
}

async function getDbUserState(u: HouseholdMember) {
  const { data } = await adminSb
    .from("popcorn_user_state")
    .select("movies, locked_tv, episodes, hidden_movies, bd, games")
    .eq("email", u.email)
    .maybeSingle();

  return {
    email: u.email,
    name: u.name,
    tmdbLinked: Boolean(u.sessionId),
    movies: (data?.movies ?? []) as number[],
    hiddenMovies: (data?.hidden_movies ?? []) as number[],
    lockedTv: (data?.locked_tv ?? []) as number[],
    episodes: (data?.episodes ?? {}) as Record<string, [number, number, number][]>,
    bd: (data?.bd ?? {}) as BdState,
    games: (data?.games ?? {}) as GameState,
  };
}

async function saveDbUserState(
  u: HouseholdMember,
  state: { movies: number[]; lockedTv: number[]; episodes: Record<string, [number, number, number][]> },
) {
  await adminSb.from("popcorn_user_state").upsert(
    {
      email: u.email,
      name: u.name,
      movies: state.movies,
      locked_tv: state.lockedTv,
      episodes: state.episodes,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "email" },
  );
}

async function getUserState(u: HouseholdMember) {
  if (!u.sessionId) {
    return await getDbUserState(u);
  }
  const accountId = await getAccountId(u.sessionId);
  const [movies, tv, episodes] = await Promise.all([
    fetchAllPages(`/account/${accountId}/rated/movies`, u.sessionId),
    fetchAllPages(`/account/${accountId}/rated/tv`, u.sessionId),
    fetchAllPages(`/account/${accountId}/rated/tv/episodes`, u.sessionId),
  ]);
  const eps: Record<string, [number, number, number][]> = {};
  for (const e of episodes) {
    if (!e?.show_id || e.season_number == null || e.episode_number == null) continue;
    (eps[e.show_id] ??= []).push([e.season_number, e.episode_number, Number(e.rating ?? SEASON_MARKER)]);
  }
  const res = {
    email: u.email,
    name: u.name,
    tmdbLinked: true,
    movies: movies.map((m) => m.id),
    lockedTv: tv.map((t) => t.id),
    episodes: eps,
  };
  await saveDbUserState(u, res);
  const { data: hid } = await adminSb
    .from("popcorn_user_state")
    .select("hidden_movies, bd, games")
    .eq("email", u.email)
    .maybeSingle();
  return { ...res, hiddenMovies: (hid?.hidden_movies ?? []) as number[], bd: (hid?.bd ?? {}) as BdState, games: (hid?.games ?? {}) as GameState };
}

const rate = (path: string, sid: string, value: number) =>
  tmdb("POST", `${path}/rating`, sid, {}, { value });
const unrate = (path: string, sid: string) => tmdb("DELETE", `${path}/rating`, sid);

type EpState = { ep: number; rated: number | null };

async function seasonStates(tvId: number, season: number, sid: string): Promise<EpState[]> {
  const r = await tmdb("GET", `/tv/${tvId}/season/${season}/account_states`, sid);
  return (r?.results ?? [])
    .map((x: any) => ({
      ep: Number(x.episode_number),
      rated: x.rated && typeof x.rated === "object" ? Number(x.rated.value) : null,
    }))
    .filter((x: EpState) => Number.isFinite(x.ep))
    .sort((a: EpState, b: EpState) => a.ep - b.ep);
}

const isEpisodeMarker = (v: number | null) => v !== null && Math.abs(v - EPISODE_MARKER) <= 0.01;

async function isLocked(tvId: number, sid: string): Promise<boolean> {
  const r = await tmdb("GET", `/tv/${tvId}/account_states`, sid);
  return Boolean(r?.rated);
}

async function markSeason(tvId: number, season: number, mode: string, sid: string) {
  if (mode === "tmdb_single_split") {
    await rate(`/tv/${tvId}/season/1/episode/${season}`, sid, SEASON_MARKER);
    return;
  }
  const states = await seasonStates(tvId, season, sid);
  if (!states.length) throw new HttpError(404, `Saison ${season} introuvable sur TMDB`);
  const first = states[0].ep;
  await rate(`/tv/${tvId}/season/${season}/episode/${first}`, sid, SEASON_MARKER);
  await Promise.all(
    states
      .filter((s) => s.ep !== first && s.rated !== null)
      .map((s) => unrate(`/tv/${tvId}/season/${season}/episode/${s.ep}`, sid)),
  );
}

async function unmarkSeason(tvId: number, season: number, mode: string, sid: string) {
  if (mode === "tmdb_single_split") {
    await unrate(`/tv/${tvId}/season/1/episode/${season}`, sid);
    return;
  }
  const states = await seasonStates(tvId, season, sid);
  await Promise.all(
    states
      .filter((s) => s.rated !== null)
      .map((s) => unrate(`/tv/${tvId}/season/${season}/episode/${s.ep}`, sid)),
  );
}

async function unlockIntoSeasons(tvId: number, seasons: number[], mode: string, sid: string) {
  if (!(await isLocked(tvId, sid))) return;
  for (const s of seasons) await markSeason(tvId, s, mode, sid);
  await unrate(`/tv/${tvId}`, sid);
}

async function setEpisode(
  tvId: number,
  season: number,
  ep: number,
  watched: boolean,
  sid: string,
) {
  const states = await seasonStates(tvId, season, sid);
  const seasonMarked = states.some((s) => s.rated !== null && !isEpisodeMarker(s.rated));

  if (watched) {
    if (seasonMarked) return;
    await rate(`/tv/${tvId}/season/${season}/episode/${ep}`, sid, EPISODE_MARKER);
    return;
  }

  if (seasonMarked) {
    await Promise.all(
      states
        .filter((s) => s.rated !== null && !isEpisodeMarker(s.rated))
        .map((s) => unrate(`/tv/${tvId}/season/${season}/episode/${s.ep}`, sid)),
    );
    await Promise.all(
      states
        .filter((s) => s.ep !== ep)
        .map((s) => rate(`/tv/${tvId}/season/${season}/episode/${s.ep}`, sid, EPISODE_MARKER)),
    );
    return;
  }
  await unrate(`/tv/${tvId}/season/${season}/episode/${ep}`, sid);
}

type SetPayload = {
  action: "set";
  kind: "movie" | "hide_movie" | "series" | "season" | "episode" | "lock";
  id: number;
  watched: boolean;
  season?: number;
  episode?: number;
  mode?: string;
  seasons?: number[];
};

async function applySetTmdb(p: SetPayload, sid: string) {
  const id = Number(p.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id invalide");
  const mode = p.mode === "tmdb_single_split" ? "tmdb_single_split" : "tmdb_seasons";
  const seasons = (p.seasons ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 1).slice(0, 60);

  switch (p.kind) {
    case "movie":
      return p.watched ? rate(`/movie/${id}`, sid, MOVIE_RATING) : unrate(`/movie/${id}`, sid);

    case "lock":
      return p.watched ? rate(`/tv/${id}`, sid, SEASON_MARKER) : unrate(`/tv/${id}`, sid);

    case "series":
      if (p.watched) {
        for (const s of seasons) await markSeason(id, s, mode, sid);
        return unrate(`/tv/${id}`, sid);
      }
      await unrate(`/tv/${id}`, sid);
      for (const s of seasons) await unmarkSeason(id, s, mode, sid);
      return;

    case "season": {
      const s = Number(p.season);
      if (!Number.isInteger(s) || s < 1) throw new HttpError(400, "saison invalide");
      if (p.watched) {
        await markSeason(id, s, mode, sid);
        return unrate(`/tv/${id}`, sid);
      }
      await unlockIntoSeasons(id, seasons.filter((x) => x !== s), mode, sid);
      return unmarkSeason(id, s, mode, sid);
    }

    case "episode": {
      const s = Number(p.season);
      const e = Number(p.episode);
      if (!Number.isInteger(s) || s < 1 || !Number.isInteger(e) || e < 1) {
        throw new HttpError(400, "épisode invalide");
      }
      if (mode === "tmdb_single_split") throw new HttpError(400, "Suivi par épisode indisponible pour cette série");
      if (!p.watched) await unlockIntoSeasons(id, seasons, mode, sid);
      await setEpisode(id, s, e, p.watched, sid);
      if (p.watched) await unrate(`/tv/${id}`, sid);
      return;
    }
    default:
      throw new HttpError(400, "action inconnue");
  }
}

// Fallback quand l'utilisateur n'a pas encore lié de compte TMDB (ex. Vilma au départ)
async function applySetDbOnly(p: SetPayload, u: HouseholdMember) {
  const id = Number(p.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, "id invalide");
  const mode = p.mode === "tmdb_single_split" ? "tmdb_single_split" : "tmdb_seasons";
  const seasons = (p.seasons ?? []).map(Number).filter((n) => Number.isInteger(n) && n >= 1).slice(0, 60);

  const cur = await getDbUserState(u);
  const moviesSet = new Set<number>(cur.movies);
  const lockedSet = new Set<number>(cur.lockedTv);
  const epsObj: Record<string, [number, number, number][]> = { ...cur.episodes };
  const mkSeasonMarker = (s: number): [number, number, number] =>
    mode === "tmdb_single_split" ? [1, s, SEASON_MARKER] : [s, 1, SEASON_MARKER];

  if (p.kind === "hide_movie") {
    // Masquage film : uniquement en base (pas de note TMDB)
    const hidden = new Set<number>(cur.hiddenMovies);
    if (p.watched) hidden.add(id);
    else hidden.delete(id);
    await adminSb
      .from("popcorn_user_state")
      .update({ hidden_movies: [...hidden], updated_at: new Date().toISOString() })
      .eq("email", u.email);
    return;
  }

  if (p.kind === "movie") {
    if (p.watched) moviesSet.add(id);
    else moviesSet.delete(id);
  } else if (p.kind === "lock") {
    if (p.watched) lockedSet.add(id);
    else lockedSet.delete(id);
  } else if (p.kind === "series") {
    lockedSet.delete(id);
    if (p.watched) epsObj[String(id)] = seasons.map(mkSeasonMarker);
    else delete epsObj[String(id)];
  } else if (p.kind === "season") {
    const s = Number(p.season);
    const wasLocked = lockedSet.has(id);
    lockedSet.delete(id);
    let arr: [number, number, number][] = (epsObj[String(id)] ?? []).slice();
    if (!p.watched && wasLocked) {
      arr = seasons.filter((x) => x !== s).map(mkSeasonMarker);
    }
    if (mode === "tmdb_single_split") {
      arr = arr.filter(([a, b]) => !(a === 1 && b === s));
    } else {
      arr = arr.filter(([a]) => a !== s);
    }
    if (p.watched) arr.push(mkSeasonMarker(s));
    epsObj[String(id)] = arr;
  } else if (p.kind === "episode") {
    const s = Number(p.season);
    const e = Number(p.episode);
    lockedSet.delete(id);
    let arr: [number, number, number][] = (epsObj[String(id)] ?? []).slice();
    arr = arr.filter(([a, b]) => !(a === s && b === e));
    if (p.watched) arr.push([s, e, EPISODE_MARKER]);
    epsObj[String(id)] = arr;
  }

  await saveDbUserState(u, {
    movies: [...moviesSet],
    lockedTv: [...lockedSet],
    episodes: epsObj,
  });
}

// ---------- AniList (section Lecture : mangas & webtoons) ----------

const ANILIST = "https://graphql.anilist.co";

async function anilist(query: string, variables: Record<string, unknown>, token: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(ANILIST, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    const body = await r.json().catch(() => ({}));
    if (r.status === 401 || (r.status === 400 && /token|unauthori[sz]ed/i.test(JSON.stringify(body?.errors ?? "")))) {
      throw new HttpError(401, "Jeton AniList invalide ou expiré : relie à nouveau ton compte AniList");
    }
    if (!r.ok || body?.errors) {
      const msg = body?.errors?.[0]?.message ?? `HTTP ${r.status}`;
      throw new HttpError(502, `AniList : ${msg}`);
    }
    return body.data;
  }
  throw new HttpError(503, "AniList surchargé, réessaie dans un instant");
}

// Statut AniList → statut de l'app : read (lu), reading (en cours, lu jusqu'au tome N), hidden (masqué)
const ANILIST_TO_APP: Record<string, string> = {
  COMPLETED: "read",
  CURRENT: "reading",
  PAUSED: "reading",
  REPEATING: "read",
  DROPPED: "hidden",
};
const APP_TO_ANILIST: Record<string, string> = { read: "COMPLETED", reading: "CURRENT", hidden: "DROPPED" };

// { mediaId: [statut, dernier tome lu] }
type MangaState = Record<string, [string, number]>;

async function getMangaState(u: HouseholdMember): Promise<MangaState | null> {
  if (!u.anilistToken || !u.anilistUserId) return null;
  const data = await anilist(
    `query ($uid: Int) {
      MediaListCollection(userId: $uid, type: MANGA) {
        lists { entries { mediaId status progressVolumes } }
      }
    }`,
    { uid: u.anilistUserId },
    u.anilistToken,
  );
  const out: MangaState = {};
  for (const l of data?.MediaListCollection?.lists ?? []) {
    for (const e of l?.entries ?? []) {
      const st = ANILIST_TO_APP[String(e?.status)];
      if (!st || !e?.mediaId) continue;
      out[String(e.mediaId)] = [st, Number(e.progressVolumes ?? 0)];
    }
  }
  return out;
}

async function setManga(u: HouseholdMember, mediaId: number, status: string | null, volume: number) {
  if (!u.anilistToken || !u.anilistUserId) {
    throw new HttpError(400, "Relie d'abord ton compte AniList (menu compte)");
  }
  if (!status) {
    const cur = await anilist(
      `query ($uid: Int, $mid: Int) { MediaList(userId: $uid, mediaId: $mid) { id } }`,
      { uid: u.anilistUserId, mid: mediaId },
      u.anilistToken,
    ).catch((err) => {
      // AniList renvoie une erreur 404 si l'entrée n'existe pas : rien à supprimer
      if (err instanceof HttpError && /not found/i.test(err.message)) return null;
      throw err;
    });
    const entryId = cur?.MediaList?.id;
    if (entryId) {
      await anilist(`mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`, { id: entryId }, u.anilistToken);
    }
    return;
  }
  const alStatus = APP_TO_ANILIST[status];
  if (!alStatus) throw new HttpError(400, "statut invalide");
  const vars: Record<string, unknown> = { mid: mediaId, st: alStatus };
  let mutation = `mutation ($mid: Int, $st: MediaListStatus) { SaveMediaListEntry(mediaId: $mid, status: $st) { id } }`;
  if (status === "reading" && Number.isInteger(volume) && volume >= 0) {
    vars.vol = volume;
    mutation =
      `mutation ($mid: Int, $st: MediaListStatus, $vol: Int) { SaveMediaListEntry(mediaId: $mid, status: $st, progressVolumes: $vol) { id } }`;
  }
  await anilist(mutation, vars, u.anilistToken);
}

async function withManga<T extends object>(u: HouseholdMember, base: T) {
  let manga: MangaState | null = null;
  let anilistError = "";
  try {
    manga = await getMangaState(u);
  } catch (err) {
    anilistError = err instanceof Error ? err.message : String(err);
  }
  return {
    ...base,
    anilistLinked: Boolean(u.anilistToken && u.anilistUserId),
    anilistName: u.anilistName,
    manga: manga ?? {},
    anilistError,
  };
}

// ---------- BD & comics (lectures stockées dans Supabase) ----------

// { id: [statut, dernier tome lu, indices des albums lus] }
type BdState = Record<string, [string, number, number[]]>;
const BD_STATUSES = new Set(["read", "reading", "hidden"]);

async function setBd(u: HouseholdMember, id: string, status: string | null, volume: number, albums: number[]) {
  const { data } = await adminSb.from("popcorn_user_state").select("bd").eq("email", u.email).maybeSingle();
  const bd: BdState = { ...((data?.bd ?? {}) as BdState) };
  if (status) bd[id] = [status, volume, albums];
  else delete bd[id];
  await adminSb
    .from("popcorn_user_state")
    .upsert({ email: u.email, name: u.name, bd, updated_at: new Date().toISOString() }, { onConflict: "email" });
}

// ---------- Jeux Game Pass (stockés dans Supabase) ----------

// { productId: statut }
type GameState = Record<string, string>;
const GAME_STATUSES = new Set(["played", "playing", "hidden"]);

async function setGame(u: HouseholdMember, id: string, status: string | null) {
  const { data } = await adminSb.from("popcorn_user_state").select("games").eq("email", u.email).maybeSingle();
  const games: GameState = { ...((data?.games ?? {}) as GameState) };
  if (status) games[id] = status;
  else delete games[id];
  await adminSb
    .from("popcorn_user_state")
    .upsert({ email: u.email, name: u.name, games, updated_at: new Date().toISOString() }, { onConflict: "email" });
}

// ---------- Handler ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });

  try {
    await ensureTmdbApiKey();
    const members = await loadHouseholdMembers();
    const me = await authenticate(req, members);

    let payload: any = { action: "state" };
    if (req.method === "POST") payload = await req.json().catch(() => ({}));

    // 1. Générer un lien d'authentification TMDB (pour relier le compte TMDB de Vilma ou Pierre en 1 clic)
    if (payload.action === "tmdb_auth_url") {
      const redirectTo = String(payload.redirectTo || ALLOWED_ORIGINS[0]);
      const tokRes = await tmdb("GET", "/authentication/token/new");
      if (!tokRes?.request_token) throw new HttpError(502, "Impossible de créer un jeton TMDB");
      const authUrl = `https://www.themoviedb.org/authenticate/${tokRes.request_token}?redirect_to=${encodeURIComponent(redirectTo)}`;
      return json(req, { url: authUrl, requestToken: tokRes.request_token });
    }

    // 2. Finaliser la liaison du compte TMDB après approbation sur themoviedb.org
    if (payload.action === "tmdb_link_session") {
      const requestToken = String(payload.requestToken || "").trim();
      if (!requestToken) throw new HttpError(400, "requestToken manquant");
      const sesRes = await tmdb("POST", "/authentication/session/new", undefined, {}, { request_token: requestToken });
      if (!sesRes?.session_id) throw new HttpError(502, "Session TMDB refusée ou expirée");
      const newSid = String(sesRes.session_id);

      // Si l'utilisateur avait déjà coché des films/épisodes dans l'app avant de lier TMDB, on les pousse sur TMDB
      const prior = await getDbUserState(me);
      await adminSb
        .from("popcorn_user_state")
        .update({ tmdb_session_id: newSid, updated_at: new Date().toISOString() })
        .eq("email", me.email);
      me.sessionId = newSid;

      for (const mid of prior.movies) await rate(`/movie/${mid}`, newSid, MOVIE_RATING);
      for (const tid of prior.lockedTv) await rate(`/tv/${tid}`, newSid, SEASON_MARKER);
      for (const [tid, epList] of Object.entries(prior.episodes)) {
        for (const [s, e, r] of epList) {
          await rate(`/tv/${tid}/season/${s}/episode/${e}`, newSid, r);
        }
      }

      const fresh = await getUserState(me);
      return json(req, { ok: true, user: fresh });
    }

    // 2b. Relier le compte AniList (jeton obtenu par l'app via OAuth implicite AniList)
    if (payload.action === "anilist_link") {
      const token = String(payload.token || "").trim();
      if (!token || token.length > 4000) throw new HttpError(400, "jeton AniList manquant");
      const v = await anilist(`query { Viewer { id name } }`, {}, token);
      if (!v?.Viewer?.id) throw new HttpError(502, "Compte AniList introuvable");
      await adminSb
        .from("popcorn_user_state")
        .update({
          anilist_token: token,
          anilist_user_id: Number(v.Viewer.id),
          anilist_name: String(v.Viewer.name ?? ""),
          updated_at: new Date().toISOString(),
        })
        .eq("email", me.email);
      me.anilistToken = token;
      me.anilistUserId = Number(v.Viewer.id);
      me.anilistName = String(v.Viewer.name ?? "");
      return json(req, { ok: true, user: await withManga(me, await getDbUserState(me)) });
    }

    if (payload.action === "anilist_unlink") {
      await adminSb
        .from("popcorn_user_state")
        .update({ anilist_token: null, anilist_user_id: null, anilist_name: null, updated_at: new Date().toISOString() })
        .eq("email", me.email);
      me.anilistToken = "";
      me.anilistUserId = null;
      me.anilistName = "";
      return json(req, { ok: true, user: await withManga(me, await getDbUserState(me)) });
    }

    // 2c. Lecture : marquer un manga / webtoon (lu, en cours jusqu'au tome N, masqué, ou rien) sur AniList
    if (payload.action === "set_manga") {
      const mediaId = Number(payload.id);
      if (!Number.isInteger(mediaId) || mediaId <= 0) throw new HttpError(400, "id invalide");
      const status = payload.status ? String(payload.status) : null;
      await setManga(me, mediaId, status, Number(payload.volume ?? 0));
      return json(req, { ok: true, user: await withManga(me, await getDbUserState(me)) });
    }

    // 2d. Lecture : marquer une BD / un comics (lu, en cours jusqu'au tome N ou albums cochés, masqué, ou rien)
    if (payload.action === "set_bd") {
      const id = String(payload.id ?? "");
      if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new HttpError(400, "id invalide");
      const status = payload.status ? String(payload.status) : null;
      if (status && !BD_STATUSES.has(status)) throw new HttpError(400, "statut invalide");
      const volume = Math.max(0, Math.min(999, Math.floor(Number(payload.volume ?? 0)) || 0));
      const albums = (Array.isArray(payload.albums) ? payload.albums : [])
        .map((x: unknown) => Math.floor(Number(x)))
        .filter((x: number) => Number.isInteger(x) && x >= 0 && x < 500)
        .slice(0, 500);
      await setBd(me, id, status, volume, [...new Set<number>(albums)].sort((a, b) => a - b));
      const state = await getDbUserState(me);
      return json(req, { ok: true, user: { ...state, anilistLinked: Boolean(me.anilistToken && me.anilistUserId) } });
    }

    // 2e. Jeux : marquer un jeu Game Pass (joué, en cours, masqué, ou rien)
    if (payload.action === "set_game") {
      const id = String(payload.id ?? "");
      if (!/^[0-9A-Z]{8,20}$/.test(id)) throw new HttpError(400, "id invalide");
      const status = payload.status ? String(payload.status) : null;
      if (status && !GAME_STATUSES.has(status)) throw new HttpError(400, "statut invalide");
      await setGame(me, id, status);
      const state = await getDbUserState(me);
      return json(req, { ok: true, user: { ...state, anilistLinked: Boolean(me.anilistToken && me.anilistUserId) } });
    }

    // 3. Cocher / décocher un film, une série, une saison ou un épisode (ou masquer un film)
    if (payload.action === "set") {
      if (me.sessionId && payload.kind !== "hide_movie") {
        await applySetTmdb(payload as SetPayload, me.sessionId);
      }
      // Les listes « rated » de TMDB sont mises en cache côté TMDB quelques secondes/minutes :
      // relire TMDB juste après l'écriture renverrait l'ancien état (le « vu » sauterait).
      // On applique donc la même modification sur l'état en base et on renvoie celui-ci.
      await applySetDbOnly(payload as SetPayload, me);
      const state = await getDbUserState(me);
      return json(req, { ok: true, user: { ...state, anilistLinked: Boolean(me.anilistToken && me.anilistUserId) } });
    }

    // 4. Lecture de l'état complet du foyer (Pierre + Vilma)
    const states = await Promise.all(members.map(async (u) => withManga(u, await getUserState(u))));
    return json(req, { me: me.email, users: states });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    console.error(status, message);
    return json(req, { error: message }, status);
  }
});
