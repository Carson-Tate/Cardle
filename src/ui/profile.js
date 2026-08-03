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
import {
  fetchPlayHistory,
  loadOwnHistory,
  deleteOwnAccount,
  saveEquippedCosmetics,
  fetchProfileByUsername,
  updateUsername,
} from '../state/profile.js';
import { getFriendshipWith, sendFriendRequest, acceptFriendRequest } from '../state/friends.js';
import { loadGameConfig } from '../state/game-config.js';
import { derivePlayerStats, splitAchievements } from '../core/player-stats.js';
import { resolveCosmetics, resolveEquipped, canEquip, DEFAULT_PAINT_ID } from '../core/cosmetics.js';
import { nameplateHtml, announceProfileUpdate } from './nameplate.js';
import { miniCardHtml, miniHandHtml } from './mini-card.js';
import { PERSONALITIES } from '../core/personality.js';
import { HAND_RANKS } from '../core/hand-evaluator.js';
import { gradeForScore } from '../core/score-grade.js';
import { openModal } from './modal.js';
import { openHandBreakdown } from './hand-modal.js';

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

/**
 * @param {HTMLElement} root
 * @param {{username?: string|null}} [options] - `username` views SOMEONE ELSE's
 *   profile (`?profile=<username>`, §11j). Omitted/null means your own.
 */
