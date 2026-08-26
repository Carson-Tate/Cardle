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
  adminResetTodayForEveryone,
  adminDeletePlayer,
  adminRenamePlayer,
  adminListBlockedWords,
  adminAddBlockedWords,
  adminRemoveBlockedWord,
  adminQueueStackedDeal,
  adminClearStackedDeal,
  fetchStackedDeals,
} from '../state/admin.js';
import {
  RANKS,
  SUITS,
  rankLabel,
  suitGlyph,
  normalizeStackedDeal,
  STACK_HAND_SIZE,
  STACK_MAX_DRAWS,
} from '../core/deck.js';
import { RARITIES } from '../core/rarity.js';
import { fetchSubmitRunFeatures } from '../state/daily-play.js';
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
import { gameDayFor, addGameDays, instantWithinGameDay, msUntilNextReset } from '../core/game-day.js';

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

// Opening values for the Stack the Deck slots (§11al) — a recognisable
// A-K-Q-J-10 spread, purely so the panel doesn't open on five identical 2♠'s.
// Same reasoning, and the same numbers, as the test-mode builder's defaults.
const STACK_DEFAULT_RANKS = [14, 13, 12, 11, 10];
const STACK_DEFAULT_SUITS = ['S', 'H', 'D', 'C', 'S'];

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
  // The selected player's stacked deals (§11al) — the queued one plus every day
  // already dealt from one. Kept beside `selected` rather than inside it
  // because it comes from a different table and reloads on its own schedule.
  let stackedDeals = [];
  // Whether the DEPLOYED submit-run understands stacked deals: 'ready',
  // 'stale' or 'unknown' (§11al). Probed once per page load rather than per
  // player — it is a property of the deployment, not of who is selected.
  let submitRunStatus = 'unknown';
  let searchTerm = '';
  let notice = null;
  let gameConfig = null;

  // UNSAVED modifier picks, keyed by game day; '' means "back to rotation".
  //
  // This exists because render() rebuilds `root.innerHTML` wholesale, and it is
  // called by things that have nothing to do with the schedule — searching for a
  // username, clicking a player, any player action. Every one of those silently
  // reverted a modifier the owner had just picked, with no warning, and the next
  // Save then wrote the OLD value back and reported "Modifier schedule saved."
  // That is the likeliest shape of the reported bug: the save genuinely
  // succeeded, it just saved something the owner had never chosen.
  let pendingModifierEdits = new Map();

  // Loaded on demand rather than at init: the blocklist is the one panel that is
  // usually irrelevant, and reading it costs a privileged round trip the other
  // sections don't need. `blockedWords` stays null until it has actually arrived,
  // so "not loaded" and "loaded and empty" are distinguishable.
  let blocklistOpen = false;
  let blockedWords = null;

  await Promise.all([
    loadOverview(),
    runSearch(''),
    loadConfig(),
    // Never rejects — it resolves to 'unknown' on any failure — so it cannot
    // be the reason the admin page fails to open.
    fetchSubmitRunFeatures()
      .then(({ status }) => {
        submitRunStatus = status;
      })
      .catch(() => {}),
  ]);
  render();
  scheduleGameDayRefresh();

  // The schedule's labels ("Today", "Tomorrow", "+2d") and the ISO days they map
  // to are computed once per render, from the game day at that moment. A tab
  // left open across the 19:00 America/New_York rollover therefore keeps calling
  // an ENDED day "Today" — and a pin saved then is filed under a dead date and
  // silently never applies. Not hypothetical: the stored config's own
  // `updated_at` shows the owner editing fourteen seconds after a rollover.
  //
  // Re-renders rather than reloading, so any unsaved picks survive; they are
  // keyed by absolute ISO day, so they stay attached to the day they were
  // chosen for even as the labels shift under them.
  function scheduleGameDayRefresh() {
    setTimeout(
      async () => {
        await loadConfig();
        notice = { kind: 'ok', text: 'A new game day just started — the schedule below has been relabelled.' };
        render();
        scheduleGameDayRefresh();
      },
      // A second past the boundary, so gameDayFor() is unambiguously into the
      // new day rather than racing it.
      msUntilNextReset() + 1000,
    );
  }

  async function loadConfig() {
    try {
      // The VALIDATED config, deliberately -- not the raw stored rows. The
      // editors must show what the game is actually honouring, so a stored value
      // that failed validation appears as the default it fell back to rather
      // than as text the game is silently ignoring.
      const next = await loadGameConfig({ force: true });
      // loadGameConfig NEVER REJECTS — by design, so one failed read can't take
      // the game down (state/game-config.js). For the game that is right; for
      // this page it is dangerous, because a failed read arrives as a perfectly
      // valid-looking EMPTY config. Left unchecked it repainted all fourteen
      // rows as "— rotation —", which looks exactly like a save that didn't
      // take, and armed the next Save to write that emptiness back and delete
      // every real pin. `loaded` is the flag that tells the two apart.
      if (!next.loaded) throw new Error('the config read came back empty');
      gameConfig = next;
      return true;
    } catch (error) {
      notice = { kind: 'error', text: `Couldn't load game config: ${error.message ?? error}. Nothing was changed — reload before editing.` };
      return false;
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
      // The write is already committed at this point, so a failed read-back must
      // not be reported as a failed save — but it must not be reported as a
      // clean success either, because the rows below are now showing defaults
      // rather than what is stored.
      notice = (await loadConfig())
        ? { kind: 'ok', text: successMessage }
        : { kind: 'error', text: `Saved — but couldn't read it back to confirm. Reload the page before editing again.` };
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
      // Fetched together: the stacked-deal read resolves to [] on any failure
      // (including the table not existing yet), so it can never be the reason a
      // player fails to open.
      const [detail, stacks] = await Promise.all([fetchPlayerDetail(userId), fetchStackedDeals(userId)]);
      selected = { ...detail, stats: derivePlayerStats(detail.history) };
      stackedDeals = stacks;
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
        ${blocklistHtml()}
        ${wordBankHtml()}
        ${customCosmeticsHtml()}
        ${searchHtml()}
        ${selected ? playerHtml() : ''}
        ${dayResetHtml()}
      </div>
    `;
    wire();
  }

  // The full day reset (§11aj). Site-wide and destructive, so it is rendered
  // LAST — below even the per-player panel. Everything above it acts on one
  // account you had to go looking for; this one acts on everybody at once, and
  // it should never be something a click lands on while heading somewhere else.
  function dayResetHtml() {
    const today = todayIso();
    const claimed = overview?.claimed_today;
    return `
      <section class="profile-section admin-danger">
        <h3 class="profile-section-title">Danger — Full Day Reset</h3>
        <p class="admin-hint">
          Clears <strong>every player's</strong> claimed hand for today
          (${escapeHtml(formatDate(today))} · Cardle #${dayNumber()}) so the whole
          site plays the day again from a brand-new deal. Deleting the claim is
          what releases the seed — blanking the score would leave everyone stuck
          on the same hand.
          ${
            // Omitted rather than guessed when the server predates migration 020,
            // because a wrong number here is worse than no number.
            typeof claimed === 'number'
              ? `<strong>${claimed.toLocaleString()}</strong> ${claimed === 1 ? 'hand is' : 'hands are'} claimed right now, finished and in-progress together.`
              : ''
          }
        </p>
        <p class="admin-hint">
          Today's leaderboard empties with them, and so do the XP, levels and
          streaks earned today — all of that is derived from these rows, so it
          moves the moment they do. Only today can be reset from here; a single
          older day is a per-player reset, in the panel above.
        </p>
        <p class="admin-hint">
          Two things it can't reach: a signed-out player's result lives in their
          own browser's storage, so they will still be told they've played today;
          and anyone with the game already open keeps their finished board until
          they reload.
        </p>
        <button type="button" class="profile-delete-btn" id="admin-reset-everyone">
          Reset Today For Everyone
        </button>
      </section>
    `;
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
    // Stepped as GAME days (§11l), which is what a pin is keyed on. Two bugs
    // lived in the previous `new Date(Date.now() + offset * 86_400_000)` plus
    // `toISOString()`: the row labelled "Today" was keyed to the UTC date, which
    // disagrees with the live game day for an hour each evening during EDT — so
    // a pin saved in that window was filed under the wrong day and never applied
    // (the owner's "it resets"). And adding fixed 24h blocks drifts across a DST
    // change, which could list a day twice or skip one entirely.
    const todayGameDay = gameDayFor(new Date());
    for (let offset = 0; offset < 14; offset++) {
      const iso = addGameDays(todayGameDay, offset);
      // getDailyModifier and dayNumber take an instant, not a label.
      const date = instantWithinGameDay(iso);
      // An unsaved pick outranks what's stored, so a re-render triggered by an
      // unrelated action can't quietly undo it.
      const dirty = pendingModifierEdits.has(iso);
      const overrideId = dirty ? pendingModifierEdits.get(iso) || null : modifierOverrideFor(overrides, iso);
      days.push({ date, iso, offset, overrideId, dirty, effective: getDailyModifier(date, overrideId) });
    }
    const overrideCount = Object.keys(overrides).length;
    const unsavedCount = pendingModifierEdits.size;

    return `
      <section class="profile-section">
        <h3 class="profile-section-title">
          Daily Modifier Schedule ${overrideCount > 0 ? `<span class="profile-count">${overrideCount} overridden</span>` : ''}
          ${unsavedCount > 0 ? `<span class="profile-count admin-unsaved-count">${unsavedCount} unsaved</span>` : ''}
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
                <small>${escapeHtml(`${d.effective.emoji} ${d.effective.label}`)}${d.overrideId ? ' (pinned)' : ''}${
                  d.dirty ? ' · unsaved' : ''
                }</small>
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

  // The username blocklist (§11x).
  //
  // Its whole reason for being an EDITOR rather than a migration: the useful
  // list is the one that grows in response to what people actually try, and
  // words added here never enter the public repository. Loaded on demand — it is
  // the only admin panel that is usually irrelevant, and it needs its own
  // privileged round trip (the table has no read policy).
  function blocklistHtml() {
    if (!blocklistOpen) {
      return `
        <section class="profile-section">
          <h3 class="profile-section-title">Username Blocklist</h3>
          <p class="admin-hint">
            Words refused as usernames. Enforced by a database trigger, not by
            this page — the client check is only there to warn while typing.
          </p>
          <button type="button" class="admin-action-btn" id="admin-blocklist-open">Show the list</button>
        </section>
      `;
    }
    const rows = blockedWords ?? [];
    const byType = (type) => rows.filter((w) => w.match_type === type);
    const group = (type, heading, hint) => `
      <h4 class="profile-subheading">${heading} <span class="profile-count">${byType(type).length}</span></h4>
      <p class="admin-hint">${hint}</p>
      <div class="admin-blocklist-words">
        ${
          byType(type).length === 0
            ? '<p class="friends-empty">None.</p>'
            : byType(type)
                .map(
                  (w) => `<span class="admin-blocklist-word">${escapeHtml(w.pattern)}
                    <button type="button" class="admin-blocklist-remove" data-remove-word="${escapeHtml(w.id)}"
                            aria-label="Remove ${escapeHtml(w.pattern)}">×</button></span>`,
                )
                .join('')
        }
      </div>
    `;
    return `
      <section class="profile-section">
        <h3 class="profile-section-title">Username Blocklist <span class="profile-count">${rows.length}</span></h3>
        <p class="admin-hint">
          Matching folds case, leetspeak and padding before comparing, so
          <code>5L_UR</code> and <code>slur</code> are the same word to it.
          Entries are stored normalized — letters only.
        </p>
        ${group('substring', 'Blocked anywhere', 'For terms no innocent word contains. Catches padding and embedding.')}
        ${group('exact', 'Blocked as the whole name only', 'For words that appear inside legitimate ones — substring matching here would block CLASSIC for ASS.')}
        ${group('allow', 'Always allowed', 'Explicit exemptions, checked first and winning outright. The fix for a real false positive.')}
        <h4 class="profile-subheading">Add words</h4>
        <p class="admin-hint">One per line, or separated by commas.</p>
        <textarea id="admin-blocklist-input" rows="3" class="admin-wordbank-input"
                  placeholder="one word per line"></textarea>
        <div class="admin-search">
          <select id="admin-blocklist-type">
            <option value="substring">Block anywhere</option>
            <option value="exact">Block as whole name only</option>
            <option value="allow">Always allow</option>
          </select>
          <button type="button" class="admin-action-btn" id="admin-blocklist-add">Add</button>
        </div>
      </section>
    `;
  }

  // The fortune word bank (§6c). Edited as one phrase per line, which matches how
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
          Fortune Word Bank ${overriddenCount > 0 ? `<span class="profile-count">${overriddenCount} customised</span>` : ''}
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

        <h4 class="profile-subheading">Rename</h4>
        <p class="admin-hint">
          The proportionate response to an offensive name. Before this existed
          the only option was deleting the account, which also destroyed the
          player's whole history. The blocklist applies here too, so a rename
          cannot land on a blocked name either.
        </p>
        <form class="admin-search" id="admin-rename-form">
          <input type="text" id="admin-rename-input" value="${escapeHtml(profile.username)}"
                 autocomplete="off" autocapitalize="characters" spellcheck="false"
                 aria-label="New username" />
          <button type="submit" class="admin-action-btn">Rename</button>
        </form>

        ${stackedDealHtml()}

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

  // Stack the Deck (§11al) — choose the exact cards this player is dealt on
  // their next hand, and the first few they draw if they discard.
  //
  // Placed above Danger and below every other per-player action, because it is
  // the only one here that changes what someone EXPERIENCES rather than what
  // their profile says — but it is fully reversible while queued, so it does
  // not belong in Danger itself.
  function stackedDealHtml() {
    const queued = stackedDeals.find((d) => d.play_date === null) ?? null;
    const attached = stackedDeals.filter((d) => d.play_date !== null);

    return `
      <h4 class="profile-subheading">Stack the Deck</h4>
      <p class="admin-hint">
        Sets the exact hand this player opens with on their <strong>next</strong> hand — whenever that is.
        Each row is one slot: the card they're dealt, and the card they draw <strong>if they throw that
        slot away</strong>. So to hand someone a straight from 2 3 Q 5 6, put the 4 opposite the Q — it
        arrives only if the Q is the card they drop. Leave a replacement on <em>— random —</em> to let it
        roll normally. The run scores and appears on the leaderboards like any other; only this panel
        records that it was stacked. Their board and the server both build the deal from these cards, so
        the score is real either way.
      </p>
      ${
        queued
          ? `<p class="admin-notice admin-notice--ok">⚑ A deal is queued for their next hand: ${escapeHtml(
              describeStack(queued.cards),
            )}</p>`
          : ''
      }
      <div class="admin-slots" id="admin-stack-hand">
        ${stackSlotRows(queued?.cards?.hand ?? null, queued?.cards?.slotDraws ?? null)}
      </div>
      ${
        // The deploy-order guard (§11al). A stacked deal queued while an OLD
        // submit-run is live is scored from the ORDINARY deal — the player sees
        // cards nobody chose, and every screen here says it worked. Blocked
        // rather than warned, because there is no version of that outcome worth
        // having. 'unknown' does NOT block: we could not ask, and refusing on a
        // failed probe would make the panel unusable on a flaky connection
        // without preventing anything.
        submitRunStatus === 'stale'
          ? `<p class="admin-notice admin-notice--error">The deployed <code>submit-run</code> doesn't know about stacked deals yet, so a queued hand would be scored from the ordinary deal. Run <code>supabase functions deploy submit-run</code>, then reload this page.</p>`
          : submitRunStatus === 'unknown'
            ? `<p class="admin-hint">⚠ Couldn't check whether <code>submit-run</code> is up to date. If you haven't run <code>supabase functions deploy submit-run</code> since adding this feature, do that first — otherwise the hand is dealt but scored from the ordinary deal.</p>`
            : ''
      }
      <div class="admin-search">
        <button type="button" class="admin-action-btn" id="admin-stack-save"${submitRunStatus === 'stale' ? ' disabled' : ''}>Queue This Deal</button>
        ${queued ? `<button type="button" class="admin-remove-btn" id="admin-stack-clear">Cancel Queued Deal</button>` : ''}
      </div>
      ${
        attached.length > 0
          ? `<p class="admin-hint">⚑ Already dealt from a stack: ${attached
              .map((d) => escapeHtml(formatDate(d.play_date)))
              .join(', ')}. Those days can't be changed — the cards are already scored.</p>`
          : ''
      }
    `;
  }

  // ONE ROW PER SLOT, carrying both cards — the dealt card and the card that
  // replaces it. Putting them on the same line is the whole point of the
  // rework: the question being answered is "what do they get if they throw
  // THIS away", and a separate draw-pile list made that a matter of predicting
  // how many cards they discard and in what order.
  function stackSlotRows(existingHand, existingDraws) {
    return Array.from({ length: STACK_HAND_SIZE }, (_, i) => {
      const card = existingHand?.[i] ?? null;
      const rank = card ? Number(card.rank) : STACK_DEFAULT_RANKS[i % STACK_DEFAULT_RANKS.length];
      const suit = card ? card.suit : STACK_DEFAULT_SUITS[i % STACK_DEFAULT_SUITS.length];
      return `
        <div class="admin-slot admin-stack-row">
          <span class="admin-slot-label">${i + 1}</span>
          <span class="admin-stack-card">
            ${cardPickerHtml('deal', i, { rank, suit, rarity: card?.rarity ?? null, wild: card?.wild === true }, false)}
          </span>
          <span class="admin-stack-card admin-stack-card--draw">
            <!-- The arrow LEADS the replacement group rather than sitting
                 between the two, so when the row wraps — which it does at any
                 realistic admin width, eight controls being too many for one
                 line — it starts the second line instead of being stranded at
                 the end of the first, where it read as pointing at nothing. -->
            <span class="admin-stack-arrow" aria-hidden="true">→</span>
            <span class="admin-stack-draw-label">if discarded</span>
            ${cardPickerHtml('draw', i, existingDraws?.[i] ?? null, true)}
          </span>
        </div>
      `;
    }).join('');
  }

  // A rank/suit/rarity/wild picker. `allowRandom` adds the empty rank option,
  // which is how a replacement slot says "don't pin this one" — clearer than a
  // separate checkbox beside a control that is already a dropdown.
  function cardPickerHtml(kind, index, card, allowRandom) {
    const rank = card ? Number(card.rank) : STACK_DEFAULT_RANKS[index % STACK_DEFAULT_RANKS.length];
    const suit = card ? card.suit : STACK_DEFAULT_SUITS[index % STACK_DEFAULT_SUITS.length];
    const pinned = Boolean(card);
    return `
      <select class="admin-slot-rank" data-stack="${kind}" data-slot="${index}">
        ${allowRandom ? `<option value=""${pinned ? '' : ' selected'}>— random —</option>` : ''}
        ${RANKS.map(
          (r) => `<option value="${r}"${(pinned || !allowRandom) && r === rank ? ' selected' : ''}>${rankLabel(r)}</option>`,
        ).join('')}
      </select>
      <select class="admin-slot-suit">
        ${SUITS.map((s) => `<option value="${s}"${s === suit ? ' selected' : ''}>${suitGlyph(s)}</option>`).join('')}
      </select>
      <select class="admin-slot-rarity">
        <option value=""${card?.rarity ? '' : ' selected'}>— none —</option>
        ${RARITIES.map(
          (t) => `<option value="${t.id}"${card?.rarity === t.id ? ' selected' : ''}>${t.emoji} ${t.label}</option>`,
        ).join('')}
      </select>
      <label class="admin-slot-wild">
        <input type="checkbox" class="admin-slot-wild-input"${card?.wild ? ' checked' : ''} /> 🃏
      </label>
    `;
  }

  // Scraped from the DOM at click time, the same way the test-mode builder
  // reads its slots. `slotDraws` is a LENGTH-5 SPARSE array — index is the hand
  // slot — so a blank leaves a hole rather than shifting the ones after it,
  // which is exactly the difference between this and the ordered pile it
  // replaces.
  function readStackFromDom() {
    const readPicker = (rankEl) => {
      if (rankEl.value === '') return null;
      const row = rankEl.closest('.admin-stack-card');
      return {
        rank: Number(rankEl.value),
        suit: row.querySelector('.admin-slot-suit').value,
        rarity: row.querySelector('.admin-slot-rarity').value || null,
        wild: row.querySelector('.admin-slot-wild-input').checked,
      };
    };
    const pick = (kind) =>
      [...root.querySelectorAll(`#admin-stack-hand .admin-slot-rank[data-stack="${kind}"]`)]
        .sort((a, b) => Number(a.dataset.slot) - Number(b.dataset.slot))
        .map(readPicker);
    return { hand: pick('deal'), slotDraws: pick('draw') };
  }

  // Reads back as slot pairs, not as a hand plus a pile, so a glance confirms
  // the thing that actually matters: which replacement is opposite which card.
  function describeStack(cards) {
    const check = normalizeStackedDeal(cards);
    if (!check.ok) return 'malformed — re-save it';
    const label = (c) => `${rankLabel(c.rank)}${suitGlyph(c.suit)}`;
    return check.deal.hand
      .map((card, i) => {
        const draw = check.deal.slotDraws[i];
        return draw ? `${label(card)}→${label(draw)}` : label(card);
      })
      .join(' ');
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

    root.querySelector('#admin-stack-save')?.addEventListener('click', () => {
      const deal = readStackFromDom();
      // VALIDATED HERE FIRST, with the same function the board and the Edge
      // Function run, so a duplicate card is refused with a sentence naming the
      // slot instead of a Postgres error naming a constraint.
      const check = normalizeStackedDeal(deal);
      if (!check.ok) {
        notice = { kind: 'error', text: check.errors.join(' · ') };
        render();
        return;
      }
      withNotice(
        () => adminQueueStackedDeal(selected.profile.id, check.deal),
        `Queued for ${selected.profile.username}'s next hand: ${describeStack(check.deal)}`,
      );
    });

    root.querySelector('#admin-stack-clear')?.addEventListener('click', () => {
      withNotice(() => adminClearStackedDeal(selected.profile.id), 'Queued deal cancelled.');
    });

    root.querySelector('#admin-reset-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const date = root.querySelector('#admin-reset-date').value || null;
      withNotice(() => adminResetDay(selected.profile.id, date), `Reset ${date ?? 'today'}.`);
    });

    root.querySelector('#admin-rename-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = root.querySelector('#admin-rename-input').value.trim();
      if (!name || name.toUpperCase() === selected.profile.username) return;
      withNotice(() => adminRenamePlayer(selected.profile.id, name), `Renamed to ${name.toUpperCase()}.`);
    });

    root.querySelector('#admin-delete-player')?.addEventListener('click', () => confirmDeletePlayer());

    root.querySelector('#admin-reset-everyone')?.addEventListener('click', () => confirmResetToday());

    // Records a pick the moment it is made, so it survives any re-render before
    // Save is clicked. Re-rendering here instead would be simpler but would take
    // focus off the select mid-interaction, so the row's own preview text is
    // patched in place.
    root.querySelectorAll('[data-modifier-day]').forEach((select) => {
      select.addEventListener('change', () => {
        const iso = select.dataset.modifierDay;
        pendingModifierEdits.set(iso, select.value);
        const preview = select.parentElement?.querySelector('small');
        if (preview) {
          const effective = getDailyModifier(instantWithinGameDay(iso), select.value || null);
          preview.textContent = `${effective.emoji} ${effective.label}${select.value ? ' (pinned)' : ''} · unsaved`;
        }
      });
    });

    root.querySelector('#admin-save-modifiers')?.addEventListener('click', () => {
      // MERGED onto what is already stored, not rebuilt from the visible rows.
      // Rebuilding meant the payload only ever described the 14 days on screen,
      // so saving any change silently DELETED every pin outside that window —
      // including yesterday's, and anything scheduled more than two weeks out.
      // A row explicitly set back to "— rotation —" still deletes that one day,
      // because that is a choice the admin actually made.
      const overrides = { ...(gameConfig?.modifierOverrides ?? {}) };
      root.querySelectorAll('[data-modifier-day]').forEach((select) => {
        const day = select.dataset.modifierDay;
        if (select.value) overrides[day] = select.value;
        else delete overrides[day];
      });
      pendingModifierEdits = new Map();
      saveConfig(CONFIG_KEYS.MODIFIER_OVERRIDES, overrides, validateModifierOverrides, 'Modifier schedule saved.');
    });

    root.querySelector('#admin-clear-modifiers')?.addEventListener('click', () => {
      clearConfig(CONFIG_KEYS.MODIFIER_OVERRIDES, 'All modifier overrides cleared.');
    });

    // Deliberately NOT routed through withNotice: that helper re-fetches the
    // selected player and the overview, which a blocklist edit has no bearing
    // on, and it overwrites `notice` with a fixed string — losing the "added 2
    // of 5" count that is the whole point of reporting the result.
    async function withBlocklist(action, successText) {
      try {
        await action();
        blockedWords = await adminListBlockedWords();
        notice = { kind: 'ok', text: typeof successText === 'function' ? successText() : successText };
      } catch (error) {
        notice = { kind: 'error', text: `${error.message ?? error}` };
      }
      render();
    }

    root.querySelector('#admin-blocklist-open')?.addEventListener('click', () => {
      blocklistOpen = true;
      withBlocklist(() => {}, 'Blocklist loaded.');
    });

    root.querySelector('#admin-blocklist-add')?.addEventListener('click', () => {
      const raw = root.querySelector('#admin-blocklist-input').value;
      const matchType = root.querySelector('#admin-blocklist-type').value;
      // Split on newlines OR commas, so a pasted list works whichever shape it
      // arrives in.
      const words = raw
        .split(/[\n,]/)
        .map((w) => w.trim())
        .filter(Boolean);
      if (words.length === 0) {
        notice = { kind: 'error', text: 'Nothing to add.' };
        render();
        return;
      }
      let added = 0;
      // Reported honestly: the server normalizes and de-duplicates, so
      // "added 2 of 5" is a real outcome worth seeing rather than an error.
      withBlocklist(
        async () => {
          added = await adminAddBlockedWords(words, matchType);
        },
        () => `Added ${added} of ${words.length}.`,
      );
    });

    root.querySelectorAll('[data-remove-word]').forEach((btn) => {
      btn.addEventListener('click', () => {
        withBlocklist(() => adminRemoveBlockedWord(btn.dataset.removeWord), 'Removed.');
      });
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

  // Type-to-confirm, matching confirmDeletePlayer below — the established shape
  // for anything unrecoverable here, and this is the only other button on the
  // page that qualifies.
  //
  // The phrase to type is the DATE rather than a fixed word like RESET. A fixed
  // word is muscle memory after the second use; the date forces the one fact
  // worth re-reading before committing, and it is the fact that goes wrong when
  // an admin leaves this tab open across the 19:00 rollover.
  function confirmResetToday() {
    const today = todayIso();
    openModal({
      title: 'Reset Today For Everyone',
      render: (body, close) => {
        const claimed = overview?.claimed_today;
        body.innerHTML = `
          <p>This deletes <strong>every player's</strong> hand for
          <strong>${escapeHtml(formatDate(today))}</strong> (Cardle #${dayNumber()})${
            typeof claimed === 'number'
              ? ` — <strong>${claimed.toLocaleString()}</strong> ${claimed === 1 ? 'hand' : 'hands'}`
              : ''
          }. Everyone plays the day again from a new deal, today's leaderboard
          empties, and the XP and streaks earned today go with it.
          <strong>It cannot be undone.</strong></p>
          <p>Type <strong>${escapeHtml(today)}</strong> to confirm.</p>
          <form class="login-form" id="admin-reset-all-form">
            <!-- Deliberately no inputmode="numeric": the phrase contains hyphens,
                 and iOS's numeric keypad has no hyphen key — it would make the
                 confirmation untypeable on a phone. -->
            <input type="text" id="admin-reset-all-input" autocomplete="off" required />
            <button type="submit" class="profile-delete-btn" id="admin-reset-all-btn" disabled>Reset The Day</button>
          </form>
          <p class="login-status" id="admin-reset-all-status" hidden></p>
        `;
        const input = body.querySelector('#admin-reset-all-input');
        const btn = body.querySelector('#admin-reset-all-btn');
        input.addEventListener('input', () => {
          btn.disabled = input.value.trim() !== today;
        });
        body.querySelector('#admin-reset-all-form').addEventListener('submit', async (event) => {
          event.preventDefault();
          if (input.value.trim() !== today) return;
          btn.disabled = true;
          try {
            // The day that was CONFIRMED, not the day at submit time — that's
            // the whole point of the guard. If the rollover happened while this
            // modal was open, the server refuses and says so, rather than
            // clearing a day nobody agreed to.
            const removed = await adminResetTodayForEveryone(today);
            close();
            // Not routed through withNotice: that re-reads the SELECTED player,
            // whose panel is now showing a day that no longer exists. Reloading
            // the overview and dropping the selection is what's actually true
            // afterwards.
            selected = null;
            await loadOverview();
            notice = {
              kind: 'ok',
              text: `Reset ${today} for everyone — ${removed.toLocaleString()} ${removed === 1 ? 'hand' : 'hands'} cleared.`,
            };
            render();
          } catch (error) {
            btn.disabled = false;
            const status = body.querySelector('#admin-reset-all-status');
            status.hidden = false;
            status.textContent = `${error.message ?? error}`;
          }
        });
      },
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
