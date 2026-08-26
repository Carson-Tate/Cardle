// The leaderboard page (DESIGN.md §11j) — reached at `?leaderboard`.
//
// Four boards behind tabs (Today / This Week / All-Time / Career Points) with a
// friends-only toggle, per the owner's spec.

import { resolveSession } from '../state/auth.js';
import { BOARDS, BOARD_SIZE, fetchLeaderboard, fetchRunResult } from '../state/leaderboard.js';
import { loadGameConfig } from '../state/game-config.js';
import { getDailyModifier, modifierBoardIsAscending } from '../core/modifiers.js';
import { modifierOverrideFor } from '../core/game-config.js';
import { nameplateHtml } from './nameplate.js';
import { gradeForScore } from '../core/score-grade.js';
import { evaluateHand } from '../core/hand-evaluator.js';
import { miniHandHtml } from './mini-card.js';
import { openHandBreakdown } from './hand-modal.js';

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
  return parsed.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

// What the hand actually IS, in words, above the cards (owner request). Derived
// here rather than stored alongside the score — the same "derived, not
// accumulated" rule the career stats follow: the cards are the record, and a
// stored label could only ever drift out of step with them if the evaluator's
// categories ever change. Cheap at 25 rows.
//
// Guarded because a row's `final_hand` is whatever the database holds, not
// something this page controls: evaluateHand THROWS on anything that isn't
// exactly 5 cards, and one malformed historical row must not blank the whole
// board. Falls back to no label, so the cards still render.
function handLabel(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) return null;
  try {
    return evaluateHand(cards).label ?? null;
  } catch {
    return null;
  }
}

