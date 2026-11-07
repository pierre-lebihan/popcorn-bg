-- Section Lecture : BD & comics lues (référentiel figé, pas de compte externe)
-- { "<id référentiel>": ["read"|"reading"|"hidden", tome, [albums lus]] }
alter table public.popcorn_user_state
  add column if not exists bd jsonb not null default '{}'::jsonb;
