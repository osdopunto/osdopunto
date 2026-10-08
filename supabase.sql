-- Os do Punto · base de datos. Pegar entero en Supabase > SQL Editor > Run.
-- ANTES de ejecutar: cambia CAMBIA-ESTA-CLAVE (al final) por tu contraseña de administrador.

create extension if not exists pgcrypto with schema extensions;

create table if not exists players (
  id uuid primary key, name text not null, number int, position text, active boolean not null default true);
create table if not exists competitions (
  id uuid primary key, name text not null, teams text[] not null default '{}', sort int);
create table if not exists matches (
  id uuid primary key, competition_id uuid not null references competitions on delete cascade,
  round int, date text, venue text, home text not null, away text not null,
  home_goals int, away_goals int, voting_open boolean not null default false);
create table if not exists player_stats (
  match_id uuid references matches on delete cascade, player_id uuid references players on delete cascade,
  goals int not null default 0, assists int not null default 0, yellow int not null default 0,
  red int not null default 0, own_goals int not null default 0, primary key (match_id, player_id));
create table if not exists player_photos (
  player_id uuid primary key references players on delete cascade, data text not null);
-- Tablas privadas (nadie las lee desde la web)
create table if not exists player_pins (
  player_id uuid primary key references players on delete cascade, pin_hash text not null);
create table if not exists ratings (
  match_id uuid references matches on delete cascade, voter_id uuid references players on delete cascade,
  player_id uuid references players on delete cascade, score int not null check (score between 1 and 10),
  primary key (match_id, voter_id, player_id));
create table if not exists mvp_votes (
  match_id uuid references matches on delete cascade, voter_id uuid references players on delete cascade,
  player_id uuid references players on delete cascade, primary key (match_id, voter_id));
alter table competitions add column if not exists friendly boolean;
create table if not exists attendance (
  match_id uuid references matches on delete cascade, player_id uuid references players on delete cascade,
  status text not null check (status in ('si','no','duda')), primary key (match_id, player_id));
create table if not exists fees (
  id uuid primary key, name text not null, amount numeric not null default 0, due text, sort int);
create table if not exists fee_payments (
  fee_id uuid references fees on delete cascade, player_id uuid references players on delete cascade,
  paid numeric not null default 0, primary key (fee_id, player_id));
create table if not exists app_secrets (key text primary key, value text not null);

alter table players enable row level security;
alter table competitions enable row level security;
alter table matches enable row level security;
alter table player_stats enable row level security;
alter table player_photos enable row level security;
alter table player_pins enable row level security;
alter table ratings enable row level security;
alter table mvp_votes enable row level security;
alter table app_secrets enable row level security;
alter table fees enable row level security;
alter table attendance enable row level security;
alter table fee_payments enable row level security;

do $$ declare t text; begin
  foreach t in array array['players','competitions','matches','player_stats','player_photos','attendance'] loop
    execute format('drop policy if exists lectura on %I', t);
    execute format('create policy lectura on %I for select using (true)', t);
    execute format('grant select on %I to anon, authenticated', t);
  end loop;
end $$;

-- Resultados de las votaciones: solo visibles cuando la votación está cerrada
create or replace view match_results as
  select s.match_id, s.player_id,
    (select round(avg(r.score), 2)::float from ratings r where r.match_id = s.match_id and r.player_id = s.player_id) as avg_score,
    (select count(*)::int from mvp_votes v where v.match_id = s.match_id and v.player_id = s.player_id) as mvp_votes
  from player_stats s join matches m on m.id = s.match_id where not m.voting_open;
create or replace view match_voters as select match_id, voter_id from mvp_votes;
grant select on match_results, match_voters to anon, authenticated;

create or replace function is_admin(pw text) returns boolean language sql security definer
set search_path = public, extensions as $$
  select exists (select 1 from app_secrets where key = 'admin' and value = crypt(pw, value)) $$;

create or replace function pin_ok(pid uuid, pin text) returns boolean language sql security definer
set search_path = public, extensions as $$
  select exists (select 1 from player_pins where player_id = pid and pin_hash = crypt(pin, pin_hash)) $$;

create or replace function admin_check(pw text) returns boolean language sql security definer
set search_path = public, extensions as $$ select is_admin(pw) $$;

create or replace function admin_upsert(pw text, tbl text, rows jsonb) returns void language plpgsql security definer
set search_path = public, extensions as $$
declare cols text;
begin
  if not is_admin(pw) then raise exception 'Contraseña incorrecta'; end if;
  if tbl not in ('players','competitions','matches','fees') then raise exception 'Tabla no válida'; end if;
  select string_agg(format('%I = excluded.%I', column_name, column_name), ', ') into cols
    from information_schema.columns where table_schema = 'public' and table_name = tbl and column_name <> 'id';
  execute format('insert into %I select * from jsonb_populate_recordset(null::%I, $1) on conflict (id) do update set %s', tbl, tbl, cols) using rows;
end $$;

create or replace function admin_delete(pw text, tbl text, rid uuid) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not is_admin(pw) then raise exception 'Contraseña incorrecta'; end if;
  if tbl not in ('players','competitions','matches','fees') then raise exception 'Tabla no válida'; end if;
  execute format('delete from %I where id = $1', tbl) using rid;
end $$;

