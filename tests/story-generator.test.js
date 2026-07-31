import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmojiGrid,
  getPoolKeys,
  getStoryOptions,
  getDefaultSelections,
  buildStoryTextFromSelections,
  buildStoryText,
  buildShareText,
  buildFinalHandText,
  generateStory,
} from '../src/story/generator.js';
import { FRAGMENTS, SLOT_META } from '../src/story/templates.js';
import { HAND_RANKS } from '../src/core/hand-evaluator.js';

const c = (rank, suit) => ({ rank, suit });
const ZERO_SELECTIONS = { opening: 0, action: 0, object: 0, connector: 0, ending: 0, emoji: 0 };

describe('buildEmojiGrid', () => {
  test('shows suit glyphs with a marker on drawn positions', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    assert.equal(buildEmojiGrid(hand, [1, 3]), '♠ ♥✨ ♦ ♣✨ ♠');
  });

  test('no markers when nothing was discarded', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    assert.equal(buildEmojiGrid(hand, []), '♠ ♥ ♦ ♣ ♠');
  });

  test('never reveals rank, only suit', () => {
    const hand = [c(14, 'S'), c(14, 'H'), c(14, 'D'), c(14, 'C'), c(14, 'S')];
    const grid = buildEmojiGrid(hand, [0]);
    assert.ok(!/\d/.test(grid));
  });
});

describe('getPoolKeys', () => {
  test('every non-ending slot always resolves to its own flat pool key, regardless of the hand', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')]; // pair
    const keys = getPoolKeys(hand, hand, []);
    assert.equal(keys.opening, 'opening');
    assert.equal(keys.action, 'action');
    assert.equal(keys.object, 'object');
    assert.equal(keys.connector, 'connector');
    assert.equal(keys.emoji, 'emoji');
  });

  test('ending key reflects whether the final hand is Two Pair+ ("good") or not ("bad")', () => {
    const weak = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')]; // pair
    const strong = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(2, 'C'), c(5, 'S')]; // two pair
    assert.equal(getPoolKeys(weak, weak, []).ending, 'ending.bad');
    assert.equal(getPoolKeys(strong, strong, []).ending, 'ending.good');
  });
});

describe('getStoryOptions', () => {
  test('every slot has more than one option (a real choice to make)', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    const options = getStoryOptions(hand, hand, []);
    for (const slot of Object.keys(SLOT_META)) {
      assert.ok(options[slot].length > 1, `${slot} should offer more than one choice`);
    }
  });

  test('ending pool switches between good/bad based on the final hand, independent of the original hand', () => {
    const weak = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')]; // high card
    const strong = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(2, 'C'), c(5, 'S')]; // two pair
    const date = new Date('2026-01-01T00:00:00Z'); // fixed, since ending's pool is now also daily-rotated
    const badPool = getStoryOptions(weak, weak, [], date).ending;
    const goodPool = getStoryOptions(weak, strong, [], date).ending;
    for (const phrase of badPool) assert.ok(FRAGMENTS.ending.bad.includes(phrase), phrase);
    for (const phrase of goodPool) assert.ok(FRAGMENTS.ending.good.includes(phrase), phrase);
    assert.notDeepEqual(badPool, goodPool);
  });

  test('opening/action/object/connector/emoji never change with the hand', () => {
    const weak = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    const strong = [c(14, 'S'), c(13, 'S'), c(12, 'S'), c(11, 'S'), c(10, 'S')];
    const a = getStoryOptions(weak, weak, []);
    const b = getStoryOptions(strong, strong, [1, 2]);
    for (const slot of ['opening', 'action', 'object', 'connector', 'emoji']) {
      assert.deepEqual(a[slot], b[slot]);
    }
  });
});

