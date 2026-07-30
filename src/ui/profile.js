// The profile page (DESIGN.md §11d) — reached by clicking your own username in
// the site header, which navigates to `?profile`.
//
// A query param rather than a real `/profile` path on purpose: this is a
// static single-page app with no router, and adding a path would mean a Vercel
// rewrite plus matching dev-server handling — the exact area that produced the
// "unstyled page" deployment bug (§11a). `?profile` needs zero server config
// and behaves identically locally and deployed. It's also shaped to extend to
// `?profile=<username>` for viewing a friend's profile later, without changing
// how routing works.

import { getSession, signOut, getProfile } from '../state/auth.js';
import { fetchPlayHistory, deleteOwnAccount, saveEquippedCosmetics } from '../state/profile.js';
import { derivePlayerStats, splitAchievements } from '../core/player-stats.js';
import { resolveCosmetics, resolveEquipped, canEquip, DEFAULT_PAINT_ID } from '../core/cosmetics.js';
import { nameplateHtml, announceProfileUpdate } from './nameplate.js';
import { rankLabel, suitGlyph } from '../core/deck.js';
import { PERSONALITIES } from '../core/personality.js';
import { HAND_RANKS } from '../core/hand-evaluator.js';
import { openModal } from './modal.js';

// How many hands the recent-hands list shows at a time (owner request: "your
// 5 recent hands (with a load more to show more)").
const HANDS_PER_PAGE = 5;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(isoDate) {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return parsed.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPercent(ratio) {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export async function initProfile(root) {
  root.innerHTML = `<p class="profile-loading">Loading your profile…</p>`;

  const session = await getSession().catch(() => null);
  if (!session) {
    // Reachable by typing the URL while signed out (the header only shows the
    // username button when signed in), and also whenever accounts are
    // unavailable at all — a blocked CDN or an unconfigured project.
    root.innerHTML = `
      <div class="profile-empty">
        <h2>Your Profile</h2>
        <p>Log in to see your stats, hand history, and achievements.</p>
        <a class="profile-back-link" href="/">← Back to today's hand</a>
      </div>
    `;
    return;
  }

  const userId = session.user.id;
  let profile = null;
  let history = [];
  let loadError = null;
  try {
    [profile, history] = await Promise.all([getProfile(userId).catch(() => null), fetchPlayHistory(userId)]);
  } catch (error) {
    loadError = error;
  }

  if (loadError) {
    root.innerHTML = `
      <div class="profile-empty">
        <h2>Your Profile</h2>
        <p class="profile-error">Couldn't load your history: ${escapeHtml(loadError.message ?? 'unknown error')}</p>
        <a class="profile-back-link" href="/">← Back to today's hand</a>
      </div>
    `;
    return;
  }

  const stats = derivePlayerStats(history);
  const username = profile?.username ?? session.user.email ?? 'Player';
  let shownHands = HANDS_PER_PAGE;

  // Equipped cosmetics, held as ids so the pickers and the live nameplate
  // preview stay in sync without a round trip. Seeded from the stored row and
  // updated optimistically on selection — a failed save reverts and says so.
  const stored = resolveEquipped(profile);
  let equipped = {
    badge: stored.badge?.id ?? null,
    title: stored.title?.id ?? null,
    paint: stored.paint?.id ?? DEFAULT_PAINT_ID,
  };
  const cosmetics = resolveCosmetics({ level: stats.level, achievementsUnlocked: stats.achievementsUnlocked });

  // The shape nameplateHtml expects, rebuilt from the current selection so the
  // header preview updates the instant a picker changes.
  function equippedRow() {
    return {
      username,
      equipped_badge: equipped.badge,
      equipped_title: equipped.title,
      equipped_paint: equipped.paint,
    };
  }

  render();

  function render() {
    root.innerHTML = `
      <div class="profile">
        <a class="profile-back-link" href="/">← Back to today's hand</a>

        <header class="profile-header">
          <div class="profile-identity">
            <h2 class="profile-username">${nameplateHtml(equippedRow(), { fallbackName: username })}</h2>
            <p class="profile-since">${stats.firstPlayDate ? `Playing since ${formatDate(stats.firstPlayDate)}` : 'No hands played yet'}</p>
          </div>
          ${levelBlockHtml(stats)}
        </header>

        <section class="profile-section">
          <h3 class="profile-section-title">Stats</h3>
          <div class="stat-grid">
            ${statTile('Hands Played', stats.gamesPlayed.toLocaleString())}
            ${statTile('Total Points', stats.totalPoints.toLocaleString())}
            ${statTile('Best Score', stats.bestScore.toLocaleString())}
            ${statTile('Highest Hand', stats.bestHandLabel ?? '—')}
            ${statTile('Average Score', stats.averageScore.toLocaleString())}
            ${statTile('Avg Decision', formatPercent(stats.averageDecisionRating))}
            ${statTile('Best Decision', formatPercent(stats.bestDecisionRating))}
            ${statTile('Current Streak', `${stats.currentStreak} day${stats.currentStreak === 1 ? '' : 's'}`)}
            ${statTile('Longest Streak', `${stats.longestStreak} day${stats.longestStreak === 1 ? '' : 's'}`)}
            ${statTile('Rare Cards Kept', stats.rareCardsKept.toLocaleString())}
            ${statTile('Hand Types', `${stats.handsSeen.length} / ${stats.totalHandCategories}`)}
            ${statTile('Personalities', `${stats.personalitiesSeen.length} / ${stats.totalPersonalities}`)}
          </div>
        </section>

        ${customizeHtml()}

        ${recentHandsHtml(history, shownHands)}
        ${achievementsHtml(stats)}
        ${collectionHtml(stats)}

        <section class="profile-section profile-danger">
          <h3 class="profile-section-title">Account</h3>
          <div class="profile-account-actions">
            <button type="button" class="profile-signout-btn" id="profile-signout">Sign Out</button>
            <button type="button" class="profile-delete-btn" id="profile-delete">Delete Account</button>
          </div>
        </section>
      </div>
    `;

    const loadMore = root.querySelector('#profile-load-more');
    if (loadMore) {
      loadMore.addEventListener('click', () => {
        shownHands += HANDS_PER_PAGE;
        render();
        // Keep the newly-revealed rows in view instead of jumping to the top.
        root.querySelector('#recent-hands')?.scrollIntoView({ block: 'end', behavior: 'smooth' });
      });
    }

    root.querySelector('#profile-signout').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await signOut();
        window.location.href = '/';
      } catch (error) {
        button.disabled = false;
        alert(`Couldn't sign out: ${error.message ?? error}`);
      }
    });

    root.querySelector('#profile-delete').addEventListener('click', confirmDelete);
    wireCustomizePickers();
  }

  // Each picker is a row of chips: unlocked ones selectable, locked ones
  // disabled with their requirement as a tooltip so you can see what to aim
  // for rather than just being shown a blank.
  function wireCustomizePickers() {
    root.querySelectorAll('.cosmetic-chip[data-kind]').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const kind = chip.dataset.kind;
        const rawId = chip.dataset.id ?? '';
        const id = rawId === '' ? null : rawId;
        const slot = { badges: 'badge', titles: 'title', paints: 'paint' }[kind];

        // Re-checked even though locked chips are disabled: the page could have
        // been open across a level-up in another tab, and this is the last gate
        // before something unearned gets persisted.
        if (!canEquip(kind, id, { level: stats.level, achievementsUnlocked: stats.achievementsUnlocked })) return;

        const previous = equipped[slot];
        equipped[slot] = slot === 'paint' ? (id ?? DEFAULT_PAINT_ID) : id;
        render();
        const status = root.querySelector('#customize-status');
        try {
          await saveEquippedCosmetics(userId, {
            badge: equipped.badge,
            title: equipped.title,
            // The default paint is stored as null rather than its id — "no
            // paint chosen" and "explicitly chose the default" are the same
            // thing, and null keeps the column empty for the common case.
            paint: equipped.paint === DEFAULT_PAINT_ID ? null : equipped.paint,
          });
          announceProfileUpdate(equippedRow());
          if (status) {
            status.hidden = false;
            status.textContent = 'Saved.';
            status.classList.remove('customize-status--error');
          }
        } catch (error) {
          equipped[slot] = previous;
          render();
          const revertedStatus = root.querySelector('#customize-status');
          if (revertedStatus) {
            revertedStatus.hidden = false;
            revertedStatus.textContent = `Couldn't save: ${error.message ?? error}`;
            revertedStatus.classList.add('customize-status--error');
          }
        }
      });
    });
  }

  function customizeHtml() {
    return `
      <section class="profile-section">
        <h3 class="profile-section-title">Customize</h3>
        <p class="customize-preview-label">Preview</p>
        <div class="customize-preview">${nameplateHtml(equippedRow(), { fallbackName: username })}</div>
        <p class="login-status customize-status" id="customize-status" hidden></p>

        ${pickerHtml('Badge', 'badges', cosmetics.badges, equipped.badge, {
          noneLabel: 'None',
          renderChip: (item) => `${escapeHtml(item.emoji)} ${escapeHtml(item.label)}`,
        })}
        ${pickerHtml('Title', 'titles', cosmetics.titles, equipped.title, {
          noneLabel: 'None',
          renderChip: (item) => escapeHtml(item.label),
        })}
        ${pickerHtml('Name Paint', 'paints', cosmetics.paints, equipped.paint, {
          noneLabel: null, // the default paint IS the "none" option
          renderChip: (item) => `<span class="paint-${escapeHtml(item.id)}">${escapeHtml(item.label)}</span>`,
        })}
      </section>
    `;
  }

  function pickerHtml(heading, kind, items, selectedId, { noneLabel, renderChip }) {
    const unlockedCount = items.filter((i) => i.unlocked).length;
    const none =
      noneLabel === null
        ? ''
        : `<button type="button" class="cosmetic-chip${selectedId === null ? ' cosmetic-chip--selected' : ''}"
             data-kind="${kind}" data-id="">${escapeHtml(noneLabel)}</button>`;
    return `
      <h4 class="profile-subheading">${escapeHtml(heading)} <span class="profile-count">${unlockedCount} / ${items.length}</span></h4>
      <div class="cosmetic-picker">
        ${none}
        ${items
          .map((item) => {
            const selected = item.id === selectedId ? ' cosmetic-chip--selected' : '';
            const locked = item.unlocked ? '' : ' cosmetic-chip--locked';
            const disabled = item.unlocked ? '' : ' disabled';
            const tip = item.unlocked ? escapeHtml(item.label) : `🔒 ${escapeHtml(item.requirementText)}`;
            return `<button type="button" class="cosmetic-chip${selected}${locked}"
                      data-kind="${kind}" data-id="${escapeHtml(item.id)}" title="${tip}"${disabled}>${renderChip(item)}</button>`;
          })
          .join('')}
      </div>
    `;
  }

  // Deleting an account is irreversible and takes every stored run with it, so
  // it asks for the username to be typed rather than relying on a single
  // click-through — the one place in the app where an accidental click can't
  // be undone.
  function confirmDelete() {
    openModal({
      title: 'Delete Account',
      render: (body, close) => {
        body.innerHTML = `
          <p>This permanently deletes your account, your username, all
          ${stats.gamesPlayed.toLocaleString()} stored hand${stats.gamesPlayed === 1 ? '' : 's'}, and your friends list.
          <strong>It cannot be undone.</strong></p>
          <p>Type <strong>${escapeHtml(username)}</strong> to confirm.</p>
          <form class="login-form" id="delete-form">
            <input type="text" id="delete-confirm-input" autocomplete="off" placeholder="${escapeHtml(username)}" required />
            <button type="submit" class="profile-delete-btn" id="delete-confirm-btn" disabled>Delete Forever</button>
          </form>
          <p class="login-status" id="delete-status" hidden></p>
        `;
        const input = body.querySelector('#delete-confirm-input');
        const confirmBtn = body.querySelector('#delete-confirm-btn');
        const status = body.querySelector('#delete-status');

        input.addEventListener('input', () => {
          confirmBtn.disabled = input.value !== username;
        });

        body.querySelector('#delete-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          if (input.value !== username) return;
          confirmBtn.disabled = true;
          input.disabled = true;
          try {
            await deleteOwnAccount();
            close();
            window.location.href = '/';
          } catch (error) {
            input.disabled = false;
            confirmBtn.disabled = false;
            status.hidden = false;
            status.textContent = `Couldn't delete the account: ${error.message ?? error}`;
          }
        });
      },
    });
  }
}