create or replace function admin_set_stats(pw text, mid uuid, rows jsonb) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not is_admin(pw) then raise exception 'Contraseña incorrecta'; end if;
  delete from player_stats where match_id = mid
    and player_id not in (select (x->>'player_id')::uuid from jsonb_array_elements(rows) x);
  insert into player_stats (match_id, player_id, goals, assists, yellow, red, own_goals)
    select mid, r.player_id, coalesce(r.goals,0), coalesce(r.assists,0), coalesce(r.yellow,0), coalesce(r.red,0), coalesce(r.own_goals,0)
    from jsonb_populate_recordset(null::player_stats, rows) r
  on conflict (match_id, player_id) do update set goals = excluded.goals, assists = excluded.assists,
    yellow = excluded.yellow, red = excluded.red, own_goals = excluded.own_goals;
end $$;

create or replace function admin_reset_pin(pw text, pid uuid) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not is_admin(pw) then raise exception 'Contraseña incorrecta'; end if;
  delete from player_pins where player_id = pid;
end $$;

create or replace function admin_set_password(pw text, newpw text) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not is_admin(pw) then raise exception 'Contraseña incorrecta'; end if;
  if length(newpw) < 6 then raise exception 'La contraseña debe tener al menos 6 caracteres'; end if;
  update app_secrets set value = crypt(newpw, gen_salt('bf')) where key = 'admin';
end $$;

-- Primera vez: el PIN que escriba el jugador queda guardado. Después, se comprueba.
create or replace function pin_login(pid uuid, pin text) returns boolean language plpgsql security definer
set search_path = public, extensions as $$
begin
  if length(pin) < 4 then raise exception 'El PIN debe tener al menos 4 cifras'; end if;
  if not exists (select 1 from players where id = pid) then raise exception 'Jugador no encontrado'; end if;
  if not exists (select 1 from player_pins where player_id = pid) then
    insert into player_pins values (pid, crypt(pin, gen_salt('bf')));
    return true;
  end if;
  return pin_ok(pid, pin);
end $$;

create or replace function set_photo(pid uuid, secret text, data text) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not (is_admin(secret) or pin_ok(pid, secret)) then raise exception 'PIN incorrecto'; end if;
  if data is null or data = '' then delete from player_photos where player_id = pid; return; end if;
  if length(data) > 300000 or data not like 'data:image/%' then raise exception 'Imagen no válida'; end if;
  insert into player_photos values (pid, data) on conflict (player_id) do update set data = excluded.data;
end $$;

create or replace function cast_vote(pid uuid, pin text, mid uuid, mvp uuid, scores jsonb) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not pin_ok(pid, pin) then raise exception 'PIN incorrecto'; end if;
  if not exists (select 1 from matches where id = mid and voting_open) then raise exception 'La votación está cerrada'; end if;
  if mvp = pid then raise exception 'No puedes votarte a ti mismo'; end if;
  if not exists (select 1 from player_stats where match_id = mid and player_id = mvp) then raise exception 'Ese jugador no jugó el partido'; end if;
  delete from ratings where match_id = mid and voter_id = pid;
  insert into ratings (match_id, voter_id, player_id, score)
    select mid, pid, k::uuid, v::int from jsonb_each_text(scores) as t(k, v)
    where k::uuid <> pid and exists (select 1 from player_stats s where s.match_id = mid and s.player_id = k::uuid);
  insert into mvp_votes values (mid, pid, mvp)
    on conflict (match_id, voter_id) do update set player_id = excluded.player_id;
end $$;

-- Convocatoria: cada jugador responde con su PIN; el administrador puede responder por cualquiera
create or replace function set_attendance(pid uuid, secret text, mid uuid, st text) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not (is_admin(secret) or pin_ok(pid, secret)) then raise exception 'PIN incorrecto'; end if;
  if st is null or st = '' then delete from attendance where match_id = mid and player_id = pid; return; end if;
  insert into attendance values (mid, pid, st) on conflict (match_id, player_id) do update set status = excluded.status;
end $$;

-- Cuotas: solo las ven los jugadores identificados con su PIN y el administrador
create or replace function get_fees(pid uuid, secret text) returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not (is_admin(secret) or (pid is not null and pin_ok(pid, secret))) then raise exception 'PIN incorrecto'; end if;
  return jsonb_build_object(
    'fees', (select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb) from fees f),
    'payments', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from fee_payments p));
end $$;

create or replace function admin_set_payment(pw text, fid uuid, pid uuid, amount numeric) returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  if not is_admin(pw) then raise exception 'Contraseña incorrecta'; end if;
  if amount <= 0 then delete from fee_payments where fee_id = fid and player_id = pid; return; end if;
  insert into fee_payments values (fid, pid, amount) on conflict (fee_id, player_id) do update set paid = excluded.paid;
end $$;

revoke execute on function is_admin(text), pin_ok(uuid, text) from public, anon, authenticated;
grant execute on function admin_check(text), admin_upsert(text, text, jsonb), admin_delete(text, text, uuid),
  admin_set_stats(text, uuid, jsonb), admin_reset_pin(text, uuid), admin_set_password(text, text),
  set_attendance(uuid, text, uuid, text), get_fees(uuid, text), admin_set_payment(text, uuid, uuid, numeric),
  pin_login(uuid, text), set_photo(uuid, text, text), cast_vote(uuid, text, uuid, uuid, jsonb) to anon, authenticated;

-- Contraseña de administrador inicial (cámbiala aquí antes de ejecutar)
insert into app_secrets values ('admin', extensions.crypt('Mosteiro_96.', extensions.gen_salt('bf')))
  on conflict (key) do nothing;
