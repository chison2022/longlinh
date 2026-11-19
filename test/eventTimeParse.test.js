const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseEventTime, titleOf } = require('../src/services/eventTimeParse');
const { fromLocal } = require('../src/utils/time');

// Wednesday 18/11/2026 21:00, Vietnam time (Saturday = 21/11, Sunday = 22/11)
const NOW = fromLocal(2026, 10, 18, 21, 0);
const vn = (d, h, m = 0, mo = 10, y = 2026) => fromLocal(y, mo, d, h, m);
const at = (text) => parseEventTime(text, NOW);

describe('parseEventTime: the start of an event in a free-text post', () => {
  it('a weekday with a clock time: the next such day', () => {
    assert.deepEqual(at('Bang chiến CN 20h'), vn(22, 20));
    assert.deepEqual(at('Giải solo tối thứ 7 lúc 20h30'), vn(21, 20, 30));
    assert.deepEqual(at('T7 9h sáng tập trung'), vn(21, 9));
    assert.deepEqual(at('thứ bảy 9h sáng'), vn(21, 9));
    assert.deepEqual(at('Chủ Nhật 20:00'), vn(22, 20));
  });
  it('a date with a clock time, in either order', () => {
    assert.deepEqual(at('Họp bang 21:00 25/11'), vn(25, 21));
    assert.deepEqual(at('25/11 lúc 20h'), vn(25, 20));
    assert.deepEqual(at('ngày 1/12/2026 20h'), vn(1, 20, 0, 11));
    assert.deepEqual(at('01-12-2026 20h'), vn(1, 20, 0, 11));
  });
  it('relative days and "tối" / "chiều" turn a morning hour into the evening', () => {
    assert.deepEqual(at('8 giờ tối mai'), vn(19, 20));
    assert.deepEqual(at('tối nay 22h'), vn(18, 22));
    assert.equal(at('tối nay 9h'), null, 'today 21:00 is now: not after now');
    assert.deepEqual(at('tối nay 9h30'), vn(18, 21, 30));
    assert.deepEqual(at('chiều mai 3h'), vn(19, 15));
  });
  it('a clock time alone: today when still ahead, else tomorrow', () => {
    assert.deepEqual(at('20h'), vn(19, 20));
    assert.deepEqual(at('23h30 đánh boss'), vn(18, 23, 30));
  });
  it('the first clock time of the post is the start', () => {
    assert.deepEqual(at('CN 20h bắt đầu, tập trung trước 19h45'), vn(22, 20));
  });
  it('no clock time, a past date or an impossible one: null', () => {
    assert.equal(at('Giải đấu bang, ai tham gia báo danh nhé'), null);
    assert.equal(at('thứ 7 giải đấu'), null, '"7 g..." is no time');
    assert.equal(at('10/11 20h'), null, 'already past');
    assert.equal(at('31/02 20h'), null);
    assert.equal(at('25h'), null);
  });
  it('"15-20 người" is no date; the weekday still counts', () => {
    assert.deepEqual(at('cần 15-20 người, 20h CN'), vn(22, 20));
  });
});

describe('titleOf: the first line of a post, cleaned', () => {
  it('drops markdown, mentions, custom emoji and links', () => {
    assert.equal(titleOf('## 🎉 **Giải Solo** <@&123> <:x:456>\nchi tiết'), '🎉 Giải Solo');
    assert.equal(titleOf('\n\n> Họp bang https://x.y/z\n'), 'Họp bang');
  });
  it('cuts a long line with "…" and gives "" for an empty post', () => {
    const t = titleOf('a'.repeat(150));
    assert.equal(t.length, 100);
    assert.ok(t.endsWith('…'));
    assert.equal(titleOf('<@123>\n<:x:1>'), '');
  });
});

describe('parseEventTime: words that only look like a day or a time', () => {
  it('"một" (one) is not "mốt", "mãi" is not "mai"', () => {
    assert.deepEqual(at('Một đêm vui vẻ 22h'), vn(18, 22));
    assert.deepEqual(at('Chơi mãi 22h'), vn(18, 22));
    assert.deepEqual(at('Hẹn mốt 20h'), vn(20, 20));
  });
  it('"x1.5", "1.5 triệu" are no dates; "23.11" is', () => {
    assert.deepEqual(at('Phó bản 22h, x1.5 exp'), vn(18, 22));
    assert.deepEqual(at('Thưởng 1.5 triệu, 22h tối nay'), vn(18, 22));
    assert.deepEqual(at('23.11 20h'), vn(23, 20));
  });
  it('a bare "N giờ" (a length) loses to a written clock; "12h đêm" is midnight', () => {
    assert.deepEqual(at('Chơi 2 giờ, bắt đầu 22h'), vn(18, 22));
    assert.deepEqual(at('8 giờ tối mai'), vn(19, 20));
    assert.deepEqual(at('12h đêm nay quẩy'), vn(19, 0));
  });
});
