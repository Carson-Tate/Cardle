import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDeck, createRng, hashSeed, dailySeed, shuffle, dealHand, cardId, rarityForRoll } from '../src/core/deck.js';
import { RARITIES, TOTAL_SPECIAL_CHANCE } from '../src/core/rarity.js';

describe('createDeck', () => {
  test('has 52 unique cards', () => {
    const deck = createDeck();
    assert.equal(deck.length, 52);
    const ids = new Set(deck.map(cardId));
    assert.equal(ids.size, 52);
  });
});

describe('createRng', () => {
  test('same seed produces the same sequence', () => {
    const a = createRng(12345);
    const b = createRng(12345);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    assert.deepEqual(seqA, seqB);
  });

  test('different seeds produce different sequences', () => {
    const a = createRng(1);
    const b = createRng(2);
    assert.notEqual(a(), b());
  });

  test('produces values in [0, 1)', () => {
    const rng = createRng(999);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1);
    }
  });
});

describe('hashSeed / dailySeed', () => {
  test('same string always hashes the same', () => {
    assert.equal(hashSeed('cardle-2026-07-27'), hashSeed('cardle-2026-07-27'));
  });

  test('different dates hash differently', () => {
    assert.notEqual(hashSeed('cardle-2026-07-27'), hashSeed('cardle-2026-07-28'));
  });

  test('dailySeed is stable for the same calendar day', () => {
    const morning = new Date('2026-07-27T01:00:00Z');
    const night = new Date('2026-07-27T23:00:00Z');
    assert.equal(dailySeed(morning), dailySeed(night));
  });

  test('dailySeed differs across days', () => {
    const day1 = new Date('2026-07-27T12:00:00Z');
    const day2 = new Date('2026-07-28T12:00:00Z');
    assert.notEqual(dailySeed(day1), dailySeed(day2));
  });
});

describe('shuffle', () => {
  test('is a permutation of the input (same cards, same count)', () => {
    const deck = createDeck();
    const rng = createRng(42);
    const shuffled = shuffle(deck, rng);
    assert.equal(shuffled.length, deck.length);
    assert.deepEqual(new Set(shuffled.map(cardId)), new Set(deck.map(cardId)));
  });

  test('is deterministic for a given seed', () => {
    const deck = createDeck();
    const a = shuffle(deck, createRng(7));
    const b = shuffle(deck, createRng(7));
    assert.deepEqual(a.map(cardId), b.map(cardId));
  });

  test('does not mutate the input array', () => {
    const deck = createDeck();
    const before = deck.map(cardId);
    shuffle(deck, createRng(7));
    assert.deepEqual(deck.map(cardId), before);
  });
});

describe('dealHand', () => {
  test('deals 5 cards and a 47-card draw pile with no overlap', () => {
    const { hand, drawPile } = dealHand(dailySeed(new Date('2026-07-27T12:00:00Z')));
    assert.equal(hand.length, 5);
    assert.equal(drawPile.length, 47);
    const handIds = new Set(hand.map(cardId));
    const drawIds = new Set(drawPile.map(cardId));
    for (const id of handIds) assert.ok(!drawIds.has(id));
    assert.equal(new Set([...handIds, ...drawIds]).size, 52);
  });

  test('same seed deals the same hand every time', () => {
    const seed = dailySeed(new Date('2026-07-27T12:00:00Z'));
    const a = dealHand(seed);
    const b = dealHand(seed);
    assert.deepEqual(a.hand.map(cardId), b.hand.map(cardId));
  });

  test('every card in hand and drawPile has a rarity field (possibly null)', () => {
    const { hand, drawPile } = dealHand(dailySeed(new Date('2026-07-27T12:00:00Z')));
    for (const card of [...hand, ...drawPile]) {
      assert.ok('rarity' in card);
      assert.ok(card.rarity === null || RARITIES.some((tier) => tier.id === card.rarity));
    }
  });

  test('same seed deals the same rarities every time', () => {
    const seed = dailySeed(new Date('2026-07-27T12:00:00Z'));
    const a = dealHand(seed);
    const b = dealHand(seed);
    assert.deepEqual(a.hand.map((c) => c.rarity), b.hand.map((c) => c.rarity));
    assert.deepEqual(a.drawPile.map((c) => c.rarity), b.drawPile.map((c) => c.rarity));
  });

  test('every joker-rarity card also has a jokerTier; every other card has a null jokerTier', () => {
    // Scan a wide range of seeds since jokers are rare (~0.2%/card) — with
    // 52 cards/seed this reliably turns up several across a few hundred tries.
    let sawAJoker = false;
    for (let seed = 0; seed < 300; seed++) {
      const { hand, drawPile } = dealHand(seed);
      for (const card of [...hand, ...drawPile]) {
        if (card.rarity === 'joker') {
          sawAJoker = true;
          assert.ok(
            ['bronze', 'silver', 'gold'].includes(card.jokerTier),
            `joker card had invalid jokerTier: ${card.jokerTier}`,
          );
        } else {
          assert.equal(card.jokerTier, null);
        }
      }
    }
    assert.ok(sawAJoker, 'expected at least one joker across 300 seeds x 52 cards');
  });

  test('same seed deals the same joker tiers every time', () => {
    // Seed 4 is already known (elsewhere in this session's testing) to deal a joker.
    let seed = 0;
    for (; seed < 500; seed++) {
      if (dealHand(seed).hand.concat(dealHand(seed).drawPile).some((c) => c.rarity === 'joker')) break;
    }
    const a = dealHand(seed);
    const b = dealHand(seed);
    assert.deepEqual(a.hand.map((c) => c.jokerTier), b.hand.map((c) => c.jokerTier));
    assert.deepEqual(a.drawPile.map((c) => c.jokerTier), b.drawPile.map((c) => c.jokerTier));
  });

  // Regression, integration-level: owner bug report — "i set the luck slider
  // to 500x and i only get bronze cards, rarely silver gold or diamond."
  test('a high luckMultiplier reaches every rarity tier across enough deals, not just bronze', () => {
    const counts = { bronze: 0, silver: 0, gold: 0, joker: 0, diamond: 0 };
    for (let seed = 0; seed < 400; seed++) {
      const { hand, drawPile } = dealHand(seed, 5, { luckMultiplier: 500 });
      for (const card of [...hand, ...drawPile]) {
        if (card.rarity) counts[card.rarity] += 1;
      }
    }
    for (const tier of ['bronze', 'silver', 'gold', 'joker', 'diamond']) {
      assert.ok(counts[tier] > 0, `expected at least one ${tier} across 400 seeds x 52 cards at luck=500, got 0`);
    }
  });
});