function levelBlockHtml(stats) {
  const pct = Math.round(stats.levelProgress * 100);
  return `
    <div class="profile-level">
      <div class="profile-level-top">
        <span class="profile-level-badge">Level ${stats.level}</span>
        <span class="profile-level-xp">${stats.xpIntoLevel.toLocaleString()} / ${stats.xpForNextLevel.toLocaleString()} XP</span>
      </div>
      <div class="profile-xp-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
           aria-label="Progress to level ${stats.level + 1}">
        <div class="profile-xp-fill" style="width: ${pct}%"></div>
      </div>
      <p class="profile-level-total">${stats.totalXp.toLocaleString()} XP total</p>
    </div>
  `;
}

function statTile(label, value) {
  return `
    <div class="stat-tile">
      <span class="stat-tile-value">${escapeHtml(value)}</span>
      <span class="stat-tile-label">${escapeHtml(label)}</span>
    </div>
  `;
}

function recentHandsHtml(history, shown) {
  if (history.length === 0) {
    return `
      <section class="profile-section" id="recent-hands">
        <h3 class="profile-section-title">Recent Hands</h3>
        <p class="profile-empty-note">No hands played yet — today's is waiting.</p>
      </section>
    `;
  }

  const visible = history.slice(0, shown);
  const remaining = history.length - visible.length;
  return `
    <section class="profile-section" id="recent-hands">
      <h3 class="profile-section-title">Recent Hands</h3>
      <ul class="hand-history">
        ${visible.map(handRowHtml).join('')}
      </ul>
      ${
        remaining > 0
          ? `<button type="button" class="profile-load-more" id="profile-load-more">Load ${Math.min(
              remaining,
              HANDS_PER_PAGE,
            )} more (${remaining} left)</button>`
          : ''
      }
    </section>
  `;
}

