-- The Activity's OWN database (Neon): a snapshot of what the lineup board needs, taken by the bot when registration locks, plus
-- everything the board edits. Idempotent: the bot runs this file on every start; the Activity server only checks that it exists.
-- Nothing here references the main (Aiven) database.

create table if not exists act_guilds (
  guild_id          text primary key,
  admin_role_ids    text[] not null default '{}',   -- the configured admin roles of the bot
  manager_role_ids  text[] not null default '{}',   -- roles with Administrator / Manage Server (from the bot's guild cache)
  owner_id          text,
  classes           jsonb not null default '[]',    -- [{ name, tag, emojiId }]
  rules             jsonb not null default '{}',    -- { healerClass, tankClass }
  shape             jsonb not null default '{}',    -- { groupCount, partiesPerGroup, partySize }
  updated_at        timestamptz not null default now()
);

create table if not exists act_wars (
  war_id        char(24) primary key,
  guild_id      text not null,
  title         text not null,
  start_at      timestamptz not null,
  status        text not null,
  locked_at     timestamptz,
  snapshot_at   timestamptz not null default now(),
  link_groups   jsonb not null default '[]'         -- Tuyến Khiên groups: [[member_key]]
);
create index if not exists act_wars_guild on act_wars (guild_id, start_at desc);

-- joiners: member_key = the Discord id, or 'm:<random>' for someone a manager added by hand
create table if not exists act_members (
  war_id        char(24) not null references act_wars (war_id) on delete cascade,
  member_key    text not null,
  discord_id    text,
  name          text not null,                      -- in-game name when linked, else the Discord name
  discord_name  text not null default '',
  linked        boolean not null default false,
  class_name    text not null default '',
  role_pref     text not null default 'any',
  created_at    timestamptz not null default now(), -- when they registered (first come, first served)
  manual        boolean not null default false,
  removed       boolean not null default false,
  removed_by    text,                               -- the manager who removed them; null + removed = they left the war
  primary key (war_id, member_key)
);

create table if not exists act_lineups (
  war_id               char(24) primary key references act_wars (war_id) on delete cascade,
  guild_id             text not null,
  layout               jsonb not null,              -- { groups: [ [ [member_key x <= 6] x 5 PT ] x groupCount ] }
  version              int not null default 0,      -- optimistic concurrency: every change bumps it
  tasks                jsonb not null default '{}', -- member_key -> task key ('' = explicitly none)
  party_notes          jsonb not null default '{}', -- 'group-party' (0-based) -> note
  updated_by           text,
  updated_at           timestamptz not null default now(),
  publish_requested_at timestamptz,
  publish_requested_by text,
  published_version    int,
  published_at         timestamptz,
  publish_error        text,
  published_layout     jsonb,                       -- { layout, tasks, notes, names } exactly as posted: what "Xem PT của tôi" answers from
  claimed_at           timestamptz                  -- taken by the bot's publisher while it posts (older than 2 minutes = dead)
);

-- custom tasks (nhiệm vụ) per guild, kept across wars
create table if not exists act_tasks (
  guild_id    text not null,
  key         text not null check (key ~ '^c:[a-z0-9-]{1,30}$'),
  label       text not null,
  emoji       text not null default '',
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  primary key (guild_id, key)
);

-- added later (idempotent): the publisher records that a request's post went out before it does the rest of its bookkeeping, so a restart
-- never posts the same lineup twice
alter table act_lineups add column if not exists sent_for timestamptz;      -- the publish_requested_at whose post was sent
alter table act_lineups add column if not exists sent_at timestamptz;
alter table act_lineups add column if not exists sent_snapshot jsonb;       -- { layout, tasks, notes, names } as posted (+ version)
