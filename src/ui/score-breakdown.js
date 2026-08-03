// The RNGDLE-style score breakdown — badge cards with a category tag, a
// plain-English description, and a strip of the 5 final-hand cards with the
// ones that actually justify the badge highlighted (DESIGN.md §3q/§3r).
//
// Extracted from board.js when hand breakdowns became viewable from the
// leaderboard and the profile (§11ab). It lives here rather than there
// because three surfaces now render the same thing and a second copy would
// drift the first time a bonus was added — the same rule that made badges
// derive from the achievement registry (§11e) and career stats derive from
// `daily_plays` (§11d) instead of being authored twice.
//
// Everything in this module is a PURE STRING BUILDER over a stored `result`
// blob. No DOM, no timers, no animation state. That is what lets the live
// board consume it mid-animation (rendering a badge at value 0 and counting
// up) while the modal and the already-played panel render the same badge
// statically, from the identical source.

import { suitGlyph, rankLabel } from '../core/deck.js';
import { isWild } from '../core/rarity.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Owner request: a description + card-proof for every score-breakdown line,
// "like the attached picture" (RNGDLE's badge breakdown) — see
// buildScoreBadges() below, which is what actually consumes these.
const SKILL_META = {
  perfectKeep: { emoji: '⭐', label: 'Perfect Keep', description: 'Held all 5 cards and still landed an excellent hand.' },
  optimalDiscard: { emoji: '🎯', label: 'Optimal Discard', description: 'Your discard matched the mathematically best play.' },
  longShot: { emoji: '🔥', label: 'Long Shot', description: 'Improved by 3 or more hand ranks after drawing.' },
  cleanFinish: { emoji: '💎', label: 'Clean Finish', description: 'Every card in the final hand contributes — no dead weight.' },
};

// Exported for the hand-rankings cheat sheet (§11af), which teaches exactly what
// these badges remind you of. One wording for "what is a Full House", not two
// that drift.
export const HAND_DESCRIPTIONS = {
  HIGH_CARD: 'No pair, no flush, no straight.',
  PAIR: 'Two cards share a rank.',
  THREE_STRAIGHT: 'Three ranks in a row, no pair.',
  TWO_PAIR: 'Two separate pairs.',
  FOUR_STRAIGHT: 'Four ranks in a row, one card short of a straight.',
  THREE_OF_A_KIND: 'Three cards share a rank.',
  STRAIGHT: 'Five ranks in a row.',
  FLUSH: 'All five cards share a suit.',
  FULL_HOUSE: 'Three of a kind plus a pair.',
  FOUR_OF_A_KIND: 'Four cards share a rank.',
  STRAIGHT_FLUSH: 'Five in a row, all one suit.',
  ROYAL_FLUSH: '10 through Ace, all one suit — the best hand in poker.',
};