function handRowHtml({ playDate, result }) {
  const score = result.score ?? {};
  const cards = Array.isArray(result.finalHand) ? result.finalHand : [];
  const personality = PERSONALITIES.find((p) => p.id === result.personalityId);
  return `
    <li class="hand-history-row">
      <div class="hand-history-meta">
        <span class="hand-history-date">${escapeHtml(formatDate(playDate))}</span>
        <span class="hand-history-label">${escapeHtml(score.handResult?.label ?? 'Unknown hand')}</span>
      </div>
      <div class="hand-history-cards">
        ${cards.map((card) => miniCardHtml(card)).join('')}
      </div>
      <div class="hand-history-numbers">
        <span class="hand-history-score">${(score.total ?? 0).toLocaleString()} pts</span>
        <span class="hand-history-rating">${formatPercent(result.decisionRating)}${
          personality ? ` · ${escapeHtml(personality.emoji)} ${escapeHtml(personality.label)}` : ''
        }</span>
      </div>
    </li>
  `;
}

// A read-only miniature of a card. Rarity gets a ring so a run that pulled
// something rare is visible at a glance in the history list.
function miniCardHtml(card) {
  if (!card || typeof card !== 'object') return '';
  const red = card.suit === 'H' || card.suit === 'D';
  const rarity = card.rarity ? ` history-card--${escapeHtml(card.rarity)}` : '';
  if (card.rarity === 'joker') {
    return `<span class="history-card history-card--wild${rarity}" title="Wild">🃏</span>`;
  }
  return `<span class="history-card${red ? ' history-card--red' : ''}${rarity}">${escapeHtml(
    rankLabel(card.rank),
  )}${escapeHtml(suitGlyph(card.suit) ?? '')}</span>`;
}

