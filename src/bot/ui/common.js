const { TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MessageFlags } = require('discord.js');

const EMBED_LIMIT = 6000; // total text of all embeds in one message
const ZWSP = '​';

// Cuts at code-point boundaries so a surrogate pair (emoji) is never split; result.length <= max.
function truncate(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  let out = '';
  for (const ch of Array.from(s)) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

function normalizeField(f) {
  return { name: truncate(f.name, 256), value: truncate(f.value || ZWSP, 1024), inline: Boolean(f.inline) };
}

// Pack `groups` ([{ prefix?, items, sep? }]) into chunks of at most `max` chars.
// Each group is one line (prefix + items joined by sep); lines are joined by "\n".
// A chunk break never splits an item, and the prefix is repeated on the continuation line.
// Returns [{ text, count }] where count = number of items placed in that chunk.
function packGroups(groups, max = 1024) {
  const chunks = [];
  let lines = [];
  let count = 0;
  const flush = () => {
    if (lines.length) chunks.push({ text: lines.join('\n'), count });
    lines = [];
    count = 0;
  };
  for (const { prefix = '', items, sep = ', ' } of groups) {
    let cur = null; // line being built
    const endLine = () => {
      if (cur !== null) lines.push(cur);
      cur = null;
    };
    for (const raw of items) {
      const item = truncate(raw, max - prefix.length);
      const cand = cur === null ? `${prefix}${item}` : `${cur}${sep}${item}`;
      if ([...lines, cand].join('\n').length <= max) {
        cur = cand;
      } else {
        endLine();
        flush();
        cur = `${prefix}${item}`;
      }
      count += 1;
    }
    endLine();
  }
  flush();
  return chunks;
}

// Split fields over several embeds: each page has ≤25 fields and (overhead + fields) ≤ 6000 chars.
// `overheads` = text length already used by title/description of the first and the following pages.
function paginateFields(fields, firstOverhead = 0, nextOverhead = 0) {
  const pages = [[]];
  let used = firstOverhead;
  for (const raw of fields) {
    const f = normalizeField(raw);
    const n = f.name.length + f.value.length;
    const page = pages[pages.length - 1];
    if (page.length && (page.length >= 25 || used + n > EMBED_LIMIT)) {
      pages.push([f]);
      used = nextOverhead + n;
    } else {
      page.push(f);
      used += n;
    }
  }
  return pages;
}

function embedLength(embed) {
  const e = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
  let n = (e.title || '').length + (e.description || '').length + ((e.footer && e.footer.text) || '').length;
  for (const f of e.fields || []) n += f.name.length + f.value.length;
  return n;
}

// Group embeds into messages: at most 10 embeds and 6000 chars of embed text per message.
function toMessages(embeds) {
  const messages = [];
  let cur = [];
  let used = 0;
  for (const e of embeds) {
    const n = embedLength(e);
    if (cur.length && (cur.length >= 10 || used + n > EMBED_LIMIT)) {
      messages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(e);
    used += n;
  }
  if (cur.length) messages.push(cur);
  return messages;
}

const TK_MARK = '🔗'; // after the name of a person in a confirmed Tuyến Khiên group
const TK_LEGEND = `${TK_MARK} = nhóm Tuyến Khiên`;

// ---------- Components V2 ----------
// A V2 message carries no content / embeds (it is the only body there is) and its text mentions DO ping: always send
// allowedMentions { parse: [] }. The edit form clears content and embeds so an old embed message converts in place.
const V2_TEXT_LIMIT = 4000; // total text of all Text Display components of one message

const textDisplay = (content) => new TextDisplayBuilder().setContent(truncate(content, 4000));
const separator = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

// Edit payload of a V2 message (embeds cleared: the war message / dashboard were embed messages without any content; discord.js would
// send content:null as an empty string, so it is simply left out); extra = more top-level keys (files...). Containers / rows go in components.
function v2Payload(components, extra = {}) {
  return { embeds: [], ...extra, components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

// The same payload for channel.send: nothing to clear on a new message.
function v2Create(payload) {
  const { content, embeds, ...rest } = payload;
  return rest;
}

module.exports = {
  V2_TEXT_LIMIT,
  textDisplay,
  separator,
  v2Payload,
  v2Create,
  TK_MARK,
  TK_LEGEND,
  truncate,
  packGroups,
  paginateFields,
  toMessages,
};