describe('daily rotation (owner request: "i would like for it to not be the same words everyday")', () => {
  const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];

  test('the same day always produces the same pool (deterministic, shared by every player that day)', () => {
    const date = new Date('2026-03-14T12:00:00Z');
    const a = getStoryOptions(hand, hand, [], date);
    const b = getStoryOptions(hand, hand, [], date);
    assert.deepEqual(a, b);
  });

  test('different calendar days produce different pools for slots bigger than the daily cap', () => {
    const day1 = getStoryOptions(hand, hand, [], new Date('2026-01-01T00:00:00Z'));
    const day2 = getStoryOptions(hand, hand, [], new Date('2026-06-15T00:00:00Z'));
    // opening/action/object all exceed the daily cap, so they should rotate.
    assert.notDeepEqual(day1.opening, day2.opening);
    assert.notDeepEqual(day1.action, day2.action);
    assert.notDeepEqual(day1.object, day2.object);
  });

  test('every option shown on a given day is actually drawn from that slot\'s master vocabulary', () => {
    const options = getStoryOptions(hand, hand, [], new Date('2026-05-05T00:00:00Z'));
    for (const phrase of options.opening) assert.ok(FRAGMENTS.opening.includes(phrase), phrase);
    for (const phrase of options.action) assert.ok(FRAGMENTS.action.includes(phrase), phrase);
    for (const phrase of options.object) assert.ok(FRAGMENTS.object.includes(phrase), phrase);
    for (const phrase of options.emoji) assert.ok(FRAGMENTS.emoji.includes(phrase), phrase);
  });

  test('a single day\'s rotated pool never contains duplicates', () => {
    const options = getStoryOptions(hand, hand, [], new Date('2026-02-02T00:00:00Z'));
    for (const slot of Object.keys(options)) {
      assert.equal(new Set(options[slot]).size, options[slot].length, slot);
    }
  });

  test('slots smaller than the daily cap (connector) show their whole pool every day, unrotated', () => {
    const options = getStoryOptions(hand, hand, [], new Date('2026-04-04T00:00:00Z'));
    assert.deepEqual([...options.connector].sort(), [...FRAGMENTS.connector].sort());
  });
});

describe('getDefaultSelections', () => {
  test('is deterministic for the same run', () => {
    const original = [c(13, 'S'), c(13, 'H'), c(8, 'D'), c(5, 'C'), c(2, 'S')];
    const final = [c(13, 'S'), c(13, 'H'), c(8, 'D'), c(8, 'C'), c(11, 'S')];
    const a = getDefaultSelections(original, final, [3, 4]);
    const b = getDefaultSelections(original, final, [3, 4]);
    assert.deepEqual(a, b);
  });

  test('every selected index is in range for its pool', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    const options = getStoryOptions(hand, hand, []);
    const selections = getDefaultSelections(hand, hand, []);
    for (const slot of Object.keys(SLOT_META)) {
      assert.ok(selections[slot] >= 0 && selections[slot] < options[slot].length);
    }
  });
});

describe('buildStoryTextFromSelections', () => {
  test('picking different slot values changes the assembled text', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    const a = buildStoryTextFromSelections(hand, hand, [], ZERO_SELECTIONS);
    const b = buildStoryTextFromSelections(hand, hand, [], { ...ZERO_SELECTIONS, action: 1 });
    assert.notEqual(a, b);
  });

  test('falls back to option 0 for an out-of-range or missing index', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    const withGarbageIndex = buildStoryTextFromSelections(hand, hand, [], { ...ZERO_SELECTIONS, opening: 999, action: -1 });
    const withZeroes = buildStoryTextFromSelections(hand, hand, [], ZERO_SELECTIONS);
    assert.equal(withGarbageIndex, withZeroes);

    const withMissingSelections = buildStoryTextFromSelections(hand, hand, [], {});
    assert.equal(withMissingSelections, withZeroes);
  });

  test('assembles all 6 slots into one space-joined sentence, in slot order', () => {
    const hand = [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')];
    const options = getStoryOptions(hand, hand, []);
    const text = buildStoryTextFromSelections(hand, hand, [], ZERO_SELECTIONS);
    assert.equal(
      text,
      `${options.opening[0]} ${options.action[0]} ${options.object[0]} ${options.connector[0]} ${options.ending[0]} ${options.emoji[0]}`,
    );
  });

  test('is a single line, not multiple', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    const text = buildStoryTextFromSelections(hand, hand, [], getDefaultSelections(hand, hand, []));
    assert.equal(text.split('\n').length, 1);
  });
});

