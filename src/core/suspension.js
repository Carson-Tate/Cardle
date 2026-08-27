// SUSPENSIONS (DESIGN.md §11ap) — the pure half.
//
// Everything here is a function of a suspension row and the current time, with
// no network and no DOM, so `npm test` covers the rules directly. The row comes
// from `public.suspensions` and is shaped:
//
//   { suspended_until: string|null, reason: string|null, created_at: string }
//
// `suspended_until === null` means PERMANENT, which is deliberately distinct
// from having no row at all (never suspended). Conflating those is how a
// permanent ban silently becomes no ban, so every function here separates them.
//
// THE DATABASE IS THE ENFORCEMENT AND THIS IS THE EXPLANATION. `is_suspended()`
// and the `daily_plays` insert trigger decide whether somebody may play; these
// functions only decide what to tell them. A disagreement between the two shows
// up as a wrong message, never as an unearned hand — which is the safe
// direction for the pair to fail in.

/**
 * Whether a row still bans the player right now.
 *
 * A row that has expired is not active, and neither is one that was lifted —
 * but the lifted case is filtered out in SQL before it ever reaches here, so
 * `lifted_at` is checked only defensively.
 */
export function isSuspensionActive(row, now = new Date()) {
  if (!row) return false;
  if (row.lifted_at) return false;
  if (row.suspended_until === null || row.suspended_until === undefined) return true; // permanent
  const until = new Date(row.suspended_until);
  if (Number.isNaN(until.getTime())) return false; // unparseable end date bans nobody
  return until.getTime() > now.getTime();
}

/**
 * Milliseconds until the suspension lifts — `null` when it is permanent, and
 * `0` when it has already expired.
 *
 * Separate from `isSuspensionActive` so a caller can render a countdown without
 * re-deriving the parse, and so "permanent" stays representable as something
 * other than a very large number.
 */
export function suspensionRemaining(row, now = new Date()) {
  if (!isSuspensionActive(row, now)) return 0;
  if (row.suspended_until === null || row.suspended_until === undefined) return null;
  return Math.max(0, new Date(row.suspended_until).getTime() - now.getTime());
}

/**
 * The player-facing description, as data rather than markup.
 *
 * Returns `null` when there is nothing to say, so a caller can treat "no
 * suspension" and "an expired one" identically without asking twice.
 */
export function describeSuspension(row, now = new Date()) {
  if (!isSuspensionActive(row, now)) return null;
  const permanent = row.suspended_until === null || row.suspended_until === undefined;
  return {
    permanent,
    until: permanent ? null : new Date(row.suspended_until),
    // Trimmed to nothing becomes null so the caller has ONE empty case to
    // handle rather than distinguishing null from '' from '   '.
    reason: typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim() : null,
    headline: permanent
      ? 'Your account has been suspended'
      : 'You have received a temporary suspension',
  };
}

/**
 * The end date, written the way the banner says it.
 *
 * Fixed to New York, NOT the viewer's locale, because the game day already
 * rolls at 19:00 there (§11l) and a suspension that reads "ends 9:00 PM" in one
 * timezone and "2:00 AM" in another describes the same instant while looking
 * like a different punishment. One clock for the whole game.
 */
export function formatSuspensionEnd(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/**
 * A coarse "1 day", "3 hours" for the headline.
 *
 * Deliberately coarse: the exact instant is already on screen from
 * `formatSuspensionEnd`, and a to-the-second countdown invites staring at it.
 */
export function formatSuspensionLength(ms) {
  if (ms === null) return null; // permanent
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Preset lengths the admin panel offers, in hours. Permanent is `null`. */
export const SUSPENSION_PRESETS = [
  { label: '1 day', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
  { label: 'Permanent', hours: null },
];
