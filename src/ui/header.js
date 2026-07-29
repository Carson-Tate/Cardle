// Site header (owner request: logo + help on the left, login/username +
// friends on the right) — DESIGN.md §11. Independent of board.js's own
// per-run header (day label, modifier banner): this one is site-wide chrome
// that doesn't change between runs, so it's its own module with its own
// init call, wired up alongside initBoard() in main.js rather than folded
// into it.

import { openModal } from './modal.js';
import { getSession, onAuthStateChange, signInWithMagicLink, signOut, getProfile, createProfile } from '../state/auth.js';
import { sendFriendRequest, getPendingRequests, getFriends, acceptFriendRequest, removeFriendship } from '../state/friends.js';
import { isSupabaseConfigured } from '../state/supabase-client.js';

export function initHeader(root) {
  const logoBtn = root.querySelector('#header-logo');
  const helpBtn = root.querySelector('#header-help');
  const authSlot = root.querySelector('#header-auth-slot');
  const friendsBtn = root.querySelector('#header-friends-btn');

  // Mirrors whatever onAuthStateChange last reported — read by the friends
  // button and the auth slot's own click handler, so they always act on the
  // current session without each needing their own subscription.
  let currentSession = null;
  let currentProfile = null;

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

  friendsBtn.addEventListener('click', () => {
    if (!currentSession) {
      openLoginModal({ hint: 'Log in to see your friends.' });
      return;
    }
    openFriendsPanel(currentSession.user.id);
  });

  function renderAuthSlot() {
    friendsBtn.hidden = !currentSession;
    if (!currentSession) {
      authSlot.innerHTML = `<button type="button" class="header-login-btn">Log In</button>`;
      authSlot.querySelector('.header-login-btn').addEventListener('click', () => openLoginModal());
      return;
    }
    // Between sign-in and the profile finishing its fetch (or a brand new
    // user still being prompted for a username), there's a real gap where
    // we have a session but no username yet — an ellipsis instead of a
    // blank button avoids the header looking broken during that beat.
    const label = currentProfile?.username ?? '…';
    authSlot.innerHTML = `<button type="button" class="header-user-btn">👤 ${label}</button>`;
    authSlot.querySelector('.header-user-btn').addEventListener('click', openAccountModal);
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
    if (!currentProfile && usernamePromptOpenForUserId !== currentSession.user.id) {
      promptForUsername(currentSession.user.id);
    }
  }

  renderAuthSlot(); // paint the logged-out state immediately; getSession/onAuthStateChange correct it the moment the real session is known

  // Seeds the header with whatever session Supabase already restored from
  // localStorage (a magic-link sign-in persists there by default, so this is
  // what makes a closed-and-reopened tab still show as logged in) — Supabase's
  // own recommended pattern is to read the current session explicitly on
  // startup rather than rely solely on onAuthStateChange's initial firing,
  // since exactly when/whether that first callback carries the restored
  // session isn't consistent across SDK versions.
  getSession().then((session) => {
    currentSession = session;
    refreshProfile();
  });

  onAuthStateChange((session) => {
    currentSession = session;
    refreshProfile();
  });

  function openHelpModal() {
    openModal({
      title: 'How to Play',
      render: (body) => {
        body.innerHTML = `
          <ol class="help-steps">
            <li>You get one hand of 5 cards, once per day.</li>
            <li>Click a card to mark it for discard — the number you're allowed to mark is shown under your hand.</li>
            <li>Click <strong>Lock In</strong>. Marked cards get swapped for new ones, and your final 5-card poker hand is scored — stronger hands (and rare cards) score more.</li>
            <li>That's it for today — come back tomorrow for a new hand.</li>
          </ol>
        `;
      },
    });
  }

  function openLoginModal({ hint } = {}) {
    openModal({
      title: 'Log In',
      render: (body) => {
        if (!isSupabaseConfigured) {
          body.innerHTML = `<p>Accounts aren't set up on this deployment yet.</p>`;
          return;
        }
        body.innerHTML = `
          <p>${hint ?? "We'll email you a one-time sign-in link — no password to remember."}</p>
          <form class="login-form">
            <input type="email" class="login-email-input" placeholder="you@example.com" required autocomplete="email" />
            <button type="submit">Send Link</button>
          </form>
          <p class="login-status" hidden></p>
        `;
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
            status.textContent = `Check ${email} for a sign-in link.`;
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
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const username = body.querySelector('.username-input').value.trim();
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

  function openAccountModal() {
    openModal({
      title: currentProfile?.username ?? 'Account',
      render: (body, close) => {
        body.innerHTML = `<button type="button" class="sign-out-btn">Sign Out</button>`;
        body.querySelector('.sign-out-btn').addEventListener('click', async () => {
          await signOut();
          close();
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
    try {
      [friends, pending] = await Promise.all([getFriends(userId), getPendingRequests(userId)]);
    } catch (error) {
      body.innerHTML = `<p class="friends-error">${error.message}</p>`;
      return;
    }

    body.innerHTML = `
      <form class="add-friend-form">
        <input type="text" class="add-friend-input" placeholder="username" required />
        <button type="submit">Add Friend</button>
      </form>
      <p class="login-status add-friend-status" hidden></p>
      ${
        pending.length > 0
          ? `<h3 class="friends-subheading">Requests</h3>
             <ul class="friends-list">
               ${pending
                 .map(
                   (r) => `
                 <li class="friends-list-item">
                   <span>${r.requesterUsername ?? 'Unknown'}</span>
                   <button type="button" class="friend-accept-btn" data-id="${r.id}">Accept</button>
                   <button type="button" class="friend-decline-btn" data-id="${r.id}">Decline</button>
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
                  <span>${f.friendUsername ?? 'Unknown'}</span>
                  <button type="button" class="friend-remove-btn" data-id="${f.id}">Remove</button>
                </li>`,
                )
                .join('')}
            </ul>`
      }
    `;

    body.querySelector('.add-friend-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const username = body.querySelector('.add-friend-input').value.trim();
      const status = body.querySelector('.add-friend-status');
      try {
        await sendFriendRequest(userId, username);
        await renderFriendsPanel(body, userId);
      } catch (error) {
        status.hidden = false;
        status.textContent = error.message;
      }
    });

    body.querySelectorAll('.friend-accept-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await acceptFriendRequest(btn.dataset.id);
        await renderFriendsPanel(body, userId);
      });
    });

    body.querySelectorAll('.friend-decline-btn, .friend-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await removeFriendship(btn.dataset.id);
        await renderFriendsPanel(body, userId);
      });
    });
  }
}
