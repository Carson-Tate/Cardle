// The leaderboard page (DESIGN.md §11j) — reached at `?leaderboard`.
//
// Four boards behind tabs (Today / This Week / All-Time / Career Points) with a
// friends-only toggle, per the owner's spec.

import { getSession } from '../state/auth.js';
import { BOARDS, BOARD_SIZE, fetchLeaderboard } from '../state/leaderboard.js';
import { loadGameConfig } from '../state/game-config.js';
import { nameplateHtml } from './nameplate.js';
import { gradeForScore } from '../core/score-grade.js';
import { miniHandHtml } from './mini-card.js';

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

export async function initLeaderboard(root) {
  root.innerHTML = `<p class="profile-loading">Loading leaderboards…</p>`;

  const session = await getSession().catch(() => null);
  if (!session) {
    // The boards read other players' scores, which the database only permits for
    // a signed-in caller (§11j) — so this isn't a UI preference, it's what the
    // policy allows.
    root.innerHTML = `
      <div class="profile-empty">
        <h2>Leaderboards</h2>
        <p>Log in to see how you stack up.</p>
        <a class="profile-back-link" href="/">← Back to today's hand</a>
      </div>
    `;
    return;
  }

  const userId = session.user.id;
  const gameConfig = await loadGameConfig();
  const custom = gameConfig?.customCosmetics ?? null;

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
      rows = await fetchLeaderboard({ boardId, friendsOnly, userId });
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

        <div class="lb-tabs" role="tablist">
          ${BOARDS.map(
            (b) => `
            <button type="button" role="tab" aria-selected="${b.id === boardId}"
              class="lb-tab${b.id === boardId ? ' lb-tab--active' : ''}" data-board="${escapeHtml(b.id)}">
              ${escapeHtml(b.label)}
            </button>`,
          ).join('')}
        </div>

        <label class="lb-friends-toggle">
          <input type="checkbox" id="lb-friends-only"${friendsOnly ? ' checked' : ''} />
          <span>Friends only</span>
        </label>

        <section class="profile-section">
          ${
            loading
              ? '<p class="profile-loading">Loading…</p>'
              : loadError
                ? `<p class="profile-error">Couldn't load this board: ${escapeHtml(loadError.message ?? loadError)}</p>`
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
    root.querySelector('#lb-friends-only')?.addEventListener('change', (event) => {
      friendsOnly = event.currentTarget.checked;
      load();
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
            return `
            <li class="lb-row${isMe ? ' lb-row--me' : ''}">
              <span class="lb-rank${index < 3 ? ` lb-rank--${index + 1}` : ''}">${index + 1}</span>
              <a class="lb-name" href="/?profile=${encodeURIComponent(row.profile.username ?? '')}">
                ${nameplateHtml(row.profile, { custom })}
              </a>
              ${
                // The winning hand, on the score boards only — a career total
                // isn't a single hand, so there is nothing to show there.
                row.finalHand ? `<span class="lb-hand">${miniHandHtml(row.finalHand)}</span>` : ''
              }
              <span class="lb-value">
                ${row.value.toLocaleString()}${board.career ? ' pts' : ''}
                <small>${
                  board.career
                    ? `${(row.runs ?? 0).toLocaleString()} run${row.runs === 1 ? '' : 's'}`
                    : `${grade ? `<span class="lb-grade score-grade--${grade.id}">${grade.emoji} ${escapeHtml(grade.label)}</span>` : ''}${row.playDate ? ` <span class="lb-date">${escapeHtml(formatDate(row.playDate))}</span>` : ''}`
                }</small>
              </span>
            </li>`;
          })
          .join('')}
      </ol>
      <p class="admin-hint">
        Top ${BOARD_SIZE}${friendsOnly ? ' among you and your friends' : ''}. Click any name to see their profile.
      </p>
    `;
  }
}
