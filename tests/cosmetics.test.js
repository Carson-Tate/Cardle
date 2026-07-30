import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGES,
  TITLES,
  NAME_PAINTS,
  DEFAULT_PAINT_ID,
  resolveCosmetics,
  resolveCosmeticsForXp,
  resolveEquipped,
  canEquip,
} from '../src/core/cosmetics.js';
import { ACHIEVEMENTS } from '../src/core/achievements.js';
import { totalXpForLevel } from '../src/core/progression.js';

describe('registries', () => {
  test('there is exactly one badge per achievement, generated from the registry', () => {
    assert.equal(BADGES.length, ACHIEVEMENTS.length);
    for (const achievement of ACHIEVEMENTS) {
      const badge = BADGES.find((b) => b.achievementId === achievement.id);
      assert.ok(badge, `no badge for achievement ${achievement.id}`);
      assert.equal(badge.emoji, achievement.emoji);
      assert.equal(badge.label, achievement.label);
    }
  });

  test('every cosmetic id is unique across all three kinds', () => {
    const ids = [...BADGES, ...TITLES, ...NAME_PAINTS].map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  // These ids are persisted and pattern-checked in the schema, so what matters
  // is that they contain nothing needing escaping — not their casing. Badge ids
  // are generated from achievement ids, which are camelCase throughout the
  // codebase (`royalFlushClub`), so this allows both cases rather than forcing
  // a lowercase transform that would need an inverse mapping to maintain.
  test('every cosmetic id is a safe alphanumeric slug', () => {
    for (const c of [...BADGES, ...TITLES, ...NAME_PAINTS]) {
      assert.match(c.id, /^[A-Za-z0-9_]{1,40}$/, `bad id: ${c.id}`);
    }
  });

  test('exactly five basic colours plus a default are available from level 1', () => {
    const atLevelOne = NAME_PAINTS.filter((p) => p.level <= 1);
    assert.equal(atLevelOne.length, 6, 'expected the default plus 5 colours');
    assert.equal(atLevelOne.filter((p) => p.id === DEFAULT_PAINT_ID).length, 1);
    assert.equal(atLevelOne.filter((p) => p.id !== DEFAULT_PAINT_ID).length, 5);
  });

  test('titles and paints are ordered by ascending unlock level', () => {
    for (const list of [TITLES, NAME_PAINTS]) {
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].level >= list[i - 1].level, `${list[i].id} is out of order`);
      }
    }
  });

  test('no title is available at level 1 — a title has to be earned', () => {
    assert.equal(TITLES.filter((t) => t.level <= 1).length, 0);
  });
});

