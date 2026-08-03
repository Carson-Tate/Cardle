// The hand-rankings cheat sheet (DESIGN.md §11af).
//
// Owner: "a lot of people dont know what any poker hands are so i would like to
// make a little cheat sheet for people to look at, it should be easy to access
// for new players, i sent it to a random person and he had trouble what the
// game was about."
//
// ── WHY THIS IS ITS OWN MODAL, NOT A SECTION OF HOW TO PLAY ─────────────────
// They answer questions asked at different moments. How to Play is read once,
// before the first hand. "Does a Flush beat a Straight?" is asked mid-decision,
// with three cards already marked for discard — so it opens from a button
// sitting next to the cards, not from a tutorial you would have to scroll past.
// How to Play links here too, for the player who is reading the rules cold.
//
// ── THE TWO RANKS THAT ARE NOT POKER ────────────────────────────────────────
// Three Straight and Four Straight are Cardle's own (§3w), and they sit in
// places that would genuinely mislead somebody who already plays poker: a Four
// Straight beats Two Pair here, and a Three Straight beats a Pair. They are
// marked, because a cheat sheet that quietly reorders a game its readers think
// they know is worse than no cheat sheet.

import { HAND_RANKS } from '../core/hand-evaluator.js';
import { HAND_DESCRIPTIONS } from './score-breakdown.js';
import { miniHandHtml } from './mini-card.js';
import { openModal } from './modal.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const card = (rank, suit) => ({ rank, suit, rarity: null, jokerTier: null });

// A worked example per category. Deliberately hand-picked rather than generated:
// each one should read as OBVIOUSLY that hand at a glance, which a random valid
// example often does not — and the Full House / Two Pair examples reuse ranks
// from the ones above them so the pattern is easy to compare down the list.
const EXAMPLES = {
  ROYAL_FLUSH: [card(14, 'S'), card(13, 'S'), card(12, 'S'), card(11, 'S'), card(10, 'S')],
  STRAIGHT_FLUSH: [card(9, 'H'), card(8, 'H'), card(7, 'H'), card(6, 'H'), card(5, 'H')],
  FOUR_OF_A_KIND: [card(13, 'S'), card(13, 'H'), card(13, 'D'), card(13, 'C'), card(4, 'S')],
  FULL_HOUSE: [card(13, 'S'), card(13, 'H'), card(13, 'D'), card(8, 'C'), card(8, 'S')],
  FLUSH: [card(14, 'D'), card(10, 'D'), card(7, 'D'), card(5, 'D'), card(2, 'D')],
  STRAIGHT: [card(9, 'S'), card(8, 'H'), card(7, 'D'), card(6, 'C'), card(5, 'S')],
  THREE_OF_A_KIND: [card(11, 'S'), card(11, 'H'), card(11, 'D'), card(7, 'C'), card(3, 'S')],
  FOUR_STRAIGHT: [card(9, 'S'), card(8, 'H'), card(7, 'D'), card(6, 'C'), card(2, 'S')],
  TWO_PAIR: [card(13, 'S'), card(13, 'H'), card(8, 'D'), card(8, 'C'), card(3, 'S')],
  THREE_STRAIGHT: [card(9, 'S'), card(8, 'H'), card(7, 'D'), card(4, 'C'), card(2, 'S')],
  PAIR: [card(13, 'S'), card(13, 'H'), card(9, 'D'), card(6, 'C'), card(3, 'S')],
  HIGH_CARD: [card(14, 'S'), card(11, 'H'), card(8, 'D'), card(5, 'C'), card(3, 'S')],
};

// Cardle's own additions (§3w) — not standard poker, and both outrank a hand a
// poker player would expect to beat them.
const CARDLE_ONLY = new Set(['THREE_STRAIGHT', 'FOUR_STRAIGHT']);

function rowHtml(rank, index) {
  const example = EXAMPLES[rank.id];
  return `
    <li class="guide-row">
      <div class="guide-row-head">
        <span class="guide-rank">${index + 1}</span>
        <span class="guide-name">${escapeHtml(rank.label)}</span>
        ${CARDLE_ONLY.has(rank.id) ? '<span class="guide-tag">Cardle only</span>' : ''}
        <span class="guide-score">${rank.score === 0 ? '0 pts' : `${rank.score.toLocaleString()}+`}</span>
      </div>
      <p class="guide-desc">${escapeHtml(HAND_DESCRIPTIONS[rank.id] ?? '')}</p>
      ${example ? `<div class="guide-cards">${miniHandHtml(example)}</div>` : ''}
    </li>
  `;
}

export function openHandGuide() {
  return openModal({
    title: 'Hand Rankings',
    className: 'modal--guide',
    render(body) {
      body.innerHTML = `
        <p class="guide-intro">
          Best at the top. Your five cards are scored as the <strong>best single hand</strong> they
          can make — you never pick which one, the game always takes the highest.
        </p>
        <ol class="guide-list">
          ${HAND_RANKS.map(rowHtml).join('')}
        </ol>
        <p class="guide-note">
          <strong>Two of these aren't real poker.</strong> Three Straight and Four Straight are
          Cardle's own, so near-misses still pay something — which is why a Four Straight beats
          Two Pair here, and a Three Straight beats a Pair. Everything else ranks exactly as it
          does at a card table.
        </p>
        <p class="guide-note">
          The points shown are a starting value. Higher cards score more within the same hand
          (a pair of Kings beats a pair of 3s), and bonuses, rare cards and the day's modifier
          all build on top.
        </p>
      `;
    },
  });
}
