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

export const DEFAULT_PAINT_ID = 'paint_default';

// Admin-authored cosmetics (DESIGN.md §11g) are APPENDED to the built-ins
// rather than replacing them, so a custom title can never shadow or remove a
// real one. `custom` is passed in by the caller (which fetched it from
// game_config and validated it via core/game-config.js) — this module still
// never touches the network.
//
// A custom paint carries a plain hex `color` instead of a CSS class, because a
// class cannot be authored at runtime. That's why validateCustomCosmetics()
// enforces a strict 6-digit hex: it's applied as an inline `color`, and a
// nameplate renders in OTHER players' browsers, so anything looser would be a
// CSS-injection vector.
function withCustom(base, customList) {
  if (!Array.isArray(customList) || customList.length === 0) return base;
  const existing = new Set(base.map((entry) => entry.id));
  return [...base, ...customList.filter((entry) => entry && !existing.has(entry.id))];
}

/** The effective registries for a given custom-cosmetics config. */
export function effectiveRegistries(custom = null) {
  return {
    badges: withCustom(BADGES, custom?.badges),
    titles: withCustom(TITLES, custom?.titles),
    paints: withCustom(NAME_PAINTS, custom?.paints),
  };
}

/**
 * Splits every cosmetic into unlocked/locked for a given player, with a
 * human-readable requirement on the locked ones so the picker can say WHY
 * something isn't available yet.
 *
 * `adminUnlocks` (profiles.admin_unlocks, §11f) force-unlocks specific ids
 * regardless of achievements or level. It exists because normal unlocks are
 * DERIVED from history, so there was otherwise nowhere to record "an admin
 * granted this" — a granted cosmetic would have been silently re-locked the
 * next time the profile recomputed itself. Additive only: it never takes
 * away something legitimately earned.
 *
 * @param {{level?: number, achievementsUnlocked?: string[], adminUnlocks?: string[]}} player
 */
export function resolveCosmetics({ level = 1, achievementsUnlocked = [], adminUnlocks = [], custom = null } = {}) {
  const earned = new Set(achievementsUnlocked ?? []);
  const granted = new Set(adminUnlocks ?? []);
  const safeLevel = Number.isFinite(level) ? level : 1;
  const { badges, titles, paints } = effectiveRegistries(custom);

  const mark = (entry, earnedNormally, requirementText) => ({
    ...entry,
    unlocked: earnedNormally || granted.has(entry.id),
    grantedByAdmin: !earnedNormally && granted.has(entry.id),
    requirementText,
  });

  // Availability applies to CUSTOM cosmetics only (§11h); built-ins keep their
  // achievement/level rules. `hidden` means "don't show this in a player's
  // picker at all unless they have it" — an exclusive cosmetic shouldn't
  // advertise itself to everyone. The admin panel ignores `hidden` so it can
  // still hand these out.
  const markCustom = (entry, levelEarned) => {
    const availability = entry.availability ?? 'level';
    if (availability === 'everyone') {
      return { ...entry, unlocked: true, grantedByAdmin: false, hidden: false, requirementText: 'Available to everyone' };
    }
    if (availability === 'grant') {
      const has = granted.has(entry.id);
      return {
        ...entry,
        unlocked: has,
        grantedByAdmin: has,
        hidden: !has,
        requirementText: 'Granted by an admin only',
      };
    }
    return { ...mark(entry, levelEarned, `Reach level ${entry.level}`), hidden: false };
  };

  const resolveEntry = (entry, levelEarned, builtInRequirement) =>
    entry.custom ? markCustom(entry, levelEarned) : { ...mark(entry, levelEarned, builtInRequirement), hidden: false };

  return {
    badges: badges.map((badge) =>
      resolveEntry(badge, Boolean(badge.achievementId) && earned.has(badge.achievementId), `Achievement: ${badge.label}`),
    ),
    titles: titles.map((title) => resolveEntry(title, safeLevel >= title.level, `Reach level ${title.level}`)),
    paints: paints.map((paint) =>
      resolveEntry(
        paint,
        safeLevel >= paint.level,
        paint.level <= 1 ? 'Available from the start' : `Reach level ${paint.level}`,
      ),
    ),
  };
}

/**
 * Whether a player currently OWNS a cosmetic, judged only from data present on
 * their `profiles` row. Deliberately limited: it can answer definitively for a
 * `grant`-mode custom cosmetic (ownership is exactly `admin_unlocks`, which is
 * on the row) and says nothing about level- or achievement-gated ones, which
 * would need their whole play history.
 *
 * That narrow question is the one that matters for correctness. Flipping an
 * over-permissive custom cosmetic to `grant` has to actually REMOVE it from
 * everyone who already equipped it — otherwise re-locking would be cosmetic
 * only, and an "Owner" title handed out by accident could never be taken back.
 */
function ownsGrantOnly(entry, profileRow) {
  if (!entry?.custom || (entry.availability ?? 'level') !== 'grant') return true;
  const granted = profileRow?.admin_unlocks;
  return Array.isArray(granted) && granted.includes(entry.id);
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
export function resolveEquipped(profileRow, custom = null) {
  const { badges, titles, paints } = effectiveRegistries(custom);
  // A grant-only custom cosmetic is dropped unless the row actually carries the
  // grant — see ownsGrantOnly(). This is what makes re-locking an accidentally
  // over-permissive cosmetic actually take effect for players who equipped it.
  const find = (list, id) => {
    const entry = list.find((e) => e.id === id) ?? null;
    return entry && ownsGrantOnly(entry, profileRow) ? entry : null;
  };
  const paint = find(paints, profileRow?.equipped_paint) ?? paints.find((p) => p.id === DEFAULT_PAINT_ID);
  return {
    badge: find(badges, profileRow?.equipped_badge),
    title: find(titles, profileRow?.equipped_title),
    paint,
  };
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
