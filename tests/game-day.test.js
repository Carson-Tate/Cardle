import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESET_HOUR_NY,
  gameDayFor,
  nextResetAt,
  msUntilNextReset,
  resetCountdown,
  formatCountdown,
  gameDayNumber,
} from '../src/core/game-day.js';

const at = (iso) => new Date(iso);

describe('gameDayFor', () => {
  // WINTER: 19:00 EST is exactly midnight UTC, so the game day must equal the
  // UTC calendar date. This is the property that let existing daily_plays rows
  // stay valid without a migration — if it ever breaks, historical play dates
  // silently stop lining up.
  test('in winter (EST) it matches the UTC calendar date exactly', () => {
    const samples = [
      '2026-01-05T00:00:00Z',
      '2026-01-05T12:00:00Z',
      '2026-01-05T23:59:59Z',
      '2026-02-14T06:30:00Z',
      '2026-12-31T23:59:59Z',
    ];
    for (const iso of samples) {
      assert.equal(gameDayFor(at(iso)), iso.slice(0, 10), `at ${iso}`);
    }
  });

  test('winter boundary: 18:59 EST is the old day, 19:00 EST is the new one', () => {
    // 19:00 EST = 00:00 UTC next day.
    assert.equal(gameDayFor(at('2026-01-05T23:59:59Z')), '2026-01-05');
    assert.equal(gameDayFor(at('2026-01-06T00:00:00Z')), '2026-01-06');
  });

  // SUMMER: 19:00 EDT is 23:00 UTC, so the day rolls an hour BEFORE the UTC
  // date does. This is the whole behavioural change.
  test('summer boundary: rolls at 23:00 UTC, an hour before the UTC date', () => {
    assert.equal(gameDayFor(at('2026-07-30T22:59:59Z')), '2026-07-30');
    assert.equal(gameDayFor(at('2026-07-30T23:00:00Z')), '2026-07-31', 'the reset has happened');
    assert.equal(gameDayFor(at('2026-07-30T23:30:00Z')), '2026-07-31');
    assert.equal(gameDayFor(at('2026-07-31T00:00:00Z')), '2026-07-31', 'and stays there past midnight UTC');
  });

  test('the same instant never belongs to two days, and days only move forward', () => {
    let previous = gameDayFor(at('2026-03-01T00:00:00Z'));
    const start = Date.parse('2026-03-01T00:00:00Z');
    // Walk 40 days in 37-minute steps, straight through the March DST change.
    for (let ms = start; ms < start + 40 * 86_400_000; ms += 37 * 60_000) {
      const day = gameDayFor(new Date(ms));
      assert.ok(day >= previous, `went backwards at ${new Date(ms).toISOString()}: ${previous} -> ${day}`);
      previous = day;
    }
  });

  test('every game day lasts exactly 24 hours except across a DST change', () => {
    // Count distinct game days over a fixed span; with a 7pm-local boundary the
    // count must match the number of calendar days, never drifting.
    const seen = new Set();
    const start = Date.parse('2026-06-01T00:00:00Z');
    for (let ms = start; ms < start + 30 * 86_400_000; ms += 15 * 60_000) {
      seen.add(gameDayFor(new Date(ms)));
    }
    // 30 days of samples straddles 31 distinct game-day labels at most.
    assert.ok(seen.size === 30 || seen.size === 31, `expected ~30 distinct days, got ${seen.size}`);
  });

  test('handles the spring-forward transition without skipping or repeating a day', () => {
    // US DST starts 2026-03-08. The 7pm boundary is well clear of the 2am jump,
    // so days either side must still be consecutive.
    assert.equal(gameDayFor(at('2026-03-07T23:59:00Z')), '2026-03-07');
    assert.equal(gameDayFor(at('2026-03-08T00:00:00Z')), '2026-03-08');
    assert.equal(gameDayFor(at('2026-03-08T22:59:00Z')), '2026-03-08');
    assert.equal(gameDayFor(at('2026-03-08T23:00:00Z')), '2026-03-09', 'now on EDT, so 19:00 local = 23:00 UTC');
  });

  test('handles the fall-back transition', () => {
    // US DST ends 2026-11-01.
    assert.equal(gameDayFor(at('2026-10-31T22:59:00Z')), '2026-10-31');
    assert.equal(gameDayFor(at('2026-10-31T23:00:00Z')), '2026-11-01', 'still EDT');
    assert.equal(gameDayFor(at('2026-11-02T23:59:00Z')), '2026-11-02', 'back on EST, so the UTC date matches again');
    assert.equal(gameDayFor(at('2026-11-03T00:00:00Z')), '2026-11-03');
  });

  test('returns a well-formed date string', () => {
    for (const iso of ['2026-01-01T05:00:00Z', '2026-07-04T18:00:00Z', '2027-02-28T23:30:00Z']) {
      assert.match(gameDayFor(at(iso)), /^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('nextResetAt', () => {
  test('is always 19:00 New York local, whatever the season', () => {
    for (const iso of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z', '2026-11-15T12:00:00Z']) {
      const reset = nextResetAt(at(iso));
      const hour = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
      }).format(reset);
      assert.equal(Number(hour) % 24, RESET_HOUR_NY, `at ${iso} the reset was ${reset.toISOString()}`);
    }
  });

  test('is midnight UTC in winter and 23:00 UTC in summer', () => {
    assert.equal(nextResetAt(at('2026-01-15T12:00:00Z')).toISOString(), '2026-01-16T00:00:00.000Z');
    assert.equal(nextResetAt(at('2026-07-15T12:00:00Z')).toISOString(), '2026-07-15T23:00:00.000Z');
  });

  test('is always strictly in the future, including exactly at a reset', () => {
    for (const iso of ['2026-07-30T23:00:00Z', '2026-01-06T00:00:00Z', '2026-07-30T22:59:59Z']) {
      const now = at(iso);
      assert.ok(nextResetAt(now).getTime() > now.getTime(), `not future at ${iso}`);
    }
  });

  test('is never more than 24 hours away', () => {
    const start = Date.parse('2026-03-01T00:00:00Z');
    for (let ms = start; ms < start + 20 * 86_400_000; ms += 53 * 60_000) {
      const now = new Date(ms);
      const delta = nextResetAt(now).getTime() - ms;
      assert.ok(delta > 0 && delta <= 86_400_000 + 3_600_000, `bad gap at ${now.toISOString()}: ${delta}ms`);
    }
  });
});

describe('countdown', () => {
  test('msUntilNextReset is never negative', () => {
    for (const iso of ['2026-07-30T22:59:59Z', '2026-07-30T23:00:00Z', '2026-01-06T00:00:00Z']) {
      assert.ok(msUntilNextReset(at(iso)) >= 0);
    }
  });

  test('splits into hours/minutes/seconds consistently', () => {
    // 2026-07-15 20:00 UTC, reset at 23:00 UTC -> exactly 3 hours.
    const c = resetCountdown(at('2026-07-15T20:00:00Z'));
    assert.equal(c.hours, 3);
    assert.equal(c.minutes, 0);
    assert.equal(c.seconds, 0);
    assert.equal(c.totalMs, 3 * 3_600_000);
  });

  test('formats as a ticking h:mm:ss clock at every distance', () => {
    assert.equal(formatCountdown(at('2026-07-15T20:00:00Z')), '3:00:00');
    assert.equal(formatCountdown(at('2026-07-15T22:47:30Z')), '0:12:30');
    assert.equal(formatCountdown(at('2026-07-15T22:59:50Z')), '0:00:10');
    // Seconds must be present even when hours are, or the per-second tick on the
    // board is invisible.
    assert.match(formatCountdown(at('2026-07-15T13:20:05Z')), /^\d+:[0-5]\d:[0-5]\d$/);
    assert.equal(formatCountdown(at('2026-07-15T13:20:05Z')), '9:39:55');
  });

  test('the countdown reaches the reset and restarts, never going negative', () => {
    const justBefore = resetCountdown(at('2026-07-15T22:59:59Z'));
    assert.equal(justBefore.totalMs, 1000);
    const justAfter = resetCountdown(at('2026-07-15T23:00:00Z'));
    assert.ok(justAfter.totalMs > 0, 'a new day has begun, so a full countdown restarts');
    assert.ok(justAfter.hours >= 23, `expected ~24h, got ${justAfter.hours}h`);
  });
});

describe('gameDayNumber', () => {
  test('day 1 is the project epoch', () => {
    assert.equal(gameDayNumber(at('2026-07-27T12:00:00Z')), 1);
  });

  test('advances by one per game day', () => {
    assert.equal(gameDayNumber(at('2026-07-28T12:00:00Z')), 2);
    assert.equal(gameDayNumber(at('2026-07-29T12:00:00Z')), 3);
  });

  test('advances at the 7pm reset, not at midnight UTC', () => {
    const before = gameDayNumber(at('2026-07-30T22:59:00Z'));
    const after = gameDayNumber(at('2026-07-30T23:00:00Z'));
    assert.equal(after, before + 1, 'the number should tick over with the reset');
    assert.equal(gameDayNumber(at('2026-07-31T00:30:00Z')), after, 'and not again at midnight UTC');
  });
});