export async function initProfile(root, { username: viewingUsername = null } = {}) {
  root.innerHTML = `<p class="profile-loading">Loading profile…</p>`;

  const session = await getSession().catch(() => null);

  // Viewing another player: resolve their id from the username first. Kept
  // separate from the signed-out branch below because a signed-in visitor
  // viewing a stranger is a perfectly normal case, whereas being signed out is
  // not — reading anyone's runs requires an authenticated caller (§11j).
  let viewedProfile = null;
  if (viewingUsername) {
    if (!session) {
      root.innerHTML = `
        <div class="profile-empty">
          <h2>${escapeHtml(viewingUsername)}</h2>
          <p>Log in to view other players' profiles.</p>
          <a class="profile-back-link" href="/">← Back to today's hand</a>
        </div>
      `;
      return;
    }
    try {
      viewedProfile = await fetchProfileByUsername(viewingUsername);
    } catch {
      viewedProfile = null;
    }
    if (!viewedProfile) {
      root.innerHTML = `
        <div class="profile-empty">
          <h2>Not found</h2>
          <p>No player called <strong>${escapeHtml(viewingUsername)}</strong>.</p>
          <a class="profile-back-link" href="/">← Back to today's hand</a>
        </div>
      `;
      return;
    }
    // Viewing your own username via the URL is just your own profile — don't
    // render a read-only copy of it with the controls stripped out.
    if (session.user.id === viewedProfile.id) viewedProfile = null;
  }

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

  // `userId` is whose data is shown; `viewerId` is who is looking. They differ
  // when viewing someone else, and every write path below is gated on them
  // matching (`canEdit`).
  const viewerId = session.user.id;
  const userId = viewedProfile ? viewedProfile.id : viewerId;
  const canEdit = !viewedProfile;
  let profile = null;
  let history = [];
  let gameConfig = null;
  let loadError = null;
  // Only meaningful when looking at SOMEBODY ELSE — `null` on your own profile,
  // which is what keeps the friend button off it. Fetched alongside everything
  // else rather than after render, so the button paints in its correct state
  // instead of flickering from "Add Friend" to "Friends".
  let friendship = null;
  try {
    [profile, history, gameConfig, friendship] = await Promise.all([
      viewedProfile ? Promise.resolve(viewedProfile) : getProfile(userId).catch(() => null),
      // The header already loads YOUR history for its XP bar, so reuse that one
      // fetch rather than pulling the same few hundred rows twice on this page.
      // Someone else's profile has no cache to share and goes direct.
      canEdit ? loadOwnHistory(userId) : fetchPlayHistory(userId),
      loadGameConfig(),
      // Tolerates failure: a friendship lookup that errors should cost the
      // button, not the whole profile page.
      canEdit ? Promise.resolve(null) : getFriendshipWith(viewerId, userId).catch(() => null),
    ]);
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
  // `let`, not `const`: renaming updates this in place so the page can re-render
  // under the new name without a reload.
  let username = profile?.username ?? session.user.email ?? 'Player';
  let shownHands = HANDS_PER_PAGE;

  // Equipped cosmetics, held as ids so the pickers and the live nameplate
  // preview stay in sync without a round trip. Seeded from the stored row and
  // updated optimistically on selection — a failed save reverts and says so.
  const custom = gameConfig?.customCosmetics ?? null;
  const stored = resolveEquipped(profile, custom);
  let equipped = {
    badge: stored.badge?.id ?? null,
    title: stored.title?.id ?? null,
    paint: stored.paint?.id ?? DEFAULT_PAINT_ID,
  };
  // One shared context for BOTH the picker and the pre-save re-check below, so
  // the two can never disagree about what this player may equip.
  // `adminUnlocks` matters: cosmetic unlocks are otherwise derived from
  // achievements and level, so without it an admin-granted cosmetic would show
  // as locked to the player who was given it -- the grant would do nothing.
  const playerContext = {
    level: stats.level,
    achievementsUnlocked: stats.achievementsUnlocked,
    adminUnlocks: profile?.admin_unlocks ?? [],
    custom,
  };
  const cosmetics = resolveCosmetics(playerContext);

  // The shape nameplateHtml expects, rebuilt from the current selection so the
  // header preview updates the instant a picker changes.
  //
  // `admin_unlocks` has to be carried through. It isn't decorative: a grant-only
  // custom cosmetic is deliberately dropped by resolveEquipped() unless the row
  // proves the player holds the grant (§11h). Omitting it here is exactly the
  // bug the owner hit — an admin-granted title equipped fine and then rendered
  // as nothing, on the very page you equip it from.
  function equippedRow() {
    return {
      username,
      equipped_badge: equipped.badge,
      equipped_title: equipped.title,
      equipped_paint: equipped.paint,
      admin_unlocks: profile?.admin_unlocks ?? [],
    };
  }

  render();

  function render() {
    root.innerHTML = `
      <div class="profile">
        <a class="profile-back-link" href="${canEdit ? '/' : '/?leaderboard'}">${
          canEdit ? '← Back to today&rsquo;s hand' : '← Back to the leaderboards'
        }</a>
        ${canEdit ? '' : '<p class="profile-viewing-note">Viewing another player&rsquo;s profile.</p>'}

        <header class="profile-header">
          <div class="profile-header-top">
            <div class="profile-identity">
              <h2 class="profile-username">${nameplateHtml(equippedRow(), { fallbackName: username, custom })}</h2>
              <p class="profile-since">${stats.firstPlayDate ? `Playing since ${formatDate(stats.firstPlayDate)}` : 'No hands played yet'}</p>
              ${friendActionHtml()}
            </div>
            ${levelBlockHtml(stats)}
          </div>
          ${bestRunHtml(stats)}
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

        ${canEdit ? customizeHtml() : ''}

        ${recentHandsHtml(history, shownHands)}
        ${achievementsHtml(stats)}
        ${collectionHtml(stats)}

        ${
          canEdit
            ? `<section class="profile-section profile-danger">
          <h3 class="profile-section-title">Account</h3>
          <div class="profile-account-actions">
            <button type="button" class="profile-rename-btn" id="profile-rename">Change Name</button>
            <button type="button" class="profile-signout-btn" id="profile-signout">Sign Out</button>
            <button type="button" class="profile-delete-btn" id="profile-delete">Delete Account</button>
          </div>
        </section>`
            : ''
        }
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

    // The Best Hand plaque opens the same modal. `stats.bestRun` IS a stored
    // result blob, so nothing needs fetching or reshaping here either.
    root.querySelector('#profile-best-run')?.addEventListener('click', () => {
      if (!stats.bestRun) return;
      openHandBreakdown({
        title: profile?.username ?? 'Hand Breakdown',
        playDate: stats.bestRunDate,
        result: stats.bestRun,
      });
    });

    // Click a past hand to see how it scored (§11ab). No fetch — this page
    // already holds every row's full result, so the entry is read straight out
    // of `history` by the index the row was rendered with.
    root.querySelectorAll('.hand-history-open').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = history[Number(btn.dataset.handIndex)];
        if (!entry) return;
        openHandBreakdown({
          title: profile?.username ?? 'Hand Breakdown',
          playDate: entry.playDate,
          result: entry.result,
        });
      });
    });

    root.querySelector('#profile-signout')?.addEventListener('click', async (event) => {
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

    root.querySelector('#profile-rename')?.addEventListener('click', confirmRename);
    root.querySelector('#profile-delete')?.addEventListener('click', confirmDelete);
    root.querySelector('#profile-friend-action')?.addEventListener('click', onFriendAction);
    if (canEdit) wireCustomizePickers();
  }

  // Add a friend straight from their profile (owner request: "click to add
  // friend on their profile"). Previously the only route was the header panel,
  // which meant seeing someone on the leaderboard, opening their profile, then
  // going back and typing their name from memory somewhere else entirely.
  //
  // Renders the state rather than a fixed "Add Friend": the row already exists
  // in three other shapes, and offering "Add" to someone who has already asked
  // YOU would try to create the reciprocal duplicate that migration 010 forbids.
  function friendActionHtml() {
    if (canEdit) return ''; // your own profile — nothing to add
    const label =
      friendship === null
        ? 'Add Friend'
        : friendship.status === 'accepted'
          ? 'Friends ✓'
          : friendship.requester_id === viewerId
            ? 'Request Sent'
            : 'Accept Request';
    // Only the two actionable states are clickable. "Friends" and "Request Sent"
    // are statements — removing a friend or cancelling a request stays in the
    // friends panel, where the confirmation context is.
    const actionable = friendship === null || (friendship.status === 'pending' && friendship.requester_id !== viewerId);
    return `<p class="profile-friend-row">
      <button type="button" id="profile-friend-action" class="profile-friend-btn${actionable ? '' : ' profile-friend-btn--done'}"
        ${actionable ? '' : 'disabled'}>${label}</button>
    </p>`;
  }

  async function onFriendAction(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      if (friendship === null) {
        await sendFriendRequest(viewerId, username);
      } else if (friendship.status === 'pending' && friendship.requester_id !== viewerId) {
        await acceptFriendRequest(friendship.id);
      }
      // Re-read rather than assuming what the write produced — the accept path
      // changes status while the send path creates a row whose id this page
      // never saw, and a later render needs the real one.
      friendship = await getFriendshipWith(viewerId, userId).catch(() => friendship);
      render();
    } catch (error) {
      button.disabled = false;
      const row = root.querySelector('.profile-friend-row');
      if (row) row.insertAdjacentHTML('beforeend', `<span class="profile-friend-error">${escapeHtml(error.message ?? error)}</span>`);
    }
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
        if (!canEquip(kind, id, playerContext)) return;

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
        <div class="customize-preview">${nameplateHtml(equippedRow(), { fallbackName: username, custom })}</div>
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
          // The swatch already shows the colour; the ✨ marks the ones that move,
          // which a still chip can't convey on its own.
          renderChip: (item) =>
            `<span class="paint-${escapeHtml(item.id)}">${escapeHtml(item.label)}</span>${
              item.animated ? '<span class="paint-animated-mark" title="Animated">✨</span>' : ''
            }`,
        })}
      </section>
    `;
  }

  function pickerHtml(heading, kind, allItems, selectedId, { noneLabel, renderChip }) {
    // `hidden` entries are grant-only custom cosmetics this player wasn't
    // granted (§11h) — an exclusive cosmetic shouldn't advertise itself to
    // everyone, so it isn't listed at all rather than shown as locked.
    const items = allItems.filter((i) => !i.hidden);
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

  // Changing your username (owner request: "i also would like the option to
  // change my name").
  //
  // Deliberately NOT a destructive-style confirm like delete: renaming is
  // reversible, so it just needs a field and a save. It does two things worth
  // noting:
  //
  //  - It re-renders in place and announces the change, rather than reloading.
  //    Every surface that shows your name reads it from the same row, so the
  //    profile heading, the delete-confirmation prompt and the site header all
  //    need to agree afterwards — PROFILE_UPDATED_EVENT is the existing channel
  //    for exactly that (see nameplate.js).
  //  - The name is validated client-side for immediate feedback, but the
  //    database's unique index is what actually decides "taken" — state/profile.js
  //    turns that into a message shown here verbatim.
  function confirmRename() {
    openModal({
      title: 'Change Name',
      render: (body, close) => {
        body.innerHTML = `
          <p>Pick a new username. 3-20 characters: letters, numbers and underscores.</p>
          <form class="login-form" id="rename-form">
            <input type="text" id="rename-input" autocomplete="off" maxlength="20"
              value="${escapeHtml(username)}" required />
            <button type="submit" class="profile-rename-btn" id="rename-submit">Save Name</button>
          </form>
          <p class="login-status" id="rename-status" hidden></p>
        `;
        const input = body.querySelector('#rename-input');
        const submit = body.querySelector('#rename-submit');
        const status = body.querySelector('#rename-status');
        input.focus();
        input.select();

        const fail = (message) => {
          status.hidden = false;
          status.textContent = message;
          submit.disabled = false;
          input.disabled = false;
        };

        body.querySelector('#rename-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const next = input.value.trim();
          // Saying "that's already your name" beats a silent no-op that looks
          // like the save failed. Compared case-INSENSITIVELY: stored names are
          // uppercase (§11n), so typing "car" when you are CAR is the same name,
          // not a rename — a case-sensitive check here would let it through as a
          // pointless write that appears to succeed while changing nothing.
          if (next.toUpperCase() === username.toUpperCase()) return fail('That is already your name.');
          submit.disabled = true;
          input.disabled = true;
          status.hidden = true;
          try {
            const saved = await updateUsername(userId, next);
            username = saved;
            if (profile) profile.username = saved;
            // Keeps the site header's nameplate in step without a reload.
            announceProfileUpdate({ ...(profile ?? {}), username: saved });
            close();
            render();
          } catch (error) {
            fail(error.message ?? String(error));
          }
        });
      },
    });
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

        // Case-insensitive. The friction that matters here is having to type your
        // own name deliberately, not matching its case — and since names became
        // uppercase (§11n), an exact-match check would reject the lower-case
        // spelling most people would type and give no clue why.
        const matches = () => input.value.trim().toUpperCase() === username.toUpperCase();

        input.addEventListener('input', () => {
          confirmBtn.disabled = !matches();
        });

        body.querySelector('#delete-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          if (!matches()) return;
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

// The best run, showcased directly under the name (owner request: "in the
// profile i would like to display the best hand right under the name, along with
// the points and rarity of points under it").
//
// Uses `bestRun` — the highest-SCORING run — rather than `bestHandLabel`, which
// tracks the highest-ranked hand category and can come from a different day.
// They have to be the same run here: showing one run's cards above another run's
// points would be quietly wrong in a way nobody would catch.
//
// Renders nothing at all for a player with no completed runs. An empty medal
// frame reads as a loading failure, and the stats grid below already says the
// history is empty.
function bestRunHtml(stats) {
  const run = stats.bestRun;
  if (!run || !stats.bestScore) return '';
  const hand = Array.isArray(run.finalHand) ? run.finalHand : null;
  const grade = gradeForScore(stats.bestScore);
  const handLabel = run.score?.handResult?.label ?? null;

  // A <button> for the same reason the history rows are (§11ab): this plaque is
  // one destination, so the whole thing is the control. Unlike a leaderboard row
  // it contains no nested link, which is why the entire plaque can be the target
  // rather than just the cards.
  return `
    <button type="button" class="best-run best-run--open" id="profile-best-run"
      aria-label="${escapeHtml(
        `See how this ${handLabel ?? 'hand'} scored — ${stats.bestScore.toLocaleString()} points, your best`,
      )}">
      <div class="best-run-head">
        <span class="best-run-label">Best Hand</span>
        ${handLabel ? `<span class="best-run-hand-name">${escapeHtml(handLabel)}</span>` : ''}
      </div>
      ${hand ? `<div class="best-run-cards">${miniHandHtml(hand)}</div>` : ''}
      <div class="best-run-score">
        <span class="best-run-points grade-pill score-grade--${grade.id}"
          title="${escapeHtml(`${grade.label} — ${stats.bestScore.toLocaleString()} points`)}">
          ${stats.bestScore.toLocaleString()}
        </span>
        <span class="best-run-grade">${grade.emoji} ${escapeHtml(grade.label)}</span>
      </div>
    </button>
  `;
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

// `index` addresses the row back into `history` on click (§11ab). The whole
// result blob is already in memory here — the profile fetches complete rows,
// unlike the leaderboard — so opening a breakdown costs no request at all.
// Passing the index rather than serialising the blob into a data attribute
// keeps several KB of JSON out of the markup for every row on the page.
function handRowHtml({ playDate, result }, index) {
  const score = result.score ?? {};
  const cards = Array.isArray(result.finalHand) ? result.finalHand : [];
  const personality = PERSONALITIES.find((p) => p.id === result.personalityId);
  return `
    <li class="hand-history-row">
      <button type="button" class="hand-history-open" data-hand-index="${index}"
        aria-label="${escapeHtml(
          `See how this ${score.handResult?.label ?? 'hand'} scored — ${(score.total ?? 0).toLocaleString()} points on ${formatDate(playDate)}`,
        )}">
      <div class="hand-history-meta">
        <span class="hand-history-date">${escapeHtml(formatDate(playDate))}</span>
        <span class="hand-history-label">${escapeHtml(score.handResult?.label ?? 'Unknown hand')}</span>
        ${(() => {
          const grade = gradeForScore(score.total);
          return `<span class="history-grade score-grade--${grade.id}">${escapeHtml(grade.emoji)} ${escapeHtml(grade.label)}</span>`;
        })()}
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
      </button>
    </li>
  `;
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
