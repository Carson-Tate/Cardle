// The admin page (DESIGN.md §11f) — reached at `?admin`, linked from the site
// header only for admins.
//
// The "only I can access it" guarantee does NOT come from this file. This is a
// static site with public JavaScript, so any check here can be read and skipped.
// It comes from Postgres: every action calls a `security definer` function that
// re-checks `public.is_admin()` server-side. The gate below decides what to
// RENDER; the database decides what actually happens. A non-admin who loads
// this URL sees the refusal notice, and even if they patched that away, every
// button would fail against the database.

import { getSession } from '../state/auth.js';
import {
  isCurrentUserAdmin,
  fetchAdminOverview,
  searchProfiles,
  fetchPlayerDetail,
  adminSetCosmetics,
  adminSetUnlocks,
  adminResetDay,
  adminDeletePlayer,
} from '../state/admin.js';
import { derivePlayerStats } from '../core/player-stats.js';
import { resolveCosmetics, resolveEquipped, BADGES, TITLES, NAME_PAINTS, DEFAULT_PAINT_ID } from '../core/cosmetics.js';
import { nameplateHtml } from './nameplate.js';
import { getDailyModifier } from '../core/modifiers.js';
import { dayNumber } from '../state/persistence.js';
import { openModal } from './modal.js';

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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function initAdmin(root) {
  root.innerHTML = `<p class="profile-loading">Checking access…</p>`;

  const session = await getSession().catch(() => null);
  const admin = session ? await isCurrentUserAdmin() : false;

  if (!admin) {
    root.innerHTML = `
      <div class="profile-empty">
        <h2>Admin</h2>
        <p>${session ? 'This account does not have admin access.' : 'Log in with an admin account to continue.'}</p>
        <a class="profile-back-link" href="/">← Back to today's hand</a>
      </div>
    `;
    return;
  }

  let overview = null;
  let results = [];
  let selected = null; // { profile, history, claimedDays, stats }
  let searchTerm = '';
  let notice = null;

  await Promise.all([loadOverview(), runSearch('')]);
  render();

  async function loadOverview() {
    try {
      overview = await fetchAdminOverview();
    } catch (error) {
      notice = { kind: 'error', text: `Couldn't load the overview: ${error.message ?? error}` };
    }
  }

  async function runSearch(term) {
    searchTerm = term;
    try {
      results = await searchProfiles(term);
    } catch (error) {
      results = [];
      notice = { kind: 'error', text: `Search failed: ${error.message ?? error}` };
    }
  }

  async function selectPlayer(userId) {
    try {
      const detail = await fetchPlayerDetail(userId);
      selected = { ...detail, stats: derivePlayerStats(detail.history) };
    } catch (error) {
      notice = { kind: 'error', text: `Couldn't load that player: ${error.message ?? error}` };
    }
    render();
  }

  // Re-reads the selected player from the database after a write, so what's on
  // screen is what's actually stored rather than an optimistic guess.
  async function refreshSelected(message) {
    if (selected?.profile) await selectPlayer(selected.profile.id);
    await loadOverview();
    notice = { kind: 'ok', text: message };
    render();
  }

  async function withNotice(action, successMessage) {
    try {
      await action();
      await refreshSelected(successMessage);
    } catch (error) {
      notice = { kind: 'error', text: `${error.message ?? error}` };
      render();
    }
  }

  function render() {
    root.innerHTML = `
      <div class="admin">
        <a class="profile-back-link" href="/">← Back to today's hand</a>
        <h2 class="admin-title">Admin</h2>
        <p class="admin-scope-note">
          Every action here is authorized by the database, not by this page — see
          <code>supabase/migrations/004-admin-foundation.sql</code>.
        </p>
        ${notice ? `<p class="admin-notice admin-notice--${notice.kind}">${escapeHtml(notice.text)}</p>` : ''}
        ${overviewHtml()}
        ${modifierHtml()}
        ${searchHtml()}
        ${selected ? playerHtml() : ''}
      </div>
    `;
    wire();
  }

  function overviewHtml() {
    if (!overview) return '';
    return `
      <section class="profile-section">
        <h3 class="profile-section-title">Overview</h3>
        <div class="stat-grid">
          ${tile('Total Profiles', overview.total_profiles)}
          ${tile('Active (24h)', overview.active_24h)}
          ${tile('Active (7d)', overview.active_7d)}
          ${tile('Active (30d)', overview.active_30d)}
          ${tile('Runs Today', overview.runs_today)}
          ${tile('Total Runs', overview.total_runs)}
          ${tile('Admins', overview.admins)}
        </div>
        <p class="admin-hint">
          "Active" counts accounts with a completed run in the window. Real login
          timestamps live in <code>auth.users</code> and aren't readable from the
          browser, so play activity is the honest available signal.
        </p>
      </section>
    `;
  }

  function tile(label, value) {
    const shown = typeof value === 'number' ? value.toLocaleString() : (value ?? '—');
    return `<div class="stat-tile"><span class="stat-tile-value">${escapeHtml(shown)}</span><span class="stat-tile-label">${escapeHtml(
      label,
    )}</span></div>`;
  }

  // Read-only for now: the modifier is a pure function of the date
  // (core/modifiers.js) with no server-side config to override, so showing the
  // schedule is honest while "change it" is not yet possible. Overriding it is
  // pass 2 — see §11f.
  function modifierHtml() {
    const days = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(Date.now() + offset * 86_400_000);
      const modifier = getDailyModifier(date);
      days.push({ date, modifier, offset });
    }
    return `
      <section class="profile-section">
        <h3 class="profile-section-title">Daily Modifier Schedule</h3>
        <ul class="admin-schedule">
          ${days
            .map(
              (d) => `
            <li class="admin-schedule-row${d.offset === 0 ? ' admin-schedule-row--today' : ''}">
              <span class="admin-schedule-day">${d.offset === 0 ? 'Today' : d.offset === 1 ? 'Tomorrow' : `+${d.offset}d`}
                <small>Cardle #${dayNumber(d.date)}</small></span>
              <span class="admin-schedule-mod">${escapeHtml(d.modifier.emoji)} ${escapeHtml(d.modifier.label)}</span>
            </li>`,
            )
            .join('')}
        </ul>
        <p class="admin-hint">
          Read-only. The modifier is currently computed from the date with no
          server-side override, so there is nothing to edit yet — making it
          changeable (and editing the poem word bank) is the next pass.
        </p>
      </section>
    `;
  }

  function searchHtml() {
    return `
      <section class="profile-section">
        <h3 class="profile-section-title">Players</h3>
        <form class="admin-search" id="admin-search-form">
          <input type="text" id="admin-search-input" placeholder="Search username…" value="${escapeHtml(searchTerm)}" autocomplete="off" />
          <button type="submit">Search</button>
        </form>
        ${
          results.length === 0
            ? `<p class="profile-empty-note">No profiles found.</p>`
            : `<ul class="admin-results">
                ${results
                  .map(
                    (p) => `
                  <li class="admin-result-row">
                    <span class="admin-result-name">${nameplateHtml(p)}</span>
                    ${p.is_admin ? '<span class="admin-tag">ADMIN</span>' : ''}
                    <button type="button" class="admin-select-btn" data-id="${escapeHtml(p.id)}">Manage</button>
                  </li>`,
                  )
                  .join('')}
              </ul>`
        }
      </section>
    `;
  }

  function playerHtml() {
    const { profile, stats, claimedDays } = selected;
    if (!profile) return '';
    const equipped = resolveEquipped(profile);
    const granted = new Set(profile.admin_unlocks ?? []);
    const cosmetics = resolveCosmetics({
      level: stats.level,
      achievementsUnlocked: stats.achievementsUnlocked,
      adminUnlocks: profile.admin_unlocks ?? [],
    });

    return `
      <section class="profile-section admin-player">
        <h3 class="profile-section-title">Managing ${escapeHtml(profile.username ?? profile.id)}</h3>
        <div class="customize-preview">${nameplateHtml(profile)}</div>

        <div class="stat-grid">
          ${tile('Level', stats.level)}
          ${tile('Hands Played', stats.gamesPlayed)}
          ${tile('Total Points', stats.totalPoints)}
          ${tile('Best Score', stats.bestScore)}
          ${tile('Total XP', stats.totalXp)}
          ${tile('Achievements', `${stats.achievementsUnlocked.length} / ${stats.totalAchievements}`)}
        </div>

        <h4 class="profile-subheading">Equipped</h4>
        <div class="admin-equip-grid">
          ${equipSelect('Badge', 'badge', BADGES, equipped.badge?.id ?? '')}
          ${equipSelect('Title', 'title', TITLES, equipped.title?.id ?? '')}
          ${equipSelect('Paint', 'paint', NAME_PAINTS, equipped.paint?.id ?? DEFAULT_PAINT_ID)}
        </div>
        <button type="button" class="admin-action-btn" id="admin-save-equipped">Save Equipped</button>

        <h4 class="profile-subheading">
          Granted Unlocks <span class="profile-count">${granted.size}</span>
        </h4>
        <p class="admin-hint">
          Grants force-unlock a cosmetic regardless of level or achievements.
          Normal unlocks stay earned — a grant only ever adds.
        </p>
        <div class="cosmetic-picker" id="admin-grant-picker">
          ${[...cosmetics.badges, ...cosmetics.titles, ...cosmetics.paints]
            .filter((c) => c.id !== DEFAULT_PAINT_ID)
            .map((c) => {
              const isGranted = granted.has(c.id);
              const earned = c.unlocked && !c.grantedByAdmin;
              return `<button type="button"
                class="cosmetic-chip${isGranted ? ' cosmetic-chip--selected' : ''}${earned ? ' admin-chip--earned' : ''}"
                data-grant="${escapeHtml(c.id)}"
                title="${earned ? 'Earned normally' : isGranted ? 'Granted by admin — click to remove' : 'Click to grant'}"
                ${earned ? 'disabled' : ''}>${escapeHtml(c.emoji ? `${c.emoji} ` : '')}${escapeHtml(c.label)}</button>`;
            })
            .join('')}
        </div>

        <h4 class="profile-subheading">Reset a Day</h4>
        <p class="admin-hint">
          Clears their claimed hand for that date so it can be played again.
          ${claimedDays.length > 0 ? `Most recent claim: ${escapeHtml(formatDate(claimedDays[0].playDate))}.` : 'No days claimed yet.'}
        </p>
        <form class="admin-search" id="admin-reset-form">
          <input type="date" id="admin-reset-date" value="${todayIso()}" />
          <button type="submit" class="admin-action-btn">Reset Day</button>
        </form>

        <h4 class="profile-subheading">Danger</h4>
        <button type="button" class="profile-delete-btn" id="admin-delete-player"${profile.is_admin ? ' disabled' : ''}>
          Delete This Account
        </button>
        ${
          profile.is_admin
            ? `<p class="admin-hint">Admin accounts can't be deleted here — clear <code>is_admin</code> in SQL first. That's deliberate: an accidental click would be unrecoverable and could lock the project out of its own admin access.</p>`
            : ''
        }
      </section>
    `;
  }

  function equipSelect(label, slot, items, current) {
    return `
      <label class="admin-equip-field">
        <span class="stat-tile-label">${escapeHtml(label)}</span>
        <select data-equip="${slot}">
          <option value=""${current === '' ? ' selected' : ''}>— none —</option>
          ${items
            .map(
              (i) =>
                `<option value="${escapeHtml(i.id)}"${i.id === current ? ' selected' : ''}>${escapeHtml(
                  i.emoji ? `${i.emoji} ${i.label}` : i.label,
                )}</option>`,
            )
            .join('')}
        </select>
      </label>
    `;
  }

  function wire() {
    root.querySelector('#admin-search-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      notice = null;
      await runSearch(root.querySelector('#admin-search-input').value);
      render();
    });

    root.querySelectorAll('.admin-select-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        notice = null;
        selectPlayer(btn.dataset.id);
      });
    });

    root.querySelector('#admin-save-equipped')?.addEventListener('click', () => {
      const read = (slot) => root.querySelector(`select[data-equip="${slot}"]`)?.value || null;
      const paint = read('paint');
      withNotice(
        () =>
          adminSetCosmetics(selected.profile.id, {
            badge: read('badge'),
            title: read('title'),
            // Stored as null for the default, matching how a player's own save
            // behaves (profile.js) so the two paths can't diverge.
            paint: paint === DEFAULT_PAINT_ID ? null : paint,
          }),
        'Equipped cosmetics saved.',
      );
    });

    root.querySelectorAll('[data-grant]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.grant;
        const current = new Set(selected.profile.admin_unlocks ?? []);
        if (current.has(id)) current.delete(id);
        else current.add(id);
        withNotice(() => adminSetUnlocks(selected.profile.id, [...current]), 'Grants updated.');
      });
    });

    root.querySelector('#admin-reset-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const date = root.querySelector('#admin-reset-date').value || null;
      withNotice(() => adminResetDay(selected.profile.id, date), `Reset ${date ?? 'today'}.`);
    });

    root.querySelector('#admin-delete-player')?.addEventListener('click', () => confirmDeletePlayer());
  }

  function confirmDeletePlayer() {
    const { profile } = selected;
    const name = profile.username ?? profile.id;
    openModal({
      title: 'Delete Player',
      render: (body, close) => {
        body.innerHTML = `
          <p>This permanently deletes <strong>${escapeHtml(name)}</strong>, their username, every stored hand,
          and all their friendships. <strong>It cannot be undone.</strong></p>
          <p>Type <strong>${escapeHtml(name)}</strong> to confirm.</p>
          <form class="login-form" id="admin-del-form">
            <input type="text" id="admin-del-input" autocomplete="off" required />
            <button type="submit" class="profile-delete-btn" id="admin-del-btn" disabled>Delete Forever</button>
          </form>
          <p class="login-status" id="admin-del-status" hidden></p>
        `;
        const input = body.querySelector('#admin-del-input');
        const btn = body.querySelector('#admin-del-btn');
        input.addEventListener('input', () => {
          btn.disabled = input.value !== name;
        });
        body.querySelector('#admin-del-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          if (input.value !== name) return;
          btn.disabled = true;
          try {
            await adminDeletePlayer(profile.id);
            close();
            selected = null;
            await Promise.all([loadOverview(), runSearch(searchTerm)]);
            notice = { kind: 'ok', text: `Deleted ${name}.` };
            render();
          } catch (error) {
            btn.disabled = false;
            const status = body.querySelector('#admin-del-status');
            status.hidden = false;
            status.textContent = `${error.message ?? error}`;
          }
        });
      },
    });
  }
}
