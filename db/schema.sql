-- Long Linh: PostgreSQL schema (draft for the move off MongoDB Atlas, see the plan in memory "pg-migration-plan").
--
-- Conventions
-- - Discord snowflakes (guild, user, channel, message ids) are text: they overflow a JS number.
-- - Rows whose id is embedded in Discord buttons (war:*, ev:*, gate:*, mb:*) keep a 24-hex text id:
--   the old Mongo _id is copied as is, new rows get the same shape from the app, so buttons on old messages keep working.
-- - Everything else uses bigint identity ids.
-- - Per-guild rows reference parents through (guild_id, id) composite keys, so a row can never point at another guild's member or character.
-- - Dropped on purpose (off and empty on 2026-10-21): violations, prize draws / drafts, leave requests.
-- - Only the data the bot uses: names shown in lists come from discord_members (no per-row display name copies).

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------- guilds
create table guilds (
  id          text primary key,                 -- Discord guild id
  settings    jsonb not null default '{}',      -- the whole old GuildConfig (channels, roles, schedule, classes, features, mailBlocked ...)
  mail_seq    int not null default 0,           -- last letter number (old MailCounter)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- Discord side
create table discord_members (
  id            bigint generated always as identity primary key,
  guild_id      text not null references guilds (id) on delete cascade,
  discord_id    text not null,
  display_name  text not null default '',
  class_name    text,
  mission_pref  text not null default 'any' check (mission_pref in ('def', 'cong', 'daytru', 'vattu', 'any')), -- old mid / mobile / supply mapped to cong / daytru / vattu at migration
  tuyen_khien   boolean not null default false, -- carries the passive "Nhất Tuyến Khiên"
  tk_partners   text[] not null default '{}',   -- Discord ids picked as Tuyến Khiên partners (one-sided is enough: A-B are linked when either lists the other; max 5)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (guild_id, discord_id),
  unique (guild_id, id)
);

-- ---------------------------------------------------------------- game side
create table roster_imports (
  id           bigint generated always as identity primary key,
  guild_id     text not null references guilds (id) on delete cascade,
  imported_at  timestamptz not null default now(),
  imported_by  text not null default 'script',  -- Discord id or 'script'
  source       text not null default '',        -- file name
  total        int not null default 0
);
create index roster_imports_guild_at on roster_imports (guild_id, imported_at desc);

-- One row per in-game character. A roster import overwrites the latest values (no per-import history).
create table game_characters (
  id              bigint generated always as identity primary key,
  guild_id        text not null references guilds (id) on delete cascade,
  name            text not null,
  name_key        text not null,                -- nameKey(name): case / accent / spacing / lookalike-letter blind
  origin          text not null default 'roster' check (origin in ('roster', 'typed')), -- typed = a member typed it (selfFree) and no roster has shown it yet
  class_name      text not null default '',
  rank            text not null default '',
  days_in_guild   int not null default 0,
  status          text not null default '',     -- in-game last-seen text
  off_days        int,                          -- null = unknown
  last_import_id  bigint references roster_imports (id) on delete set null,
  position        int,                          -- order in that import (menus carry positions in the roster)
  first_seen      timestamptz not null default now(),
  left_at         timestamptz,                  -- set when a newer import no longer lists it; null = still in the guild
  returned_at     timestamptz,                  -- when an import listed it again after it had left
  old_names       text[] not null default '{}', -- earlier names, oldest first (✏️ Đổi tên confirmed by a manager)
  game_uid        text,                         -- in-game character ID, digits only (5-20); null = unknown
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (guild_id, id)
);
-- a departed character keeps its row, so a newcomer may take the same name
create unique index game_characters_active_name on game_characters (guild_id, name_key) where left_at is null;
-- an in-game ID is never shared, a departed character included (a rename moves the ID to the new row)
create unique index game_characters_uid on game_characters (guild_id, game_uid) where game_uid is not null;

-- 1 character <-> 1 Discord account (clone accounts are simply not linked).
-- Automatic name matches are not stored: they are worked out on read, as today.
create table character_links (
  character_id  bigint primary key,
  member_id     bigint not null unique,
  guild_id      text not null,
  source        text not null check (source in ('admin', 'self', 'selfFree')),
  linked_by     text,                           -- Discord id of whoever made the link
  linked_at     timestamptz not null default now(),
  foreign key (guild_id, character_id) references game_characters (guild_id, id) on delete cascade,
  foreign key (guild_id, member_id) references discord_members (guild_id, id) on delete cascade
);

-- ---------------------------------------------------------------- wars
create table war_events (
  id                char(24) primary key check (id ~ '^[0-9a-f]{24}$'),
  guild_id          text not null references guilds (id) on delete cascade,
  title             text not null,
  start_at          timestamptz not null,
  deadline_at       timestamptz not null,
  remind_at         timestamptz,
  reminded          boolean not null default false,
  status            text not null default 'open' check (status in ('open', 'locked', 'published', 'done')),
  channel_id        text,
  message_id        text,
  post_attempt_at   timestamptz,                -- claim taken before sending the war message
  manual_remind_at  timestamptz,                -- last manual "Nhắc ngay"
  auto              boolean not null default false,
  lineup_url        text,
  lineup_note       text not null default '',
  published_at      timestamptz,
  attendance_at     timestamptz,                -- when the "went for real" list of the result screen was imported; null = not yet
  attendance_source text not null default '',   -- file it came from
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (guild_id, start_at),
  unique (guild_id, id)
);
create index war_events_guild_status on war_events (guild_id, status, start_at desc);
create index war_events_due on war_events (status, deadline_at);

create table registrations (
  war_id        char(24) not null,
  member_id     bigint not null,
  guild_id      text not null,
  status        text not null check (status in ('join', 'absent')),
  class_name    text,                           -- class at click time
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (war_id, member_id),
  foreign key (guild_id, war_id) references war_events (guild_id, id) on delete cascade,
  foreign key (guild_id, member_id) references discord_members (guild_id, id) on delete cascade
);
create index registrations_member on registrations (member_id, status);

-- attendance read from the war result screen: one row per name seen (the import itself is war_events.attendance_at)
create table attendance_entries (
  war_id        char(24) not null references war_events (id) on delete cascade,
  seen_name     text not null,                  -- as transcribed from the screen
  character_id  bigint references game_characters (id) on delete set null, -- null = not found in the roster
  member_id     bigint references discord_members (id) on delete set null, -- Discord member at import time; null = none found
  how           text not null default 'none' check (how in ('link', 'auto', 'none')),
  stats         jsonb,                          -- optional screen numbers { diem, ha, chet, ... }
  primary key (war_id, seen_name)
);
create index attendance_entries_character on attendance_entries (character_id);

-- ---------------------------------------------------------------- guild events
create table guild_events (
  id                     char(24) primary key check (id ~ '^[0-9a-f]{24}$'),
  guild_id               text not null references guilds (id) on delete cascade,
  title                  varchar(100) not null,
  description            varchar(4000) not null default '',
  category               text not null,
  start_at               timestamptz not null,
  end_at                 timestamptz,
  deadline_at            timestamptz not null,
  capacity               int check (capacity >= 1),       -- null = unlimited; enforced by locking the event row and counting 'yes'
  min_participants       int check (min_participants >= 1),
  min_notice_at          timestamptz,
  allow_maybe            boolean not null default true,
  remind_before_minutes  int not null default 60 check (remind_before_minutes >= 0),
  channel_id             text,
  message_id             text,
  status                 text not null default 'open' check (status in ('open', 'locked', 'cancelled', 'done')),
  created_by             text,
  reminded_at            timestamptz,
  manual_remind_at       timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (guild_id, id)
);
create index guild_events_guild_status on guild_events (guild_id, status, start_at);
create index guild_events_due on guild_events (status, deadline_at);

create table event_replies (
  event_id      char(24) not null,
  member_id     bigint not null,
  guild_id      text not null,
  status        text not null check (status in ('yes', 'maybe', 'no')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (event_id, member_id),
  foreign key (guild_id, event_id) references guild_events (guild_id, id) on delete cascade,
  foreign key (guild_id, member_id) references discord_members (guild_id, id) on delete cascade
);

-- ---------------------------------------------------------------- gate (join requests)
create table gate_requests (
  id                char(24) primary key check (id ~ '^[0-9a-f]{24}$'),
  guild_id          text not null,
  member_id         bigint not null,            -- a stranger gets a discord_members row when asking
  character_id      bigint references game_characters (id) on delete set null, -- picked from the roster; null = typed by hand
  game_name         text not null,              -- the name as asked (kept even when character_id is set)
  game_name_free    boolean not null default false,
  class_name        text not null default '',
  game_uid          text,                       -- optional in-game ID typed by the applicant
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'guest', 'cancelled', 'revoked')),
  decided_by        text,
  decided_at        timestamptz,
  reason            varchar(500) not null default '',
  admin_channel_id  text,
  admin_message_id  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (guild_id, member_id) references discord_members (guild_id, id) on delete cascade
);
create unique index gate_requests_one_pending on gate_requests (guild_id, member_id) where status = 'pending';
-- a pending request reserves its in-game ID: two applicants cannot ask with the same one
create unique index gate_requests_pending_uid on gate_requests (guild_id, game_uid) where status = 'pending' and game_uid is not null;
create index gate_requests_guild_status on gate_requests (guild_id, status, created_at desc);

