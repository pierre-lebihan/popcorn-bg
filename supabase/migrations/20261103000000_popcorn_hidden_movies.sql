-- Films masqués (« pas prévu de le voir ») : stockés uniquement dans Supabase pour ne pas polluer les notes TMDB.
alter table public.popcorn_user_state
  add column if not exists hidden_movies integer[] not null default '{}';
