// Site header (owner request: logo + help on the left, login/username +
// friends on the right) — DESIGN.md §11. Independent of board.js's own
// per-run header (day label, modifier banner): this one is site-wide chrome
// that doesn't change between runs, so it's its own module with its own
// init call, wired up alongside initBoard() in main.js rather than folded
// into it.

import { openModal } from './modal.js';
import { nameplateHtml, PROFILE_UPDATED_EVENT } from './nameplate.js';
import {
  getSession,
  onAuthStateChange,
  signInWithMagicLink,
  getProfile,
  createProfile,
  isValidUsername,
  isUsernameAvailable,
} from '../state/auth.js';
import { sendFriendRequest, getPendingRequests, getSentRequests, getFriends, acceptFriendRequest, removeFriendship, searchProfiles } from '../state/friends.js';
import { isSupabaseConfigured, SupabaseUnavailableError } from '../state/supabase-client.js';
import { loadOwnHistory, invalidateOwnHistory, XP_UPDATED_EVENT } from '../state/profile.js';
import { derivePlayerStats } from '../core/player-stats.js';
import { delay } from './animations.js';

// Matches `.header-xp-fill`'s own `transition: width` so each stage of the
// fill is waited out rather than cut off mid-travel.
const XP_FILL_MS = 700;
// How long the level-up flash holds at a full bar before the next level
// starts — long enough to register as an event, short enough not to stall.
const XP_LEVEL_FLASH_MS = 900;
import { isCurrentUserAdmin } from '../state/admin.js';
import { loadGameConfig } from '../state/game-config.js';

// Escapes text destined for an innerHTML template. Every value interpolated
// below that did NOT originate in this file gets run through this — usernames
// (other people's, fetched from the database) and error messages (which embed
// user input, e.g. createProfile's `"<name>" is already taken`).
//
// This is the output half of a real stored-XSS fix: the database only checked
// username LENGTH, not characters, so a caller bypassing the UI could store
// `<svg onload=...>` — 14 characters — and the friends panel rendered other
// users' names straight into innerHTML, executing it in the viewer's browser.
// supabase/migrations/001-username-pattern-constraint.sql adds the matching
// input constraint. Both halves are kept deliberately: the DB constraint stops
// bad values being stored, and escaping means even a value that somehow gets
// in (an older row, a future code path, a hand-edited record) renders as inert
// text instead of markup.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {Document|HTMLElement} root
 * @param {{signInError?: Error|null}} [options] - the ERROR from a failed
 *   sign-in link, forwarded by main.js. Surfaced as a pre-opened login modal
 *   rather than swallowed: a dead link otherwise drops the player on an ordinary
 *   logged-out home page, where the only available reading is "it just didn't
 *   work". The error object itself is passed, not a pre-flattened string,
 *   because what to SAY depends on which failure it was — see signInHint.
 */
