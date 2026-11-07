-- Section Lecture : les mangas / webtoons lus sont stockés sur le compte AniList de chacun.
-- On ne garde ici que le jeton OAuth AniList (valable 1 an, sans renouvellement) et l'identifiant du compte.
alter table public.popcorn_user_state
  add column if not exists anilist_token text,
  add column if not exists anilist_user_id integer,
  add column if not exists anilist_name text;
