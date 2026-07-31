import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_KEYS,
  validateModifierOverrides,
  modifierOverrideFor,
  validateWordBank,
  mergeWordBank,
  wordBankSlots,
  validateCustomCosmetics,
} from '../src/core/game-config.js';
import { MODIFIERS, getDailyModifier } from '../src/core/modifiers.js';
import { gameDayFor } from '../src/core/game-day.js';
import { FRAGMENTS } from '../src/story/templates.js';
import { buildStoryText } from '../src/story/generator.js';
import { resolveCosmetics, resolveEquipped, effectiveRegistries, NAME_PAINTS } from '../src/core/cosmetics.js';

describe('config keys', () => {
  test('every key is a safe slug matching the schema CHECK', () => {
    for (const key of Object.values(CONFIG_KEYS)) {
      assert.match(key, /^[a-z0-9_]{1,40}$/);
    }
  });
});

describe('validateModifierOverrides', () => {
  test('accepts valid date → modifier id pairs', () => {
    const { value, errors } = validateModifierOverrides({ '2026-08-01': 'flushFrenzy', '2026-08-02': 'cleanSlate' });
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { '2026-08-01': 'flushFrenzy', '2026-08-02': 'cleanSlate' });
  });

  test('empty/missing config is valid and means no overrides', () => {
    for (const empty of [null, undefined, {}]) {
      const { value, errors } = validateModifierOverrides(empty);
      assert.deepEqual(value, {});
      assert.deepEqual(errors, []);
    }
  });

  test('rejects malformed dates and unknown modifier ids, but keeps the good entries', () => {
    const { value, errors } = validateModifierOverrides({
      '2026-08-01': 'flushFrenzy',
      'not-a-date': 'cleanSlate',
      '2026-08-03': 'noSuchModifier',
    });
    assert.deepEqual(value, { '2026-08-01': 'flushFrenzy' }, 'one bad entry must not discard the valid ones');
    assert.equal(errors.length, 2);
  });

  test('rejects a non-object outright', () => {
    for (const bad of ['nope', 42, ['a'], true]) {
      const { value, errors } = validateModifierOverrides(bad);
      assert.deepEqual(value, {});
      assert.equal(errors.length, 1);
    }
  });

  test('modifierOverrideFor finds the entry for a date and is safe on junk', () => {
    const overrides = { '2026-08-01': 'highRoller' };
    assert.equal(modifierOverrideFor(overrides, new Date('2026-08-01T12:00:00Z')), 'highRoller');
    assert.equal(modifierOverrideFor(overrides, new Date('2026-08-02T12:00:00Z')), null);
    assert.equal(modifierOverrideFor('garbage', new Date('2026-08-01T12:00:00Z')), null);
    assert.equal(modifierOverrideFor(null, new Date('2026-08-01T12:00:00Z')), null);
  });

  // THE PINNED MODIFIER "RESETTING" (owner bug report). The rotation is keyed on
  // the GAME day, which rolls at 19:00 New York, but the override lookup used to
  // key on `toISOString().slice(0,10)` — the UTC calendar date, which rolls at
  // 20:00 during EDT. That one-hour disagreement did two visible things: an
  // override kept applying for an hour after its day had ended, and then stopped
  // applying to the day it was actually pinned to.
  //
  // 23:30 UTC on Aug 1 is 19:30 EDT — past the reset, so this instant belongs to
  // game day Aug 2. The UTC date still reads Aug 1.
  test('modifierOverrideFor keys on the GAME day, not the UTC date', () => {
    const justAfterReset = new Date('2026-08-01T23:30:00Z'); // 19:30 EDT -> game day Aug 2
    assert.equal(gameDayFor(justAfterReset), '2026-08-02');

    // Yesterday's pin must NOT leak into the new game day.
    assert.equal(modifierOverrideFor({ '2026-08-01': 'highRoller' }, justAfterReset), null);
    // And the pin for the day that is actually live must be found.
    assert.equal(modifierOverrideFor({ '2026-08-02': 'highRoller' }, justAfterReset), 'highRoller');
  });

  test('modifierOverrideFor accepts a game-day string as well as a Date', () => {
    const overrides = { '2026-08-01': 'highRoller' };
    assert.equal(modifierOverrideFor(overrides, '2026-08-01'), 'highRoller');
    assert.equal(modifierOverrideFor(overrides, '2026-08-02'), null);
  });
});

