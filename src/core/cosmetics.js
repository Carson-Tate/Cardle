// Unlockable cosmetics (DESIGN.md §11e) — badges, titles, and name paints.
// Pure registries plus the unlock resolver; nothing here touches storage or
// the DOM, so the whole unlock model is directly unit-testable.
//
// UNLOCK SOURCES ARE SPLIT BY KIND, per the contract agreed in decision log
// #56: badges come from ACHIEVEMENTS (each badge is proof of one specific
// thing you did), while titles and name paints come from LEVELS (predictable
// progression you can see coming). That way neither system is redundant —
// levels aren't just a number, and achievements aren't purely decorative.

import { ACHIEVEMENTS } from './achievements.js';
import { levelForXp } from './progression.js';

// Every achievement grants the matching badge, generated from the achievement
// registry rather than hand-listed. Deliberate: a hand-written parallel list
// would silently drift the moment an achievement is added or renamed, and
// there'd be nothing to catch it. The badge IS the achievement's own emoji, so
// wearing one is legible to anyone who knows the achievement.
export const BADGES = ACHIEVEMENTS.map((achievement) => ({
  id: `badge_${achievement.id}`,
  emoji: achievement.emoji,
  label: achievement.label,
  achievementId: achievement.id,
  requirement: achievement.description,
}));

// Titles unlock on level. Level 1 gets none — a title should feel earned, and
// there's a "no title" option in the picker for players who'd rather show
// nothing.
export const TITLES = [
  { id: 'title_newcomer', label: 'Newcomer', level: 2 },
  { id: 'title_card_counter', label: 'Card Counter', level: 4 },
  { id: 'title_bluff_artist', label: 'Bluff Artist', level: 6 },
  { id: 'title_high_roller', label: 'High Roller', level: 8 },
  { id: 'title_sharp', label: 'Sharp', level: 10 },
  { id: 'title_table_captain', label: 'Table Captain', level: 13 },
  { id: 'title_shark', label: 'Shark', level: 16 },
  { id: 'title_grandmaster', label: 'Grandmaster', level: 20 },
  { id: 'title_legend', label: 'Legend of the Felt', level: 25 },
  { id: 'title_immortal', label: 'Cardle Immortal', level: 30 },
];

// Name paints. The five plain colours are available from level 1 (owner:
// "with like 5 basic colors as default") so customising your name is possible
// on day one; the gradient and animated ones are the level rewards.
//
// Each paint's actual appearance lives in a CSS class (`.paint-<id>` in
// styles.css) rather than inline style strings here — colours belong in the
// stylesheet, it keeps dark-mode variants possible, and it means this registry
// can't inject arbitrary CSS into a nameplate.
export const NAME_PAINTS = [
  { id: 'paint_default', label: 'Default', level: 1, basic: true },
  { id: 'paint_crimson', label: 'Crimson', level: 1, basic: true },
  { id: 'paint_ocean', label: 'Ocean', level: 1, basic: true },
  { id: 'paint_forest', label: 'Forest', level: 1, basic: true },
  { id: 'paint_amber', label: 'Amber', level: 1, basic: true },
  { id: 'paint_violet', label: 'Violet', level: 1, basic: true },
  { id: 'paint_sunset', label: 'Sunset', level: 5 },
  { id: 'paint_tide', label: 'Tide', level: 8 },
  { id: 'paint_emerald', label: 'Emerald', level: 12 },
  { id: 'paint_royal', label: 'Royal', level: 16 },
  { id: 'paint_diamond', label: 'Diamond', level: 20 },
  { id: 'paint_jackpot', label: 'Jackpot', level: 25 },
];

const BADGE_BY_ID = new Map(BADGES.map((b) => [b.id, b]));
const TITLE_BY_ID = new Map(TITLES.map((t) => [t.id, t]));
const PAINT_BY_ID = new Map(NAME_PAINTS.map((p) => [p.id, p]));

export const DEFAULT_PAINT_ID = 'paint_default';

/**
 * Splits every cosmetic into unlocked/locked for a given player, with a
 * human-readable requirement on the locked ones so the picker can say WHY
 * something isn't available yet.
 *
 * @param {{level?: number, achievementsUnlocked?: string[]}} player
 */
export function resolveCosmetics({ level = 1, achievementsUnlocked = [] } = {}) {
  const earned = new Set(achievementsUnlocked);
  const safeLevel = Number.isFinite(level) ? level : 1;

  return {
    badges: BADGES.map((badge) => ({
      ...badge,
      unlocked: earned.has(badge.achievementId),
      requirementText: `Achievement: ${badge.label}`,
    })),
    titles: TITLES.map((title) => ({
      ...title,
      unlocked: safeLevel >= title.level,
      requirementText: `Reach level ${title.level}`,
    })),
    paints: NAME_PAINTS.map((paint) => ({
      ...paint,
      unlocked: safeLevel >= paint.level,
      requirementText: paint.level <= 1 ? 'Available from the start' : `Reach level ${paint.level}`,
    })),
  };
}

/** Convenience wrapper for callers that hold lifetime XP rather than a level. */
export function resolveCosmeticsForXp(totalXp, achievementsUnlocked) {
  return resolveCosmetics({ level: levelForXp(totalXp), achievementsUnlocked });
}

/**
 * Normalizes whatever is stored on a profile row into something safe to
 * render. Anything unrecognized — a retired cosmetic id, a value written
 * directly through the REST API, a typo — resolves to null (or the default
 * paint) rather than being passed through.
 *
 * This is the layer that makes "the database only pattern-constrains these
 * columns" acceptable: the app owns the vocabulary, so an id that isn't in a
 * registry above simply doesn't render. See §11e on why unlock ENFORCEMENT is
 * client-side while id VALIDITY is enforced here and in the schema.
 */
export function resolveEquipped(profileRow) {
  const badge = BADGE_BY_ID.get(profileRow?.equipped_badge) ?? null;
  const title = TITLE_BY_ID.get(profileRow?.equipped_title) ?? null;
  const paint = PAINT_BY_ID.get(profileRow?.equipped_paint) ?? PAINT_BY_ID.get(DEFAULT_PAINT_ID);
  return { badge, title, paint };
}

/**
 * Whether a player may equip a given id. Used to gate the picker, and also
 * re-checked before saving so a stale page (levelled up in another tab, or a
 * locked option somehow clicked) can't persist something unearned.
 */
export function canEquip(kind, id, player) {
  if (id === null || id === undefined || id === '') return true; // clearing a slot is always allowed
  const resolved = resolveCosmetics(player);
  const list = resolved[kind];
  if (!list) return false;
  const match = list.find((entry) => entry.id === id);
  return Boolean(match && match.unlocked);
}
