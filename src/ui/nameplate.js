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
export function nameplateHtml(profileRow, { variant = 'full', fallbackName = 'Player' } = {}) {
  const { badge, title, paint } = resolveEquipped(profileRow);
  const name = profileRow?.username ?? fallbackName;

  // Every dynamic value is escaped, and the paint is applied as a class from a
  // fixed registry rather than an inline style — a stored id can never inject
  // markup or CSS. resolveEquipped() has already discarded anything it doesn't
  // recognize, so `paint.id` is always one of ours.
  const badgePart = badge ? `<span class="nameplate-badge" title="${escapeHtml(badge.label)}">${escapeHtml(badge.emoji)}</span>` : '';
  const namePart = `<span class="nameplate-name paint-${escapeHtml(paint.id)}">${escapeHtml(name)}</span>`;
  const titlePart =
    variant === 'full' && title ? `<span class="nameplate-title">${escapeHtml(title.label)}</span>` : '';

  return `<span class="nameplate nameplate--${escapeHtml(variant)}">
    <span class="nameplate-line">${badgePart}${namePart}</span>
    ${titlePart}
  </span>`;
}
