// Renders a player's name with their equipped cosmetics (DESIGN.md §11e).
// Shared by every place a username appears — the site header, the profile page,
// and the friends list — so a nameplate looks the same everywhere and there's
// exactly one piece of code deciding how badge/title/paint combine.
//
// LAYOUT (owner delegated this: "unlockable titles you can put either below or
// next to your name (whichever looks best)"): badge sits immediately BEFORE the
// name, title goes BELOW it. Below rather than beside because titles are real
// phrases ("Legend of the Felt"), and inline they push the name around and wrap
// unpredictably in a narrow friends row; stacked, the name stays the anchor and
// the title reads as a subtitle. The one exception is the site header, which is
// a tight top bar rather than a nameplate — it takes the `compact` variant and
// shows badge + painted name only.

import { resolveEquipped } from '../core/cosmetics.js';

// Fired on `window` whenever the signed-in player's own profile row changes
// (currently: equipping a cosmetic). The site header caches its profile row
// when the session resolves, so without this its nameplate would keep showing
// the pre-change badge/title/paint until the next page load — visibly stale,
// since the header and the profile page's own preview are on screen together.
// An event rather than a direct call keeps header.js and profile.js from having
// to know about each other.
export const PROFILE_UPDATED_EVENT = 'cardle:profile-updated';

/** Announces an updated `profiles` row so any nameplate on screen can re-render. */
export function announceProfileUpdate(profileRow) {
  window.dispatchEvent(new CustomEvent(PROFILE_UPDATED_EVENT, { detail: profileRow }));
}

// Asking the header to open its login modal (§11ac). The modal is a closure
// inside initHeader — it owns the session, the username prompt and the
// duplicate guard (§11b), none of which should get a second implementation just
// so another page can offer a login button. This file is where the two already
// meet, so the event lives here rather than adding an import in either
// direction.
export const LOGIN_REQUESTED_EVENT = 'cardle:login-requested';

/**
 * Ask the header to open the login modal.
 * @param {string} [hint] - why the caller needs an account, shown in the modal.
 */
export function requestLogin(hint) {
  window.dispatchEvent(new CustomEvent(LOGIN_REQUESTED_EVENT, { detail: { hint } }));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * @param {object} profileRow - a `profiles` row (may be null/partial)
 * @param {{variant?: 'full'|'compact', fallbackName?: string}} [options]
 *   `compact` omits the title (see the layout note above).
 * @returns {string} HTML
 */
export function nameplateHtml(profileRow, { variant = 'full', fallbackName = 'Player', custom = null } = {}) {
  const { badge, title, paint } = resolveEquipped(profileRow, custom);
  const name = profileRow?.username ?? fallbackName;

  // Every dynamic value is escaped, and the paint is applied as a class from a
  // fixed registry rather than an inline style — a stored id can never inject
  // markup or CSS. resolveEquipped() has already discarded anything it doesn't
  // recognize, so `paint.id` is always one of ours.
  const badgePart = badge ? `<span class="nameplate-badge" title="${escapeHtml(badge.label)}">${escapeHtml(badge.emoji)}</span>` : '';
  // A built-in paint is a CSS class; an admin-authored one carries a plain hex
  // colour instead, because a class can't be created at runtime. The hex is
  // strictly validated upstream (core/game-config.js) precisely because this
  // becomes an inline style in other players' browsers — anything looser would
  // be a CSS-injection vector.
  const paintStyle = paint.custom && paint.color ? ` style="color: ${escapeHtml(paint.color)}"` : '';
  const namePart = `<span class="nameplate-name paint-${escapeHtml(paint.id)}"${paintStyle}>${escapeHtml(name)}</span>`;
  const titlePart =
    variant === 'full' && title ? `<span class="nameplate-title">${escapeHtml(title.label)}</span>` : '';

  return `<span class="nameplate nameplate--${escapeHtml(variant)}">
    <span class="nameplate-line">${badgePart}${namePart}</span>
    ${titlePart}
  </span>`;
}