// Each badge carries everything the RNGDLE-style breakdown card needs
// (owner request, "like the attached picture"): a category `tag`, a plain-
// English `description` of why it fired, and `highlightIndices` — which of
// the 5 final-hand card positions are the actual proof — on top of the
// existing label/value.
export function buildScoreBadges(score, finalHand, discardIndices = []) {
  const badges = [];

  badges.push({
    key: 'hand',
    tag: 'HAND',
    emoji: null,
    label: score.handResult.label,
    value: score.baseScore,
    description: HAND_DESCRIPTIONS[score.handResult.id] ?? '',
    highlightIndices: score.handContributingIndices,
  });

  if (score.flavor.total > 0) {
    badges.push({
      key: 'flavor',
      tag: 'FLAVOR',
      emoji: '✨',
      label: 'Flavor Bonus',
      value: score.flavor.total,
      description: 'Points for Aces and Face cards in your hand.',
      highlightIndices: [...score.flavor.aceIndices, ...score.flavor.faceIndices],
    });
  }

  if (score.suitSynergy.total > 0) {
    const glyph = suitGlyph(score.suitSynergy.suit);
    badges.push({
      key: 'suitSynergy',
      tag: 'SUIT',
      emoji: glyph,
      label: 'Suit Synergy',
      value: score.suitSynergy.total,
      description: `${score.suitSynergy.count} cards share the ${glyph} suit.`,
      highlightIndices: score.suitSynergy.indices,
    });
  }

  badges.push({
    key: 'cardValue',
    tag: 'CARD VALUE',
    emoji: '🎴',
    label: 'Card Value',
    value: score.cardValue.total,
    description: 'Every card in your hand contributes its rank — always.',
    highlightIndices: [0, 1, 2, 3, 4],
  });

  for (const [key, value] of Object.entries(score.skillBonuses)) {
    if (value <= 0) continue;
    const meta = SKILL_META[key];
    const highlightIndices =
      key === 'perfectKeep' || key === 'cleanFinish'
        ? [0, 1, 2, 3, 4]
        : key === 'optimalDiscard'
          ? [0, 1, 2, 3, 4].filter((i) => !discardIndices.includes(i))
          : [];
    badges.push({ key, tag: 'SKILL', emoji: meta.emoji, label: meta.label, value, description: meta.description, highlightIndices });
  }

  for (const bonus of score.extraBonuses) {
    badges.push({
      key: `extra-${bonus.id}`,
      tag: 'BONUS',
      emoji: bonus.emoji,
      label: bonus.label,
      value: bonus.points,
      description: bonus.description,
      highlightIndices: bonus.highlightIndices,
    });
  }

  for (const item of score.rarity.items) {
    const label =
      item.rarity === 'joker'
        ? item.label // already "<Flavor> Wild", e.g. "Gold Wild" — see rarityBonus()
        : `${item.label} ${rankLabel(item.card.rank)}${suitGlyph(item.card.suit)}`;
    const tierForTag = item.rarity === 'joker' ? (item.jokerTier ?? 'bronze') : item.rarity;
    badges.push({
      key: `rarity-${item.index}`,
      tag: tierForTag.toUpperCase(),
      emoji: item.emoji,
      label,
      value: item.points,
      description:
        item.rarity === 'joker'
          ? 'A wild card — completes the best possible hand, whatever that takes.'
          : 'A rare card, worth extra points just for showing up.',
      highlightIndices: [item.index],
    });
  }

  for (const item of score.discardedRarity.items) {
    const label =
      item.rarity === 'joker'
        ? item.label // already "<Flavor> Wild", e.g. "Gold Wild" — see discardedRarityBonus()
        : `${item.label} ${rankLabel(item.card.rank)}${suitGlyph(item.card.suit)}`;
    const tierForTag = item.rarity === 'joker' ? (item.jokerTier ?? 'bronze') : item.rarity;
    badges.push({
      key: `discard-rarity-${item.index}`,
      tag: tierForTag.toUpperCase(),
      emoji: '🗑️',
      label: `Discarded ${label}`,
      value: item.points,
      description: 'A bold discard — half credit for letting a rare card go.',
      highlightIndices: [], // discarded cards never appear in the final hand's proof strip
    });
  }

  if (score.handSynergyBonus > 0) {
    // Which rare cards get highlighted depends on which tier of the
    // multiplier fired (scoring.js's scoreRun — DESIGN.md §3n/§3o): if any
    // rare card is genuinely part of the winning combo, highlight just
    // those; otherwise (2+ rare cards, none in combo, but still stacking)
    // highlight all of them, since none is more "responsible" than another.
    const rareIndices = score.rarity.items.map((item) => item.index);
    const comboIndexSet = new Set([...score.handContributingIndices, ...score.runIndices]);
    const inCombo = rareIndices.filter((i) => comboIndexSet.has(i));
    badges.push({
      key: 'synergy',
      tag: 'SYNERGY',
      emoji: '✨',
      label: `×${score.multiplier} Hand-Rarity Synergy`,
      value: score.handSynergyBonus,
      description:
        inCombo.length > 0
          ? 'A rare card is part of the winning combination — the multiplier applies to the WHOLE score.'
          : 'More than one rare card landed in this hand — their bonus stacks, even unused.',
      highlightIndices: inCombo.length > 0 ? inCombo : rareIndices,
    });
  }

  if (score.pity > 0) {
    badges.push({
      key: 'pity',
      tag: 'PITY',
      emoji: '🎗️',
      label: 'Pity Points',
      value: score.pity,
      description: 'A small consolation bonus for a low-scoring run.',
      highlightIndices: [],
    });
  }

  // `!== 0`, not `> 0` — Double or Nothing (§4e) can drive this NEGATIVE
  // (×0 wipes the whole additive total). Every other modifier only ever
  // multiplies UP, so this was `> 0` until that modifier exposed the gap:
  // a hidden negative badge would silently understate `score.total` in the
  // UI, since the running count-up total below is an accumulation of
  // exactly the badges shown, not a re-read of `score.total` itself.
  if (score.modifierBonusAmount !== 0) {
    const busted = score.modifierBonusAmount < 0;
    badges.push({
      key: 'modifier',
      tag: 'MODIFIER',
      emoji: busted ? '💥' : '🧭',
      label: busted ? 'Busted — Nothing' : `×${score.modifierMultiplier} Modifier Multiplier`,
      value: score.modifierBonusAmount,
      description: busted
        ? "Today's modifier wiped your total — the gamble didn't pay off."
        : "Today's modifier multiplied your total.",
      highlightIndices: [],
    });
  }

  // Ascending — smallest first. This is the REVEAL order (owner request:
  // builds suspense toward the biggest number last); the biggest number
  // still ends up visually at the TOP of the list, because revealScore()
  // inserts each new badge above the previous ones rather than below (owner
  // follow-up request) — see insertLineAtTop(). Callers that render without
  // that insertion sequence (the static "already played" panel, the hand
  // modal) want breakdownListHtml() below, which reverses for them.
  return badges.sort((a, b) => a.value - b.value);
}

