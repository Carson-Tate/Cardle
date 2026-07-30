// Cumulative, cross-day player stats — the substrate cumulative achievements
// (Collector, Veteran, ...) check against. Distinct from persistence.js
// (one day's result); this is a running history. Test-mode runs never call
// recordRun(), so they can't pollute it.

const STATS_KEY = 'cardle:stats';

function defaultStats() {
  return {
    gamesPlayed: 0,
    bestScore: 0,
    handsSeen: [],
    personalitiesSeen: [],
    achievementsUnlocked: [],
  };
}

// Same reasoning as persistence.js's readJson/writeJson: unreadable or
// unwritable storage (disabled, full, or a malformed value) must not take
// the game down — an unguarded JSON.parse here would throw from inside
// lockIn(), after the hand was already played but before the score rendered.
// Falling back to a fresh stats object loses history, which is strictly
// better than losing the run. The defaultStats() spread also means a
// partially-shaped stored object can't produce undefined array fields for
// recordRun() below to push into.
export function getStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return defaultStats();
    return { ...defaultStats(), ...JSON.parse(raw) };
  } catch (error) {
    console.warn('Ignoring unreadable cardle:stats entry:', error);
    return defaultStats();
  }
}

function saveStats(stats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch (error) {
    console.warn('Could not persist cardle:stats:', error);
  }
}

/**
 * Folds a completed run into cumulative stats and returns the updated copy.
 * @param {{handId: string, personalityId: string, score: number}} run
 */
export function recordRun({ handId, personalityId, score }) {
  const stats = getStats();
  stats.gamesPlayed += 1;
  stats.bestScore = Math.max(stats.bestScore, score);
  if (!stats.handsSeen.includes(handId)) stats.handsSeen.push(handId);
  if (!stats.personalitiesSeen.includes(personalityId)) stats.personalitiesSeen.push(personalityId);
  saveStats(stats);
  return stats;
}

/**
 * Marks the given achievement ids as unlocked (idempotent — already-unlocked
 * ids are ignored) and returns which ones were newly unlocked just now.
 * @param {object} stats - as returned by getStats()/recordRun()
 * @param {string[]} eligibleIds - every achievement id currently satisfied
 */
export function markAchievementsUnlocked(stats, eligibleIds) {
  const newlyUnlocked = eligibleIds.filter((id) => !stats.achievementsUnlocked.includes(id));
  if (newlyUnlocked.length > 0) {
    stats.achievementsUnlocked.push(...newlyUnlocked);
    saveStats(stats);
  }
  return { stats, newlyUnlocked };
}
