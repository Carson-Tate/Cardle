// Career stats, derived entirely from a player's stored run history
// (DESIGN.md §11d). Pure — takes a list of `{ playDate, result }` entries and
// returns everything the profile page shows.
//
// DERIVED, not accumulated, on purpose. src/state/stats.js already keeps a
// running localStorage tally, but that's per-browser: it can't back an
// account-level profile, it double-counts nothing but also survives nothing
// (clear site data and your career is gone), and any bug in the incremental
// update path corrupts the total permanently. Recomputing from the actual
// `daily_plays` rows means the profile is correct on every device, self-heals
// after any bad write, and has exactly one source of truth.

import { handStrengthIndex, HAND_RANKS } from './hand-evaluator.js';
import { PERSONALITIES } from './personality.js';
import { ACHIEVEMENTS, evaluateAchievements } from './achievements.js';
import { xpForRun, levelProgress } from './progression.js';
import { gameDayFor } from './game-day.js';

// Milliseconds in a day, for streak detection over `play_date` values.
const MS_PER_DAY = 86_400_000;

function utcDayNumber(isoDate) {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / MS_PER_DAY) : null;
}

/**
 * @param {Array<{playDate: string, result: object}>} history - one entry per
 *   completed run, any order (sorted internally). `playDate` is a YYYY-MM-DD
 *   GAME DAY string (§11l, rolls 19:00 America/New_York), matching
 *   daily_plays.play_date — which state/daily-play.js writes with gameDayFor().
 *   NOT a UTC date: passing one disagrees with the game day for an hour each
 *   summer evening and reintroduces the streak bug §11l fixed.
 * @param {{today?: string}} [options] - `today` (YYYY-MM-DD) decides whether
 *   the current streak is still live; defaults to the current GAME day.
 */