function achievementsHtml(stats) {
  const all = splitAchievements(stats.achievementsUnlocked);
  const earned = all.filter((a) => a.unlocked).length;
  return `
    <section class="profile-section">
      <h3 class="profile-section-title">Achievements <span class="profile-count">${earned} / ${all.length}</span></h3>
      <ul class="achievement-grid">
        ${all
          .map(
            (a) => `
          <li class="achievement-card${a.unlocked ? '' : ' achievement-card--locked'}">
            <span class="achievement-emoji">${escapeHtml(a.emoji)}</span>
            <span class="achievement-label">${escapeHtml(a.label)}</span>
            <span class="achievement-desc">${escapeHtml(a.description)}</span>
          </li>`,
          )
          .join('')}
      </ul>
    </section>
  `;
}

// Which hand categories and personalities have been seen — the "collection"
// half of the profile, and the thing the Collector/Personality achievements
// are actually tracking.
function collectionHtml(stats) {
  const handsSeen = new Set(stats.handsSeen);
  const personalitiesSeen = new Set(stats.personalitiesSeen);
  return `
    <section class="profile-section">
      <h3 class="profile-section-title">Collection</h3>
      <h4 class="profile-subheading">Hand Types <span class="profile-count">${handsSeen.size} / ${HAND_RANKS.length}</span></h4>
      <ul class="collection-list">
        ${HAND_RANKS.map(
          (rank) => `
          <li class="collection-chip${handsSeen.has(rank.id) ? '' : ' collection-chip--locked'}">${escapeHtml(rank.label)}</li>`,
        ).join('')}
      </ul>
      <h4 class="profile-subheading">Personalities <span class="profile-count">${personalitiesSeen.size} / ${PERSONALITIES.length}</span></h4>
      <ul class="collection-list">
        ${PERSONALITIES.map(
          (p) => `
          <li class="collection-chip${personalitiesSeen.has(p.id) ? '' : ' collection-chip--locked'}">${escapeHtml(
            p.emoji,
          )} ${escapeHtml(p.label)}</li>`,
        ).join('')}
      </ul>
    </section>
  `;
}