export async function initLeaderboard(root) {
  root.innerHTML = `<p class="profile-loading">Loading leaderboards…</p>`;

  // No session required (§11ac, owner: "i want to make the leaderboard public
  // and able to see without signing in"). This used to refuse outright, and the
  // comment here said that was the policy's decision rather than a UI
  // preference — true at the time, and migration 017 is what changed it. The
  // boards now read through `security definer` functions an anonymous caller
  // may execute.
  //
  // `userId` stays null when signed out. It is only used to highlight your own
  // row and to filter to friends, and both of those degrade to "not applicable"
  // rather than needing a branch.
  // `status` matters as well as the session (§11ak): when the SDK itself
  // cannot be loaded, `userId` is null for a player who IS signed in, and the
  // error copy below used to read that as "signed out" and tell them the
  // boards aren't public yet. That is the sentence a player sees when their
  // run is missing from the board — it says the wrong thing about the wrong
  // problem, at the exact moment they are trying to find out what happened.
  const { status, session } = await resolveSession();
  const userId = session?.user?.id ?? null;
  const sessionUnknown = status === 'unavailable';
  const gameConfig = await loadGameConfig();
  const custom = gameConfig?.customCosmetics ?? null;

  // Today's modifier can turn the Today board upside down (§4f). Resolved the
  // same way board.js resolves it — the rotation plus any admin override — so
  // the board and the hand can never disagree about which day's rule is live.
  const todayModifier = getDailyModifier(new Date(), modifierOverrideFor(gameConfig?.modifierOverrides, new Date()));
  const ascending = modifierBoardIsAscending(todayModifier);

  let boardId = 'daily';
  let friendsOnly = false;
  let rows = [];
  let loadError = null;
  let loading = true;

  render();
  await load();

  async function load() {
    loading = true;
    loadError = null;
    render();
    try {
      rows = await fetchLeaderboard({ boardId, friendsOnly, userId, ascending });
    } catch (error) {
      rows = [];
      loadError = error;
    }
    loading = false;
    render();
  }

  function render() {
    const board = BOARDS.find((b) => b.id === boardId) ?? BOARDS[0];
    root.innerHTML = `
      <div class="leaderboard">
        <a class="profile-back-link" href="/">← Back to today's hand</a>
        <h2 class="admin-title">Leaderboards</h2>

        <div class="lb-controls">
          <div class="lb-tabs" role="tablist">
            ${BOARDS.map(
              (b) => `
              <button type="button" role="tab" aria-selected="${b.id === boardId}"
                class="lb-tab${b.id === boardId ? ' lb-tab--active' : ''}" data-board="${escapeHtml(b.id)}">
                ${escapeHtml(b.label)}
              </button>`,
            ).join('')}
          </div>

          <!-- Global vs Friends, inline to the right of the board tabs (owner
               request). A two-option segmented control rather than the checkbox
               this replaces: "Friends only" left the other state unnamed, so it
               never said what unticking it actually showed. Marked up as a
               radiogroup because the two are mutually exclusive - aria-pressed
               buttons would announce as two independent toggles. -->
          ${
            // Hidden entirely when signed out rather than shown disabled: with
            // no account there is no friends list for it to describe, so a
            // Global/Friends pair would be a control whose two states are the
            // same board. The rest of the page is fully usable, which is the
            // case for dropping it rather than explaining it (§11ac).
            userId
              ? `<div class="lb-scope" role="radiogroup" aria-label="Leaderboard scope">
            ${[
              { id: 'global', label: 'Global', on: !friendsOnly },
              { id: 'friends', label: 'Friends', on: friendsOnly },
            ]
              .map(
                (opt) => `
              <button type="button" role="radio" aria-checked="${opt.on}"
                class="lb-scope-btn${opt.on ? ' lb-scope-btn--active' : ''}"
                data-scope="${opt.id}">${opt.label}</button>`,
              )
              .join('')}
          </div>`
              : ''
          }
        </div>

        ${
          // Only on the board it actually affects. A flipped board with no
          // explanation just looks broken — the top score being the worst one is
          // indistinguishable from a sorting bug.
          ascending && board.id === 'daily'
            ? `<p class="lb-flipped-note">${escapeHtml(todayModifier.emoji)} <strong>${escapeHtml(
                todayModifier.label,
              )}</strong> — today's board is upside down. The <strong>lowest</strong> score is on top. Career points still reward a big score, so today those two pull in opposite directions.</p>`
            : ''
        }

        <section class="profile-section">
          ${
            loading
              ? '<p class="profile-loading">Loading…</p>'
              : loadError
                ? // A signed-out visitor sees the friendly version, because the
                  // one failure they can actually hit is migration 017 not
                  // having been run yet — in which case the boards are exactly
                  // as private as they were before, and a raw Postgres error
                  // would be both alarming and useless to them.
                  //
                  // `sessionUnknown` has to be checked FIRST, because in that
                  // state `userId` is null for signed-in and signed-out players
                  // alike — so the signed-out copy would be shown to someone
                  // whose only real problem is that they cannot reach us.
                  sessionUnknown
                  ? `<p class="profile-error">Couldn't reach the leaderboards — check your connection, or try again with any content blocker paused.</p>`
                  : userId
                    ? `<p class="profile-error">Couldn't load this board: ${escapeHtml(loadError.message ?? loadError)}</p>`
                    : `<p class="profile-empty-note">These boards aren't public yet. <strong>Log in</strong> to see how you stack up.</p>`
                : rowsHtml(board)
          }
        </section>
      </div>
    `;

    root.querySelectorAll('[data-board]').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.dataset.board === boardId) return;
        boardId = tab.dataset.board;
        load();
      });
    });
    root.querySelectorAll('[data-scope]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.scope === 'friends';
        if (next === friendsOnly) return; // already on this scope — no reload
        friendsOnly = next;
        load();
      });
    });

    // The board only holds a score and a final hand, so the breakdown is a
    // second request — handed to the modal as a loader rather than awaited
    // here, so the panel opens on the click instead of after the round trip.
    root.querySelectorAll('.lb-hand--open').forEach((btn) => {
      btn.addEventListener('click', () => {
        const { runUser, runDate, runName } = btn.dataset;
        openHandBreakdown({
          title: runName || 'Hand Breakdown',
          playDate: runDate,
          loadResult: () => fetchRunResult(runUser, runDate),
        });
      });
    });
  }

  function rowsHtml(board) {
    if (rows.length === 0) {
      return `<p class="profile-empty-note">${
        friendsOnly ? 'Nobody on your friends list has a score here yet.' : 'No scores here yet — be the first.'
      }</p>`;
    }

    return `
      <ol class="lb-list">
        ${rows
          .map((row, index) => {
            // Highlighting your own row is the whole reason to look at a board
            // you're not at the top of.
            const isMe = row.userId === userId;
            const grade = board.career ? null : gradeForScore(row.value);
            const handName = handLabel(row.finalHand);
            // The score itself carries the rarity highlight (owner request:
            // "make the score on the leaderboards be highlighted in the rarity
            // of the score instead of just showing the rarity next to it"), so
            // the separate grade pill is gone. The tier name would be lost with
            // it, so it moves to a tooltip and an aria-label — the colour is the
            // at-a-glance signal, but the name stays available and is the only
            // form a screen reader can convey.
            const gradeClass = grade ? ` lb-value--graded score-grade--${grade.id}` : '';
            const gradeTip = grade ? ` title="${escapeHtml(`${grade.label} — ${row.value.toLocaleString()} points`)}"` : '';
            return `
            <li class="lb-row${isMe ? ' lb-row--me' : ''}">
              <span class="lb-rank${index < 3 ? ` lb-rank--${index + 1}` : ''}">${index + 1}</span>
              <a class="lb-name" href="/?profile=${encodeURIComponent(row.profile.username ?? '')}">
                ${nameplateHtml(row.profile, { custom })}
              </a>
              ${
                // The winning hand, on the score boards only — a career total
                // isn't a single hand. The wrapper is always present so the grid
                // column exists on every row and the hands line up (owner
                // request: "align hands on the leaderboard").
                //
                // The category name sits ABOVE the cards (owner request), inside
                // this same wrapper rather than in a column of its own: it has to
                // stay glued to the hand it describes, and a separate track would
                // reserve width on the career board, which has no hand at all.
                //
                // A real <button> when the hand can be opened (§11ab), not a
                // click handler on the <li>: the row already contains the profile
                // anchor, so making the whole row activatable would have nested
                // two different destinations in one control and left the keyboard
                // with no way to choose. The hand IS the affordance — you click
                // the thing you want to look at. Career rows keep the plain span
                // so the grid track still exists but nothing invites a click.
                row.finalHand && row.playDate
                  ? `<button type="button" class="lb-hand lb-hand--open"
                       data-run-user="${escapeHtml(row.userId)}"
                       data-run-date="${escapeHtml(row.playDate)}"
                       data-run-name="${escapeHtml(row.profile.username ?? '')}"
                       aria-label="${escapeHtml(
                         `See how ${row.profile.username ?? 'this player'}'s ${handName ?? 'hand'} scored — ${row.value.toLocaleString()} points`,
                       )}">
                       ${handName ? `<span class="lb-hand-name">${escapeHtml(handName)}</span>` : ''}
                       <span class="lb-hand-cards">${miniHandHtml(row.finalHand)}</span>
                     </button>`
                  : `<span class="lb-hand"></span>`
              }
              <span class="lb-value-cell">
                <span class="lb-value${gradeClass ? ` grade-pill${gradeClass}` : ''}"${gradeTip}${
                  grade ? ` aria-label="${escapeHtml(`${grade.label}: ${row.value.toLocaleString()} points`)}"` : ''
                }>${row.value.toLocaleString()}${board.career ? ' pts' : ''}</span>
                <small>${
                  board.career
                    ? `${(row.runs ?? 0).toLocaleString()} run${row.runs === 1 ? '' : 's'}`
                    : `${row.playDate ? `<span class="lb-date">${escapeHtml(formatDate(row.playDate))}</span>` : ''}`
                }</small>
              </span>
            </li>`;
          })
          .join('')}
      </ol>
      <p class="admin-hint">
        ${
          // "Top 25" is a lie on an Upside Down day — these are the 25 LOWEST
          // scores, which is the whole point of the board.
          ascending && board.id === 'daily' ? 'Bottom' : 'Top'
        } ${BOARD_SIZE}${friendsOnly ? ' among you and your friends' : ''}. Click any name to see their profile${
          board.career ? '' : ', or a hand to see how it scored'
        }.${
          // The one thing a signed-out visitor genuinely cannot do here is
          // appear on the board, so that is what the nudge says — rather than
          // "log in for more", which would imply the page is withholding
          // something it isn't.
          userId ? '' : ' Play a hand and log in to get your own name up here.'
        }
      </p>
    `;
  }
}