export function derivePlayerStats(history, { today } = {}) {
  const entries = (Array.isArray(history) ? history : [])
    .filter((entry) => entry && entry.result && typeof entry.result === 'object')
    // Oldest first: achievement replay below has to see cumulative stats grow
    // in the order the player actually experienced them.
    .sort((a, b) => String(a.playDate).localeCompare(String(b.playDate)));

  const stats = {
    gamesPlayed: entries.length,
    totalPoints: 0,
    bestScore: 0,
    bestRun: null,
    bestRunDate: null,
    bestHandId: null,
    bestHandLabel: null,
    totalXp: 0,
    handsSeen: [],
    personalitiesSeen: [],
    achievementsUnlocked: [],
    averageScore: 0,
    averageDecisionRating: null,
    bestDecisionRating: null,
    rareCardsKept: 0,
    currentStreak: 0,
    longestStreak: 0,
    firstPlayDate: entries.length > 0 ? entries[0].playDate : null,
    lastPlayDate: entries.length > 0 ? entries[entries.length - 1].playDate : null,
  };

  const handsSeen = new Set();
  const personalitiesSeen = new Set();
  const unlocked = new Set();
  let ratingSum = 0;
  let ratingCount = 0;
  let bestStrength = -1;

  // Cumulative counters as of the run currently being replayed — the shape
  // src/state/stats.js's recordRun() produces, rebuilt here so achievement
  // checks see exactly what they saw on the day. recordRun folds the run in
  // BEFORE achievements are evaluated, so each of these is updated first and
  // the replay happens at the bottom of the loop.
  let gamesPlayedSoFar = 0;
  let bestScoreSoFar = 0;

  for (const { playDate, result } of entries) {
    const score = result.score ?? {};
    const total = Number.isFinite(score.total) ? score.total : 0;

    stats.totalPoints += total;
    stats.totalXp += xpForRun(result);
    gamesPlayedSoFar += 1;
    bestScoreSoFar = Math.max(bestScoreSoFar, total);

    if (total > stats.bestScore) {
      stats.bestScore = total;
      stats.bestRun = result;
      // Carried alongside the run rather than looked up again by the caller.
      // The profile's Best Hand plaque is clickable (§11ab) and its modal wants
      // a date; finding it by matching the result object back against `history`
      // would work only because they are the same reference, which is exactly
      // the kind of thing that silently stops being true.
      stats.bestRunDate = playDate ?? null;
    }

    const handId = score.handResult?.id;
    if (handId) {
      handsSeen.add(handId);
      // "Highest hand" means the best CATEGORY reached, not the biggest score
      // — a rank-scaled Pair with huge bonuses can outscore a genuine
      // Straight, and a player asking for their highest hand means the poker
      // hand. Ties break on score so the best example of that category wins.
      const strength = handStrengthIndex(handId);
      if (strength > bestStrength || (strength === bestStrength && total > (stats.bestHandScore ?? 0))) {
        bestStrength = strength;
        stats.bestHandId = handId;
        stats.bestHandLabel = score.handResult?.label ?? handId;
        stats.bestHandScore = total;
      }
    }

    if (result.personalityId) personalitiesSeen.add(result.personalityId);

    if (Number.isFinite(result.decisionRating)) {
      ratingSum += result.decisionRating;
      ratingCount += 1;
      if (stats.bestDecisionRating === null || result.decisionRating > stats.bestDecisionRating) {
        stats.bestDecisionRating = result.decisionRating;
      }
    }

    if (Array.isArray(score.rarity?.items)) stats.rareCardsKept += score.rarity.items.length;

    // Achievements: union of what was recorded AT THE TIME (`newlyUnlocked`,
    // written by board.js when the run was played) and a fresh replay against
    // cumulative stats as of this run. The union matters in both directions —
    // replay alone would silently drop anything whose rule has since changed,
    // and the stored list alone would miss cumulative achievements for runs
    // played before this account-backed profile existed (those were only ever
    // evaluated against per-browser localStorage stats).
    if (Array.isArray(result.newlyUnlocked)) {
      for (const id of result.newlyUnlocked) unlocked.add(id);
    }
    for (const achievement of evaluateAchievements({
      score,
      decisionRating: result.decisionRating,
      discardedCount: Array.isArray(result.discardIndices) ? result.discardIndices.length : 0,
      // Not stored on older rows. Left undefined rather than guessed: the
      // checks that need it compare for equality, so undefined simply fails
      // to unlock rather than unlocking something unearned.
      maxDiscards: result.maxDiscards,
      stats: {
        gamesPlayed: gamesPlayedSoFar,
        bestScore: bestScoreSoFar,
        handsSeen: [...handsSeen],
        personalitiesSeen: [...personalitiesSeen],
        achievementsUnlocked: [...unlocked],
      },
    })) {
      unlocked.add(achievement.id);
    }
  }

  stats.handsSeen = [...handsSeen];
  stats.personalitiesSeen = [...personalitiesSeen];
  stats.achievementsUnlocked = [...unlocked];
  stats.averageScore = entries.length > 0 ? Math.round(stats.totalPoints / entries.length) : 0;
  stats.averageDecisionRating = ratingCount > 0 ? ratingSum / ratingCount : null;

  const streaks = deriveStreaks(entries, today);
  stats.currentStreak = streaks.current;
  stats.longestStreak = streaks.longest;

  const progress = levelProgress(stats.totalXp);
  stats.level = progress.level;
  stats.xpIntoLevel = progress.xpIntoLevel;
  stats.xpForNextLevel = progress.xpForNextLevel;
  stats.levelProgress = progress.progress;

  stats.totalHandCategories = HAND_RANKS.length;
  stats.totalPersonalities = PERSONALITIES.length;
  stats.totalAchievements = ACHIEVEMENTS.length;

  return stats;
}

// Consecutive calendar days played. `current` only counts if the most recent
// play was today or yesterday — a streak that already lapsed reads as 0
// rather than lingering at its old value.
function deriveStreaks(entries, today) {
  const days = [...new Set(entries.map((e) => utcDayNumber(e.playDate)).filter((d) => d !== null))].sort((a, b) => a - b);
  if (days.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // Defaults to the current GAME day (§11l), so a streak isn't declared lapsed
  // during the hours where the UTC date has rolled but the game day hasn't.
  const todayNumber = utcDayNumber(today ?? gameDayFor(new Date()));
  const lastDay = days[days.length - 1];
  const lapsed = todayNumber === null || todayNumber - lastDay > 1;
  return { current: lapsed ? 0 : run, longest };
}

/**
 * The achievement registry split into earned / unearned, preserving registry
 * order so the profile's list is stable rather than reordering as things
 * unlock.
 */
export function splitAchievements(unlockedIds) {
  const owned = new Set(unlockedIds ?? []);
  return ACHIEVEMENTS.map((achievement) => ({ ...achievement, unlocked: owned.has(achievement.id) }));
}
