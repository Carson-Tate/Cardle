// Click a hand on the leaderboard or a profile, see how it actually scored
// (§11ab, owner: "i would like the option to see peoples hands and the
// breakdown of them but only when you click on it").
//
// WHY THIS IS SAFE TO SHOW AT ALL. It would not have been under the original
// design, where the seed was a hash of the date and every player got the
// SAME five cards (DESIGN.md §2, now stale): the stored blob carries
// `originalHand` and `discardIndices`, so opening today's top run would have
// handed a player who hadn't drawn yet the exact deal and the winning line.
// Seeds are now claimed per player (`claimDailyPlay`, state/daily-play.js),
// so one player's cards say nothing about another's and the whole run —
// including what they threw away — can be shown the moment it is finished.
// If per-day seeds ever come back, this needs a gate on today's rows.
//
// The breakdown itself is NOT rebuilt here. It comes from the same
// score-breakdown.js the live board and the already-played panel render, so
// a bonus added tomorrow appears on all three without anyone remembering to
// update a third copy.

import { openModal } from './modal.js';
import { breakdownListHtml } from './score-breakdown.js';
import { gradeForScore } from '../core/score-grade.js';
import { PERSONALITIES } from '../core/personality.js';
import { isWild } from '../core/rarity.js';
import { suitGlyph, rankLabel } from '../core/deck.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

// Same chip as the breakdown's proof strips (`.mini-card`), deliberately not
// the profile/leaderboard's `.history-card` — inside this modal every other
// card is a proof-strip chip, and two card sizes in one panel reads as a
// mistake. `discarded` marks the ones that were thrown.
function chipHtml(card, { discarded = false } = {}) {
  if (!card || typeof card !== 'object') return '';
  const color = card.suit === 'H' || card.suit === 'D' ? 'mini-card--red' : 'mini-card--black';
  const wild = isWild(card) ? ' mini-card--wild' : '';
  const thrown = discarded ? ' mini-card--discarded' : '';
  return `<span class="mini-card ${color}${wild}${thrown}">${rankLabel(card.rank)}${suitGlyph(card.suit)}</span>`;
}

// What they were dealt and what they did with it — the decision, which is the
// part a final hand alone can't show.
//
// Caveat worth knowing: on a Second Wind day (§4d) the stored `originalHand`
// is the hand as it stood AFTER round one, not the original deal, because
// that modifier rebinds the hand between rounds (§11z). So this shows the
// last discard decision, which is the one `discardIndices` describes — the
// two always agree with each other, which is what matters for the markers.
function drawHtml(result) {
  const original = Array.isArray(result.originalHand) ? result.originalHand : null;
  const finalHand = Array.isArray(result.finalHand) ? result.finalHand : [];
  if (!original || original.length === 0) return '';

  const discarded = new Set(Array.isArray(result.discardIndices) ? result.discardIndices : []);
  const thrown = discarded.size;
  const caption =
    thrown === 0
      ? 'Stood pat — kept all five.'
      : `Threw ${thrown} card${thrown === 1 ? '' : 's'}, kept ${original.length - thrown}.`;

  return `
    <div class="hand-modal-draw">
      <div class="hand-modal-draw-row">
        <span class="hand-modal-draw-label">Dealt</span>
        <span class="hand-modal-draw-cards">${original
          .map((card, i) => chipHtml(card, { discarded: discarded.has(i) }))
          .join('')}</span>
      </div>
      <div class="hand-modal-draw-row">
        <span class="hand-modal-draw-label">Kept</span>
        <span class="hand-modal-draw-cards">${finalHand.map((card) => chipHtml(card)).join('')}</span>
      </div>
      <p class="hand-modal-draw-caption">${escapeHtml(caption)}</p>
    </div>
  `;
}

function ratingHtml(result) {
  const rating = result.decisionRating;
  const personality = PERSONALITIES.find((p) => p.id === result.personalityId);
  // null is meaningful, not missing: Double or Nothing removes the choice, so
  // there is nothing to rate and §11y decided to say so rather than show a 0%
  // that reads as a bad decision the player never made.
  //
  // Capped at 100% because this modal opens rows from any point in the game's
  // history, including runs stored while the rating was actualScore/bestEV and
  // deliberately unbounded above. Those rows really do hold 3.4 and 14.0, and
  // "1,400%" beside a scale that now tops out at 100% reads as a rendering bug
  // rather than as an old number. Same cap player-stats.js applies.
  const ratingText = Number.isFinite(rating) ? `${Math.round(Math.min(rating, 1) * 100)}%` : 'Not measured';
  return `
    <p class="hand-modal-rating">
      <span>Decision Rating: <strong>${escapeHtml(ratingText)}</strong></span>
      ${personality ? `<span class="hand-modal-personality">${escapeHtml(personality.emoji)} ${escapeHtml(personality.label)}</span>` : ''}
    </p>
  `;
}

function bodyHtml(result, playDate) {
  const score = result?.score;
  if (!score?.handResult) {
    return `<p class="profile-error">This run's breakdown couldn't be read.</p>`;
  }
  const grade = gradeForScore(score.total);
  return `
    ${playDate ? `<p class="hand-modal-date">${escapeHtml(formatDate(playDate))}</p>` : ''}
    <h3 class="hand-modal-hand">${escapeHtml(score.handResult.label)}</h3>
    <div class="hand-modal-total">${(score.total ?? 0).toLocaleString()}</div>
    <div class="hand-modal-grade grade-pill score-grade--${escapeHtml(grade.id)}">
      <span>${escapeHtml(grade.emoji)}</span><span>${escapeHtml(grade.label)}</span>
    </div>
    ${drawHtml(result)}
    <h4 class="hand-modal-section">Score Breakdown</h4>
    ${breakdownListHtml(result)}
    ${ratingHtml(result)}
  `;
}

/**
 * Open the breakdown for one finished run.
 *
 * Pass `result` when the caller already has the blob (the profile page fetches
 * whole rows, so its history is already in memory and a click costs nothing).
 * Pass `loadResult` when it doesn't (the leaderboard's RPC returns only a
 * score and a final hand, so the full blob is a second request) — the modal
 * opens immediately on a loading line rather than after the round trip, so a
 * slow network reads as loading rather than as a dead click.
 */
export function openHandBreakdown({ title, playDate, result, loadResult }) {
  return openModal({
    title: title || 'Hand Breakdown',
    className: 'modal--hand',
    render(body) {
      if (result) {
        body.innerHTML = bodyHtml(result, playDate);
        return;
      }
      body.innerHTML = `<p class="profile-loading">Loading this hand…</p>`;
      Promise.resolve()
        .then(loadResult)
        .then((loaded) => {
          // The modal may already be closed by the time this lands — a
          // detached body still accepts innerHTML, so guard on connectedness
          // rather than writing into a node nobody can see.
          if (!body.isConnected) return;
          body.innerHTML = loaded
            ? bodyHtml(loaded, playDate)
            : `<p class="profile-empty-note">This run's details are no longer available.</p>`;
        })
        .catch((error) => {
          if (!body.isConnected) return;
          body.innerHTML = `<p class="profile-error">Couldn't load this hand: ${escapeHtml(error?.message ?? error)}</p>`;
        });
    },
  });
}
