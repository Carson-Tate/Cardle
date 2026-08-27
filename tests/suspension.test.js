import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSuspensionActive,
  suspensionRemaining,
  describeSuspension,
  formatSuspensionEnd,
  formatSuspensionLength,
  SUSPENSION_PRESETS,
} from '../src/core/suspension.js';

const NOW = new Date('2026-09-01T12:00:00Z');
const inHours = (h) => new Date(NOW.getTime() + h * 3600_000).toISOString();

describe('isSuspensionActive', () => {
  test('no row at all is not a suspension', () => {
    assert.equal(isSuspensionActive(null, NOW), false);
    assert.equal(isSuspensionActive(undefined, NOW), false);
  });

  test('a future end date is active, a past one is not', () => {
    assert.equal(isSuspensionActive({ suspended_until: inHours(1) }, NOW), true);
    assert.equal(isSuspensionActive({ suspended_until: inHours(-1) }, NOW), false);
  });

  // The case worth stating outright: a null end date is PERMANENT, not
  // "no suspension". Treating those the same is how a permanent ban quietly
  // becomes no ban at all.
  test('a null end date is permanent, not absent', () => {
    assert.equal(isSuspensionActive({ suspended_until: null }, NOW), true);
  });

  test('a lifted row bans nobody even if its end date is still ahead', () => {
    assert.equal(
      isSuspensionActive({ suspended_until: inHours(48), lifted_at: inHours(-1) }, NOW),
      false,
    );
  });

  // Fails OPEN, deliberately: an unparseable date is a data fault, and locking
  // someone out of a daily game over one is the worse of the two errors. The
  // database is the enforcement anyway — this only decides what to display.
  test('an unparseable end date does not ban', () => {
    assert.equal(isSuspensionActive({ suspended_until: 'not-a-date' }, NOW), false);
  });

  test('the exact expiry instant has passed', () => {
    assert.equal(isSuspensionActive({ suspended_until: NOW.toISOString() }, NOW), false);
  });
});

describe('suspensionRemaining', () => {
  test('permanent is null, not a huge number', () => {
    assert.equal(suspensionRemaining({ suspended_until: null }, NOW), null);
  });

  test('an inactive suspension has no time left', () => {
    assert.equal(suspensionRemaining({ suspended_until: inHours(-5) }, NOW), 0);
    assert.equal(suspensionRemaining(null, NOW), 0);
  });

  test('a live one reports the gap', () => {
    assert.equal(suspensionRemaining({ suspended_until: inHours(3) }, NOW), 3 * 3600_000);
  });
});

describe('describeSuspension', () => {
  test('nothing to say for an absent or expired row', () => {
    assert.equal(describeSuspension(null, NOW), null);
    assert.equal(describeSuspension({ suspended_until: inHours(-1) }, NOW), null);
  });

  test('a temporary suspension names itself as temporary and carries the date', () => {
    const d = describeSuspension({ suspended_until: inHours(24), reason: 'Cheating' }, NOW);
    assert.equal(d.permanent, false);
    assert.equal(d.headline, 'You have received a temporary suspension');
    assert.equal(d.reason, 'Cheating');
    assert.equal(d.until.toISOString(), inHours(24));
  });

  test('a permanent one says so and has no date', () => {
    const d = describeSuspension({ suspended_until: null }, NOW);
    assert.equal(d.permanent, true);
    assert.equal(d.headline, 'Your account has been suspended');
    assert.equal(d.until, null);
  });

  // One empty case for the caller, not three.
  test('a blank or whitespace reason collapses to null', () => {
    assert.equal(describeSuspension({ suspended_until: inHours(1), reason: '   ' }, NOW).reason, null);
    assert.equal(describeSuspension({ suspended_until: inHours(1), reason: '' }, NOW).reason, null);
    assert.equal(describeSuspension({ suspended_until: inHours(1) }, NOW).reason, null);
  });
});

describe('formatSuspensionEnd', () => {
  // Pinned to New York rather than the viewer's locale, so the same suspension
  // does not read as a different punishment in two timezones (§11l's one-clock
  // rule). Asserted by comparing two identical instants formatted the same way
  // rather than by hardcoding a string, which would break on an ICU update.
  test('renders in New York regardless of the host timezone', () => {
    const formatted = formatSuspensionEnd(new Date('2026-09-01T23:30:00Z'));
    assert.match(formatted, /Sep 1/);
    assert.match(formatted, /7:30/); // 23:30 UTC is 19:30 EDT
    assert.match(formatted, /EDT|EST/);
  });

  test('always includes the year', () => {
    assert.match(formatSuspensionEnd(new Date('2026-09-01T23:30:00Z')), /2026/);
  });

  // The case the year exists FOR: a ban issued in December lifts in January,
  // and "Sat, Jan 3" alone is ambiguous precisely when certainty matters most.
  test('a suspension crossing into the next year is unambiguous', () => {
    const formatted = formatSuspensionEnd(new Date('2027-01-03T18:00:00Z'));
    assert.match(formatted, /Jan 3/);
    assert.match(formatted, /2027/);
  });

  test('a bad date formats to nothing rather than "Invalid Date"', () => {
    assert.equal(formatSuspensionEnd(new Date('nope')), null);
    assert.equal(formatSuspensionEnd(null), null);
  });
});

describe('formatSuspensionLength', () => {
  test('permanent has no length', () => {
    assert.equal(formatSuspensionLength(null), null);
  });

  test('singular and plural are both right', () => {
    assert.equal(formatSuspensionLength(60_000), '1 minute');
    assert.equal(formatSuspensionLength(120_000), '2 minutes');
    assert.equal(formatSuspensionLength(3600_000), '1 hour');
    assert.equal(formatSuspensionLength(24 * 3600_000), '24 hours');
    assert.equal(formatSuspensionLength(72 * 3600_000), '3 days');
  });
});

describe('SUSPENSION_PRESETS', () => {
  test('permanent is expressed as a null length, matching the row shape', () => {
    const permanent = SUSPENSION_PRESETS.find((p) => p.label === 'Permanent');
    assert.equal(permanent.hours, null);
  });

  test('every other preset is a positive number of hours', () => {
    for (const preset of SUSPENSION_PRESETS.filter((p) => p.hours !== null)) {
      assert.ok(preset.hours > 0, `${preset.label} should be positive`);
    }
  });
});