describe('buildStoryText (default-selection convenience)', () => {
  test('is deterministic for the same run', () => {
    const original = [c(13, 'S'), c(13, 'H'), c(8, 'D'), c(5, 'C'), c(2, 'S')];
    const final = [c(13, 'S'), c(13, 'H'), c(8, 'D'), c(8, 'C'), c(11, 'S')];
    assert.equal(buildStoryText(original, final, [3, 4]), buildStoryText(original, final, [3, 4]));
  });

  test('handles every poker hand category and discard count without throwing (catches missing pools)', () => {
    const examples = {
      ROYAL_FLUSH: [c(14, 'S'), c(13, 'S'), c(12, 'S'), c(11, 'S'), c(10, 'S')],
      STRAIGHT_FLUSH: [c(9, 'H'), c(8, 'H'), c(7, 'H'), c(6, 'H'), c(5, 'H')],
      FOUR_OF_A_KIND: [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(9, 'C'), c(2, 'S')],
      FULL_HOUSE: [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), c(2, 'S')],
      FLUSH: [c(2, 'D'), c(5, 'D'), c(9, 'D'), c(11, 'D'), c(13, 'D')],
      STRAIGHT: [c(9, 'S'), c(8, 'H'), c(7, 'D'), c(6, 'C'), c(5, 'S')],
      THREE_OF_A_KIND: [c(9, 'S'), c(9, 'H'), c(9, 'D'), c(2, 'C'), c(5, 'S')],
      FOUR_STRAIGHT: [c(8, 'S'), c(9, 'H'), c(10, 'D'), c(11, 'C'), c(2, 'S')],
      TWO_PAIR: [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(2, 'C'), c(5, 'S')],
      THREE_STRAIGHT: [c(8, 'S'), c(9, 'H'), c(10, 'D'), c(2, 'C'), c(13, 'S')],
      PAIR: [c(9, 'S'), c(9, 'H'), c(2, 'D'), c(4, 'C'), c(5, 'S')],
      HIGH_CARD: [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')],
    };
    assert.equal(Object.keys(examples).length, HAND_RANKS.length);

    for (const [id, finalHand] of Object.entries(examples)) {
      for (let discardCount = 0; discardCount <= 3; discardCount++) {
        const discardIndices = Array.from({ length: discardCount }, (_, i) => i);
        assert.doesNotThrow(
          () => buildStoryText(finalHand, finalHand, discardIndices),
          `threw for ${id} with ${discardCount} discards`,
        );
      }
    }
  });
});

describe('FRAGMENTS completeness', () => {
  test('every flat slot pool is non-empty', () => {
    for (const slot of ['opening', 'action', 'object', 'connector', 'emoji']) {
      assert.ok(Array.isArray(FRAGMENTS[slot]) && FRAGMENTS[slot].length > 0, slot);
    }
  });

  test('ending covers both good and bad', () => {
    for (const key of ['good', 'bad']) {
      assert.ok(Array.isArray(FRAGMENTS.ending[key]) && FRAGMENTS.ending[key].length > 0, `ending.${key}`);
    }
  });

  test('every category stays within a reasonable cap (enough variety without an overwhelming dropdown)', () => {
    const CAP = 40;
    const pools = [
      ['opening', FRAGMENTS.opening],
      ['action', FRAGMENTS.action],
      ['object', FRAGMENTS.object],
      ['connector', FRAGMENTS.connector],
      ['ending.good', FRAGMENTS.ending.good],
      ['ending.bad', FRAGMENTS.ending.bad],
      ['emoji', FRAGMENTS.emoji],
    ];
    for (const [key, pool] of pools) {
      assert.ok(pool.length <= CAP, `${key} has ${pool.length} options, expected <= ${CAP}`);
    }
  });

  test('no fragment has an internal period before its final character (would break the one-line sentence)', () => {
    // Ellipses ("...", a legitimate stylistic device) are stripped first so
    // they don't false-positive here.
    const allFragments = [
      ...FRAGMENTS.opening,
      ...FRAGMENTS.action,
      ...FRAGMENTS.object,
      ...FRAGMENTS.connector,
      ...FRAGMENTS.ending.good,
      ...FRAGMENTS.ending.bad,
      ...FRAGMENTS.emoji,
    ];
    for (const fragment of allFragments) {
      const withoutEllipses = fragment.replace(/\.\.\./g, '');
      const midStringPeriod = withoutEllipses.slice(0, -1).includes('.');
      assert.ok(!midStringPeriod, `"${fragment}" has a period before its final character`);
    }
  });

  test('no duplicate phrases within a single pool', () => {
    const pools = [FRAGMENTS.opening, FRAGMENTS.action, FRAGMENTS.object, FRAGMENTS.connector, FRAGMENTS.ending.good, FRAGMENTS.ending.bad, FRAGMENTS.emoji];
    for (const pool of pools) {
      assert.equal(new Set(pool).size, pool.length);
    }
  });

  test('SLOT_META has a label for every slot generateStory produces', () => {
    for (const slot of ['opening', 'action', 'object', 'connector', 'ending', 'emoji']) {
      assert.equal(typeof SLOT_META[slot]?.label, 'string');
    }
  });
});