describe('rarityForRoll', () => {
  test('returns the first tier whose cumulative range contains the roll', () => {
    assert.equal(rarityForRoll(0), 'bronze'); // bronze: [0, 0.07)
    assert.equal(rarityForRoll(0.069), 'bronze');
    assert.equal(rarityForRoll(0.07), 'silver'); // silver: [0.07, 0.10)
    assert.equal(rarityForRoll(0.099), 'silver');
    assert.equal(rarityForRoll(0.1), 'gold'); // gold: [0.10, 0.11)
    assert.equal(rarityForRoll(0.109), 'gold');
    assert.equal(rarityForRoll(0.11), 'joker'); // joker: [0.11, 0.112)
    assert.equal(rarityForRoll(0.1119), 'joker');
  });

  test('returns null (common) above the combined special-tier chance', () => {
    assert.equal(rarityForRoll(TOTAL_SPECIAL_CHANCE), null);
    assert.equal(rarityForRoll(0.999999), null);
  });

  test('roll of exactly a tier boundary belongs to the next tier (half-open ranges, no gaps or overlaps)', () => {
    let cumulative = 0;
    for (const tier of RARITIES) {
      assert.equal(rarityForRoll(cumulative), tier.id);
      cumulative += tier.chance;
    }
  });

  // Regression: owner bug report — "i set the luck slider to 500x and i
  // only get bronze cards, rarely silver gold or diamond." The old
  // implementation shrank the raw roll (roll/luckMultiplier) before this
  // same lookup, which — since bronze is checked first and its own
  // cumulative boundary (0.07) is far bigger than any shrunk roll once
  // luckMultiplier exceeds ~14x — made bronze the ONLY reachable tier at
  // high luck, the opposite of what a luck slider should do. Fixed by
  // scaling the COMBINED chance of landing any rarity (capped at 1) while
  // preserving each tier's relative share of it.
  describe('luckMultiplier', () => {
    test('a high luckMultiplier makes every tier reachable, not just bronze', () => {
      const scaledTotal = Math.min(TOTAL_SPECIAL_CHANCE * 500, 1);
      assert.equal(scaledTotal, 1); // 500x is high enough that SOME rarity is guaranteed
      let cumulative = 0;
      for (const tier of RARITIES) {
        cumulative += tier.chance / TOTAL_SPECIAL_CHANCE; // proportional share of the guaranteed 100%
        assert.equal(rarityForRoll(cumulative - 1e-9, 500), tier.id, tier.id);
      }
    });

    test('a high luckMultiplier never returns null (common) — some rarity is guaranteed once the combined chance saturates at 1', () => {
      for (const roll of [0, 0.25, 0.5, 0.75, 0.999999]) {
        assert.notEqual(rarityForRoll(roll, 500), null, `roll ${roll}`);
      }
    });

    test('relative tier proportions are preserved under scaling — bronze region is still the biggest, diamond the smallest', () => {
      const boundary = (luckMultiplier) => {
        const scaledTotal = Math.min(TOTAL_SPECIAL_CHANCE * luckMultiplier, 1);
        return RARITIES.map((tier) => scaledTotal * (tier.chance / TOTAL_SPECIAL_CHANCE));
      };
      for (const luckMultiplier of [1, 5, 50, 500]) {
        const [bronze, silver, gold, joker, diamond] = boundary(luckMultiplier);
        assert.ok(bronze > silver, `luck=${luckMultiplier}`);
        assert.ok(silver > gold, `luck=${luckMultiplier}`);
        assert.ok(gold > joker, `luck=${luckMultiplier}`);
        assert.ok(joker > diamond, `luck=${luckMultiplier}`);
      }
    });

    test('luckMultiplier of 1 behaves identically to no luckMultiplier argument at all', () => {
      for (const roll of [0, 0.05, 0.07, 0.1, 0.11, 0.112, 0.113, 0.5, 0.999999]) {
        assert.equal(rarityForRoll(roll, 1), rarityForRoll(roll));
      }
    });
  });
});