export function initHeader(root, { signInError = null } = {}) {
  const logoBtn = root.querySelector('#header-logo');
  const helpBtn = root.querySelector('#header-help');
  const authSlot = root.querySelector('#header-auth-slot');
  const friendsBtn = root.querySelector('#header-friends-btn');
  const adminBtn = root.querySelector('#header-admin-btn');
  const leaderboardBtn = root.querySelector('#header-leaderboard-btn');
  const menuBtn = root.querySelector('#header-menu-btn');
  const headerNav = root.querySelector('#header-nav');

  // Mirrors whatever onAuthStateChange last reported — read by the friends
  // button and the auth slot's own click handler, so they always act on the
  // current session without each needing their own subscription.
  let currentSession = null;
  let currentProfile = null;
  // Whether the initial session lookup has finished. Until it has, the auth slot
  // shows a neutral placeholder rather than the logged-OUT state — owner bug
  // report: "fix login flashing when reloading". renderAuthSlot() runs
  // synchronously at init so the header isn't blank, but at that moment
  // `currentSession` is still null, so a signed-in player briefly saw "Log In"
  // on every reload before getSession() resolved and swapped it for their name.
  // A placeholder of the same size also stops the header jumping when the real
  // nameplate lands.
  let sessionResolved = false;

  // Admin-authored cosmetics live in the server config, not in the built-in
  // registries, so a nameplate cannot resolve one without this. It is fetched
  // once (loadGameConfig caches per page load) and the header re-renders when it
  // arrives — the header must paint immediately, so it cannot await this first.
  // Owner bug report: a granted title "doesnt show on my name".
  let customCosmetics = null;

  // Lifetime XP for the bar beside the name. Null until the history it is
  // DERIVED from arrives (progression.js recomputes XP from every stored run
  // rather than keeping a running total), so the header paints immediately and
  // the bar appears when it can — a slow or failed read costs the bar, never
  // the name or the nav.
  let levelStats = null;

  async function refreshXp({ animate = false } = {}) {
    if (!currentSession) {
      levelStats = null;
      return;
    }
    let next = null;
    try {
      const history = await loadOwnHistory(currentSession.user.id);
      next = derivePlayerStats(history);
    } catch {
      levelStats = null; // accounts still work; the bar just stays hidden
      return;
    }
    if (animate && levelStats) {
      await animateXpTo(next);
      return;
    }
    levelStats = next;
    renderAuthSlot();
  }

  // Moves the EXISTING bar rather than re-rendering the slot.
  //
  // This is the whole reason the bar visibly fills. `renderAuthSlot()` replaces
  // the auth slot's innerHTML, which destroys the fill element and builds a new
  // one already at its final width — a CSS transition has nothing to animate
  // FROM, so the bar simply appeared at its new value. Mutating the element that
  // is already on screen lets `transition: width` do its job.
  async function animateXpTo(next) {
    const xpEl = authSlot.querySelector('#header-xp');
    const fill = xpEl?.querySelector('.header-xp-fill');
    const levelEl = xpEl?.querySelector('.header-xp-level');
    const track = xpEl?.querySelector('.header-xp-track');
    if (!xpEl || !fill) {
      // No bar on screen yet (it had not loaded when the run finished) — fall
      // back to a plain render so the value is at least correct.
      levelStats = next;
      renderAuthSlot();
      return;
    }

    const from = levelStats;
    levelStats = next;

    // Claim the slot for the duration. Everything below mutates the EXISTING
    // nodes, so any re-render arriving now is deferred rather than allowed to
    // swap the element out from under the transition.
    xpAnimating = true;
    try {
      // LEVELLED UP: run the bar to full, hold on a flash, then start the new
      // level from empty. Snapping straight to the new (lower) percentage would
      // read as the bar going BACKWARDS, which is the opposite of what happened.
      // Looped, because a big run can cross more than one level at once.
      for (let level = (from?.level ?? next.level) + 1; level <= next.level; level++) {
        fill.style.width = '100%';
        await delay(XP_FILL_MS);
        xpEl.classList.add('header-xp--levelup');
        if (levelEl) levelEl.textContent = `Lv ${level}`;
        await delay(XP_LEVEL_FLASH_MS);
        // Reset to empty WITHOUT animating, so the rewind is instant and only
        // the refill is seen. Forcing layout between the two is what stops the
        // browser coalescing them into a single no-op.
        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth;
        fill.style.transition = '';
        xpEl.classList.remove('header-xp--levelup');
      }

      const pct = Math.round((next.levelProgress ?? 0) * 100);
      fill.style.width = `${pct}%`;
      if (levelEl) levelEl.textContent = `Lv ${next.level}`;
      if (track) track.setAttribute('aria-valuenow', String(pct));
      xpEl.setAttribute('title', xpTitle(next));
      await delay(XP_FILL_MS);
    } finally {
      // `finally`, so a throw mid-animation can't leave the header permanently
      // unable to re-render.
      xpAnimating = false;
      if (renderDeferred) {
        renderDeferred = false;
        renderAuthSlot();
      }
    }
  }

  // Called by the board once a run has been scored and saved, so the bar catches
  // up without a reload. Exposed on `window` rather than imported because
  // board.js and header.js are siblings that deliberately know nothing about
  // each other — the same reasoning as nameplate.js's PROFILE_UPDATED_EVENT.
  window.addEventListener(XP_UPDATED_EVENT, () => {
    invalidateOwnHistory();
    refreshXp({ animate: true });
  });

  loadGameConfig()
    .then((config) => {
      customCosmetics = config?.customCosmetics ?? null;
      renderAuthSlot();
    })
    // loadGameConfig already resolves to defaults rather than rejecting, so this
    // only guards against an unexpected throw; built-in cosmetics still render.
    .catch(() => {});

  // Which user id (if any) currently has a username-prompt modal open —
  // owner bug report: "when someone successfully logs in for the first
  // time it prompts them to make a username, and when they chose a
  // username it prompts for it again, and it says it is taken." Root
  // cause: Supabase's onAuthStateChange fires more than once for a single
  // sign-in (e.g. once restoring INITIAL_SESSION, again for the actual
  // SIGNED_IN event) — refreshProfile() ran on every firing and, seeing no
  // profile yet either time, opened a SECOND prompt on top of the first
  // before the user had finished the one they were looking at. Submitting
  // through the stale second modal after the first had already created the
  // profile hit the username's unique constraint — "taken" by themselves.
  // This flag (set the instant a prompt opens, cleared via openModal's
  // onClose no matter how it's dismissed) makes a second firing a no-op
  // instead of a second modal.
  let usernamePromptOpenForUserId = null;

  logoBtn.addEventListener('click', () => {
    window.location.href = '/';
  });

  helpBtn.addEventListener('click', openHelpModal);

  leaderboardBtn.addEventListener('click', () => {
    window.location.href = '/?leaderboard';
  });

  adminBtn.addEventListener('click', () => {
    window.location.href = '/?admin';
  });

  friendsBtn.addEventListener('click', () => {
    if (!currentSession) {
      openLoginModal({ hint: 'Log in to see your friends.' });
      return;
    }
    openFriendsPanel(currentSession.user.id);
  });

  // Whether to show the admin link. Deliberately asks the DATABASE (the same
  // is_admin() function that authorizes every admin action) rather than
  // comparing a username in public JavaScript — so the link and the actual
  // permission can never disagree, and no admin identity is baked into the
  // bundle. Hiding the link is presentation only; see admin.js.
  let isAdmin = false;

  async function refreshAdminLink() {
    isAdmin = currentSession ? await isCurrentUserAdmin() : false;
    adminBtn.hidden = !isAdmin;
  }

  // Whether an XP bar animation currently owns the auth slot's DOM.
  //
  // renderAuthSlot() replaces the slot's innerHTML, which DESTROYS the element
  // animateXpTo is mutating — the new one is a different node, already at its
  // final width, with nothing to transition from. Any late async callback that
  // re-renders (loadGameConfig resolving, a PROFILE_UPDATED_EVENT) could
  // therefore silently turn the fill into a teleport, which is precisely the
  // bug animateXpTo was written to fix. Deferring instead of dropping means the
  // re-render still happens, just after the animation has finished with the
  // node. Caught by levelup-run's "the bar element is never replaced
  // mid-animation" assertion.
  let xpAnimating = false;
  let renderDeferred = false;

  function renderAuthSlot() {
    if (xpAnimating) {
      renderDeferred = true;
      return;
    }
    if (!sessionResolved) {
      // Nothing is known yet — reserve the space, claim nothing.
      authSlot.innerHTML = '<span class="header-auth-pending" aria-hidden="true"></span>';
      friendsBtn.hidden = true;
      adminBtn.hidden = true;
      return;
    }
    friendsBtn.hidden = !currentSession;
    if (!currentSession) adminBtn.hidden = true;
    if (!currentSession) {
      authSlot.innerHTML = `<button type="button" class="header-login-btn">Log In</button>`;
      authSlot.querySelector('.header-login-btn').addEventListener('click', () => openLoginModal());
      return;
    }
    // Between sign-in and the profile finishing its fetch (or a brand new
    // user still being prompted for a username), there's a real gap where
    // we have a session but no username yet — an ellipsis instead of a
    // blank button avoids the header looking broken during that beat.
    // Compact variant: badge + painted name, no title. The header is a tight
    // top bar rather than a nameplate, and a full phrase like "Legend of the
    // Felt" would crowd it -- see ui/nameplate.js.
    const label = currentProfile?.username ?? '…';
    authSlot.innerHTML = `<button type="button" class="header-user-btn">
      <span class="header-user-name">${
        currentProfile
          ? nameplateHtml(currentProfile, { variant: 'compact', fallbackName: label, custom: customCosmetics })
          : `👤 ${escapeHtml(label)}`
      }</span>
      ${levelStats ? xpBarHtml(levelStats) : ''}
    </button>`;
    // Owner request: clicking your own username goes to the profile page,
    // which is now where signing out and deleting the account live — so this
    // replaces the small sign-out-only modal that used to open here.
    authSlot.querySelector('.header-user-btn').addEventListener('click', () => {
      window.location.href = '/?profile';
    });
  }

  // Runs on every auth state change (sign-in, sign-out, and once immediately
  // on page load with whatever session already existed). A signed-in user
  // with no `profiles` row yet is a brand-new sign-up — the username prompt
  // is how that row gets created; it isn't optional, since without a
  // username nothing else here (the header slot, friend requests naming
  // this user) has anything to display.
  async function refreshProfile() {
    if (!currentSession) {
      currentProfile = null;
      renderAuthSlot();
      return;
    }
    try {
      currentProfile = await getProfile(currentSession.user.id);
    } catch {
      currentProfile = null;
    }
    renderAuthSlot();
    refreshAdminLink();
    if (!currentProfile && usernamePromptOpenForUserId !== currentSession.user.id) {
      promptForUsername(currentSession.user.id);
    }
  }

  renderAuthSlot(); // paint the logged-out state immediately; getSession/onAuthStateChange correct it the moment the real session is known

  // A sign-in link that failed. Reopens the login form with the reason already
  // shown, so the next step is one tap away.
  //
  // WHICH reason matters. This used to assert a single hardcoded diagnosis —
  // "links expire, and each one can only be used once" — for every failure,
  // including the one where the Supabase SDK never downloaded at all. On mobile
  // that was not merely unhelpful but actively misleading: it told the player
  // (and the owner, for weeks) that sign-in links were expiring, when the link
  // was fine and the CDN was blocked. Telling someone to request a fresh link
  // when the network is the problem sends them round a loop that cannot
  // terminate — every new link fails identically.
  if (signInError) {
    openLoginModal({ hint: signInHint(signInError), retryable: signInError instanceof SupabaseUnavailableError });
  }

  function signInHint(error) {
    if (error instanceof SupabaseUnavailableError) {
      return `${error.message} Your link is still valid — pull down to refresh once you're back online.`;
    }
    // Expiry and an already-redeemed token are the likeliest remaining causes
    // and both are fixed the same way, so the wording covers them rather than
    // parroting Supabase's single "invalid or has expired" string.
    return `That sign-in link didn't work — links expire, and each one can only be used once. Enter your email for a fresh one.`;
  }

  // Seeds the header with whatever session Supabase already restored from
  // localStorage (a magic-link sign-in persists there by default, so this is
  // what makes a closed-and-reopened tab still show as logged in) — Supabase's
  // own recommended pattern is to read the current session explicitly on
  // startup rather than rely solely on onAuthStateChange's initial firing,
  // since exactly when/whether that first callback carries the restored
  // session isn't consistent across SDK versions.
  getSession().then((session) => {
    currentSession = session;
    sessionResolved = true;
    refreshProfile();
    refreshXp();
  });

  onAuthStateChange((session) => {
    currentSession = session;
    sessionResolved = true;
    refreshProfile();
    refreshXp();
  });

  // Keeps the header's nameplate in step when the profile page changes a
  // cosmetic — see nameplate.js's PROFILE_UPDATED_EVENT comment.
  window.addEventListener(PROFILE_UPDATED_EVENT, (event) => {
    if (!event.detail) return;
    // MERGED, not replaced. Callers announce a partial row — the cosmetics
    // preview sends just the nameplate fields — so assigning it wholesale would
    // drop everything else the header holds about the player.
    currentProfile = { ...currentProfile, ...event.detail };
    renderAuthSlot();
  });

  // The level bar under the name. Rendered only once lifetime XP is known, so
  // the header never shows a bar at 0% that is about to jump.
  function xpTitle(stats) {
    const into = Math.round(stats.xpIntoLevel ?? 0);
    const band = Math.round(stats.xpForNextLevel ?? 0);
    return `Level ${stats.level} — ${into.toLocaleString()} / ${band.toLocaleString()} XP to level ${stats.level + 1}`;
  }

  function xpBarHtml(stats) {
    const pct = Math.round((stats.levelProgress ?? 0) * 100);
    return `<span class="header-xp" id="header-xp" title="${escapeHtml(xpTitle(stats))}">
      <span class="header-xp-level">Lv ${stats.level}</span>
      <span class="header-xp-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"
            aria-label="Level ${stats.level}, ${pct}% to the next level">
        <span class="header-xp-fill" style="width: ${pct}%"></span>
      </span>
    </span>`;
  }

  // --- Mobile menu --------------------------------------------------------
  // The hamburger shows only under the CSS breakpoint; above it the nav is a
  // plain row and this state is inert. `hidden` is not used to collapse the nav
  // because it must reappear on resize without JS having to notice — the media
  // query owns visibility, and this class only opens the dropdown.
  let menuOpen = false;

  function setMenuOpen(open) {
    menuOpen = open;
    headerNav.classList.toggle('header-nav--open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  }

  menuBtn?.addEventListener('click', (event) => {
    event.stopPropagation(); // else the document handler below closes it immediately
    setMenuOpen(!menuOpen);
  });

  // Any tap outside closes it, which is what a dropdown is expected to do and
  // the only way out on a touch device with no Escape key.
  document.addEventListener('click', (event) => {
    if (!menuOpen) return;
    if (headerNav.contains(event.target) || menuBtn.contains(event.target)) return;
    setMenuOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuOpen) setMenuOpen(false);
  });

  // Navigating away from a menu item should not leave the menu open behind the
  // new page's paint.
  headerNav.addEventListener('click', (event) => {
    if (event.target.closest('button')) setMenuOpen(false);
  });

  function openHelpModal() {
    openModal({
      title: 'How to Play',
      render: (body) => {
        body.innerHTML = `
          <p class="help-goal">
            <!-- Carries the SAME false premise the meta description did (§11w's
                 fix): "the only thing that separates a good day from a bad one
                 is which cards you throw away" was written when every player was
                 dealt identical cards from a date-derived seed. Hands are random
                 per player now (state/persistence.js), so the deal separates
                 days too — and claiming otherwise tells a player who drew badly
                 that they simply played worse. -->
            <strong>The goal:</strong> build the strongest five-card poker hand you can, once a day,
            and score as many points as possible. Your five cards are dealt just for you — what you
            do with them is the part that's up to you.
          </p>
          <ol class="help-steps">
            <li>You get one hand of 5 cards, once per day.</li>
            <li>Every day has a <strong>Daily Modifier</strong> (shown above your hand) that changes the rules for the day — more or fewer discards, bonus multipliers, or a special twist on the usual flow.</li>
            <li>Click a card to mark it for discard — the <strong>Discard X/Y</strong> button shows how many you've marked.</li>
            <li>Click it to lock in. Marked cards get swapped for new ones, and your final 5-card poker hand is scored — stronger hands score more.</li>
            <li>That's it for today — come back tomorrow for a new hand.</li>
          </ol>

          <h3 class="help-heading">🃏 Wild cards</h3>
          <p>
            A <strong>Wild</strong> is an ordinary card that turns up now and then — slightly rarer
            than any single normal card, so expect one every handful of days. It pays a small bonus
            just for showing up, but the real reason you want it is that it
            <strong>becomes whatever card your hand needs most</strong>.
          </p>
          <p>
            Hold <span class="help-cards">9♠ 9♥ 4♦ 🃏</span> and the Wild plays as a third nine —
            Three of a Kind. Hold four hearts and a Wild, and it plays as a heart to finish the
            Flush. You never choose: it's always counted as whichever card scores you the most.
          </p>

          <h3 class="help-heading">✨ Rare cards</h3>
          <p>
            Separately, any card can turn up <strong>rare</strong> — 🥉 Bronze, 🥈 Silver, 🥇 Gold or
            💎 Diamond. Rare cards pay bonus points just for being in your hand, and if a rare card
            is genuinely <em>part of your winning hand</em> (not just sitting alongside it), it
            multiplies your <strong>entire score</strong> — the rarer the card, the bigger the
            multiplier.
          </p>
          <p class="help-note">
            The two are independent, so a card can be both: a 🥇 Gold Wild completes your hand
            <em>and</em> multiplies what it's worth.
          </p>
        `;
      },
    });
  }

  // ONE WAY IN: tap the emailed button. The link lands back on our own domain
  // carrying a `token_hash`, which main.js redeems before anything renders —
  // see verifySignInLink in state/auth.js and supabase/email-templates/.
  //
  // A 6-digit code alternative was built and then removed on the owner's call:
  // a button and a code competing in the same email and the same modal read as
  // two different things to do. `verifyEmailOtp` is kept in state/auth.js as the
  // escape hatch for mail apps whose in-app browser has isolated storage, which
  // no link can solve.
  // `retryable` means the failure was the network/CDN, not the token — main.js
  // has deliberately LEFT the token in the URL in that case, so simply loading
  // the page again redeems it. Offering "Send Link" there would be the wrong
  // advice (the link in hand is fine), so retry leads and the email form stays
  // available underneath for anyone who'd rather start over.
  function openLoginModal({ hint, retryable = false } = {}) {
    openModal({
      title: 'Log In',
      render: (body) => {
        if (!isSupabaseConfigured) {
          body.innerHTML = `<p>Accounts aren't set up on this deployment yet.</p>`;
          return;
        }
        body.innerHTML = `
          <p>${escapeHtml(hint ?? "We'll email you a one-time sign-in link — no password to remember.")}</p>
          ${retryable ? `<button type="button" class="login-retry-btn">Try Again</button>` : ''}
          <form class="login-form">
            <input type="email" class="login-email-input" placeholder="you@example.com" required autocomplete="email" />
            <button type="submit">Send Link</button>
          </form>
          <p class="login-status" hidden></p>
        `;
        body.querySelector('.login-retry-btn')?.addEventListener('click', () => window.location.reload());
        const form = body.querySelector('.login-form');
        const status = body.querySelector('.login-status');
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const email = body.querySelector('.login-email-input').value.trim();
          const submitBtn = form.querySelector('button');
          submitBtn.disabled = true;
          try {
            await signInWithMagicLink(email);
            form.hidden = true;
            status.hidden = false;
            status.textContent = `Check ${email} for your sign-in link — it expires in an hour.`;
          } catch (error) {
            status.hidden = false;
            status.textContent = error.message;
            submitBtn.disabled = false;
          }
        });
      },
    });
  }

  function promptForUsername(userId) {
    usernamePromptOpenForUserId = userId;
    openModal({
      title: 'Pick a Username',
      onClose: () => {
        usernamePromptOpenForUserId = null;
      },
      render: (body, close) => {
        body.innerHTML = `
          <p>One more step — pick a public username (3-20 characters: letters, numbers, underscores).</p>
          <form class="login-form">
            <input type="text" class="username-input" placeholder="username" required />
            <button type="submit">Save</button>
          </form>
          <p class="login-status" hidden></p>
        `;
        const form = body.querySelector('.login-form');
        const status = body.querySelector('.login-status');
        const input = body.querySelector('.username-input');

        // Live availability, so a name that cannot be used says so while it is
        // being typed rather than after a submit. Debounced and
        // sequence-numbered for the same reasons the friend search is (one query
        // per pause, and a slow early reply can never overwrite a later one).
        //
        // Advisory only — `createProfile` still handles the refusal on submit,
        // because this check can fail open (see isUsernameAvailable) and because
        // a name can be taken in the seconds between checking and submitting.
        let debounce = null;
        let sequence = 0;
        input.addEventListener('input', () => {
          clearTimeout(debounce);
          const typed = input.value.trim();
          if (!isValidUsername(typed)) {
            // The format rule is stated in the copy above the field, so an
            // incomplete name mid-typing gets no scolding.
            status.hidden = true;
            return;
          }
          debounce = setTimeout(async () => {
            const mine = ++sequence;
            const free = await isUsernameAvailable(typed);
            if (mine !== sequence || input.value.trim() !== typed) return;
            status.hidden = false;
            status.textContent = free ? `"${typed.toUpperCase()}" is available.` : `"${typed.toUpperCase()}" isn't available.`;
          }, 300);
        });

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const username = input.value.trim();
          const submitBtn = form.querySelector('button');
          submitBtn.disabled = true;
          try {
            currentProfile = await createProfile(userId, username);
            renderAuthSlot();
            close();
          } catch (error) {
            status.hidden = false;
            status.textContent = error.message;
            submitBtn.disabled = false;
          }
        });
      },
    });
  }

  function openFriendsPanel(userId) {
    openModal({
      title: 'Friends',
      render: (body) => renderFriendsPanel(body, userId),
    });
  }

  // Fetches and renders the whole panel body, and re-runs itself in place
  // after every action (send/accept/decline/remove) — simplest way to keep
  // the panel's contents honest without hand-rolling incremental DOM patches
  // for what's a small, infrequently-updated list.
  async function renderFriendsPanel(body, userId) {
    body.innerHTML = `<p class="friends-loading">Loading…</p>`;
    let friends;
    let pending;
    let sent;
    try {
      [friends, pending, sent] = await Promise.all([getFriends(userId), getPendingRequests(userId), getSentRequests(userId)]);
    } catch (error) {
      body.innerHTML = `<p class="friends-error">${escapeHtml(error.message)}</p>`;
      return;
    }

    // SEARCH, THEN CLICK (owner request: "when adding friends it should first
    // search then pop up names that are valid and then you click to add them").
    // The old form was a blind submit: you typed a name you had to already know,
    // exactly, and only found out on submit whether it existed. Now the results
    // are the affordance — every row shown is a real player, and each carries
    // the one action that makes sense for them.
    //
    // `.friend-results` is a plain div toggled with `hidden` and deliberately
    // gets NO `display` rule in styles.css; an explicit one would beat the UA's
    // `[hidden] { display: none }` and leave an empty results box permanently on
    // screen. That trap has now bitten this codebase six times.
    body.innerHTML = `
      <div class="add-friend">
        <input type="text" class="add-friend-input" placeholder="Search players by name…"
          autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Search players by name" />
        <div class="friend-results" hidden></div>
      </div>
      <p class="login-status add-friend-status" hidden></p>
      ${
        pending.length > 0
          ? `<h3 class="friends-subheading">Requests</h3>
             <ul class="friends-list">
               ${pending
                 .map(
                   (r) => `
                 <li class="friends-list-item">
                   <span>${r.requesterUsername ? `<a class="friends-profile-link" href="/?profile=${encodeURIComponent(r.requesterUsername)}">${r.requesterProfile ? nameplateHtml(r.requesterProfile, { custom: customCosmetics }) : escapeHtml(r.requesterUsername)}</a>` : 'Unknown'}</span>
                   <button type="button" class="friend-accept-btn" data-id="${r.id}">Accept</button>
                   <button type="button" class="friend-decline-btn" data-id="${r.id}">Decline</button>
                 </li>`,
                 )
                 .join('')}
             </ul>`
          : ''
      }
      ${
        sent.length > 0
          ? `<h3 class="friends-subheading">Sent <span class="profile-count">${sent.length}</span></h3>
             <ul class="friends-list">
               ${sent
                 .map(
                   (r) => `
                 <li class="friends-list-item">
                   <span>${r.addresseeUsername ? `<a class="friends-profile-link" href="/?profile=${encodeURIComponent(r.addresseeUsername)}">${r.addresseeProfile ? nameplateHtml(r.addresseeProfile, { custom: customCosmetics }) : escapeHtml(r.addresseeUsername)}</a>` : 'Unknown'}</span>
                   <span class="friends-pending-tag">Pending</span>
                   <button type="button" class="friend-cancel-btn" data-id="${escapeHtml(r.id)}">Cancel</button>
                 </li>`,
                 )
                 .join('')}
             </ul>`
          : ''
      }
      <h3 class="friends-subheading">Friends</h3>
      ${
        friends.length === 0
          ? '<p class="friends-empty">No friends yet — add one above.</p>'
          : `<ul class="friends-list">
              ${friends
                .map(
                  (f) => `
                <li class="friends-list-item">
                  <span>${f.friendUsername ? `<a class="friends-profile-link" href="/?profile=${encodeURIComponent(f.friendUsername)}">${f.friendProfile ? nameplateHtml(f.friendProfile, { custom: customCosmetics }) : escapeHtml(f.friendUsername)}</a>` : 'Unknown'}</span>
                  <button type="button" class="friend-remove-btn" data-id="${f.id}">Remove</button>
                </li>`,
                )
                .join('')}
            </ul>`
      }
    `;

    wireFriendSearch(body, userId, { friends, pending, sent });

    body.querySelectorAll('.friend-accept-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await acceptFriendRequest(btn.dataset.id);
        await renderFriendsPanel(body, userId);
      });
    });

    body.querySelectorAll('.friend-decline-btn, .friend-remove-btn, .friend-cancel-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await removeFriendship(btn.dataset.id);
        await renderFriendsPanel(body, userId);
      });
    });
  }

  // Live username search feeding a clickable result list.
  //
  // The already-loaded friends/pending/sent lists are reused to label each
  // result rather than asking the database what the relationship is — the panel
  // has just fetched all three, so every relationship the viewer has is already
  // in memory. That keeps a keystroke to ONE query instead of one plus a
  // per-result lookup, and it is why a result can say "Pending" or "Accept"
  // rather than only finding out on click.
  function wireFriendSearch(body, userId, { friends, pending, sent }) {
    const input = body.querySelector('.add-friend-input');
    const results = body.querySelector('.friend-results');
    const status = body.querySelector('.add-friend-status');
    if (!input) return;

    // id -> what this viewer's relationship with them already is.
    const relationship = new Map();
    for (const f of friends) if (f.friendProfile) relationship.set(f.friendProfile.id, { kind: 'friend', id: f.id });
    for (const r of pending) if (r.requesterProfile) relationship.set(r.requesterProfile.id, { kind: 'incoming', id: r.id });
    for (const s of sent) if (s.addresseeProfile) relationship.set(s.addresseeProfile.id, { kind: 'outgoing', id: s.id });

    // Debounced so typing a name is one query, not one per character; and
    // sequence-numbered so a slow early response cannot overwrite the results of
    // a later, more specific query — the classic out-of-order autocomplete bug.
    let debounce = null;
    let sequence = 0;

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(input.value), 180);
    });

    async function runSearch(raw) {
      const mine = ++sequence;
      const query = raw.trim();
      if (query.length < 2) {
        results.hidden = true;
        results.innerHTML = '';
        return;
      }
      let found;
      try {
        found = await searchProfiles(query, { excludeUserId: userId });
      } catch (error) {
        if (mine !== sequence) return;
        results.hidden = false;
        results.innerHTML = `<p class="friend-results-empty">${escapeHtml(error.message)}</p>`;
        return;
      }
      if (mine !== sequence) return; // a newer search already answered

      results.hidden = false;
      if (found.length === 0) {
        results.innerHTML = `<p class="friend-results-empty">No player whose name starts with “${escapeHtml(query)}”.</p>`;
        return;
      }

      results.innerHTML = found
        .map((profile) => {
          const rel = relationship.get(profile.id);
          // One action per row, decided by the existing relationship. Sending a
          // request to someone who already sent you one would create the
          // reciprocal duplicate migration 010 exists to prevent, so that case
          // offers Accept instead of Add.
          const action =
            rel?.kind === 'friend'
              ? '<span class="friend-result-tag">Friends</span>'
              : rel?.kind === 'outgoing'
                ? '<span class="friend-result-tag">Pending</span>'
                : rel?.kind === 'incoming'
                  ? `<button type="button" class="friend-result-btn" data-accept="${escapeHtml(rel.id)}">Accept</button>`
                  : `<button type="button" class="friend-result-btn" data-add="${escapeHtml(profile.username)}">Add</button>`;
          return `
            <div class="friend-result">
              <a class="friends-profile-link" href="/?profile=${encodeURIComponent(profile.username)}">
                ${nameplateHtml(profile, { custom: customCosmetics })}
              </a>
              ${action}
            </div>`;
        })
        .join('');

      results.querySelectorAll('[data-add]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const name = btn.dataset.add;
          try {
            await sendFriendRequest(userId, name);
            await renderFriendsPanel(body, userId);
            // renderFriendsPanel replaced the whole body, so the nodes captured
            // above are detached — re-query before writing to them.
            const fresh = body.querySelector('.add-friend-status');
            if (fresh) {
              fresh.hidden = false;
              fresh.textContent = `Invite sent to ${name}.`;
            }
          } catch (error) {
            btn.disabled = false;
            status.hidden = false;
            status.textContent = error.message;
          }
        });
      });

      results.querySelectorAll('[data-accept]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await acceptFriendRequest(btn.dataset.accept);
            await renderFriendsPanel(body, userId);
          } catch (error) {
            btn.disabled = false;
            status.hidden = false;
            status.textContent = error.message;
          }
        });
      });
    }
  }
}