-- ---------------------------------------------------------------- mailbox (kept although empty)
create table mail_letters (
  id                char(24) primary key check (id ~ '^[0-9a-f]{24}$'),
  guild_id          text not null references guilds (id) on delete cascade,
  no                int not null,               -- sequential per guild (guilds.mail_seq)
  category          text not null,
  title             varchar(100) not null default '',
  content           varchar(1000) not null,
  anonymous         boolean not null,
  sender_enc        text,                       -- RSA-OAEP of { discordId, at }; never selected by normal reads
  sender_id         text,                       -- named letters only; plain text on purpose, not a member FK
  code_hash         text not null,              -- SHA-256 of the code the sender keeps
  status            text not null default 'new' check (status in ('new', 'seen', 'done')),
  inbox_channel_id  text,
  inbox_message_id  text,
  replies           jsonb not null default '[]', -- [{ by, text, at }] answers of the managers
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (guild_id, no),
  unique (guild_id, code_hash),
  check (not anonymous or sender_id is null)
);

-- ---------------------------------------------------------------- updated_at triggers
do $$
declare t text;
begin
  foreach t in array array['guilds', 'discord_members', 'game_characters', 'war_events', 'registrations',
                           'guild_events', 'event_replies', 'gate_requests', 'mail_letters'] loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()', t || '_updated_at', t);
  end loop;
end $$;
