// Fetches the server-side game config and hands it to the pure core (DESIGN.md
// §11g). This is the only module that knows `game_config` exists; core/ receives
// the result as plain arguments.
//
// AVAILABILITY IS THE PRIORITY. This runs on every page load, before a hand can
// be dealt, and the game must stay fully playable when it fails — a blocked CDN,
// an offline player, an unrun migration, or a Supabase outage. So `loadGameConfig`
// never rejects: it resolves to validated defaults instead, and the game plays
// exactly as it did before this table existed. That's the same lesson as the
// top-level-await CDN failure (§54) — one optional backend read must not be able
// to take the whole game down.

import { getSupabase, requireSupabase } from './supabase-client.js';
import {
  CONFIG_KEYS,
  validateModifierOverrides,
  validateWordBank,
  validateCustomCosmetics,
  mergeWordBank,
} from '../core/game-config.js';

/** The shape callers get, whether or not anything was actually fetched. */
function emptyConfig() {
  return {
    modifierOverrides: {},
    wordBank: {},
    fragments: mergeWordBank(null),
    customCosmetics: { badges: [], titles: [], paints: [] },
    loaded: false,
  };
}

let cached = null;

/**
 * Reads every config row once per page load and validates it. Cached because
 * several views want it (board, profile, admin) and it can't change mid-session
 * without a reload anyway.
 *
 * @param {{force?: boolean}} [options] - `force` re-reads after an admin write.
 */
export async function loadGameConfig({ force = false } = {}) {
  if (cached && !force) return cached;

  const config = emptyConfig();
  try {
    const client = await getSupabase();
    if (!client) {
      cached = config;
      return cached;
    }
    const { data, error } = await client.from('game_config').select('key, value');
    if (error) throw error;

    const byKey = new Map((data ?? []).map((row) => [row.key, row.value]));

    // Validated on the way OUT as well as in: a row that predates a shape
    // change, or was hand-edited, must degrade to the default rather than
    // breaking the game for every player who loads it.
    config.modifierOverrides = validateModifierOverrides(byKey.get(CONFIG_KEYS.MODIFIER_OVERRIDES)).value;
    config.wordBank = validateWordBank(byKey.get(CONFIG_KEYS.WORD_BANK)).value;
    config.fragments = mergeWordBank(config.wordBank);
    config.customCosmetics = validateCustomCosmetics(byKey.get(CONFIG_KEYS.CUSTOM_COSMETICS)).value;
    config.loaded = true;
    cached = config;
    return cached;
  } catch (error) {
    // Deliberately swallowed: see the availability note at the top. The caller
    // still gets a fully playable config.
    console.warn('Game config unavailable; using built-in defaults:', error);
    // NOT CACHED, unlike the two resolved paths above. A failed read used to be
    // stored like a successful one, so a single transient blip at page load
    // poisoned the cache for the entire session: every later caller was served
    // the empty config from memory without another request, and the player
    // spent the whole visit on the rotation modifier while an admin's pin sat
    // in the database being ignored. Leaving `cached` alone means the next
    // caller simply tries again.
    return config;
  }
}

/** Drops the cache so the next load re-reads — used after an admin write. */
export function invalidateGameConfig() {
  cached = null;
}

/** Raw stored values, for the admin editors (which need to show what's saved). */
export async function fetchRawConfig() {
  const client = await requireSupabase();
  const { data, error } = await client.from('game_config').select('key, value, updated_at');
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
}

export async function adminSetConfig(key, value) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_set_config', { config_key: key, config_value: value });
  if (error) throw error;
  invalidateGameConfig();
}

/**
 * Removes a key entirely, which is meaningfully different from saving an empty
 * value: absent means "use the built-in default", empty means "an admin
 * deliberately cleared this".
 */
export async function adminClearConfig(key) {
  const client = await requireSupabase();
  const { error } = await client.rpc('admin_clear_config', { config_key: key });
  if (error) throw error;
  invalidateGameConfig();
}
