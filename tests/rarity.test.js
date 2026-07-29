import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RARITIES, RARITY_BY_ID, TOTAL_SPECIAL_CHANCE, pointsForRarity, multiplierForRarity, jokerTierForRoll } from '../src/core/rarity.js';

describe('pointsForRarity', () => {
  test('computes basePoints + perRankPoints * rank for each non-joker tier', () => {
    assert.equal(pointsForRarity('bronze', 2), 150 + 12 * 2);
    assert.equal(pointsForRarity('bronze', 14), 150 + 12 * 14);
    assert.equal(pointsForRarity('silver', 7), 210 + 18 * 7);
    assert.equal(pointsForRarity('gold', 10), 300 + 25 * 10);
  });

  test('joker is flat regardless of rank, and depends on jokerTier (bronze/silver/gold) not rank', () => {
    assert.equal(pointsForRarity('joker', 2, 'bronze'), RARITY_BY_ID.bronze.basePoints);
    assert.equal(pointsForRarity('joker', 14, 'bronze'), RARITY_BY_ID.bronze.basePoints);
    assert.equal(pointsForRarity('joker', 2, 'gold'), RARITY_BY_ID.gold.basePoints);
  });

  test('joker defaults to the bronze sub-tier when no jokerTier is given', () => {
    assert.equal(pointsForRarity('joker', 9), RARITY_BY_ID.bronze.basePoints);
  });

  test('returns 0 for a falsy or unknown rarity id', () => {
    assert.equal(pointsForRarity(null, 10), 0);
    assert.equal(pointsForRarity('platinum', 10), 0);
  });

  test('every non-joker tier scores strictly higher at Ace (14) than at the lowest rank (2)', () => {
    for (const tier of RARITIES) {
      if (tier.id === 'joker') continue;
      const low = pointsForRarity(tier.id, 2);
      const high = pointsForRarity(tier.id, 14);
      assert.ok(high > low, `${tier.id} should scale with rank`);
    }
  });

  test('tiers are ordered bronze < silver < gold — odds-calibrated, not arbitrary', () => {
    // See DESIGN.md §3m: each tier's *average* value (around rank 8) is set
    // to land where that tier's true per-hand probability would land on the
    // hand-rank score table — this just checks the resulting ordering holds.
    const avgRank = 8;
    const bronze = pointsForRarity('bronze', avgRank);
    const silver = pointsForRarity('silver', avgRank);
    const gold = pointsForRarity('gold', avgRank);
    assert.ok(bronze < silver);
    assert.ok(silver < gold);
  });

  test("a Joker's own flavor (bronze/silver/gold) is worth the same as a plain card of that tier (owner request: same rarities as normal cards)", () => {
    for (const flavor of ['bronze', 'silver', 'gold']) {
      assert.equal(pointsForRarity('joker', 9, flavor), RARITY_BY_ID[flavor].basePoints);
    }
  });
});

describe('multiplierForRarity', () => {
  test('is strictly increasing bronze < silver < gold', () => {
    const bronze = multiplierForRarity('bronze');
    const silver = multiplierForRarity('silver');
    const gold = multiplierForRarity('gold');
    assert.ok(bronze < silver && silver < gold);
  });

  test("a joker's multiplier matches whichever of bronze/silver/gold it rolled", () => {
    assert.equal(multiplierForRarity('joker', 'bronze'), RARITY_BY_ID.bronze.multiplier);
    assert.equal(multiplierForRarity('joker', 'silver'), RARITY_BY_ID.silver.multiplier);
    assert.equal(multiplierForRarity('joker', 'gold'), RARITY_BY_ID.gold.multiplier);
  });

  test('every tier multiplier is greater than 1 (always boosts, never shrinks)', () => {
    for (const tier of RARITIES) {
      if (tier.id === 'joker') continue;
      assert.ok(multiplierForRarity(tier.id) > 1);
    }
  });

  test('unknown rarity id multiplies by 1 (no effect)', () => {
    assert.equal(multiplierForRarity(null), 1);
    assert.equal(multiplierForRarity('platinum'), 1);
  });
});

describe('jokerTierForRoll (owner request: "the joker should just have the same rarities as the normal cards")', () => {
  test('every roll in [0, 1) resolves to bronze, silver, gold, or diamond', () => {
    const validIds = new Set(['bronze', 'silver', 'gold', 'diamond']);
    for (let roll = 0; roll < 1; roll += 0.037) {
      assert.ok(validIds.has(jokerTierForRoll(roll)), `roll ${roll} produced an invalid tier`);
    }
  });

  test('roll 0 lands on bronze (most common)', () => {
    assert.equal(jokerTierForRoll(0), 'bronze');
  });

  test('a roll just under 1 lands on diamond (rarest)', () => {
    assert.equal(jokerTierForRoll(0.999999), 'diamond');
  });

  test('frequency is strictly decreasing bronze > silver > gold > diamond (mirrors bronze:silver:gold:diamond = 70:30:10:1)', () => {
    const counts = { bronze: 0, silver: 0, gold: 0, diamond: 0 };
    const samples = 100000;
    for (let i = 0; i < samples; i++) {
      counts[jokerTierForRoll(i / samples)]++;
    }
    assert.ok(counts.bronze > counts.silver);
    assert.ok(counts.silver > counts.gold);
    assert.ok(counts.gold > counts.diamond);
    assert.ok(counts.diamond > 0, 'diamond should still occur at least once in 100000 samples');
  });
});

describe('RARITIES / RARITY_BY_ID / TOTAL_SPECIAL_CHANCE', () => {
  test('RARITY_BY_ID has an entry for every declared tier', () => {
    for (const tier of RARITIES) {
      assert.equal(RARITY_BY_ID[tier.id], tier);
    }
  });

  test('TOTAL_SPECIAL_CHANCE is the sum of every tier chance and stays well under 100%', () => {
    const manualSum = RARITIES.reduce((sum, t) => sum + t.chance, 0);
    assert.equal(TOTAL_SPECIAL_CHANCE, manualSum);
    assert.ok(TOTAL_SPECIAL_CHANCE > 0 && TOTAL_SPECIAL_CHANCE < 1);
  });

  test('joker is rarer than bronze/silver/gold, but diamond (owner request) is rarer still', () => {
    const joker = RARITY_BY_ID.joker;
    const diamond = RARITY_BY_ID.diamond;
    for (const tier of RARITIES) {
      if (tier.id === 'joker' || tier.id === 'diamond') continue;
      assert.ok(joker.chance < tier.chance);
    }
    assert.ok(diamond.chance < joker.chance, 'diamond should be the single rarest tier in the game');
  });

  test('diamond has an insanely high multiplier relative to gold (owner request)', () => {
    assert.ok(RARITY_BY_ID.diamond.multiplier > RARITY_BY_ID.gold.multiplier * 3);
  });
});
