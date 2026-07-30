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
import { resolveCosmetics, resolveEquipped, DEFAULT_PAINT_ID } from '../core/cosmetics.js';
import { nameplateHtml } from './nameplate.js';
import { getDailyModifier, MODIFIERS } from '../core/modifiers.js';
import {
  CONFIG_KEYS,
  validateModifierOverrides,
  validateWordBank,
  validateCustomCosmetics,
  wordBankSlots,
  modifierOverrideFor,
} from '../core/game-config.js';
import { loadGameConfig, adminSetConfig, adminClearConfig } from '../state/game-config.js';
import { dayNumber } from '../state/persistence.js';
import { openModal } from './modal.js';
import { gameDayFor } from '../core/game-day.js';

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

// The current GAME day (§11l), so an admin resetting "today" clears the day the
// player is actually on rather than whatever the UTC calendar says.
function todayIso() {
  return gameDayFor(new Date());
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
  let gameConfig = null;

  await Promise.all([loadOverview(), runSearch(''), loadConfig()]);
  render();

  async function loadConfig() {
    try {
      // The VALIDATED config, deliberately -- not the raw stored rows. The
      // editors must show what the game is actually honouring, so a stored value
      // that failed validation appears as the default it fell back to rather
      // than as text the game is silently ignoring.
      gameConfig = await loadGameConfig({ force: true });
    } catch (error) {
      notice = { kind: 'error', text: `Couldn't load game config: ${error.message ?? error}` };
    }
  }

  // Saves a config key after validating it here first, so an invalid value is
  // refused before it can reach a table every player's client reads.
  async function saveConfig(key, value, validate, successMessage) {
    const { errors } = validate(value);
    if (errors.length > 0) {
      notice = { kind: 'error', text: errors.join(' · ') };
      render();
      return;
    }
    try {
      await adminSetConfig(key, value);
      await loadConfig();
      notice = { kind: 'ok', text: successMessage };
    } catch (error) {
      notice = { kind: 'error', text: `${error.message ?? error}` };
    }
    render();
  }

  async function clearConfig(key, successMessage) {
    try {
      await adminClearConfig(key);
      await loadConfig();
      notice = { kind: 'ok', text: successMessage };
    } catch (error) {
      notice = { kind: 'error', text: `${error.message ?? error}` };
    }
    render();
  }

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
        ${wordBankHtml()}
        ${customCosmeticsHtml()}
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

  // Editable now that `game_config` exists (§11g). Each of the next 14 days
  // shows its computed modifier and lets an admin pin a different one; the
  // override is stored per ISO date, so it applies to that specific day rather
  // than shifting the whole rotation.
  function modifierHtml() {
    const overrides = gameConfig?.modifierOverrides ?? {};
    const days = [];
    for (let offset = 0; offset < 14; offset++) {
      const date = new Date(Date.now() + offset * 86_400_000);
      const iso = date.toISOString().slice(0, 10);
      const overrideId = modifierOverrideFor(overrides, date);
      days.push({ date, iso, offset, overrideId, effective: getDailyModifier(date, overrideId) });
    }
    const overrideCount = Object.keys(overrides).length;

    return `
      <section class="profile-section">
        <h3 class="profile-section-title">
          Daily Modifier Schedule ${overrideCount > 0 ? `<span class="profile-count">${overrideCount} overridden</span>` : ''}
        </h3>
        <ul class="admin-schedule">
          ${days
            .map(
              (d) => `
            <li class="admin-schedule-row${d.offset === 0 ? ' admin-schedule-row--today' : ''}${
                d.overrideId ? ' admin-schedule-row--overridden' : ''
              }">
              <span class="admin-schedule-day">
                ${d.offset === 0 ? 'Today' : d.offset === 1 ? 'Tomorrow' : `+${d.offset}d`}
                <small>${escapeHtml(d.iso)} · Cardle #${dayNumber(d.date)}</small>
              </span>
              <span class="admin-schedule-mod">
                <select data-modifier-day="${escapeHtml(d.iso)}">
                  <option value=""${d.overrideId ? '' : ' selected'}>— rotation —</option>
                  ${MODIFIERS.map(
                    (m) =>
                      `<option value="${escapeHtml(m.id)}"${m.id === d.overrideId ? ' selected' : ''}>${escapeHtml(
                        `${m.emoji} ${m.label}`,
                      )}</option>`,
                  ).join('')}
                </select>
                <small>${escapeHtml(`${d.effective.emoji} ${d.effective.label}`)}${d.overrideId ? ' (pinned)' : ''}</small>
              </span>
            </li>`,
            )
            .join('')}
        </ul>
        <div class="admin-search">
          <button type="button" class="admin-action-btn" id="admin-save-modifiers">Save Schedule</button>
          <button type="button" class="admin-action-btn" id="admin-clear-modifiers">Clear All Overrides</button>
        </div>
        <p class="admin-hint">
          A pinned day replaces the rotation for that date only. Players pick up
          the change on their next page load, and it is applied before any hand
          is dealt — but a player who already locked in today keeps the hand they
          played.
        </p>
      </section>
    `;
  }

  // The poem word bank (§6c). Edited as one phrase per line, which matches how
  // the fragments read and avoids inventing a JSON editor for what is really
  // just six lists of short strings. Saving is PARTIAL: a slot left identical to
  // its built-in default is not stored, so future built-in additions still reach
  // players for the slots the admin never touched.
  function wordBankHtml() {
    const stored = gameConfig?.wordBank ?? {};
    const slots = wordBankSlots();
    const storedFor = (slot) => {
      if (slot === 'ending.good') return stored.ending?.good;
      if (slot === 'ending.bad') return stored.ending?.bad;
      return stored[slot];
    };
    const overriddenCount = slots.filter((s) => storedFor(s.slot)).length;

    return `
      <section class="profile-section">
        <h3 class="profile-section-title">
          Poem Word Bank ${overriddenCount > 0 ? `<span class="profile-count">${overriddenCount} customised</span>` : ''}
        </h3>
        <div class="admin-wordbank">
          ${slots
            .map((slot) => {
              const current = storedFor(slot.slot) ?? slot.defaults;
              const isOverridden = Boolean(storedFor(slot.slot));
              return `
              <label class="admin-wordbank-field">
                <span class="stat-tile-label">
                  ${escapeHtml(slot.label)}
                  ${isOverridden ? '<em class="admin-wordbank-flag">customised</em>' : ''}
                </span>
                <textarea data-wordbank="${escapeHtml(slot.slot)}" rows="6"
                  spellcheck="false">${escapeHtml(current.join('\n'))}</textarea>
              </label>`;
            })
            .join('')}
        </div>
        <div class="admin-search">
          <button type="button" class="admin-action-btn" id="admin-save-wordbank">Save Word Bank</button>
          <button type="button" class="admin-action-btn" id="admin-reset-wordbank">Reset to Built-ins</button>
        </div>
        <p class="admin-hint">
          One phrase per line. Phrases must not contain a period — the caption is
          assembled as a single sentence, so an internal period would break it.
          Blank lines and duplicates are dropped automatically.
        </p>
      </section>
    `;
  }

  // Authoring brand-new cosmetics. Titles and paints unlock by level like the
  // built-ins; a custom BADGE has no achievement behind it, so it can only be
  // handed out with an admin grant — stated in the hint rather than showing an
  // unreachable requirement.
  // Plain-English description of how a custom cosmetic is obtained, so the list
  // makes an over-permissive entry obvious rather than hiding it behind a level
  // number that happens to be 1.
  function availabilityLabel(entry) {
    const mode = entry.availability ?? 'level';
    if (mode === 'everyone') return 'everyone';
    if (mode === 'grant') return 'admin grant only (hidden)';
    return `level ${entry.level}`;
  }

  function customCosmeticsHtml() {
    const custom = gameConfig?.customCosmetics ?? { badges: [], titles: [], paints: [] };
    const rows = [
      ...custom.badges.map((b) => ({ kind: 'badge', ...b })),
      ...custom.titles.map((t) => ({ kind: 'title', ...t })),
      ...custom.paints.map((p) => ({ kind: 'paint', ...p })),
    ];
    return `
      <section class="profile-section">
        <h3 class="profile-section-title">
          Custom Cosmetics ${rows.length > 0 ? `<span class="profile-count">${rows.length}</span>` : ''}
        </h3>
        ${
          rows.length === 0
            ? '<p class="profile-empty-note">None yet.</p>'
            : `<ul class="admin-results">
                ${rows
                  .map(
                    (r) => `
                  <li class="admin-result-row">
                    <span class="admin-tag">${escapeHtml(r.kind.toUpperCase())}</span>
                    <span class="admin-result-name">
                      ${r.kind === 'paint' ? `<span style="color: ${escapeHtml(r.color)}">${escapeHtml(r.label)}</span>` : escapeHtml(`${r.emoji ?? ''} ${r.label}`)}
                      <small>${escapeHtml(r.id)} · ${escapeHtml(availabilityLabel(r))}</small>
                    </span>
                    <button type="button" class="admin-remove-btn" data-remove-cosmetic="${escapeHtml(r.id)}">Remove</button>
                  </li>`,
                  )
                  .join('')}
              </ul>`
        }
        <h4 class="profile-subheading">Add one</h4>
        <div class="admin-equip-grid">
          <label class="admin-equip-field">
            <span class="stat-tile-label">Kind</span>
            <select id="new-cosmetic-kind">
              <option value="title">Title</option>
              <option value="paint">Name Paint</option>
              <option value="badge">Badge</option>
            </select>
          </label>
          <label class="admin-equip-field">
            <span class="stat-tile-label">Id</span>
            <input type="text" id="new-cosmetic-id" placeholder="title_beta" autocomplete="off" />
          </label>
          <label class="admin-equip-field">
            <span class="stat-tile-label">Label</span>
            <input type="text" id="new-cosmetic-label" placeholder="Beta Tester" autocomplete="off" />
          </label>
          <label class="admin-equip-field">
            <span class="stat-tile-label">Availability</span>
            <select id="new-cosmetic-availability">
              <option value="level">Unlock at level</option>
              <option value="everyone">Unlocked for everyone</option>
              <option value="grant">Locked / hidden (admin grant only)</option>
            </select>
          </label>
          <label class="admin-equip-field">
            <span class="stat-tile-label">Level (if "unlock at level")</span>
            <input type="number" id="new-cosmetic-level" min="1" value="1" />
          </label>
          <label class="admin-equip-field">
            <span class="stat-tile-label">Colour (paint)</span>
            <input type="color" id="new-cosmetic-color" value="#c0392b" />
          </label>
          <label class="admin-equip-field">
            <span class="stat-tile-label">Emoji (badge)</span>
            <input type="text" id="new-cosmetic-emoji" placeholder="🏅" autocomplete="off" />
          </label>
        </div>
        <button type="button" class="admin-action-btn" id="admin-add-cosmetic">Add Cosmetic</button>
        <p class="admin-hint">
          Custom paints are a solid colour only — gradients and animation need real
          CSS, which cannot be authored safely at runtime, so those stay code-only.
          A custom badge has no achievement behind it, so hand it out with a grant
          in the player panel below.
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
                    <span class="admin-result-name">${nameplateHtml(p, { custom: gameConfig?.customCosmetics ?? null })}</span>
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
    const custom = gameConfig?.customCosmetics ?? null;
    const equipped = resolveEquipped(profile, custom);
    const granted = new Set(profile.admin_unlocks ?? []);
    const cosmetics = resolveCosmetics({
      level: stats.level,
      achievementsUnlocked: stats.achievementsUnlocked,
      adminUnlocks: profile.admin_unlocks ?? [],
      custom,
    });

    return `
      <section class="profile-section admin-player">
        <h3 class="profile-section-title">Managing ${escapeHtml(profile.username ?? profile.id)}</h3>
        <div class="customize-preview">${nameplateHtml(profile, { custom })}</div>

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
          ${equipSelect('Badge', 'badge', cosmetics.badges, equipped.badge?.id ?? '')}
          ${equipSelect('Title', 'title', cosmetics.titles, equipped.title?.id ?? '')}
          ${equipSelect('Paint', 'paint', cosmetics.paints, equipped.paint?.id ?? DEFAULT_PAINT_ID)}
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

    root.querySelector('#admin-save-modifiers')?.addEventListener('click', () => {
      const overrides = {};
      root.querySelectorAll('[data-modifier-day]').forEach((select) => {
        if (select.value) overrides[select.dataset.modifierDay] = select.value;
      });
      saveConfig(CONFIG_KEYS.MODIFIER_OVERRIDES, overrides, validateModifierOverrides, 'Modifier schedule saved.');
    });

    root.querySelector('#admin-clear-modifiers')?.addEventListener('click', () => {
      clearConfig(CONFIG_KEYS.MODIFIER_OVERRIDES, 'All modifier overrides cleared.');
    });

    root.querySelector('#admin-save-wordbank')?.addEventListener('click', () => {
      const bank = {};
      root.querySelectorAll('[data-wordbank]').forEach((area) => {
        const slot = area.dataset.wordbank;
        const lines = area.value.split('\n').map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) return;
        // Only store a slot that actually differs from its built-in default, so
        // untouched slots keep receiving future built-in additions.
        const builtIn = wordBankSlots().find((s) => s.slot === slot)?.defaults ?? [];
        if (lines.length === builtIn.length && lines.every((l, i) => l === builtIn[i])) return;
        if (slot === 'ending.good' || slot === 'ending.bad') {
          bank.ending = bank.ending ?? {};
          bank.ending[slot === 'ending.good' ? 'good' : 'bad'] = lines;
        } else {
          bank[slot] = lines;
        }
      });
      saveConfig(CONFIG_KEYS.WORD_BANK, bank, validateWordBank, 'Word bank saved.');
    });

    root.querySelector('#admin-reset-wordbank')?.addEventListener('click', () => {
      clearConfig(CONFIG_KEYS.WORD_BANK, 'Word bank reset to built-ins.');
    });

    root.querySelector('#admin-add-cosmetic')?.addEventListener('click', () => {
      const kind = root.querySelector('#new-cosmetic-kind').value;
      const id = root.querySelector('#new-cosmetic-id').value.trim();
      const label = root.querySelector('#new-cosmetic-label').value.trim();
      const level = Number(root.querySelector('#new-cosmetic-level').value);
      const availability = root.querySelector('#new-cosmetic-availability').value;
      const color = root.querySelector('#new-cosmetic-color').value;
      const emoji = root.querySelector('#new-cosmetic-emoji').value.trim();

      const current = gameConfig?.customCosmetics ?? { badges: [], titles: [], paints: [] };
      const next = {
        badges: [...current.badges],
        titles: [...current.titles],
        paints: [...current.paints],
      };
      if (kind === 'badge') next.badges.push({ id, label, emoji, availability });
      else if (kind === 'title') next.titles.push({ id, label, level, availability });
      else next.paints.push({ id, label, level, color, availability });

      saveConfig(CONFIG_KEYS.CUSTOM_COSMETICS, next, validateCustomCosmetics, `Added ${kind} "${label}".`);
    });

    root.querySelectorAll('[data-remove-cosmetic]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.removeCosmetic;
        const current = gameConfig?.customCosmetics ?? { badges: [], titles: [], paints: [] };
        const next = {
          badges: current.badges.filter((c) => c.id !== id),
          titles: current.titles.filter((c) => c.id !== id),
          paints: current.paints.filter((c) => c.id !== id),
        };
        saveConfig(CONFIG_KEYS.CUSTOM_COSMETICS, next, validateCustomCosmetics, `Removed "${id}".`);
      });
    });
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