// Owner bug report: the Share button was "not showing wilds/correct card the
// wild should be".
//
// A wild is an ordinary dealt card carrying a flag, so its own rank/suit are
// real, printable, and meaningless — leftover data from wherever it landed in
// the shuffle. Printing them unconditionally, which is what this used to do,
// erased the wild from the share text AND contradicted the hand name on the
// line above it.
describe('buildFinalHandText and wild cards', () => {
  const wild = (rank, suit) => ({ rank, suit, wild: true });
  // The legacy shape every stored hand still uses. isWild() accepts both, so
  // both must render identically — history would otherwise silently rewrite
  // itself the moment someone re-shared an old run.
  const legacyWild = (rank, suit) => ({ rank, suit, rarity: 'joker' });

  test('an ordinary hand is unchanged', () => {
    const hand = [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')];
    assert.equal(buildFinalHandText(hand), '2♠ 5♥ 9♦ J♣ K♠');
  });

  test('a wild shows the jester AND what it played as, not its meaningless dealt face', () => {
    // Dealt as 3♦, but the hand was scored with it acting as K♥.
    const hand = [c(13, 'S'), c(13, 'C'), c(13, 'D'), wild(3, 'D'), c(7, 'H')];
    const logical = [c(13, 'S'), c(13, 'C'), c(13, 'D'), c(13, 'H'), c(7, 'H')];
    const text = buildFinalHandText(hand, logical);
    assert.equal(text, 'K♠ K♣ K♦ 🃏→K♥ 7♥');
    assert.ok(!text.includes('3♦'), 'the wild\'s meaningless dealt face leaked into the share text');
  });

  test('the legacy rarity:"joker" shape renders identically', () => {
    const hand = [c(13, 'S'), legacyWild(3, 'D')];
    const logical = [c(13, 'S'), c(13, 'H')];
    assert.equal(buildFinalHandText(hand, logical), 'K♠ 🃏→K♥');
  });

  test('two wilds resolve to their OWN substitutions, not both to the first', () => {
    const hand = [wild(3, 'D'), wild(6, 'C'), c(13, 'S'), c(13, 'C'), c(7, 'H')];
    const logical = [c(13, 'H'), c(13, 'D'), c(13, 'S'), c(13, 'C'), c(7, 'H')];
    assert.equal(buildFinalHandText(hand, logical), '🃏→K♥ 🃏→K♦ K♠ K♣ 7♥');
  });

  test('falls back to a bare jester when no logical hand is available', () => {
    const hand = [c(13, 'S'), wild(3, 'D')];
    // Incomplete, but never WRONG — which is the point. The old behaviour
    // printed "3♦" here, actively misinforming the player.
    assert.equal(buildFinalHandText(hand), 'K♠ 🃏');
  });

  test('a missing rank or suit degrades to empty, never the string "undefined"', () => {
    assert.equal(buildFinalHandText([{ rank: 13 }, { suit: 'S' }]), 'K ♠');
  });

  test('the emoji grid marks a wild as a wild rather than an unrelated suit', () => {
    const hand = [c(2, 'S'), wild(5, 'H'), c(9, 'D')];
    assert.equal(buildEmojiGrid(hand, []), '♠ 🃏 ♦');
  });

  test('generateStory feeds the logical hand through to the share text', () => {
    const result = {
      dayNumber: 7,
      originalHand: [c(13, 'S'), c(13, 'C'), c(13, 'D'), wild(3, 'D'), c(7, 'H')],
      finalHand: [c(13, 'S'), c(13, 'C'), c(13, 'D'), wild(3, 'D'), c(7, 'H')],
      discardIndices: [],
      score: {
        handResult: { label: 'Four of a Kind' },
        total: 500,
        logicalFinalHand: [c(13, 'S'), c(13, 'C'), c(13, 'D'), c(13, 'H'), c(7, 'H')],
      },
      decisionRating: 0.75,
    };
    const { shareText } = generateStory(result, ZERO_SELECTIONS, new Date('2025-01-01T12:00:00Z'));
    assert.ok(shareText.includes('🃏→K♥'), shareText);
    // The bug in one assertion: the hand name and the cards used to disagree.
    assert.ok(shareText.includes('Four of a Kind'), shareText);
    assert.ok(!shareText.includes('3♦'), shareText);
  });
});

describe('buildShareText / generateStory', () => {
  const baseResult = {
    dayNumber: 7,
    originalHand: [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')],
    finalHand: [c(2, 'S'), c(5, 'H'), c(9, 'D'), c(11, 'C'), c(13, 'S')],
    discardIndices: [],
    score: { handResult: { label: 'High Card' }, total: 12 },
    decisionRating: 0.75,
  };

  test('shareText includes the day number, hand, score, and rating', () => {
    const { finalHandText, shareText } = generateStory(baseResult);
    assert.match(shareText, /Cardle #7/);
    assert.match(shareText, /High Card/);
    assert.match(shareText, /12 pts/);
    assert.match(shareText, /75%/);
    assert.ok(shareText.includes(finalHandText));
  });

  test('handles a non-finite decision rating gracefully', () => {
    const result = { ...baseResult, decisionRating: Infinity };
    const { shareText } = generateStory(result);
    assert.match(shareText, /Decision Rating: —/);
  });

  test("never leaks exact ranks into buildEmojiGrid's own output (kept spoiler-safe for any caller still using it)", () => {
    const { emojiGrid } = generateStory(baseResult);
    assert.ok(!/\d/.test(emojiGrid));
  });

  test('shareText shows the actual final hand, ranks included (owner request: "showing what cards were drawn")', () => {
    const { finalHandText, shareText } = generateStory(baseResult);
    assert.equal(finalHandText, '2♠ 5♥ 9♦ J♣ K♠');
    assert.match(shareText, /Final Hand: 2♠ 5♥ 9♦ J♣ K♠/);
  });

  test('no ✨ markers on drawn replacement cards (owner request: "remove the stars in the copied")', () => {
    const result = { ...baseResult, discardIndices: [1, 3] };
    const { finalHandText, shareText } = generateStory(result);
    assert.equal(finalHandText, '2♠ 5♥ 9♦ J♣ K♠');
    assert.ok(!shareText.includes('✨'));
  });

  test('shareText no longer includes the poem, just the site URL below the final hand (owner request)', () => {
    const { text, shareText } = generateStory(baseResult);
    assert.ok(!shareText.includes(text));
    assert.match(shareText, /cardle\.lol\s*$/);
  });

  test('accepts explicit selections and returns them back', () => {
    const result = generateStory(baseResult, ZERO_SELECTIONS);
    assert.deepEqual(result.selections, ZERO_SELECTIONS);
  });

  test('different explicit selections change the resulting text', () => {
    const a = generateStory(baseResult, ZERO_SELECTIONS);
    const b = generateStory(baseResult, { ...ZERO_SELECTIONS, action: 1 });
    assert.notEqual(a.text, b.text);
  });
});