function tagClassName(tag) {
  return `score-badge-tag--${tag.toLowerCase().replace(/\s+/g, '-')}`;
}

// The small "proof" row of all 5 final-hand cards, with the ones that
// actually justify the badge highlighted — the visual half of "like the
// attached picture" (owner request). Omitted entirely when a badge has no
// specific cards to point to (e.g. Pity Points).
//
// `logicalHand` (score.logicalFinalHand, scoring.js) is what actually gets
// rendered — a Joker's slot shows whatever rank/suit it wild-substituted to,
// not its own meaningless dealt card — with a 🃏 marker (from `rawHand`,
// which still has the real `rarity` field) so it doesn't read as an
// ordinary duplicate of that rank/suit.
export function miniCardStripHtml(logicalHand, rawHand, highlightIndices) {
  if (!highlightIndices || highlightIndices.length === 0) return '';
  const highlightSet = new Set(highlightIndices);
  const chips = logicalHand
    .map((card, i) => {
      const color = card.suit === 'H' || card.suit === 'D' ? 'mini-card--red' : 'mini-card--black';
      const highlighted = highlightSet.has(i) ? ' mini-card--highlight' : '';
      // isWild(), not `rarity === 'joker'` — that is the LEGACY shape only, so
      // a modern wild (`wild: true`) silently lost its 🃏 marker here while
      // every other renderer showed one. The local name also shadowed the
      // imported isWild, which is what let the mismatch hide in plain sight.
      const wildClass = isWild(rawHand[i]) ? ' mini-card--wild' : '';
      return `<span class="mini-card ${color}${highlighted}${wildClass}">${rankLabel(card.rank)}${suitGlyph(card.suit)}</span>`;
    })
    .join('');
  return `<div class="mini-card-strip">${chips}</div>`;
}

export function badgeCardHtml(badge, logicalHand, rawHand, displayValue) {
  // Almost every badge is non-negative, but Double or Nothing's "Busted"
  // badge (§4e) isn't — it's the one score component that can subtract from
  // the running total instead of adding to it, so the sign has to follow
  // `displayValue` rather than always being "+".
  const sign = displayValue < 0 ? '-' : '+';
  return `
    <div class="score-badge-header">
      ${badge.emoji ? `<span class="score-badge-icon">${badge.emoji}</span>` : ''}
      <span class="score-badge-label">${escapeHtml(badge.label)}</span>
      <span class="score-badge-tag ${escapeHtml(tagClassName(badge.tag))}">${escapeHtml(badge.tag)}</span>
      <span class="score-badge-value">${sign}${Math.abs(displayValue).toLocaleString()}</span>
    </div>
    ${badge.description ? `<p class="score-badge-desc">${escapeHtml(badge.description)}</p>` : ''}
    ${miniCardStripHtml(logicalHand, rawHand, badge.highlightIndices)}
  `;
}

// The whole `<ul>`, biggest badge first — what every NON-animated caller
// wants. buildScoreBadges() returns ascending (reveal order), so the reverse
// lives here once instead of at each call site; the already-played panel and
// the hand modal were otherwise both about to write the same `.reverse()`.
//
// Tolerant of a malformed `result` rather than throwing: these blobs come
// straight from the database and are rendered on OTHER players' rows now, so
// one bad historical row must lose its own breakdown, not take down the
// board that lists it — the same guard `handLabel` already puts around
// `evaluateHand` on the leaderboard.
export function breakdownListHtml(result) {
  const score = result?.score;
  if (!score?.handResult) return '';
  let badges;
  try {
    badges = [...buildScoreBadges(score, result.finalHand, result.discardIndices)].reverse();
  } catch {
    return '';
  }
  const logical = score.logicalFinalHand ?? result.finalHand ?? [];
  const raw = result.finalHand ?? [];
  return `
    <ul class="score-breakdown">
      ${badges.map((badge) => `<li class="score-badge">${badgeCardHtml(badge, logical, raw, badge.value)}</li>`).join('')}
    </ul>
  `;
}