describe('getDailyModifier with an override', () => {
  const date = new Date('2026-08-01T12:00:00Z');

  test('an override replaces the rotation for that day', () => {
    const normal = getDailyModifier(date);
    const forced = getDailyModifier(date, 'cleanSlate');
    assert.equal(forced.id, 'cleanSlate');
    assert.equal(forced.maxDiscards, 5);
    if (normal.id !== 'cleanSlate') assert.notEqual(forced.id, normal.id);
  });

  // Config is read by every player's client on boot, so a stale or mistyped
  // override must fall back to the normal rotation rather than break the game.
  test('an unknown override id is ignored, not thrown', () => {
    const normal = getDailyModifier(date);
    for (const bad of ['nonsense', '', 'DROP TABLE']) {
      assert.equal(getDailyModifier(date, bad).id, normal.id, `override "${bad}" should be ignored`);
    }
  });

  test('null/omitted override behaves exactly as before', () => {
    assert.equal(getDailyModifier(date, null).id, getDailyModifier(date).id);
  });

  test('an overridden modifier still gets a day-stable random context', () => {
    // Suit Bonus picks a bonus suit; it must be the same on every page load of
    // that day, not re-rolled.
    const a = getDailyModifier(date, 'suitBonus');
    const b = getDailyModifier(date, 'suitBonus');
    assert.equal(a.bonusSuit, b.bonusSuit);
    const other = getDailyModifier(new Date('2026-09-15T12:00:00Z'), 'suitBonus');
    assert.ok(typeof other.bonusSuit === 'string');
  });

  test('every modifier in the roster can be forced', () => {
    for (const modifier of MODIFIERS) {
      assert.equal(getDailyModifier(date, modifier.id).id, modifier.id);
    }
  });
});

describe('validateWordBank', () => {
  test('accepts a partial override of one slot', () => {
    const { value, errors } = validateWordBank({ emoji: ['🔥', '💀'] });
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { emoji: ['🔥', '💀'] });
  });

  test('accepts the nested ending slot', () => {
    const { value, errors } = validateWordBank({ ending: { good: ['and it paid'], bad: ['and it did not'] } });
    assert.deepEqual(errors, []);
    assert.deepEqual(value.ending, { good: ['and it paid'], bad: ['and it did not'] });
  });

  test('accepts overriding just one half of ending', () => {
    const { value, errors } = validateWordBank({ ending: { good: ['nice'] } });
    assert.deepEqual(errors, []);
    assert.deepEqual(value.ending, { good: ['nice'] });
  });

  test('rejects unknown slots, empty lists, and non-strings', () => {
    assert.ok(validateWordBank({ nonsense: ['x'] }).errors.length === 1);
    assert.ok(validateWordBank({ emoji: [] }).errors.length === 1);
    assert.ok(validateWordBank({ emoji: [1, 2] }).errors.length === 1);
    assert.ok(validateWordBank({ emoji: ['   '] }).errors.length === 1);
    assert.ok(validateWordBank('nope').errors.length === 1);
  });

  // The caption is assembled as ONE line (§6c); an internal period would break
  // it. templates.js's own tests enforce the same rule for the built-ins.
  test('flags a fragment containing an internal period', () => {
    const { errors } = validateWordBank({ action: ['broke. badly'] });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /period/);
  });

  test('trims and de-duplicates entries', () => {
    const { value } = validateWordBank({ emoji: ['  🔥  ', '🔥', '💀'] });
    assert.deepEqual(value.emoji, ['🔥', '💀']);
  });
});

