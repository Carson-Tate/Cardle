// A read-only miniature card, shared by the profile's hand history and the
// leaderboards (DESIGN.md §11l).
//
// Extracted from profile.js rather than copied into leaderboard.js: the two need
// to look identical, and a duplicated renderer is exactly the kind of thing that
// drifts — one gains a rarity ring or a Wild case and the other doesn't.

import { rankLabel, suitGlyph } from '../core/deck.js';
import { isWild } from '../core/rarity.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {object} card - a stored card `{rank, suit, rarity, jokerTier}`
 * @returns {string} HTML, or '' for anything unusable
 */
export function miniCardHtml(card) {
  if (!card || typeof card !== 'object') return '';
  // Rarity gets a coloured ring so a run that pulled something rare is visible
  // at a glance without opening it.
  // Wildness is independent of rarity now (§3x): a wild still shows the jester,
  // and keeps its tier ring if it rolled one. Legacy stored cards carry
  // `rarity: 'joker'` instead, and this is the surface that renders them most —
  // the profile's hand history and the leaderboard's mini hands.
  const ringTier = card.rarity && card.rarity !== 'joker' ? card.rarity : card.jokerTier ?? null;
  const rarity = ringTier ? ` history-card--${escapeHtml(ringTier)}` : '';
  if (isWild(card)) {
    return `<span class="history-card history-card--wild${rarity}" title="Wild">🃏</span>`;
  }
  const red = card.suit === 'H' || card.suit === 'D';
  return `<span class="history-card${red ? ' history-card--red' : ''}${rarity}">${escapeHtml(
    rankLabel(card.rank),
  )}${escapeHtml(suitGlyph(card.suit) ?? '')}</span>`;
}

/** A whole hand, or '' if there's nothing renderable. */
export function miniHandHtml(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return '';
  return cards.map(miniCardHtml).join('');
}
