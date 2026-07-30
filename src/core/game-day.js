// The game day and its reset boundary (DESIGN.md §11l).
//
// A Cardle day runs from 7:00 PM America/New_York to the next 7:00 PM, tracking
// daylight saving — so it is always 7pm for a player in the US, not 7pm in
// winter and 8pm in summer (owner request: "add a timer to the next draw reset,
// it should happen at 7pm est").
//
// WHY THIS LABELLING SCHEME, and why no data migration was needed:
// a game day is named by the New York local date, plus one day once the local
// hour reaches 19. That is deliberately chosen to line up with what the game
// already did. In winter, 19:00 EST *is* midnight UTC, so this produces exactly
// the same date string the old UTC-calendar-day logic produced — every stored
// `play_date` from before this change stays correct. Only during EDT does the
// boundary move, and only by one hour (19:00 EDT = 23:00 UTC), so the single
// affected window is 23:00-00:00 UTC in summer. That is why existing rows did
// not have to be rewritten.
//
// No timezone library: `Intl.DateTimeFormat` with a `timeZone` already knows the
// full DST history, so it is both correct and dependency-free — in keeping with
// the project having no build step and one runtime dependency.

/** The hour (New York local, 24h) at which a new hand becomes available. */
export const RESET_HOUR_NY = 19;
export const GAME_TIME_ZONE = 'America/New_York';

const PART_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: GAME_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** New York local wall-clock parts for an instant. */
function nyParts(date) {
  const parts = {};
  for (const part of PART_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  // `hour12: false` can yield hour 24 for midnight in some engines; normalize so
  // arithmetic and comparisons below never see an out-of-range hour.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function isoFrom(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * The game day an instant belongs to, as a YYYY-MM-DD string. This is the value
 * used for `daily_plays.play_date`, the per-day localStorage keys, the modifier
 * rotation, and the caption pools — everything that means "which day's puzzle".
 */
export function gameDayFor(date = new Date()) {
  const { year, month, day, hour } = nyParts(date);
  if (hour < RESET_HOUR_NY) return isoFrom(year, month, day);
  // Past the reset: this instant belongs to the day that has just begun.
  const rolled = new Date(Date.UTC(year, month - 1, day));
  rolled.setUTCDate(rolled.getUTCDate() + 1);
  return isoFrom(rolled.getUTCFullYear(), rolled.getUTCMonth() + 1, rolled.getUTCDate());
}

/**
 * The UTC instant of a given New York wall-clock time.
 *
 * Iterates because the UTC offset depends on the instant we're solving for —
 * a first guess using the offset at the guessed time lands within an hour, and
 * re-deriving the offset there converges. Two passes is enough for every real
 * zone; a third is cheap insurance around the DST transitions themselves.
 */
function nyWallClockToUtc(year, month, day, hour) {
  let guess = Date.UTC(year, month - 1, day, hour);
  for (let pass = 0; pass < 3; pass++) {
    const parts = nyParts(new Date(guess));
    const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const offset = asIfUtc - guess;
    const corrected = Date.UTC(year, month - 1, day, hour) - offset;
    if (corrected === guess) break;
    guess = corrected;
  }
  return new Date(guess);
}

/**
 * When the next hand unlocks — the end of the current game day.
 * @returns {Date}
 */
export function nextResetAt(date = new Date()) {
  // The current game day's label IS the date of its own closing reset: a day
  // labelled D began at 19:00 on D-1 and ends at 19:00 on D.
  const [year, month, day] = gameDayFor(date).split('-').map(Number);
  const reset = nyWallClockToUtc(year, month, day, RESET_HOUR_NY);
  // Guard against a boundary instant landing exactly on the reset: if the
  // computed reset isn't in the future, step a day and recompute so a countdown
  // can never show zero or negative.
  if (reset.getTime() <= date.getTime()) {
    const next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + 1);
    return nyWallClockToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), RESET_HOUR_NY);
  }
  return reset;
}

/** Milliseconds until the next reset, never negative. */
export function msUntilNextReset(date = new Date()) {
  return Math.max(0, nextResetAt(date).getTime() - date.getTime());
}

/**
 * A countdown broken into parts, for display.
 * @returns {{hours: number, minutes: number, seconds: number, totalMs: number}}
 */
export function resetCountdown(date = new Date()) {
  const totalMs = msUntilNextReset(date);
  const totalSeconds = Math.floor(totalMs / 1000);
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    totalMs,
  };
}

/**
 * "5:23:07" — always hours:minutes:seconds.
 *
 * Seconds are always shown even when the reset is hours away. A coarse "5h 23m"
 * is arguably tidier, but the board ticks this every second, and a label that
 * only changes once a minute doesn't read as a running timer — it reads as a
 * static note. The seconds are the thing that makes it feel live. The width is
 * kept stable by `tabular-nums` on `.next-reset` so the text doesn't jitter.
 */
export function formatCountdown(date = new Date()) {
  const { hours, minutes, seconds } = resetCountdown(date);
  return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

const EPOCH_GAME_DAY = '2026-07-27';

/**
 * Sequential game-day number since the project epoch — the "Cardle #N" label.
 * Counts GAME days, so it advances at 7pm New York rather than at midnight UTC,
 * keeping the number in step with which puzzle is actually live.
 */
export function gameDayNumber(date = new Date()) {
  const MS_PER_DAY = 86_400_000;
  const current = Date.parse(`${gameDayFor(date)}T00:00:00Z`);
  const epoch = Date.parse(`${EPOCH_GAME_DAY}T00:00:00Z`);
  return Math.floor((current - epoch) / MS_PER_DAY) + 1;
}
