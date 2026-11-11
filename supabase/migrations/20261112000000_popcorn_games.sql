-- Section Jeux (Game Pass cloud) : jeux joués / en cours / masqués, par ProductId Microsoft
-- { "<productId>": "played"|"playing"|"hidden" }
alter table public.popcorn_user_state
  add column if not exists games jsonb not null default '{}'::jsonb;
