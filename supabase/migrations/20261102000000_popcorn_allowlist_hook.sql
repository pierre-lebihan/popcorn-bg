-- Popcorn BG : tables d'état et de configuration du foyer + blocage strict des inscriptions hors Pierre & Vilma.

create table if not exists public.popcorn_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.popcorn_config enable row level security;

create policy "popcorn_config_service_role_only"
  on public.popcorn_config
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.popcorn_user_state (
  email text primary key,
  name text not null,
  tmdb_session_id text,
  movies integer[] not null default '{}',
  locked_tv integer[] not null default '{}',
  episodes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.popcorn_user_state enable row level security;

create policy "popcorn_user_state_service_role_only"
  on public.popcorn_user_state
  for all
  to service_role
  using (true)
  with check (true);

insert into public.popcorn_user_state (email, name)
values
  ('l.bihan.pierre@gmail.com', 'Pierre'),
  ('krstevska.vilma95@gmail.com', 'Vilma')
on conflict (email) do update set name = excluded.name;

-- Trigger BEFORE INSERT sur auth.users : bloque toute inscription ou connexion OAuth hors liste blanche
create or replace function public.enforce_popcorn_auth_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if lower(coalesce(new.email, '')) not in ('l.bihan.pierre@gmail.com', 'krstevska.vilma95@gmail.com') then
    raise exception 'Inscriptions fermées : seuls Pierre et Vilma sont autorisés.';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_popcorn_auth_allowlist() from public, anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_popcorn_auth_allowlist'
  ) then
    create trigger trg_popcorn_auth_allowlist
      before insert on auth.users
      for each row
      execute function public.enforce_popcorn_auth_allowlist();
  end if;
end $$;

-- Hook optionnel Before User Created
create or replace function public.hook_popcorn_allowlist(event jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  user_email text := lower(coalesce(event->'user'->>'email', ''));
begin
  if user_email in ('l.bihan.pierre@gmail.com', 'krstevska.vilma95@gmail.com') then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Inscriptions fermées : application privée réservée à Pierre & Vilma.'
    )
  );
end;
$$;

grant execute on function public.hook_popcorn_allowlist(jsonb) to supabase_auth_admin;