describe('resolveCosmetics', () => {
  test('a brand new player has the basic paints and nothing else', () => {
    const { badges, titles, paints } = resolveCosmetics({ level: 1, achievementsUnlocked: [] });
    assert.equal(badges.filter((b) => b.unlocked).length, 0);
    assert.equal(titles.filter((t) => t.unlocked).length, 0);
    assert.equal(paints.filter((p) => p.unlocked).length, 6);
  });

  test('badges unlock from achievements, not level', () => {
    const highLevelNoAchievements = resolveCosmetics({ level: 99, achievementsUnlocked: [] });
    assert.equal(highLevelNoAchievements.badges.filter((b) => b.unlocked).length, 0);

    const oneAchievement = resolveCosmetics({ level: 1, achievementsUnlocked: ['firstSteps'] });
    const unlocked = oneAchievement.badges.filter((b) => b.unlocked);
    assert.equal(unlocked.length, 1);
    assert.equal(unlocked[0].achievementId, 'firstSteps');
  });

  test('titles and paints unlock from level, not achievements', () => {
    const everyAchievement = resolveCosmetics({ level: 1, achievementsUnlocked: ACHIEVEMENTS.map((a) => a.id) });
    assert.equal(everyAchievement.titles.filter((t) => t.unlocked).length, 0);
    assert.equal(everyAchievement.paints.filter((p) => p.unlocked).length, 6);

    const levelTen = resolveCosmetics({ level: 10, achievementsUnlocked: [] });
    assert.ok(levelTen.titles.filter((t) => t.unlocked).length >= 5);
    assert.ok(levelTen.paints.filter((p) => p.unlocked).length > 6);
  });

  test('unlocking is inclusive at the exact threshold level', () => {
    for (const title of TITLES) {
      const atLevel = resolveCosmetics({ level: title.level }).titles.find((t) => t.id === title.id);
      const below = resolveCosmetics({ level: title.level - 1 }).titles.find((t) => t.id === title.id);
      assert.equal(atLevel.unlocked, true, `${title.id} should unlock AT level ${title.level}`);
      assert.equal(below.unlocked, false, `${title.id} should be locked below level ${title.level}`);
    }
  });

  test('locked entries carry a readable requirement', () => {
    const { badges, titles, paints } = resolveCosmetics({ level: 1, achievementsUnlocked: [] });
    assert.match(badges[0].requirementText, /^Achievement: /);
    assert.match(titles[0].requirementText, /^Reach level \d+$/);
    assert.equal(paints.find((p) => p.id === DEFAULT_PAINT_ID).requirementText, 'Available from the start');
  });

  test('tolerates missing or nonsense input', () => {
    for (const bad of [undefined, {}, { level: NaN }, { level: null, achievementsUnlocked: null }]) {
      const resolved = resolveCosmetics(bad);
      assert.equal(resolved.paints.filter((p) => p.unlocked).length, 6, 'basics stay available');
      assert.equal(resolved.badges.filter((b) => b.unlocked).length, 0);
    }
  });

  test('resolveCosmeticsForXp agrees with the level it derives', () => {
    const xp = totalXpForLevel(8);
    const fromXp = resolveCosmeticsForXp(xp, []);
    const fromLevel = resolveCosmetics({ level: 8, achievementsUnlocked: [] });
    assert.deepEqual(
      fromXp.titles.map((t) => t.unlocked),
      fromLevel.titles.map((t) => t.unlocked),
    );
  });
});

describe('resolveEquipped', () => {
  test('resolves stored ids into registry entries', () => {
    const equipped = resolveEquipped({
      equipped_badge: 'badge_firstSteps',
      equipped_title: 'title_sharp',
      equipped_paint: 'paint_crimson',
    });
    assert.equal(equipped.badge.achievementId, 'firstSteps');
    assert.equal(equipped.title.label, 'Sharp');
    assert.equal(equipped.paint.label, 'Crimson');
  });

  // The database only pattern-constrains these columns, so an unknown id can
  // physically exist (a retired cosmetic, or a value written straight through
  // the REST API). It must never reach the DOM.
  test('unknown, empty, or malicious ids resolve to nothing rather than passing through', () => {
    for (const bad of ['nope', '', null, undefined, '<script>', 'badge_does_not_exist']) {
      const equipped = resolveEquipped({ equipped_badge: bad, equipped_title: bad, equipped_paint: bad });
      assert.equal(equipped.badge, null, `badge should be null for ${String(bad)}`);
      assert.equal(equipped.title, null, `title should be null for ${String(bad)}`);
      assert.equal(equipped.paint.id, DEFAULT_PAINT_ID, `paint should fall back for ${String(bad)}`);
    }
  });

  test('tolerates a missing profile row entirely', () => {
    for (const row of [null, undefined, {}]) {
      const equipped = resolveEquipped(row);
      assert.equal(equipped.badge, null);
      assert.equal(equipped.title, null);
      assert.equal(equipped.paint.id, DEFAULT_PAINT_ID);
    }
  });
});

