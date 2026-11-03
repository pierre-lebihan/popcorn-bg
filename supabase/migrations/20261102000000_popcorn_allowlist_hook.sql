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

-- Trigger sur auth.users & auth.identities : bloque toute inscription ou connexion OAuth hors liste blanche
create or replace function public.enforce_popcorn_auth_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  u_email text := lower(trim(coalesce(
    nullif(new.email, ''),
    nullif(new.raw_user_meta_data->>'email', ''),
    ''
  )));
begin
  if coalesce(new.is_anonymous, false) then
    raise exception 'Inscriptions anonymes désactivées.';
  end if;

  if u_email = '' then
    return new;
  end if;

  if u_email in (
    'l.bihan.pierre@gmail.com',
    'le.bihan.pierre@gmail.com',
    'lbihanpierre@gmail.com',
    'naustra246@gmail.com',
    'krstevska.vilma95@gmail.com',
    'krstevskavilma95@gmail.com'
  ) then
    return new;
  end if;

  raise exception 'Inscriptions fermées (%) : seuls Pierre et Vilma sont autorisés.', u_email;
end;
$$;

grant execute on function public.enforce_popcorn_auth_allowlist() to supabase_auth_admin, postgres, service_role;

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

  if not exists (
    select 1 from pg_trigger where tgname = 'trg_popcorn_auth_allowlist_upd'
  ) then
    create trigger trg_popcorn_auth_allowlist_upd
      before update of email, raw_user_meta_data, is_anonymous on auth.users
      for each row
      execute function public.enforce_popcorn_auth_allowlist();
  end if;
end $$;

create or replace function public.enforce_popcorn_identity_allowlist()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  u_email text := lower(trim(coalesce(new.identity_data->>'email', '')));
begin
  if u_email = '' then
    return new;
  end if;

  if u_email in (
    'l.bihan.pierre@gmail.com',
    'le.bihan.pierre@gmail.com',
    'lbihanpierre@gmail.com',
    'naustra246@gmail.com',
    'krstevska.vilma95@gmail.com',
    'krstevskavilma95@gmail.com'
  ) then
    return new;
  end if;

  raise exception 'Inscriptions fermées (%) : seuls Pierre et Vilma sont autorisés.', u_email;
end;
$$;

grant execute on function public.enforce_popcorn_identity_allowlist() to supabase_auth_admin, postgres, service_role;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_popcorn_identity_allowlist'
  ) then
    create trigger trg_popcorn_identity_allowlist
      before insert or update on auth.identities
      for each row
      execute function public.enforce_popcorn_identity_allowlist();
  end if;
end $$;
