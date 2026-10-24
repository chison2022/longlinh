// Discord API limit assertions for message / modal payloads. Not a test file.
const assert = require('node:assert/strict');

const SELECT_TYPES = new Set([3, 5, 6, 7, 8]);

const toJSON = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

function hasLoneSurrogate(s) {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function assertString(s, max, what) {
  assert.equal(typeof s, 'string', `${what} must be a string`);
  assert.ok(s.length <= max, `${what} length ${s.length} > ${max}: ${JSON.stringify(s.slice(0, 80))}`);
  assert.ok(!hasLoneSurrogate(s), `${what} contains a broken surrogate pair: ${JSON.stringify(s.slice(-20))}`);
}

function embedTextLength(e) {
  let n = (e.title || '').length + (e.description || '').length;
  n += e.footer && e.footer.text ? e.footer.text.length : 0;
  n += e.author && e.author.name ? e.author.name.length : 0;
  for (const f of e.fields || []) n += f.name.length + f.value.length;
  return n;
}

function assertEmbed(embedLike) {
  const e = toJSON(embedLike);
  if (e.title !== undefined) assertString(e.title, 256, 'embed.title');
  if (e.description !== undefined) assertString(e.description, 4096, 'embed.description');
  if (e.footer) assertString(e.footer.text, 2048, 'embed.footer.text');
  const fields = e.fields || [];
  assert.ok(fields.length <= 25, `embed has ${fields.length} fields > 25`);
  for (const [i, f] of fields.entries()) {
    assertString(f.name, 256, `field[${i}].name`);
    assertString(f.value, 1024, `field[${i}].value`);
    assert.ok(f.name.length > 0 && f.value.length > 0, `field[${i}] name/value must be non-empty`);
  }
  const total = embedTextLength(e);
  assert.ok(total <= 6000, `embed total text ${total} > 6000`);
  return e;
}

function assertComponent(c, customIds) {
  if (c.custom_id !== undefined) {
    assertString(c.custom_id, 100, `custom_id`);
    assert.ok(!customIds.has(c.custom_id), `duplicate custom_id ${c.custom_id}`);
    customIds.add(c.custom_id);
  }
  if (c.type === 2) {
    if (c.label !== undefined) assertString(c.label, 80, 'button.label');
  }
  if (SELECT_TYPES.has(c.type)) {
    if (c.placeholder !== undefined) assertString(c.placeholder, 150, 'select.placeholder');
    const min = c.min_values ?? 1;
    const max = c.max_values ?? 1;
    assert.ok(min >= 0 && min <= 25, `min_values ${min}`);
    assert.ok(max >= 1 && max <= 25, `max_values ${max}`);
    assert.ok(min <= max, `min_values ${min} > max_values ${max}`);
    if (c.default_values) assert.ok(c.default_values.length <= max, `default_values ${c.default_values.length} > max_values ${max}`);
  }
  if (c.type === 3) {
    const opts = c.options || [];
    assert.ok(opts.length >= 1 && opts.length <= 25, `select ${c.custom_id} has ${opts.length} options`);
    assert.ok((c.max_values ?? 1) <= opts.length, `select ${c.custom_id} max_values ${c.max_values} > ${opts.length} options`);
    const values = new Set();
    let defaults = 0;
    for (const o of opts) {
      assertString(o.label, 100, 'option.label');
      assertString(o.value, 100, 'option.value');
      if (o.description !== undefined) assertString(o.description, 100, 'option.description');
      assert.ok(!values.has(o.value), `duplicate option value ${o.value} in ${c.custom_id}`);
      values.add(o.value);
      if (o.default) defaults += 1;
    }
    assert.ok(defaults <= (c.max_values ?? 1), `${defaults} default options > max_values in ${c.custom_id}`);
  }
}

// Message payload { content?, embeds?, components? }
function assertMessage(payload) {
  if (payload.content !== undefined) assertString(payload.content, 2000, 'content');
  const embeds = (payload.embeds || []).map(assertEmbed);
  assert.ok(embeds.length <= 10, 'too many embeds');
  const total = embeds.reduce((n, e) => n + embedTextLength(e), 0);
  assert.ok(total <= 6000, `all embeds total ${total} > 6000`);
  const rows = (payload.components || []).map(toJSON);
  assert.ok(rows.length <= 5, `${rows.length} action rows > 5`);
  const customIds = new Set();
  for (const [i, row] of rows.entries()) {
    assert.equal(row.type, 1, `row ${i} is not an action row`);
    const comps = row.components || [];
    assert.ok(comps.length >= 1, `row ${i} is empty`);
    const selects = comps.filter((c) => SELECT_TYPES.has(c.type));
    if (selects.length) assert.equal(comps.length, 1, `row ${i}: a select must be alone in its row`);
    else assert.ok(comps.length <= 5, `row ${i} has ${comps.length} buttons > 5`);
    for (const c of comps) assertComponent(c, customIds);
  }
  return { embeds, rows, customIds };
}

// Components V2 message payload: V2 flag, nothing in content / embeds, no mentions, <= 40 components, <= 4000 chars of text,
// unique valid custom ids. -> { texts, text, buttons, customIds, count, json }
const V2_FLAG = 1 << 15;
function assertV2Message(payload, { forCreate = false } = {}) {
  assert.equal(payload.flags & V2_FLAG, V2_FLAG, 'IS_COMPONENTS_V2 flag missing');
  if (forCreate) assert.ok(!('content' in payload) && !('embeds' in payload), 'a new V2 message carries no content / embeds keys');
  else {
    assert.ok(!payload.content, 'no content');
    assert.deepEqual(payload.embeds, [], 'embeds must be cleared');
  }
  assert.deepEqual(payload.allowedMentions, { parse: [] }, 'V2 text mentions ping: allowedMentions must be { parse: [] }');
  const top = (payload.components || []).map(toJSON);
  const texts = [];
  const buttons = [];
  const customIds = new Set();
  let count = 0;
  const walk = (c) => {
    count += 1;
    if (c.type === 10) {
      assert.equal(typeof c.content, 'string');
      assert.ok(c.content.length > 0, 'empty text display');
      assert.ok(!hasLoneSurrogate(c.content), 'broken surrogate in text');
      texts.push(c.content);
    }
    if (c.type === 9) {
      assert.ok(c.accessory, 'section without accessory');
      assert.ok(c.components.length >= 1 && c.components.length <= 3);
      walk(c.accessory);
    }
    if (c.type === 2) {
      if (c.label !== undefined) assertString(c.label, 80, 'button.label');
      if (c.custom_id !== undefined) {
        assertString(c.custom_id, 100, 'custom_id');
        assert.ok(!customIds.has(c.custom_id), 'duplicate custom_id ' + c.custom_id);
        customIds.add(c.custom_id);
      }
      buttons.push(c);
    }
    if (c.type === 1) assert.ok(c.components.length >= 1 && c.components.length <= 5, 'row size');
    if (c.type === 12) assert.ok(c.items.length >= 1);
    for (const child of c.components || []) walk(child);
  };
  top.forEach(walk);
  assert.ok(count <= 40, `${count} components > 40`);
  const text = texts.join('\n');
  assert.ok(text.length <= 4000, `text ${text.length} > 4000`);
  return { texts, text, buttons, customIds, count, json: top };
}

function assertModal(modalLike) {
  const m = toJSON(modalLike);
  assertString(m.custom_id, 100, 'modal.custom_id');
  assertString(m.title, 45, 'modal.title');
  assert.ok(m.components.length >= 1 && m.components.length <= 5, `modal has ${m.components.length} components`);
  const ids = new Set();
  for (const label of m.components) {
    assert.equal(label.type, 18, 'modal top-level component must be a Label');
    assertString(label.label, 45, 'label.label');
    if (label.description !== undefined) assertString(label.description, 100, 'label.description');
    const input = label.component;
    assert.ok(input.type === 4 || input.type === 3, 'a label holds a text input or a string select');
    assertString(input.custom_id, 100, 'input.custom_id');
    assert.ok(!ids.has(input.custom_id), `duplicate input id ${input.custom_id}`);
    ids.add(input.custom_id);
    if (input.type === 3) {
      assertComponent(input, new Set());
      assert.ok(input.options.length >= 1 && input.options.length <= 25);
      continue;
    }
    const max = input.max_length ?? 4000;
    assert.ok(max <= 4000);
    if (input.value !== undefined) {
      assert.ok(input.value.length <= max, `input ${input.custom_id} value length ${input.value.length} > max_length ${max}`);
      if (input.min_length !== undefined) assert.ok(input.value.length >= input.min_length);
    }
    if (input.placeholder !== undefined) assertString(input.placeholder, 100, 'input.placeholder');
  }
  return m;
}

module.exports = { assertV2Message, assertMessage, assertEmbed, assertModal, embedTextLength, hasLoneSurrogate };