describe('canEquip', () => {
  const player = { level: 5, achievementsUnlocked: ['firstSteps'] };

  test('allows an unlocked cosmetic', () => {
    assert.equal(canEquip('badges', 'badge_firstSteps', player), true);
    assert.equal(canEquip('paints', 'paint_sunset', player), true);
    assert.equal(canEquip('titles', 'title_card_counter', player), true);
  });

  test('refuses a locked cosmetic', () => {
    assert.equal(canEquip('badges', 'badge_veteran', player), false);
    assert.equal(canEquip('paints', 'paint_jackpot', player), false);
    assert.equal(canEquip('titles', 'title_immortal', player), false);
  });

  test('refuses an unknown id or kind', () => {
    assert.equal(canEquip('badges', 'badge_nonsense', player), false);
    assert.equal(canEquip('nope', 'badge_firstSteps', player), false);
  });

  test('clearing a slot is always allowed', () => {
    for (const empty of [null, undefined, '']) {
      assert.equal(canEquip('titles', empty, player), true);
    }
  });
});

describe('admin-granted unlocks', () => {
  test('an admin grant unlocks something not otherwise earned', () => {
    const player = { level: 1, achievementsUnlocked: [], adminUnlocks: ['badge_veteran', 'title_immortal', 'paint_jackpot'] };
    const { badges, titles, paints } = resolveCosmetics(player);
    assert.equal(badges.find((b) => b.id === 'badge_veteran').unlocked, true);
    assert.equal(titles.find((t) => t.id === 'title_immortal').unlocked, true);
    assert.equal(paints.find((p) => p.id === 'paint_jackpot').unlocked, true);
  });

  test('granted entries are flagged so they can be shown differently', () => {
    const { badges } = resolveCosmetics({ level: 1, achievementsUnlocked: [], adminUnlocks: ['badge_veteran'] });
    assert.equal(badges.find((b) => b.id === 'badge_veteran').grantedByAdmin, true);
  });

  test('a legitimately earned cosmetic is not flagged as granted', () => {
    const { badges } = resolveCosmetics({
      level: 1,
      achievementsUnlocked: ['firstSteps'],
      adminUnlocks: ['firstSteps', 'badge_firstSteps'],
    });
    const badge = badges.find((b) => b.id === 'badge_firstSteps');
    assert.equal(badge.unlocked, true);
    assert.equal(badge.grantedByAdmin, false, 'earned normally, so not marked as a grant');
  });

  test('grants are additive — they never re-lock what was earned', () => {
    const earned = resolveCosmetics({ level: 20, achievementsUnlocked: ['veteran'], adminUnlocks: [] });
    const withGrant = resolveCosmetics({ level: 20, achievementsUnlocked: ['veteran'], adminUnlocks: ['paint_jackpot'] });
    for (const kind of ['badges', 'titles', 'paints']) {
      for (const before of earned[kind]) {
        if (!before.unlocked) continue;
        assert.equal(withGrant[kind].find((c) => c.id === before.id).unlocked, true, `${before.id} was re-locked`);
      }
    }
  });

  test('canEquip honours an admin grant', () => {
    const player = { level: 1, achievementsUnlocked: [], adminUnlocks: ['paint_jackpot'] };
    assert.equal(canEquip('paints', 'paint_jackpot', player), true);
    assert.equal(canEquip('paints', 'paint_royal', player), false, 'ungranted and unearned stays refused');
  });

  test('an unknown id in admin_unlocks unlocks nothing and does not throw', () => {
    const resolved = resolveCosmetics({ level: 1, achievementsUnlocked: [], adminUnlocks: ['not_a_cosmetic', '<script>'] });
    assert.equal(resolved.badges.filter((b) => b.unlocked).length, 0);
    assert.equal(resolved.titles.filter((t) => t.unlocked).length, 0);
    assert.equal(resolved.paints.filter((p) => p.unlocked).length, 6);
  });

  test('tolerates null adminUnlocks', () => {
    assert.doesNotThrow(() => resolveCosmetics({ level: 1, achievementsUnlocked: null, adminUnlocks: null }));
  });
});