describe('mergeWordBank', () => {
  test('returns the built-ins untouched when there is nothing to override', () => {
    assert.equal(mergeWordBank(null), FRAGMENTS);
    assert.equal(mergeWordBank({}), FRAGMENTS);
  });

  test('overrides only the slots present, leaving the rest as built-ins', () => {
    const merged = mergeWordBank({ emoji: ['🔥'] });
    assert.deepEqual(merged.emoji, ['🔥']);
    assert.deepEqual(merged.opening, FRAGMENTS.opening);
    assert.deepEqual(merged.ending, FRAGMENTS.ending);
  });

  test('merges one half of ending without losing the other', () => {
    const merged = mergeWordBank({ ending: { good: ['great'] } });
    assert.deepEqual(merged.ending.good, ['great']);
    assert.deepEqual(merged.ending.bad, FRAGMENTS.ending.bad);
  });

  test('a stored value that fails validation falls back to the built-ins', () => {
    assert.equal(mergeWordBank('garbage'), FRAGMENTS);
    assert.equal(mergeWordBank({ emoji: [] }), FRAGMENTS);
  });

  test('the merged pools actually drive the generated caption', () => {
    const hand = [
      { rank: 2, suit: 'S' },
      { rank: 5, suit: 'H' },
      { rank: 9, suit: 'D' },
      { rank: 11, suit: 'C' },
      { rank: 13, suit: 'S' },
    ];
    const custom = mergeWordBank({
      opening: ['ZZOPENING'],
      action: ['ZZACTION'],
      object: ['ZZOBJECT'],
      connector: ['ZZCONNECTOR'],
      ending: { good: ['ZZGOOD'], bad: ['ZZBAD'] },
      emoji: ['ZZEMOJI'],
    });
    const text = buildStoryText(hand, hand, [], new Date('2026-08-01T12:00:00Z'), custom);
    assert.equal(text, 'ZZOPENING ZZACTION ZZOBJECT ZZCONNECTOR ZZBAD ZZEMOJI');
    // And the built-in path is unchanged.
    assert.ok(!buildStoryText(hand, hand, [], new Date('2026-08-01T12:00:00Z')).includes('ZZ'));
  });
});

describe('wordBankSlots', () => {
  test('lists every editable slot with its built-in defaults', () => {
    const slots = wordBankSlots();
    const names = slots.map((s) => s.slot);
    assert.deepEqual(names, ['opening', 'action', 'object', 'connector', 'emoji', 'ending.good', 'ending.bad']);
    for (const slot of slots) {
      assert.ok(Array.isArray(slot.defaults) && slot.defaults.length > 0, `${slot.slot} has no defaults`);
      assert.equal(typeof slot.label, 'string');
    }
  });
});

describe('validateCustomCosmetics', () => {
  test('accepts well-formed badges, titles and paints', () => {
    const { value, errors } = validateCustomCosmetics({
      badges: [{ id: 'badge_founder', label: 'Founder', emoji: '🏅' }],
      titles: [{ id: 'title_beta', label: 'Beta Tester', level: 3 }],
      paints: [{ id: 'paint_hotpink', label: 'Hot Pink', level: 2, color: '#FF69B4' }],
    });
    assert.deepEqual(errors, []);
    assert.equal(value.badges[0].availability, 'grant', 'a custom badge has no achievement, so it defaults to grant-only');
    assert.equal(value.badges[0].custom, true);
    assert.equal(value.titles[0].level, 3);
    assert.equal(value.paints[0].color, '#ff69b4', 'hex normalized to lowercase');
  });

  test('empty/missing config yields empty lists', () => {
    for (const empty of [null, undefined, {}]) {
      const { value, errors } = validateCustomCosmetics(empty);
      assert.deepEqual(value, { badges: [], titles: [], paints: [] });
      assert.deepEqual(errors, []);
    }
  });

  test('rejects bad ids, missing labels, and bad levels', () => {
    const { value, errors } = validateCustomCosmetics({
      titles: [
        { id: 'has space', label: 'X', level: 1 },
        { id: 'title_ok', label: '', level: 1 },
        { id: 'title_ok2', label: 'Fine', level: 0 },
        { id: 'title_ok3', label: 'Fine', level: 1.5 },
      ],
    });
    assert.equal(value.titles.length, 0);
    assert.equal(errors.length, 4);
  });

  test('rejects a duplicate id, including across kinds', () => {
    const { errors } = validateCustomCosmetics({
      titles: [{ id: 'dupe', label: 'A', level: 1 }],
      paints: [{ id: 'dupe', label: 'B', level: 1, color: '#000000' }],
    });
    assert.ok(errors.some((e) => /duplicate/.test(e)));
  });

  // A custom paint becomes an INLINE style in other players' browsers, so
  // anything but a strict hex is refused — this is the CSS-injection guard.
  test('refuses any paint colour that is not a strict 6-digit hex', () => {
    for (const color of ['red', '#fff', 'rgb(0,0,0)', '#12345g', 'url(x)', '#000000;background:red', '', null]) {
      const { value, errors } = validateCustomCosmetics({
        paints: [{ id: 'paint_x', label: 'X', level: 1, color }],
      });
      assert.equal(value.paints.length, 0, `colour "${String(color)}" should be refused`);
      assert.ok(errors.length >= 1);
    }
  });

  test('a badge with no emoji gets a default rather than rendering blank', () => {
    const { value } = validateCustomCosmetics({ badges: [{ id: 'badge_x', label: 'X' }] });
    assert.equal(value.badges[0].emoji, '⭐');
  });

  test('tolerates non-array kinds', () => {
    const { value } = validateCustomCosmetics({ badges: 'nope', titles: 42, paints: {} });
    assert.deepEqual(value, { badges: [], titles: [], paints: [] });
  });
});

describe('custom cosmetics in the registries', () => {
  const custom = {
    badges: [{ id: 'badge_founder', label: 'Founder', emoji: '🏅', custom: true, availability: 'grant' }],
    titles: [{ id: 'title_beta', label: 'Beta Tester', level: 3, custom: true, availability: 'level' }],
    paints: [{ id: 'paint_hotpink', label: 'Hot Pink', level: 2, color: '#ff69b4', custom: true, availability: 'level' }],
  };

  test('custom entries are appended, never replacing the built-ins', () => {
    const { badges, titles, paints } = effectiveRegistries(custom);
    assert.equal(paints.length, NAME_PAINTS.length + 1);
    assert.ok(paints.some((p) => p.id === 'paint_hotpink'));
    for (const builtin of NAME_PAINTS) {
      assert.ok(paints.some((p) => p.id === builtin.id), `${builtin.id} was lost`);
    }
    assert.ok(titles.some((t) => t.id === 'title_beta'));
    assert.ok(badges.some((b) => b.id === 'badge_founder'));
  });

  test('a custom entry cannot shadow a built-in id', () => {
    const { paints } = effectiveRegistries({ paints: [{ id: 'paint_crimson', label: 'Hijacked', level: 1, color: '#000000' }] });
    assert.equal(paints.filter((p) => p.id === 'paint_crimson').length, 1);
    assert.equal(paints.find((p) => p.id === 'paint_crimson').label, 'Crimson', 'built-in wins');
  });

  test('a custom title unlocks by level like any other', () => {
    assert.equal(resolveCosmetics({ level: 2, custom }).titles.find((t) => t.id === 'title_beta').unlocked, false);
    assert.equal(resolveCosmetics({ level: 3, custom }).titles.find((t) => t.id === 'title_beta').unlocked, true);
  });

  test('a custom badge is grant-only and says so', () => {
    const badge = resolveCosmetics({ level: 99, achievementsUnlocked: [], custom }).badges.find((b) => b.id === 'badge_founder');
    assert.equal(badge.unlocked, false, 'no level can earn it');
    assert.match(badge.requirementText, /Granted by an admin/);
    const granted = resolveCosmetics({ level: 1, adminUnlocks: ['badge_founder'], custom }).badges.find((b) => b.id === 'badge_founder');
    assert.equal(granted.unlocked, true);
  });

  test('resolveEquipped finds a custom paint and carries its colour', () => {
    const equipped = resolveEquipped({ equipped_paint: 'paint_hotpink' }, custom);
    assert.equal(equipped.paint.id, 'paint_hotpink');
    assert.equal(equipped.paint.color, '#ff69b4');
  });

  test('without the custom config, a custom id resolves to the default', () => {
    assert.equal(resolveEquipped({ equipped_paint: 'paint_hotpink' }).paint.id, 'paint_default');
  });
});

describe('availability modes', () => {
  const title = (availability, level = 1) => ({
    titles: [{ id: 'title_owner', label: 'Owner', level, custom: true, availability }],
  });

  // The bug this whole feature exists for: an "Owner" title authored at level 1
  // unlocked for EVERY player, because everyone is at least level 1.
  test('the original bug — a level-1 custom title is unlocked for everyone', () => {
    const resolved = resolveCosmetics({ level: 1, custom: title('level', 1) });
    assert.equal(resolved.titles.find((t) => t.id === 'title_owner').unlocked, true);
  });

  test('"everyone" mode ignores level entirely', () => {
    for (const level of [1, 5, 99]) {
      const entry = resolveCosmetics({ level, custom: title('everyone', 50) }).titles.find((t) => t.id === 'title_owner');
      assert.equal(entry.unlocked, true);
      assert.equal(entry.hidden, false);
      assert.equal(entry.requirementText, 'Available to everyone');
    }
  });

  test('"grant" mode is locked and hidden regardless of level', () => {
    for (const level of [1, 50, 999]) {
      const entry = resolveCosmetics({ level, custom: title('grant') }).titles.find((t) => t.id === 'title_owner');
      assert.equal(entry.unlocked, false, `level ${level} must not unlock a grant-only cosmetic`);
      assert.equal(entry.hidden, true, 'and it must not be advertised');
    }
  });

  test('"grant" mode unlocks and unhides once granted', () => {
    const entry = resolveCosmetics({ level: 1, adminUnlocks: ['title_owner'], custom: title('grant') }).titles.find(
      (t) => t.id === 'title_owner',
    );
    assert.equal(entry.unlocked, true);
    assert.equal(entry.hidden, false);
    assert.equal(entry.grantedByAdmin, true);
  });

  test('"level" mode still gates normally', () => {
    assert.equal(resolveCosmetics({ level: 4, custom: title('level', 5) }).titles.find((t) => t.id === 'title_owner').unlocked, false);
    assert.equal(resolveCosmetics({ level: 5, custom: title('level', 5) }).titles.find((t) => t.id === 'title_owner').unlocked, true);
  });

  test('an unknown availability value is refused by the validator', () => {
    const { value, errors } = validateCustomCosmetics({
      titles: [{ id: 'title_x', label: 'X', level: 1, availability: 'whenever' }],
    });
    assert.equal(value.titles.length, 0);
    assert.match(errors[0], /availability must be one of/);
  });

  test('a custom badge cannot be level-gated — "level" collapses to "grant"', () => {
    const { value } = validateCustomCosmetics({ badges: [{ id: 'badge_x', label: 'X', availability: 'level' }] });
    assert.equal(value.badges[0].availability, 'grant');
  });

  test('a badge can still be set to everyone', () => {
    const { value } = validateCustomCosmetics({ badges: [{ id: 'badge_x', label: 'X', availability: 'everyone' }] });
    assert.equal(value.badges[0].availability, 'everyone');
  });

  test('omitting availability preserves the previous behaviour per kind', () => {
    const { value } = validateCustomCosmetics({
      badges: [{ id: 'badge_x', label: 'B' }],
      titles: [{ id: 'title_x', label: 'T', level: 3 }],
      paints: [{ id: 'paint_x', label: 'P', level: 3, color: '#000000' }],
    });
    assert.equal(value.badges[0].availability, 'grant', 'badges were already grant-only');
    assert.equal(value.titles[0].availability, 'level', 'titles were level-gated');
    assert.equal(value.paints[0].availability, 'level', 'paints were level-gated');
  });

  // Re-locking has to actually take the cosmetic AWAY from players who already
  // equipped it while it was over-permissive, or the fix would be cosmetic only
  // and an accidental "Owner" title could never be recalled.
  test('re-locking strips the cosmetic from a player who equipped it but was never granted', () => {
    const row = { username: 'someone', equipped_title: 'title_owner', admin_unlocks: [] };
    assert.equal(resolveEquipped(row, title('level', 1)).title?.id, 'title_owner', 'level mode: still theirs');
    assert.equal(resolveEquipped(row, title('grant')).title, null, 'grant mode: no longer rendered');
  });

  test('but a granted player keeps it after the switch', () => {
    const row = { username: 'car', equipped_title: 'title_owner', admin_unlocks: ['title_owner'] };
    assert.equal(resolveEquipped(row, title('grant')).title?.id, 'title_owner');
  });

  test('an "everyone" cosmetic stays equipped for anyone', () => {
    const row = { username: 'someone', equipped_title: 'title_owner', admin_unlocks: [] };
    assert.equal(resolveEquipped(row, title('everyone')).title?.id, 'title_owner');
  });

  test('a grant-only paint falls back to the default rather than vanishing', () => {
    const custom = { paints: [{ id: 'paint_owner', label: 'Owner', level: 1, color: '#ff0000', custom: true, availability: 'grant' }] };
    const row = { username: 'someone', equipped_paint: 'paint_owner', admin_unlocks: [] };
    assert.equal(resolveEquipped(row, custom).paint.id, 'paint_default');
  });

  // The bug the owner hit (§11m): the cosmetic and the grant were both correct,
  // but the row handed to resolveEquipped had been rebuilt without
  // `admin_unlocks`, so the grant check saw nothing and the title rendered as
  // nothing. Pinned here because the failure is silent and looks like the
  // cosmetic itself is broken.
  test('a row REBUILT without admin_unlocks loses a granted cosmetic (the §11m trap)', () => {
    const custom = title('grant');
    const granted = { username: 'car', equipped_title: 'title_owner', admin_unlocks: ['title_owner'] };
    assert.equal(resolveEquipped(granted, custom).title?.id, 'title_owner', 'with the grant list it renders');

    // Exactly the same player, via a row that forgot the column.
    const { admin_unlocks, ...withoutGrantList } = granted;
    assert.equal(
      resolveEquipped(withoutGrantList, custom).title,
      null,
      'without it the cosmetic silently disappears — hence state/profile.js NAMEPLATE_COLUMNS',
    );
  });

  test('a granted cosmetic still needs the custom registry to resolve', () => {
    const granted = { username: 'car', equipped_title: 'title_owner', admin_unlocks: ['title_owner'] };
    // The second half of the same bug: header.js was passing no `custom` at all,
    // so an admin-authored title was not in the registry to be found.
    assert.equal(resolveEquipped(granted, null).title, null, 'no registry, nothing to resolve');
    assert.equal(resolveEquipped(granted, title('grant')).title?.id, 'title_owner');
  });

  test('built-in cosmetics are never hidden and ignore availability', () => {
    const resolved = resolveCosmetics({ level: 1, achievementsUnlocked: [] });
    for (const kind of ['badges', 'titles', 'paints']) {
      assert.ok(resolved[kind].every((c) => c.hidden === false), `${kind} should never be hidden`);
    }
  });
});
