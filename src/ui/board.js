import { dealHand, suitGlyph, rankLabel, RANKS, SUITS, createDeck, createRng, shuffle, rarityForRoll, freshSeed } from '../core/deck.js';
import { evaluateHand } from '../core/hand-evaluator.js';
import { scoreRun } from '../core/scoring.js';
import { findEV, decisionRating } from '../core/ev-solver.js';
import { solveOptimalDiscardAsync } from '../state/solver.js';
import { computeMeters } from '../core/meters.js';
import { classifyPersonality, PERSONALITIES } from '../core/personality.js';
import { evaluateAchievements, ACHIEVEMENTS } from '../core/achievements.js';
import { getTodayResult, saveTodayResult, getOrCreateTodaySeed, dayNumber } from '../state/persistence.js';
import { resolveRunConfig } from '../state/test-mode.js';
import { loadGameConfig } from '../state/game-config.js';
import { modifierOverrideFor } from '../core/game-config.js';
import { recordRun, markAchievementsUnlocked } from '../state/stats.js';
import { xpForRun, levelProgress } from '../core/progression.js';
import {
  isTestAccountActive,
  testAccountXp,
  testAccountActualXp,
  enableTestAccount,
  disableTestAccount,
  xpJustBelowLevel,
  addTestAccountXp,
  TEST_ACCOUNT_USERNAME,
} from '../state/test-account.js';
import { announceXpUpdate } from '../state/profile.js';
import { getSession } from '../state/auth.js';
import { claimTodaySeed, saveTodayResultForUser } from '../state/daily-play.js';
import { generateStory, getStoryOptions, getDefaultSelections } from '../story/generator.js';
import { SLOT_META } from '../story/templates.js';
import { RARITIES, TOTAL_SPECIAL_CHANCE, WILD_CHANCE, isWild } from '../core/rarity.js';
import { getDailyModifier, buildModifierById, modifierScoringMultiplier, MODIFIERS } from '../core/modifiers.js';
import { gradeForScore } from '../core/score-grade.js';
import { formatCountdown, msUntilNextReset } from '../core/game-day.js';
import { createCardElement } from './card-view.js';
import { delay, animateCountUp, flipCardToBack, flipReplaceCard, flySparks, flyXpGain } from './animations.js';

// Byte-identical to the copy in every other UI module (nameplate, modal,
// mini-card, leaderboard, header, profile, admin). board.js was the ONE module
// without it, which is how two live injection paths survived here:
//
//  1. The fortune word bank. Those phrases used to be repo-authored literals —
//     a comment in this file still said so — but §11g made them admin-editable
//     through `game_config`, and validateWordBank only checks "non-empty string
//     with no internal period". A phrase containing `</select><img src=x
//     onerror=...>` renders into the story picker in EVERY player's browser
//     after every run, so one compromised admin account becomes arbitrary
//     JavaScript in every session — including the Supabase token in
//     localStorage. That is privilege escalation, not a cosmetic bug.
//  2. The stored run `result`, which is player-written jsonb: the REST grant is
//     `update (result)` on your own row with no shape validation, so
//     `score.handResult.label` and every badge field are attacker-controlled.
//     Only ever your OWN result renders here, so that half is self-XSS today —
//     but it is one refactor away from being cross-user, and the cross-user
//     renderers (profile.js, leaderboard.js) already escape.
//
// `&` must be replaced first or the later replacements would be double-escaped.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// What the Share button copies right now. Module-scope because the button is a
// persistent node bound once (see renderStoryBlock) while the text it copies
// changes with every re-render of the fortune.
let currentShareText = '';
let copyResetTimer = null;

const DEFAULT_MAX_DISCARDS = 3; // overridden per day by a discardLimit-type modifier (DESIGN.md §4)

// Owner request: a description + card-proof for every score-breakdown line,
// "like the attached picture" (RNGDLE's badge breakdown) — see
// buildScoreBadges() below, which is what actually consumes these.
const SKILL_META = {
  perfectKeep: { emoji: '⭐', label: 'Perfect Keep', description: 'Held all 5 cards and still landed an excellent hand.' },
  optimalDiscard: { emoji: '🎯', label: 'Optimal Discard', description: 'Your discard matched the mathematically best play.' },
  longShot: { emoji: '🔥', label: 'Long Shot', description: 'Improved by 3 or more hand ranks after drawing.' },
  cleanFinish: { emoji: '💎', label: 'Clean Finish', description: 'Every card in the final hand contributes — no dead weight.' },
};

const HAND_DESCRIPTIONS = {
  HIGH_CARD: 'No pair, no flush, no straight.',
  PAIR: 'Two cards share a rank.',
  THREE_STRAIGHT: 'Three ranks in a row, no pair.',
  TWO_PAIR: 'Two separate pairs.',
  FOUR_STRAIGHT: 'Four ranks in a row, one card short of a straight.',
  THREE_OF_A_KIND: 'Three cards share a rank.',
  STRAIGHT: 'Five ranks in a row.',
  FLUSH: 'All five cards share a suit.',
  FULL_HOUSE: 'Three of a kind plus a pair.',
  FOUR_OF_A_KIND: 'Four cards share a rank.',
  STRAIGHT_FLUSH: 'Five in a row, all one suit.',
  ROYAL_FLUSH: '10 through Ace, all one suit — the best hand in poker.',
};

const METER_META = {
  luck: { emoji: '🍀', label: 'Luck' },
  skill: { emoji: '🎯', label: 'Skill' },
  risk: { emoji: '🎲', label: 'Risk' },
};

const STORY_SLOT_ORDER = ['opening', 'action', 'object', 'connector', 'ending', 'emoji'];

// A common card's flip speed, and the fallback for every rarity-keyed map
// below. Also the speed of EVERY turn-to-back, rare or not (see
// revealDrawnCards).
const BASE_FLIP_MS = 180;
// How long a card's flip takes, by rarity — common stays snappy (180ms,
// matching the original animation); rare tiers slow down and add a glow
// pulse once they land, so a rare card's reveal reads as unmistakably
// different (owner request). Same maps drive both the initial deal and a
// discard's replacement reveal — see flipReplaceCard in animations.js.
// Diamond (rarer than Joker, §3o) gets the most dramatic timing of all.
//
// These pace the REVEAL only. Both reveal paths are serialized — a `for` loop
// awaiting each card — so cards always land strictly left to right no matter how
// their durations differ. The discard path used to run them in parallel with a
// fixed 90ms stagger, which meant a slow rare card and a fast common one landed
// in whatever order their durations happened to produce.
// Keyed by rarity id. Wild is no longer one of those (§3x), so a wild's pacing
// comes from wildDramaFor() below rather than from this table.
const FLIP_DURATION_BY_RARITY = { bronze: 350, silver: 500, gold: 700, diamond: 1200 };
// A wild reveals at close to NORMAL speed, just a touch slower (owner request:
// "make the wilds appear normal speed maybe a little slower than normal").
//
// It inherited the old 'joker' tier's full drama — a 1000ms flip with half a
// second of anticipation — which made sense when a wild turned up in one hand in
// a hundred. At one in eleven (§3x) that long pause stopped being a moment and
// started being a wait. The rare TIERS keep their drama; wildness on its own no
// longer buys any. A wild that also rolled a tier still takes the slower pacing,
// so a Gold Wild reveals like gold.
const WILD_FLIP_MS = 260; // vs BASE_FLIP_MS 180
const WILD_ANTICIPATION_MS = 80;
const WILD_HOLD_MS = 300; // vs a common card's 250
// A brief hold before a rare card even starts its flip, so its moment
// doesn't get lost in the normal cascading reveal.
const ANTICIPATION_BY_RARITY = { bronze: 150, silver: 250, gold: 350, diamond: 650 };
// How long the card sits showing its face-down back, mid-flip, before
// turning to reveal its face — rare tiers linger longer for extra suspense.
const HOLD_BY_RARITY = { bronze: 300, silver: 400, gold: 550, diamond: 950 };

// How dramatically a card reveals, now that "is it special?" has two sources.
function revealDramaFor(card) {
  const wild = isWild(card);
  const duration = Math.max(FLIP_DURATION_BY_RARITY[card.rarity] ?? BASE_FLIP_MS, wild ? WILD_FLIP_MS : 0);
  const anticipation = Math.max(ANTICIPATION_BY_RARITY[card.rarity] ?? 0, wild ? WILD_ANTICIPATION_MS : 0);
  const hold = Math.max(HOLD_BY_RARITY[card.rarity] ?? 250, wild ? WILD_HOLD_MS : 0);
  // ONLY a rarity earns the glow (owner request: "i dont want the normal rarity
  // wild to flash when doing the reveal animation").
  //
  // It was doubly wrong for a plain wild. The pulse reads as "a rare card
  // landed", which a plain wild is not — and `reveal-rare-pulse` colours itself
  // from `var(--rarity-glow, gold)`, a variable only the rarity classes set, so
  // an unrarity'd wild fell through to the literal fallback and flashed GOLD.
  // A wild that also rolled a tier still glows, in that tier's colour.
  const dramatic = card.rarity ? 'card--reveal-rare' : null;
  return { duration, anticipation, hold, dramatic };
}

// Matches `.card--reveal-rare`'s own animation duration in styles.css.
const REVEAL_PULSE_MS = 700;
// Timing for the opening deal's card-into-place animation (.card--deal-in,
// styles.css) — how long each card takes to land, and the stagger between
// each card starting.
const DEAL_IN_DURATION_MS = 260;
const DEAL_IN_STAGGER_MS = 90;
// A discard's turn-over pass (revealDrawnCards pass 1): the gap between each
// discarded card starting to flip face-down, and the pause once they are all
// backs before the reveal pass begins.
const TURN_OVER_STAGGER_MS = 90;
const TURN_OVER_SETTLE_MS = 220;

export function initBoard(root) {
  const handRow = root.querySelector('#hand-row');
  const drawBtn = root.querySelector('#draw-btn');
  const discardHint = root.querySelector('#discard-hint');
  // May legitimately be null: an ad blocker running a `:remove()` rule takes the
  // element out of the DOM entirely rather than just hiding it. Every use below
  // is null-guarded for that reason.
  const shareBtn = root.querySelector('#result-copy-btn');
  const lockInBtn = root.querySelector('#lock-in-btn');
  const dayLabel = root.querySelector('#day-label');
  const modifierBanner = root.querySelector('#modifier-banner');
  const anonHint = root.querySelector('#anon-hint');
  const nextResetEl = root.querySelector('#next-reset');
  const resultPanel = root.querySelector('#result');
  const wagerPrompt = root.querySelector('#wager-prompt');
  const wagerYesBtn = root.querySelector('#wager-yes-btn');
  const wagerNoBtn = root.querySelector('#wager-no-btn');

  const today = new Date();
  const config = resolveRunConfig();

  // Mutable — real daily play never changes these after the initial
  // resolution below, but the test-mode admin panel's modifier picker
  // (owner request: "a thing in the admin page to change the modifiers")
  // needs to swap them on demand without a full page reload.
  let dailyModifier;
  let maxDiscards;
  let lockedIndex;
  // Held Card (§4f). Distinct from lockedIndex despite the similar shape: this
  // slot IS discardable — the star is a bribe to keep it, not a restriction.
  let markedIndex;

  // Set once, in beginRealPlay() below, before any hand is dealt — null for
  // the whole run means "playing signed out," which gates both which
  // storage a result is saved to (persistence.js locally vs. daily-play.js's
  // account-backed table) and whether the sign-up hint is shown at all.
  // Never reassigned reactively if the player logs in mid-run (DESIGN.md
  // §11c: "this one won't be saved" — that's about THIS draw specifically).
  let currentUserId = null;

  function renderAnonHint(text) {
    anonHint.hidden = false;
    anonHint.textContent = text;
  }

  // Whether an admin preview has deliberately overridden the day's modifier.
  // The server config read is ASYNC, so on a slow connection it can resolve
  // AFTER the tester has already picked a modifier to preview — and it used to
  // overwrite that choice a second later, which reads as the preview button
  // silently not working. An explicit action taken now outranks a fetch that
  // was already in flight.
  let modifierForcedByAdmin = false;

  function applyModifier(modifier, { forced = false } = {}) {
    if (forced) modifierForcedByAdmin = true;
    dailyModifier = modifier;
    // Second Look (§4d) starts on its own, lower round-1 cap rather than the
    // usual `.maxDiscards` field — `maxDiscards` gets reassigned to
    // `round2MaxDiscards` mid-run once round 1 finishes, see startRoundTwo().
    maxDiscards = modifier.type === 'twoRoundDiscard' ? modifier.round1MaxDiscards : (modifier.maxDiscards ?? DEFAULT_MAX_DISCARDS);
    lockedIndex = modifier.lockedIndex ?? null;
    markedIndex = modifier.markedIndex ?? null;
    renderModifierBanner(modifierBanner, modifier, forced);
  }

  function isTwoRoundModifier() {
    return dailyModifier?.type === 'twoRoundDiscard';
  }

  function isPeekWagerModifier() {
    return dailyModifier?.type === 'peekWager';
  }

  startResetCountdown();

  // Ticks the "next hand in ..." label (DESIGN.md §11l). Every second rather
  // than every minute so the final stretch actually counts down; the work is a
  // single string write, so the cost is irrelevant.
  //
  // When the timer runs out the page reloads itself: at that moment this page is
  // showing a hand (or a result) for a day that has just ended, and every other
  // path — the seed claim, the modifier, the caption pools — is derived at load
  // time. Reloading is the honest way to move to the new day, and far less
  // error-prone than trying to hot-swap every one of those in place.
  function startResetCountdown() {
    if (!nextResetEl) return;

    // The clock itself is bold, the "Next hand in" label around it is not
    // (owner request: "time in timer should be bold") — so the countdown needs
    // its own element rather than being part of one flat string.
    //
    // Built ONCE, outside the tick: this redraws every second, and re-parsing
    // markup at 1Hz to change six digits would throw away and rebuild the same
    // two nodes 3,600 times an hour. After this only `timeEl`'s text changes.
    nextResetEl.textContent = 'Next hand in ';
    const timeEl = document.createElement('strong');
    timeEl.className = 'next-reset-time';
    nextResetEl.appendChild(timeEl);

    const tick = () => {
      if (msUntilNextReset() <= 0) {
        // Replaces timeEl outright, which is fine — the page is reloading.
        nextResetEl.textContent = 'New hand ready — reloading…';
        window.location.reload();
        return;
      }
      nextResetEl.hidden = false;
      timeEl.textContent = formatCountdown();
    };
    tick();
    const timer = setInterval(tick, 1000);
    // Not strictly required for a page that lives until navigation, but it keeps
    // the interval from outliving a board that gets torn down in a future
    // single-page navigation.
    window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  }

  // A pure function of the real calendar date by default — always today's
  // actual modifier, even in test mode/admin redeals (same reasoning as the
  // caption pool's daily rotation, §6d: it's tied to the day, not to
  // whichever hand/seed happens to be on screen right now) — unless the
  // admin panel below overrides it via startHand's `forceModifier`.
  applyModifier(getDailyModifier(today));

  // Server-side config (§11g): an admin can pin a specific modifier to a
  // specific day, and can edit the fortune word bank. Started here but awaited
  // before the first deal (see awaitGameConfig) rather than blocking init —
  // the day label and the computed modifier paint immediately, so a slow or
  // failed config read never leaves the page blank. loadGameConfig() resolves
  // to built-in defaults rather than rejecting, so there's nothing to catch.
  let gameConfig = null;
  const gameConfigPromise = loadGameConfig().then((config) => {
    gameConfig = config;
    // Re-apply only if the day is actually overridden, so the common path
    // doesn't repaint the banner for no reason.
    const overrideId = modifierOverrideFor(config.modifierOverrides, today);
    if (overrideId && !modifierForcedByAdmin) applyModifier(getDailyModifier(today, overrideId));
    return config;
  });

  // Every path that deals a hand awaits this first, so an override is always in
  // force before cards are dealt — a hand dealt under the wrong discard cap
  // would be unrecoverable for that player's day.
  async function awaitGameConfig() {
    await gameConfigPromise;
  }

  // The effective story fragment pools — built-ins merged with any admin word
  // bank. Read at render time so it reflects whatever config resolved to.
  function storyFragments() {
    return gameConfig?.fragments;
  }

  if (config.isTestMode) {
    renderAdminPanel(root, (options) => startHand(options));
    renderTestBanner(root, config);
  }

  dayLabel.textContent = config.isTestMode
    ? `🧪 Test hand (seed: ${config.seedLabel})`
    : `Cardle #${dayNumber(today)} — ${today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`;

  let originalHand;
  let drawPile;
  const selected = new Set();
  let cardEls = [];
  // Which discard round is currently active for Second Look (§4d) — 1 or 2,
  // meaningless (but harmless) for every other modifier. Reset on every
  // fresh deal, same as `selected`.
  let discardRound = 1;
  // Round one's discards, kept so submit-run can replay BOTH rounds from the
  // seed. The stored `originalHand` on a Second Wind day is the POST-round-one
  // hand, so without this the server could not reproduce it.
  let roundOneDiscards = null;
  // Bumped every time startHand() fires — every in-flight animation loop
  // (dealInitialHand, revealDrawnCards, lockIn) captures the token it was
  // started with and bails the moment it no longer matches. Without this, a
  // redeal mid-animation (bug report: "click new random hand" while the
  // opening deal is still flipping) left the OLD loop still running against
  // `cardEls`/`originalHand`/`handRow`, which the NEW startHand() call had
  // already reassigned/cleared out from under it — both loops fighting over
  // the same 5 card slots at once.
  let dealToken = 0;

  // Real daily play needs to know whether the player is signed in before it
  // can even pick a seed (an account-backed one via daily-play.js, or a
  // local one via persistence.js — see test-mode.js's resolveRunConfig
  // comment) — an async step test mode skips entirely, dealing immediately
  // from its own already-resolved seed.
  if (config.persist) {
    beginRealPlay();
  } else {
    beginWithDrawButton({ seed: config.seed });
  }

  // Owner request: "i want a draw button before you get the cards to start
  // the game, not right when the page is loaded." Shows the Draw button in
  // place of the (still-empty) hand row and waits for a click before
  // actually dealing — only ever used for the FIRST hand of a run. A
  // redeal from the test-mode admin panel is already its own explicit
  // button click, so those call startHand() directly with no extra gate.
  function beginWithDrawButton(dealOptions) {
    drawBtn.hidden = false;
    drawBtn.addEventListener(
      'click',
      async () => {
        // Config is awaited HERE rather than before revealing the button.
        // Gating the button itself on the fetch measurably delayed it (~117ms
        // to ~960ms on a real connection) for no benefit: what actually has to
        // be true is that any modifier override is in force before CARDS ARE
        // DEALT, since a hand dealt under the wrong discard cap can't be undone
        // for that player's day. Waiting on the click keeps the page feeling
        // instant while preserving that guarantee — and by the time anyone
        // reads the page and clicks, the fetch has almost always resolved.
        // Immediate visible feedback: awaiting config can take a few hundred
        // milliseconds on a cold connection, and a button that only greys out
        // reads as a dead click. The label makes the wait legible.
        const originalLabel = drawBtn.textContent;
        drawBtn.disabled = true;
        drawBtn.textContent = 'Shuffling…';
        await awaitGameConfig();
        drawBtn.hidden = true;
        drawBtn.disabled = false;
        drawBtn.textContent = originalLabel;
        startHand(dealOptions);
      },
      { once: true },
    );
  }

  // Resolves which identity (if any) is playing, claims/loads today's seed
  // or already-finished result for that identity, and either shows the
  // finished result or deals a fresh hand. Falls back to local anonymous
  // play — with the sign-up hint shown — both when there's genuinely no
  // session AND if the account-backed claim fails for any reason (a
  // Supabase hiccup shouldn't be able to block the game entirely).
  async function beginRealPlay() {
    const session = await getSession().catch(() => null);
    if (session) {
      try {
        const { seed, result } = await claimTodaySeed(session.user.id, today);
        currentUserId = session.user.id;
        if (result) {
          renderAlreadyPlayed(result);
        } else {
          beginWithDrawButton({ seed });
        }
        return;
      } catch (error) {
        console.error('Falling back to local anonymous play — daily_plays claim failed:', error);
      }
    }
    const existingResult = getTodayResult(today);
    if (existingResult) {
      renderAnonHint("This one wasn't saved — sign up to save future scores.");
      renderAlreadyPlayed(existingResult);
    } else {
      renderAnonHint("Sign up before drawing to save your score — otherwise this one won't be saved.");
      beginWithDrawButton({ seed: getOrCreateTodaySeed(today) });
    }
  }

  lockInBtn.addEventListener('click', () => {
    if (isTwoRoundModifier() && discardRound === 1) {
      startRoundTwo();
    } else {
      lockIn(originalHand, drawPile, selected);
    }
  });

  wagerYesBtn.addEventListener('click', () => resolveWager(true));
  wagerNoBtn.addEventListener('click', () => resolveWager(false));

  // Deals a fresh hand and animates it in. The real opening deal always
  // calls this with just `seed` (config.seed), so normal daily play is
  // completely unaffected. `luckMultiplier`/`forceRarity`/`forceWild`
  // /`customSlots`/`forceModifier` are only ever passed by the test-mode
  // admin panel below, as a way to preview rare cards (and, for Joker, its
  // nested sub-tier) on demand instead of hunting through ?test= seeds
  // (owner request), or — for `customSlots` — to hand-pick every card's
  // rank/suit/rarity exactly (owner request: "i would like for the admin
  // page to be more advanced so i can add a certain card/rarity in each of
  // the slots"), or — for `forceModifier` — to preview any Daily Modifier on
  // demand (owner request: "a thing in the admin page to change the
  // modifiers"). `forceModifier` is sticky (like the luck slider's value):
  // omitting it on a later redeal just leaves whichever modifier is already
  // active, real or forced, rather than silently reverting — the special
  // value `'__today__'` is the explicit reset back to the real day's.
  function startHand({ seed, luckMultiplier = 1, forceRarity = null, forceWild = false, customSlots = null, forceModifier = null } = {}) {
    const myToken = ++dealToken;
    if (forceModifier === '__today__') {
      // The explicit reset back to the real day's modifier, so it also clears
      // the flag that keeps the server override at bay.
      modifierForcedByAdmin = false;
      applyModifier(getDailyModifier(today, modifierOverrideFor(gameConfig?.modifierOverrides, today)));
    } else if (forceModifier) {
      const modifier = buildModifierById(forceModifier);
      if (modifier) applyModifier(modifier, { forced: true });
    }
    let dealt;
    if (customSlots) {
      dealt = buildCustomHand(customSlots);
      if (config.isTestMode) dayLabel.textContent = '🧪 Test hand (custom hand builder)';
    } else {
      const usedSeed = seed ?? freshSeed();
      if (seed === undefined && config.isTestMode) {
        const forcedLabel = [forceWild ? 'wild' : null, forceRarity].filter(Boolean).join(' ');
        const luckNote = forcedLabel ? `, forced ${forcedLabel}` : luckMultiplier > 1 ? `, luck ×${luckMultiplier}` : '';
        dayLabel.textContent = `🧪 Test hand (admin redeal${luckNote})`;
      }

      dealt = dealHand(usedSeed, 5, { luckMultiplier });
      if (forceRarity || forceWild) {
        const index = Math.floor(Math.random() * dealt.hand.length);
        dealt.hand[index] = {
          ...dealt.hand[index],
          ...(forceRarity ? { rarity: forceRarity } : {}),
          ...(forceWild ? { wild: true } : {}),
        };
      }
    }
    originalHand = dealt.hand;
    drawPile = dealt.drawPile;
    selected.clear();
    discardRound = 1;
    roundOneDiscards = null;

    resultPanel.hidden = true;
    resultPanel.innerHTML = '';
    wagerPrompt.hidden = true;
    lockInBtn.hidden = false;
    updateLockInButtonLabel();
    lockInBtn.disabled = true; // re-enabled once the deal animation finishes
    dealInitialHand(myToken);
  }

  // Flips cardEls[startIndex..endIndex) face-up in place, left to right, with
  // the same rarity-aware anticipation/duration/hold as every other reveal in
  // the game. Shared by the normal opening deal (the whole hand, in one
  // pass) and Double or Nothing's two-stage reveal (§4e — 2 cards, then the
  // remaining 3 once the wager is decided), so both read as the exact same
  // visual language. Returns `false` (caller should bail immediately,
  // touching nothing further) the moment a newer deal supersedes this one.
  async function flipCardsInRange(cards, startIndex, endIndex, token) {
    for (let index = startIndex; index < endIndex; index++) {
      if (token !== dealToken) return false;
      const card = cards[index];
      const { duration, anticipation, hold: holdMs, dramatic: dramaticClass } = revealDramaFor(card);
      if (anticipation) await delay(anticipation);
      if (token !== dealToken) return false;
      // no onClick yet — renderHand() (or the wager prompt) wires up
      // whatever's next once the relevant cards are done flipping
      cardEls[index] = await flipReplaceCard(cardEls[index], card, { duration, holdMs, dramaticClass, disabled: true });
      if (token !== dealToken) return false;
      // The LAST card needs its pulse to finish before this resolves. The caller
      // immediately calls renderHand(), which rebuilds every card element from
      // scratch — so a final card mid-pulse had its element destroyed about
      // 90ms into a 700ms animation, snapping the scale-up back to nothing.
      // Owner report: "when it is the last card it flashes weird". Earlier cards
      // never showed it, because the next card's own flip always outlasted their
      // pulse.
      const isLast = index === endIndex - 1;
      await delay(isLast && dramaticClass ? REVEAL_PULSE_MS : 90);
    }
    return true;
  }

  // Starts by dealing each card face-down into its slot — staggered, so it
  // reads as cards being dealt rather than appearing all at once (owner
  // request: "it should be like the cards are getting dealt and then once
  // they are all in the normal position is when it does the normal
  // reveal") — then, once every card has actually landed, flips each face-up
  // left to right, reusing the exact same flip animation (including
  // rarity-aware duration/glow) as a discard's replacement reveal, so the
  // opening hand is a reveal too, not data that just appears. Cards aren't
  // clickable until the whole deal finishes: a click mid-deal would call
  // renderHand(), which rebuilds the row instantly and would spoil the
  // cards still mid-animation. Double or Nothing (§4e) only flips the first
  // 2 here and stops for the wager prompt instead of finishing the deal —
  // see resolveWager() for the other 3.
  async function dealInitialHand(token) {
    handRow.innerHTML = '';
    cardEls = originalHand.map((card, index) => {
      const el = createCardElement(card, { faceUp: false });
      el.classList.add('card--deal-in');
      el.style.animationDelay = `${index * DEAL_IN_STAGGER_MS}ms`;
      // Drop the class the moment the slide-in finishes. `card-deal-in` is
      // declared `animation-fill-mode: both`, and a filled animation's
      // `transform` outranks any class rule's in the CSS cascade — so leaving
      // it on pinned the card at the animation's final `translateY(0)
      // scale(1)` and silently overrode `.card--flip-out`'s rotateY(90deg).
      // The opening reveal became a hard cut with no flip at all (confirmed by
      // sampling the computed transform mid-flip: the identity matrix, not a
      // rotation), while the discard-replacement flip still worked — which is
      // why it wasn't obvious. Removing the class hands `transform` back to
      // the flip rules.
      el.addEventListener(
        'animationend',
        () => {
          el.classList.remove('card--deal-in');
          el.style.animationDelay = '';
        },
        { once: true },
      );
      handRow.appendChild(el);
      return el;
    });

    // Every card is in position once the last-starting one's own animation
    // finishes, plus a short hold so the fully-dealt hand registers as a
    // beat before the reveal starts (mirrors the old flat 400ms pause here).
    await delay((originalHand.length - 1) * DEAL_IN_STAGGER_MS + DEAL_IN_DURATION_MS + 150);
    if (token !== dealToken) return; // superseded by a newer deal — stop here

    if (isPeekWagerModifier()) {
      const finished = await flipCardsInRange(originalHand, 0, 2, token);
      if (!finished) return;
      lockInBtn.hidden = true;
      wagerPrompt.hidden = false;
      return;
    }

    const finished = await flipCardsInRange(originalHand, 0, originalHand.length, token);
    if (!finished) return;

    renderHand(originalHand, selected); // instant rebuild — same cards, now interactive
    lockInBtn.disabled = false;
    updateHint();
  }

  function renderHand(cards, selectedSet) {
    handRow.innerHTML = '';
    cardEls = cards.map((card, index) => {
      const el = createCardElement(card, {
        faceUp: true,
        selected: selectedSet.has(index),
        locked: index === lockedIndex,
        marked: index === markedIndex,
        onClick: () => toggleDiscard(index),
      });
      handRow.appendChild(el);
      return el;
    });
  }

  function toggleDiscard(index) {
    if (index === lockedIndex) return; // Locked Card modifier — this slot can't be toggled at all
    if (selected.has(index)) {
      selected.delete(index);
    } else if (selected.size < maxDiscards) {
      selected.add(index);
    }
    renderHand(originalHand, selected);
    updateHint();
    updateLockInButtonLabel();
  }

  function updateHint() {
    const roundNote = isTwoRoundModifier() ? (discardRound === 1 ? ' (Round 1 of 2)' : ' (Round 2 of 2 — final)') : '';
    discardHint.textContent = `${selected.size}/${maxDiscards} marked for discard${roundNote} — click a card to mark it, click again to unmark.`;
  }

  // Owner bug report: a friend thought the cards you click were the ones
  // you KEEP, not the ones you discard — the plain "Lock In" label gave no
  // hint either way. Spelling out the actual count/action removes the
  // ambiguity: "Discard 0/3" up to "Discard 3/3" as cards get marked,
  // updating live on every toggle (see toggleDiscard). Second Look's round 1
  // keeps its own "(Round 1 of 2)" qualifier — it's still a discard count
  // in the same sense, just not the final scored one yet.
  function updateLockInButtonLabel() {
    const roundNote = isTwoRoundModifier() && discardRound === 1 ? ' (Round 1 of 2)' : '';
    lockInBtn.textContent = `Discard ${selected.size}/${maxDiscards}${roundNote}`;
  }

  // Second Look's round 1: replaces whatever's marked for discard (same
  // reveal animation as a normal lock-in's draw), then hands off to the
  // existing single-round flow for round 2 — `originalHand` becomes the
  // post-round-1 hand, `drawPile` drops the cards just drawn, and
  // `maxDiscards` switches to the modifier's (lower) round-2 cap. Nothing is
  // scored, solved, or persisted here — round 1 is an ungraded mulligan;
  // only round 2's discard is ever judged by the EV solver/meters/
  // achievements/personality pipeline, same as a normal day (§4d).
  async function startRoundTwo() {
    const token = dealToken;
    handRow.querySelectorAll('.card').forEach((el) => (el.disabled = true));
    lockInBtn.disabled = true;
    lockInBtn.textContent = 'Dealing…';
    discardHint.textContent = '';

    await new Promise((resolve) => setTimeout(resolve, 0));
    if (token !== dealToken) return; // a redeal fired before this even started

    const discardIndices = [...selected].sort((a, b) => a - b);
    const replacements = drawPile.slice(0, discardIndices.length);
    const roundTwoHand = originalHand.map((card, index) => {
      const discardPosition = discardIndices.indexOf(index);
      return discardPosition === -1 ? card : replacements[discardPosition];
    });

    await revealDrawnCards(discardIndices, roundTwoHand, token);
    if (token !== dealToken) return; // a redeal fired mid-reveal

    originalHand = roundTwoHand;
    drawPile = drawPile.slice(discardIndices.length);
    selected.clear();
    roundOneDiscards = discardIndices;
    discardRound = 2;
    maxDiscards = dailyModifier.round2MaxDiscards;

    renderHand(originalHand, selected);
    lockInBtn.disabled = false;
    updateLockInButtonLabel();
    updateHint();
  }

  // Double or Nothing's wager resolution (§4e, owner request: "it reveals 2
  // cards, and then you can do a double or nothing based on those cards
  // seen, and then it reveals the last 3 cards"). `wagered` is stamped
  // directly onto `dailyModifier` — the same "extra field on the resolved
  // modifier object" pattern Locked Card already uses for `.lockedIndex` —
  // so `modifierScoringMultiplier()` (modifiers.js) can read it without any
  // new plumbing through scoreRun()'s params.
  //
  // Deliberately asymmetric, by design choice (owner: "im not sure if they
  // should be allowed to discard cards on this one or not, you decide what
  // would be more fun"): going for it locks in exactly the 5 dealt cards —
  // real tension on a bet made from partial information — while playing it
  // safe is just a completely ordinary round (normal discard cap, no
  // multiplier) once the last 3 are revealed. A genuine risk/reward fork
  // instead of a watered-down version of the same round either way.
  async function resolveWager(wagered) {
    const token = dealToken;
    wagerPrompt.hidden = true;
    dailyModifier.wagered = wagered;

    const finished = await flipCardsInRange(originalHand, 2, originalHand.length, token);
    if (!finished) return;

    if (wagered) {
      maxDiscards = 0;
      await lockIn(originalHand, drawPile, new Set());
    } else {
      maxDiscards = DEFAULT_MAX_DISCARDS;
      renderHand(originalHand, selected);
      lockInBtn.hidden = false;
      lockInBtn.disabled = false;
      updateLockInButtonLabel();
      updateHint();
    }
  }

  async function lockIn(originalHand, drawPile, selectedSet) {
    // Captured up front — if a redeal (admin panel) fires while this run is
    // still solving/animating, dealToken moves on and every check below
    // bails rather than racing the new deal for the same card slots.
    const token = dealToken;
    handRow.querySelectorAll('.card').forEach((el) => (el.disabled = true));
    lockInBtn.disabled = true;
    lockInBtn.textContent = 'Dealing…';
    discardHint.textContent = '';

    // Yield one frame so the disabled state actually paints before the solve.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (token !== dealToken) return; // a redeal fired before the solve even started

    const discardIndices = [...selectedSet].sort((a, b) => a - b);
    // Off the main thread (src/state/solver.js) — the solve is exhaustive and
    // genuinely takes seconds on 4-and-5-discard days, and longer with a Wild
    // in hand. It used to run synchronously right here, which froze the page
    // for that entire time; now it awaits a worker, so the label below can
    // actually animate. Falls back to solving inline if workers are
    // unavailable, which is exactly the old behavior.
    lockInBtn.textContent = 'Crunching the odds…';
    const { evByDiscard, best, worst } = await solveOptimalDiscardAsync(originalHand, drawPile, {
      minDiscards: 0,
      maxDiscards,
      excludedIndices: lockedIndex !== null ? [lockedIndex] : [],
    });
    if (token !== dealToken) return; // a redeal fired while the solve was in flight
    const chosenEV = findEV(evByDiscard, discardIndices);
    lockInBtn.hidden = true; // solve is done; nothing left for this button to do today

    const replacements = drawPile.slice(0, discardIndices.length);
    const finalHand = originalHand.map((card, index) => {
      const discardPosition = discardIndices.indexOf(index);
      return discardPosition === -1 ? card : replacements[discardPosition];
    });

    // WAS THERE A DECISION TO GRADE AT ALL?
    //
    // Double or Nothing (§4) forces `maxDiscards = 0` and locks in immediately,
    // so the solver returns exactly ONE option and best === worst. Every
    // skill measure then degenerated into a free top mark:
    //   - optimalDiscardBonus short-circuits on `bestEV === worstEV` and pays
    //     the full OPTIMAL_DISCARD_MAX_BONUS, with a badge reading "your discard
    //     matched the mathematically best play" — for a round with no discard.
    //   - decisionRating compares the score against best.ev, which is the same
    //     five cards, so it is exactly 1.0. That pins Skill at 100% and unlocks
    //     `flawless` ("play a round with a perfect decision rating").
    // Roughly one day in thirteen handed every player who took the wager the
    // game's "you played perfectly" rewards for nothing.
    //
    // Both are suppressed rather than zeroed: the player did not play BADLY
    // either, and a 0% Skill reading would be just as untrue as 100%. Omitting
    // evContext drops the bonus and its badge, and a null rating is the shape
    // progression.js and player-stats.js already treat as "not measured".
    const hadAChoice = evByDiscard.length > 1;

    const score = scoreRun({
      originalHand,
      finalHand,
      discardedCount: discardIndices.length,
      discardIndices,
      maxDiscards,
      evContext: hadAChoice ? { chosenEV, bestEV: best.ev, worstEV: worst.ev } : undefined,
      modifierMultiplier: modifierScoringMultiplier(dailyModifier),
    });
    const rating = hadAChoice ? decisionRating(score.baseScore, best.ev) : null;

    const originalHandResult = evaluateHand(originalHand);
    const meters = computeMeters({
      originalHandResult,
      actualScore: score.baseScore,
      chosenEV,
      bestEV: best.ev,
      decisionRating: rating,
      discardedCount: discardIndices.length,
      maxDiscards,
    });
    const personality = classifyPersonality({
      meters,
      discardedCount: discardIndices.length,
      maxDiscards,
      originalHandResult,
      finalHandResult: score.handResult,
      skillBonuses: score.skillBonuses,
      extraBonuses: score.extraBonuses,
    });

    // Cumulative stats + achievements only apply to real, persisted runs —
    // test mode never touches them (same rule as saveTodayResult below).
    let newlyUnlocked = [];
    if (config.persist) {
      const stats = recordRun({ handId: score.handResult.id, personalityId: personality.id, score: score.total });
      const eligibleIds = evaluateAchievements({
        score,
        decisionRating: rating,
        discardedCount: discardIndices.length,
        maxDiscards,
        stats,
      }).map((a) => a.id);
      ({ newlyUnlocked } = markAchievementsUnlocked(stats, eligibleIds));
    }

    await revealDrawnCards(discardIndices, finalHand, token);
    if (token !== dealToken) return; // a redeal fired mid-reveal — don't show a stale score for a hand that's no longer on screen

    const result = {
      dayNumber: dayNumber(today),
      originalHand,
      discardIndices,
      finalHand,
      score,
      decisionRating: rating,
      meters,
      personalityId: personality.id,
      newlyUnlocked,
      // THE SERVER'S INPUTS (§11z). submit-run ignores the score above and
      // recomputes it from the seed; these are the only things it cannot derive.
      // `discardRounds` is ordered because Second Wind discards twice and each
      // round draws from what the previous one left behind.
      discardRounds: roundOneDiscards ? [roundOneDiscards, discardIndices] : [discardIndices],
      wagered: dailyModifier.wagered === true,
      // Advisory, and bounded server-side: it can move the total by at most
      // OPTIMAL_DISCARD_MAX_BONUS, which is why re-running the expensive EV
      // solve on the server is not worth it.
      evContext: hadAChoice ? { chosenEV, bestEV: best.ev, worstEV: worst.ev } : undefined,
      // Recorded so the profile page can faithfully replay achievement rules
      // over stored history (core/player-stats.js) — a couple of them compare
      // discardedCount against the day's cap, which wasn't recoverable from
      // the rest of the result. Rows written before this existed simply leave
      // it undefined, which those rules treat as "not satisfied" rather than
      // unlocking something unearned.
      maxDiscards,
    };
    if (config.persist) {
      if (currentUserId) {
        saveTodayResultForUser(currentUserId, result, today).catch((error) =>
          console.error("Today's result wasn't saved to the account:", error),
        );
      } else {
        saveTodayResult(result, today);
        renderAnonHint("This one wasn't saved — sign up to save future scores.");
      }
    }

    // The hint line was blanked at lock-in. It now carries the same sign-off the
    // already-played reload uses, so Share has the text it sits beside on BOTH
    // paths rather than floating under the cards on its own.
    discardHint.textContent = 'Come back tomorrow for a new hand.';
    await revealScore(resultPanel, result, storyFragments(), shareBtn);
  }

  // Replaces the discarded cards, in TWO distinct passes (owner request:
  // "discarding cards first turns over all the discarded cards first from left
  // to right, then reveals from left to right"):
  //
  //   1. every discarded card turns face-down, left to right;
  //   2. only once they are all backs does the reveal begin, left to right.
  //
  // Previously each slot did its own turn-over-hold-reveal end to end before
  // the next one started, so slot 3 was still showing its old card while slot 1
  // had already revealed — the discard read as three separate small events
  // rather than one "these are gone / here is what you got" beat.
  //
  // Both passes use the same turn-to-back, hold, turn-to-front animation as the
  // initial deal (flipCardToBack + flipReplaceCard in animations.js). A rare
  // replacement (bronze and up) gets an extra beat of anticipation, a slower
  // flip, a longer hold on the back, and a glow pulse once it lands — common
  // cards keep the original snappy 180ms flip untouched.
  async function revealDrawnCards(discardIndices, finalHand, token) {
    // PASS 1 — turn them all over. Staggered starts rather than a strict
    // await-each chain, because every turn-to-back runs at the SAME
    // BASE_FLIP_MS regardless of what is coming: with identical durations,
    // start order is land order, so an overlapping cascade is still exactly
    // left-to-right and reads as one sweep instead of a queue. (The reveal pass
    // below cannot do this — its durations vary by rarity, which is the whole
    // reason it stays serialized.)
    await Promise.all(
      discardIndices.map(async (index, position) => {
        await delay(position * TURN_OVER_STAGGER_MS);
        if (token !== dealToken) return; // a redeal fired mid-cascade — stop touching these slots
        cardEls[index] = await flipCardToBack(cardEls[index], finalHand[index], { duration: BASE_FLIP_MS });
      }),
    );
    if (token !== dealToken) return;
    // A beat with the whole discard sitting face-down, so the turn-over lands
    // as its own moment before anything is revealed.
    await delay(TURN_OVER_SETTLE_MS);

    // PASS 2 — reveal, left to right. Every element is already face-down, so
    // flipReplaceCard skips its own turn-to-back and goes straight to the
    // anticipation/hold/reveal it is being asked for here.
    for (const index of discardIndices) {
      if (token !== dealToken) return;
      const card = finalHand[index];
      const { duration, anticipation, hold: holdMs, dramatic: dramaticClass } = revealDramaFor(card);
      cardEls[index] = await flipReplaceCard(cardEls[index], card, {
        duration,
        // Anticipation waits on the face-down back, never on the outgoing card
        // — owner bug report: "the slower animation starts when it flips the
        // card back over to the back". With the turn-over hoisted into pass 1
        // that is now structurally true, not just a parameter choice.
        anticipationMs: anticipation,
        holdMs,
        dramaticClass,
        disabled: true,
      });
      if (token !== dealToken) return;
      await delay(90);
    }
    await delay(150);
  }

  function renderAlreadyPlayed(result) {
    dayLabel.textContent = `Cardle #${result.dayNumber} — already played today`;
    handRow.innerHTML = '';
    result.finalHand.forEach((card) => handRow.appendChild(createCardElement(card, { faceUp: true })));
    discardHint.textContent = 'Come back tomorrow for a new hand.';
    lockInBtn.hidden = true;
    resultPanel.hidden = false;
    resultPanel.innerHTML = staticResultHtml(result);
    // No count-up animation on this path (it's a reload of an already-
    // finished run) — collapse immediately rather than waiting for anything.
    setupBreakdownCollapse(resultPanel.querySelector('.score-breakdown'));
    renderStoryBlock(resultPanel.querySelector('#story-block'), result, storyFragments(), shareBtn);
    // Guarded like every other use: an ad blocker that REMOVES the button (as
    // opposed to hiding it) left this line throwing on null, which aborted the
    // already-played reload half-rendered — so a blocked button cost the player
    // their whole result panel, not just the button.
    if (shareBtn) shareBtn.hidden = false;
  }
}

// Today's active Daily Modifier (DESIGN.md §4), shown right below the day
// label — always visible, since every day has exactly one active modifier
// (no "vanilla" day). `forced` (admin panel only, §4a) marks it as an ad-hoc
// preview rather than the real day's modifier, so it's never mistaken for one.
// Owner: "i want the modifier to be more announced that it is a daily
// modifier" — the plain pill (just the modifier's own name/description) gave
// no sense that this is a distinct daily mechanic, not flavor text. An
// uppercase "Daily Modifier" eyebrow above the name/description makes that
// explicit, matching the small-caps label style already used elsewhere
// (e.g. .admin-panel-title) rather than inventing a new one.
function renderModifierBanner(el, dailyModifier, forced = false) {
  el.hidden = false;
  el.innerHTML = `
    <span class="modifier-banner-eyebrow">Daily Modifier${forced ? ' (admin preview)' : ''}</span>
    <span class="modifier-banner-body">${dailyModifier.emoji} <strong>${dailyModifier.label}</strong> — ${dailyModifier.description}</span>
  `;
}

function renderTestBanner(root, config) {
  const banner = document.createElement('div');
  banner.className = 'test-banner';
  const nextSeed = Date.now();
  banner.innerHTML = `
    <span>🧪 TEST MODE — this run is not saved and does not affect your daily result.</span>
    <a href="?test=${nextSeed}">New random hand</a>
  `;
  root.prepend(banner);
}

// Builds an exact 5-card hand from the admin panel's custom slot builder
// (owner request: hand-pick a rank/suit/rarity per slot). The draw pile —
// where discard replacements come from — is just the rest of the deck
// (every card not used in a slot), shuffled with a fresh random seed and
// given real rarity rolls of its own, so replacements after a discard still
// show rare cards exactly like a normal deal would. `slotConfigs` is 5
// `{rank, suit, rarity, wild}` objects straight from the panel's selects and
// checkboxes; both are used as-is (no rolling) since the whole point of this
// tool is picking them directly.
function buildCustomHand(slotConfigs) {
  const usedKeys = new Set(slotConfigs.map((slot) => `${slot.rank}${slot.suit}`));
  const rng = createRng(freshSeed());
  const remainingDeck = createDeck().filter((card) => !usedKeys.has(`${card.rank}${card.suit}`));
  const drawPile = shuffle(remainingDeck, rng).map((card) => {
    const rarity = rarityForRoll(rng());
    const wild = rng() < WILD_CHANCE;
    return { ...card, rarity, wild };
  });
  const hand = slotConfigs.map((slot) => ({
    rank: slot.rank,
    suit: slot.suit,
    rarity: slot.rarity || null,
    wild: Boolean(slot.wild),
  }));
  return { hand, drawPile };
}

// Defaults for the custom hand builder's 5 slots — a recognizable A-K-Q-J-10
// spread across alternating suits, just so the panel doesn't open on 5
// identical 2♠'s. Purely a starting point; every field is editable.
const CUSTOM_SLOT_DEFAULT_RANKS = [14, 13, 12, 11, 10];
const CUSTOM_SLOT_DEFAULT_SUITS = ['S', 'H', 'D', 'C', 'S'];

// Wild is deliberately absent: it is no longer a tier, so the panel offers it
// as a separate checkbox per slot and a separate Force button.
function rarityOptionsHtml() {
  const none = '<option value="">— none —</option>';
  const tiers = RARITIES.map((tier) => `<option value="${tier.id}">${tier.emoji} ${tier.label}</option>`).join('');
  return `${none}${tiers}`;
}

// Test-mode-only "cheater admin" panel (owner request: a way to see what
// rare cards look like without hunting through ?test= seeds). Four tools:
//   - a Luck slider that shrinks the rarity roll (deck.js dealHand's
//     luckMultiplier) so rares show up far more often across redeals —
//     exploratory, "let me see a wild hand."
//   - one-click Force buttons that guarantee a rare card of that exact tier
//     on a random slot in a freshly dealt hand, luck slider aside —
//     deterministic, "show me the Joker right now."
//   - a Modifier Preview picker (owner request: "a thing in the admin page
//     to change the modifiers") — a dropdown of all 5 Daily Modifiers (§4a)
//     plus a reset-to-today's-real-one option, applied on the next redeal
//     regardless of which button triggers it (sticky, like the luck slider).
//   - a Custom Hand Builder (owner request: "the admin page to be more
//     advanced so i can add a certain card/rarity in each of the slots") —
//     5 slot rows, each with its own rank/suit/rarity pickers, that deal the
//     exact hand specified rather than anything randomized.
// All four redeal a brand-new hand and replay the full flip/glow animation
// (same `startHand` the real opening deal uses), so what you see here is
// exactly what a real reveal looks like, not a static mockup.
function renderAdminPanel(root, onRedeal) {
  const panel = document.createElement('div');
  panel.className = 'admin-panel';
  panel.innerHTML = `
    <div class="admin-panel-title">🛠️ Rarity Preview Admin</div>
    <div class="admin-panel-luck">
      <label for="admin-luck-slider">🍀 Luck <span id="admin-luck-value">1×</span></label>
      <input type="range" id="admin-luck-slider" min="1" max="500" value="1" step="1" />
      <span class="admin-luck-hint" id="admin-luck-hint"></span>
    </div>
    <div class="admin-panel-actions">
      <button type="button" data-action="redeal">🔁 Redeal with this luck</button>
      ${RARITIES.map(
        (tier) => `<button type="button" class="admin-force-btn" data-force="${tier.id}">${tier.emoji} Show ${tier.label}</button>`,
      ).join('')}
    </div>
    <div class="admin-panel-actions">
      <!-- Wild is its own axis now (§3x), so it forces on its own and can be
           combined with any tier rather than replacing it. -->
      <button type="button" class="admin-force-btn" data-force-wild="1">🃏 Show Wild</button>
      ${RARITIES.map(
        (tier) =>
          `<button type="button" class="admin-force-btn" data-force="${tier.id}" data-force-wild="1">🃏${tier.emoji} ${tier.label} Wild</button>`,
      ).join('')}
    </div>
    <div class="admin-panel-subtitle">🧩 Modifier Preview</div>
    <div class="admin-panel-actions">
      <select id="admin-modifier-select">
        <option value="__today__">— Today's real modifier —</option>
        ${MODIFIERS.map((m) => `<option value="${m.id}">${m.emoji} ${m.label}</option>`).join('')}
      </select>
      <button type="button" data-action="preview-modifier">🔁 Redeal with this modifier</button>
    </div>
    <div class="admin-panel-subtitle">🧑‍💻 Test Account</div>
    <div class="admin-test-account">
      <label>
        <input type="checkbox" id="admin-test-account-toggle" />
        Signed in as a fake local account
      </label>
      <div class="admin-test-account-row">
        <label for="admin-test-account-xp">Lifetime XP</label>
        <input type="number" id="admin-test-account-xp" min="0" step="100" value="0" />
        <button type="button" data-action="test-account-apply">Apply &amp; reload</button>
      </div>
      <div class="admin-test-account-row">
        <button type="button" data-action="test-account-nearly">Set to 50 XP short of the next level</button>
      </div>
      <p class="admin-hint" id="admin-test-account-note"></p>
    </div>
    <div class="admin-panel-subtitle">🎛️ Custom Hand Builder</div>
    <div class="admin-slots">
      ${CUSTOM_SLOT_DEFAULT_RANKS.map(
        (defaultRank, i) => `
        <div class="admin-slot">
          <span class="admin-slot-label">${i + 1}</span>
          <select class="admin-slot-rank">
            ${RANKS.map((r) => `<option value="${r}"${r === defaultRank ? ' selected' : ''}>${rankLabel(r)}</option>`).join('')}
          </select>
          <select class="admin-slot-suit">
            ${SUITS.map(
              (s) => `<option value="${s}"${s === CUSTOM_SLOT_DEFAULT_SUITS[i] ? ' selected' : ''}>${suitGlyph(s)}</option>`,
            ).join('')}
          </select>
          <select class="admin-slot-rarity">${rarityOptionsHtml()}</select>
          <label class="admin-slot-wild"><input type="checkbox" class="admin-slot-wild-input" /> 🃏</label>
        </div>
      `,
      ).join('')}
    </div>
    <div class="admin-panel-actions">
      <button type="button" data-action="deal-custom">🎴 Deal This Hand</button>
    </div>
  `;
  root.prepend(panel);

  const luckSlider = panel.querySelector('#admin-luck-slider');
  const luckValueEl = panel.querySelector('#admin-luck-value');
  const luckHintEl = panel.querySelector('#admin-luck-hint');

  const updateLuckLabel = () => {
    const multiplier = Number(luckSlider.value);
    luckValueEl.textContent = `${multiplier}×`;
    const perCardChance = Math.min(TOTAL_SPECIAL_CHANCE * multiplier, 1);
    luckHintEl.textContent = `~${Math.round(perCardChance * 100)}% chance per card`;
  };
  luckSlider.addEventListener('input', updateLuckLabel);
  updateLuckLabel();

  panel.querySelector('[data-action="redeal"]').addEventListener('click', () => {
    onRedeal({ luckMultiplier: Number(luckSlider.value) });
  });

  // BOTH attributes: the plain "Show Wild" button carries only `data-force-wild`
  // (it forces no tier), so a `[data-force]`-only selector left it with no click
  // handler at all — the button rendered and did nothing.
  panel.querySelectorAll('[data-force], [data-force-wild]').forEach((btn) => {
    // Force buttons ignore the luck slider on purpose — one guaranteed card of
    // the exact requested tier and/or wildness, nothing else muddying the
    // preview.
    btn.addEventListener('click', () => {
      onRedeal({ forceRarity: btn.dataset.force ?? null, forceWild: btn.dataset.forceWild === '1' });
    });
  });

  const modifierSelect = panel.querySelector('#admin-modifier-select');
  panel.querySelector('[data-action="preview-modifier"]').addEventListener('click', () => {
    onRedeal({ forceModifier: modifierSelect.value });
  });

  wireTestAccountPanel(panel);

  panel.querySelector('[data-action="deal-custom"]').addEventListener('click', () => {
    const slots = [...panel.querySelectorAll('.admin-slot')].map((slotEl) => ({
      rank: Number(slotEl.querySelector('.admin-slot-rank').value),
      suit: slotEl.querySelector('.admin-slot-suit').value,
      rarity: slotEl.querySelector('.admin-slot-rarity').value || null,
      wild: slotEl.querySelector('.admin-slot-wild-input').checked,
    }));
    const seenCards = new Set();
    const hasDuplicate = slots.some((slot) => {
      const key = `${slot.rank}${slot.suit}`;
      if (seenCards.has(key)) return true;
      seenCards.add(key);
      return false;
    });
    if (hasDuplicate) {
      window.alert('Two slots have the same rank + suit — each card can only appear once.');
      return;
    }
    onRedeal({ customSlots: slots });
  });
}

// Reveals the result panel progressively: hand name, then each score line
// counting up into a running total, then Decision Rating, then the Luck /
// Skill / Risk meters, then the personality badge, then the poker story,
// then (if any) newly unlocked achievements last — a final surprise rather
// than the headline.
// Inserts `li` at the TOP of `container` (owner request: the biggest number
// should end up at the top of the list, not the bottom) and animates every
// already-present line sliding down to make room, rather than an instant
// jump — the classic FLIP technique: record each existing line's position
// before the insert, then after inserting, snap it back to its old position
// with a transform and immediately transition that away to zero.
function insertLineAtTop(container, li) {
  const existing = [...container.children];
  const oldTops = existing.map((el) => el.getBoundingClientRect().top);

  container.prepend(li);

  existing.forEach((el, i) => {
    const newTop = el.getBoundingClientRect().top;
    const delta = oldTops[i] - newTop;
    if (delta === 0) return;
    el.style.transition = 'none';
    el.style.transform = `translateY(${delta}px)`;
    void el.offsetHeight; // force a reflow so the browser registers the starting position before we transition away
    el.style.transition = 'transform 320ms ease';
    el.style.transform = '';
  });
}

// Owner request: once the breakdown is fully populated, collapse it down to
// just the top (highest-value) badge and roughly half of the second, fading
// to transparent, with a Show More/Show Less button to toggle the rest.
// Used both by revealScore() (called only after the count-up loop finishes)
// and the static "already played" path (called right after that HTML is
// inserted, since there's no animation to wait for there). Measures actual
// rendered badge heights rather than guessing in CSS, since badge height
// varies with description length and whether a card-proof strip is present.
function setupBreakdownCollapse(container) {
  const items = [...container.children];
  if (items.length < 3) return; // top badge + half of the second already shows everything there is

  container.classList.add('score-breakdown--collapsible');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'breakdown-toggle';
  container.insertAdjacentElement('afterend', toggle);

  const collapsedHeight = () => {
    const rect0 = items[0].getBoundingClientRect();
    const rect1 = items[1].getBoundingClientRect();
    return rect1.top - rect0.top + rect1.height / 2;
  };

  let expanded = false;
  const render = () => {
    if (expanded) {
      container.style.maxHeight = `${container.scrollHeight}px`;
      container.classList.remove('score-breakdown--collapsed');
      toggle.textContent = 'Show Less ▴';
    } else {
      container.style.maxHeight = `${collapsedHeight()}px`;
      container.classList.add('score-breakdown--collapsed');
      toggle.textContent = `Show ${items.length - 1} More ▾`;
    }
  };
  render();

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    render();
  });
}

async function revealScore(resultPanel, result, fragments, shareBtn = null) {
  const { score, decisionRating: rating, meters, personalityId, newlyUnlocked } = result;
  resultPanel.hidden = false;
  resultPanel.innerHTML = `
    <h2 class="hand-label">${escapeHtml(score.handResult.label)}</h2>
    <div class="score-total" id="score-total">0</div>
    <div class="score-grade" id="score-grade" hidden></div>
    <ul class="score-breakdown" id="score-breakdown"></ul>
    <p class="decision-rating" id="decision-rating" hidden>Decision Rating: <strong id="decision-rating-value">0%</strong></p>
    <div class="meters" id="meters" hidden></div>
    <div class="personality-badge" id="personality-badge" hidden></div>
    <div class="story-block" id="story-block" hidden></div>
    <div class="achievements-toast" id="achievements-toast" hidden></div>
  `;

  const totalEl = resultPanel.querySelector('#score-total');
  const breakdownEl = resultPanel.querySelector('#score-breakdown');
  // Snapshotted once — by the time scoring reveals, the hand-row's 5 cards
  // are done being replaced (revealDrawnCards already finished), so this
  // stays valid for the whole loop below. Positions each badge's flying-
  // spark departure point (owner request: "points come off the cards that
  // gave the points and add into the total") — index order matches
  // finalHand/highlightIndices exactly, since renderHand() always rebuilds
  // hand-row in card order.
  const handCardEls = [...(document.getElementById('hand-row')?.children ?? [])];

  const badges = buildScoreBadges(score, result.finalHand, result.discardIndices);

  let running = 0;
  for (const badge of badges) {
    const li = document.createElement('li');
    li.className = 'score-badge';
    li.innerHTML = badgeCardHtml(badge, score.logicalFinalHand, result.finalHand, 0);
    // Owner request: the biggest number should still be revealed last (for
    // suspense — buildScoreBadges still hands us smallest-to-largest), but
    // it should land at the TOP of the list, pushing every earlier badge
    // down — not just append to the bottom. insertLineAtTop() handles the
    // slide.
    insertLineAtTop(breakdownEl, li);
    const valueEl = li.querySelector('.score-badge-value');

    // Cards this badge is attributed to (empty for badges with no specific
    // card proof, e.g. Pity Points — those just keep the plain count-up).
    // Remove-then-reapply so the glow re-triggers even if the same card was
    // already pulsed by an earlier badge in this same reveal.
    const sourceEls = (badge.highlightIndices ?? []).map((i) => handCardEls[i]).filter(Boolean);
    sourceEls.forEach((el) => {
      el.classList.remove('card--score-pulse');
      void el.offsetWidth; // force reflow so re-adding the class restarts the animation
      el.classList.add('card--score-pulse');
    });

    // Sign-aware, not a hardcoded "+" — Double or Nothing's Busted badge
    // (§4e) can be negative, and toLocaleString() would otherwise render a
    // negative count-up as the confusing "+-655" instead of "-655".
    const badgeSign = badge.value < 0 ? '-' : '+';
    await Promise.all([
      animateCountUp(valueEl, 0, Math.abs(badge.value), 350, { prefix: badgeSign }),
      flySparks(sourceEls, totalEl),
    ]);

    const from = running;
    running += badge.value;
    await animateCountUp(totalEl, from, running, 350);
    await delay(150);
  }

  // The run's rarity grade (§11i), revealed only after the count-up finishes so
  // it reads as the verdict on the final number rather than spoiling it early.
  const gradeEl = resultPanel.querySelector('#score-grade');
  if (gradeEl) {
    const grade = gradeForScore(score.total);
    gradeEl.className = `score-grade score-grade--${grade.id}`;
    gradeEl.innerHTML = `<span class="score-grade-emoji">${grade.emoji}</span><span class="score-grade-label">${grade.label}</span>`;
    gradeEl.hidden = false;
  }

  // Owner request: collapse the breakdown down to the top badge + half of
  // the second once — and only once — the count-up reveal above is fully
  // finished, never mid-animation.
  setupBreakdownCollapse(breakdownEl);

  const ratingWrap = resultPanel.querySelector('#decision-rating');
  const ratingValueEl = resultPanel.querySelector('#decision-rating-value');
  // HIDDEN when there was no decision to grade — a Double or Nothing round
  // locks in with zero discards, so there is no choice to rate. It used to show
  // "0%" in that case (the `?? 0` below), which reads as "you played terribly"
  // for a round the player was never allowed to play. Absent is the honest
  // presentation: not measured, rather than measured badly.
  const ratingPct = Number.isFinite(rating) ? Math.round(rating * 100) : null;
  ratingWrap.hidden = ratingPct === null;
  if (ratingPct !== null) {
    await animateCountUp(ratingValueEl, 0, ratingPct, 500, { suffix: '%' });
  }

  await delay(250);
  const metersEl = resultPanel.querySelector('#meters');
  metersEl.innerHTML = Object.keys(METER_META).map((id) => meterRowHtml(id)).join('');
  metersEl.hidden = false;
  await Promise.all(Object.keys(METER_META).map((id) => animateMeterFill(metersEl, id, meters[id])));

  await delay(200);
  const personalityEl = resultPanel.querySelector('#personality-badge');
  personalityEl.innerHTML = personalityHtml(personalityId);
  personalityEl.hidden = false;

  await delay(300);
  const storyBlock = resultPanel.querySelector('#story-block');
  renderStoryBlock(storyBlock, result, fragments, shareBtn);
  storyBlock.hidden = false;
  if (shareBtn) shareBtn.hidden = false;

  // Array.isArray, matching the guards progression.js and player-stats.js
  // already apply to this same field: it can be absent on a row written by an
  // older client, and renderAlreadyPlayed() is not inside a try — a TypeError
  // here aborted the whole result panel mid-render, so one old row cost the
  // player their entire result rather than just a toast.
  const unlocked = Array.isArray(newlyUnlocked) ? newlyUnlocked : [];
  if (unlocked.length > 0) {
    await delay(400);
    const achievementsEl = resultPanel.querySelector('#achievements-toast');
    achievementsEl.innerHTML = achievementsHtml(unlocked);
    achievementsEl.hidden = false;
  }

  // LAST, after every other reveal has finished (owner: "right after all the
  // animations are done"). Deliberately below the achievements branch, since
  // those add XP of their own — showing the number before they land would show
  // a figure that does not match what was earned.
  await delay(500);
  await revealXpGain(result);
}

// Pops the run's XP beside the total, flies it into the header nameplate, then
// tells the header to recompute. Awaited by the caller so a redeal cannot start
// mid-flight, but every failure path is swallowed: this is the last decoration
// of a run that is already saved and scored, and it must never be the thing that
// throws.
async function revealXpGain(result) {
  try {
    // XP IS AN ACCOUNT FEATURE. Anonymous play is deliberately allowed (§9.2)
    // but nothing about it is persisted, so an XP number shown to a logged-out
    // player is a promise the game cannot keep — owner: "dont show xp if not
    // logged in". Worse, the animation's flight target is the header nameplate,
    // which for a logged-out visitor is the "Log In" button: the gain literally
    // flew into a control that says the player has no account.
    //
    // The test account counts as signed in on purpose. It holds no Supabase
    // session (state/test-account.js) so the getSession() half is false for it,
    // and skipping the reveal would leave its whole reason for existing —
    // watching the bar move — untestable.
    const signedIn = isTestAccountActive() || Boolean(await getSession().catch(() => null));
    if (!signedIn) return;

    const gained = xpForRun(result);
    if (gained <= 0) return;
    const totalEl = document.querySelector('#result .score-total');
    // The nameplate, not the bar: the bar is absent until lifetime XP loads,
    // and the name is the target the owner asked for.
    const target = document.querySelector('#header-auth-slot .header-user-name') ?? document.querySelector('#header-auth-slot');
    await flyXpGain(totalEl, target, gained);

    // Bank the gain into the fake account first, if one is active — test mode
    // never writes a real result, so without this its synthetic history would
    // regenerate unchanged and the bar would have nothing to move to. A no-op
    // in every other case.
    addTestAccountXp(gained);

    // Only now does the bar move, so the fill visibly responds to the number
    // that just arrived rather than having crept up while it was in flight.
    announceXpUpdate();
    const xpEl = document.querySelector('#header-xp');
    if (xpEl) {
      xpEl.classList.add('header-xp--gained');
      setTimeout(() => xpEl.classList.remove('header-xp--gained'), 800);
    }
  } catch (error) {
    console.warn('XP animation skipped:', error);
  }
}

function meterRowHtml(id) {
  const meta = METER_META[id];
  return `
    <div class="meter">
      <span class="meter-label">${meta.emoji} ${meta.label}</span>
      <div class="meter-track"><div class="meter-fill meter-fill--${id}" id="meter-fill-${id}"></div></div>
      <span class="meter-value" id="meter-value-${id}">0%</span>
    </div>
  `;
}

// The fake-account controls (state/test-account.js). Test-mode panel only, and
// the module itself refuses to activate without `?test` in the URL regardless of
// what this writes.
//
// Every change RELOADS. Identity is read once at startup by header.js, board.js
// and the profile page, so flipping it live would leave half the page believing
// one thing and half another — and a reload is exactly what a tester expects
// from "sign in as".
function wireTestAccountPanel(panel) {
  const toggle = panel.querySelector('#admin-test-account-toggle');
  const xpInput = panel.querySelector('#admin-test-account-xp');
  const note = panel.querySelector('#admin-test-account-note');
  if (!toggle) return;

  const describe = () => {
    if (!isTestAccountActive()) {
      note.textContent = 'Off — playing as whoever is really signed in (or nobody).';
      return;
    }
    const xp = testAccountXp();
    const progress = levelProgress(testAccountActualXp(xp));
    note.textContent = `On — ${TEST_ACCOUNT_USERNAME}, ${progress.totalXp.toLocaleString()} XP (level ${progress.level}, ${Math.round(
      progress.progress * 100,
    )}% to ${progress.level + 1}).`;
  };

  toggle.checked = isTestAccountActive();
  xpInput.value = String(testAccountXp());
  describe();

  const apply = (xp) => {
    if (toggle.checked) enableTestAccount(xp);
    else disableTestAccount();
    window.location.reload();
  };

  toggle.addEventListener('change', () => apply(Number(xpInput.value) || 0));
  panel.querySelector('[data-action="test-account-apply"]').addEventListener('click', () => {
    toggle.checked = true;
    apply(Number(xpInput.value) || 0);
  });
  panel.querySelector('[data-action="test-account-nearly"]').addEventListener('click', () => {
    // Parked just short of the NEXT level, so the very next run crosses it and
    // the level-up flash can actually be seen.
    const current = levelProgress(testAccountActualXp(testAccountXp())).level;
    toggle.checked = true;
    apply(xpJustBelowLevel(current + 1, 50));
  });
}

// Sets the fill width directly (CSS transitions the visual bar) while
// animating the percentage text alongside it.
async function animateMeterFill(container, id, value) {
  const fillEl = container.querySelector(`#meter-fill-${id}`);
  const valueEl = container.querySelector(`#meter-value-${id}`);
  fillEl.style.width = `${value}%`;
  await animateCountUp(valueEl, 0, value, 500, { suffix: '%' });
}

function staticMetersHtml(meters) {
  return Object.entries(METER_META)
    .map(
      ([id, meta]) => `
        <div class="meter">
          <span class="meter-label">${meta.emoji} ${meta.label}</span>
          <div class="meter-track"><div class="meter-fill meter-fill--${id}" style="width:${meters[id]}%"></div></div>
          <span class="meter-value">${meters[id]}%</span>
        </div>
      `,
    )
    .join('');
}

function personalityHtml(personalityId) {
  const personality = PERSONALITIES.find((p) => p.id === personalityId);
  if (!personality) return '';
  return `
    <span class="personality-emoji">${personality.emoji}</span>
    <span class="personality-label">${personality.label}</span>
    <span class="personality-desc">${personality.description}</span>
  `;
}

function achievementsHtml(achievementIds) {
  if (!achievementIds || achievementIds.length === 0) return '';
  const items = achievementIds
    .map((id) => ACHIEVEMENTS.find((a) => a.id === id))
    .filter(Boolean)
    .map(
      (a) =>
        `<li><span class="achievement-emoji">${a.emoji}</span><span class="achievement-text"><strong>${a.label}</strong><br />${a.description}</span></li>`,
    )
    .join('');
  const heading = achievementIds.length > 1 ? 'New Achievements Unlocked!' : 'New Achievement Unlocked!';
  return `<h3>🎉 ${heading}</h3><ul class="achievements-list">${items}</ul>`;
}

async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for non-secure contexts (e.g. plain http:// on a LAN dev server).
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

// The starting option for each of the 6 story slots — deterministic per
// hand (same seed every time that exact hand comes up), never saved across
// days. The player can still freely change any dropdown during the current
// view; those edits just aren't persisted, so a fresh day starts from a
// fresh (effectively random-looking, hand-seeded) selection again rather
// than reusing yesterday's pick.
function resolveStorySelections(originalHand, finalHand, discardIndices, fragments) {
  const selections = getDefaultSelections(originalHand, finalHand, discardIndices, undefined, fragments);
  const options = getStoryOptions(originalHand, finalHand, discardIndices, undefined, fragments);
  return { selections, options };
}

// The FORTUNE starts as a finished, randomly-seeded line (see
// resolveStorySelections) with its 6 slot pickers collapsed behind an "Edit
// Fortune" button — owner request: "give a random starting poem like it always
// has done but instead of having all the options immediately, have an 'edit
// poem' button that then drops down the selections and a submit button
// after." So the default state is just the fortune plus two buttons, and the
// pickers are opt-in rather than six dropdowns greeting every player.
//
// NAMING: the player-facing word is "Fortune" (owner request: "rename to
// fortune instead of poem"). The internal identifiers are still `story*` — that
// is the module boundary this feature has always been built on (src/story/,
// generateStory, STORY_SLOT_ORDER), and renaming a dozen internal symbols to
// chase a label would be a large diff with nothing to show for it. Only what a
// player reads changed.
//
// Copy Result is ALWAYS visible (owner: "i want to always have a copy result
// button on the bottom"), which replaces the earlier arrangement where Submit
// occupied that slot until you'd submitted. Copying and editing are
// independent now: the fortune is complete from the moment it renders, so
// there's never a state where the result can't be copied. Editing collapses
// back to the same default state on Submit, so the button pair stays stable.
function renderStoryBlock(container, result, fragments, shareBtn = null) {
  const { originalHand, finalHand, discardIndices } = result;
  const { selections, options } = resolveStorySelections(originalHand, finalHand, discardIndices, fragments);
  let story = generateStory(result, selections, undefined, fragments);

  // The editor sits ABOVE the button row on purpose, so Copy Result is the
  // last thing in the block in BOTH states — "always have a copy result
  // button on the bottom" stays literally true while the pickers are open,
  // instead of the editor pushing Copy Result up into the middle.
  container.innerHTML = `
    <p class="story-text" id="story-text"></p>
    <div class="story-editor" id="story-editor" hidden>
      <div class="story-builder">
        ${STORY_SLOT_ORDER.map(
          (slot) => `
            <label class="story-slot">
              <span class="story-slot-label">${escapeHtml(SLOT_META[slot].label)}</span>
              <select data-slot="${slot}">
                ${options[slot]
                  .map((option, index) => `<option value="${index}"${index === selections[slot] ? ' selected' : ''}>${escapeHtml(option)}</option>`)
                  .join('')}
              </select>
            </label>
          `,
        ).join('')}
      </div>
      <button type="button" class="copy-btn" id="submit-story-btn">Submit</button>
    </div>
    <div class="story-actions">
      <button type="button" class="story-edit-btn" id="edit-fortune-btn">✏️ Edit Fortune</button>
    </div>
  `;

  const storyTextEl = container.querySelector('#story-text');
  const storyEditorEl = container.querySelector('#story-editor');
  const editBtn = container.querySelector('#edit-fortune-btn');
  const submitBtn = container.querySelector('#submit-story-btn');
  // Sits below "Come back tomorrow" now (owner request), so it is no longer a
  // child of the story block and has to be handed in. It still has to be wired
  // HERE: `story` is rebuilt on every dropdown change, and the share text must
  // be whichever fortune is on screen at click time.
  const copyBtn = shareBtn;

  // textContent, not interpolated into the innerHTML above. This comment used to
  // say the fragments were "repo-authored so nothing here is untrusted" — that
  // stopped being true when §11g made the word bank admin-editable through
  // `game_config`, and the stale reassurance is part of why the unescaped
  // `<option>` above went unnoticed for so long. textContent is now doing real
  // security work, not just consistency: it is immune to markup by construction.
  // It also remains the same element the change handler below writes to, so one
  // mechanism for both keeps them from drifting.
  storyTextEl.textContent = story.text;

  container.querySelectorAll('select[data-slot]').forEach((select) => {
    select.addEventListener('change', () => {
      const slot = select.dataset.slot;
      const index = Number(select.value);
      selections[slot] = index;
      story = generateStory(result, selections, undefined, fragments);
      storyTextEl.textContent = story.text;
    });
  });

  editBtn.addEventListener('click', () => {
    storyEditorEl.hidden = false;
    editBtn.hidden = true;
  });

  // Submit only closes the editor — the fortune itself is already applied live
  // on every dropdown change, so there's nothing to commit here. It exists to
  // get the six pickers back out of the way.
  submitBtn.addEventListener('click', () => {
    storyEditorEl.hidden = true;
    editBtn.hidden = false;
  });

  if (copyBtn) {
    // BOUND EXACTLY ONCE, with the text kept in a module-scope ref that this
    // call updates.
    //
    // #result-copy-btn lives OUTSIDE #result (it shares the hint row under the
    // cards), so unlike everything else in the panel it is never rebuilt —
    // `resultPanel.innerHTML = ''` does not touch it. Every renderStoryBlock()
    // call therefore stacked another listener, each closing over its own
    // `story`. Harmless in normal play, where this runs once per page load; in
    // test mode each admin redeal added one, so a single click fired N
    // clipboard writes (last to resolve wins, so the clipboard could end up
    // holding a PREVIOUS hand's text) and a later handler captured `original`
    // as "✅ Copied!" and restored that as the permanent label.
    //
    // Deliberately NOT solved by cloning the node to drop its listeners: callers
    // hold this element in `initBoard`'s closure and set `.hidden` on it AFTER
    // this function returns, so replacing it would leave them writing to a
    // detached node and the button would never appear at all.
    currentShareText = story.shareText;
    if (!copyBtn.dataset.copyBound) {
      copyBtn.dataset.copyBound = '1';
      // Captured at BIND time, so a second click landing inside the 1.5s window
      // cannot immortalise "✅ Copied!" as the label.
      const idleLabel = copyBtn.textContent;
      copyBtn.addEventListener('click', async () => {
        await copyToClipboard(currentShareText);
        copyBtn.textContent = '✅ Copied!';
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
          copyBtn.textContent = idleLabel;
        }, 1500);
      });
    }
  }
}

// Shared between the animated reveal and the static "already played" view.
// Each badge carries everything the RNGDLE-style breakdown card needs
// (owner request, "like the attached picture"): a category `tag`, a plain-
// English `description` of why it fired, and `highlightIndices` — which of
// the 5 final-hand card positions are the actual proof — on top of the
// existing label/value.
function buildScoreBadges(score, finalHand, discardIndices = []) {
  const badges = [];

  badges.push({
    key: 'hand',
    tag: 'HAND',
    emoji: null,
    label: score.handResult.label,
    value: score.baseScore,
    description: HAND_DESCRIPTIONS[score.handResult.id] ?? '',
    highlightIndices: score.handContributingIndices,
  });

  if (score.flavor.total > 0) {
    badges.push({
      key: 'flavor',
      tag: 'FLAVOR',
      emoji: '✨',
      label: 'Flavor Bonus',
      value: score.flavor.total,
      description: 'Points for Aces and Face cards in your hand.',
      highlightIndices: [...score.flavor.aceIndices, ...score.flavor.faceIndices],
    });
  }

  if (score.suitSynergy.total > 0) {
    const glyph = suitGlyph(score.suitSynergy.suit);
    badges.push({
      key: 'suitSynergy',
      tag: 'SUIT',
      emoji: glyph,
      label: 'Suit Synergy',
      value: score.suitSynergy.total,
      description: `${score.suitSynergy.count} cards share the ${glyph} suit.`,
      highlightIndices: score.suitSynergy.indices,
    });
  }

  badges.push({
    key: 'cardValue',
    tag: 'CARD VALUE',
    emoji: '🎴',
    label: 'Card Value',
    value: score.cardValue.total,
    description: 'Every card in your hand contributes its rank — always.',
    highlightIndices: [0, 1, 2, 3, 4],
  });

  for (const [key, value] of Object.entries(score.skillBonuses)) {
    if (value <= 0) continue;
    const meta = SKILL_META[key];
    const highlightIndices =
      key === 'perfectKeep' || key === 'cleanFinish'
        ? [0, 1, 2, 3, 4]
        : key === 'optimalDiscard'
          ? [0, 1, 2, 3, 4].filter((i) => !discardIndices.includes(i))
          : [];
    badges.push({ key, tag: 'SKILL', emoji: meta.emoji, label: meta.label, value, description: meta.description, highlightIndices });
  }

  for (const bonus of score.extraBonuses) {
    badges.push({
      key: `extra-${bonus.id}`,
      tag: 'BONUS',
      emoji: bonus.emoji,
      label: bonus.label,
      value: bonus.points,
      description: bonus.description,
      highlightIndices: bonus.highlightIndices,
    });
  }

  for (const item of score.rarity.items) {
    const label =
      item.rarity === 'joker'
        ? item.label // already "<Flavor> Wild", e.g. "Gold Wild" — see rarityBonus()
        : `${item.label} ${rankLabel(item.card.rank)}${suitGlyph(item.card.suit)}`;
    const tierForTag = item.rarity === 'joker' ? (item.jokerTier ?? 'bronze') : item.rarity;
    badges.push({
      key: `rarity-${item.index}`,
      tag: tierForTag.toUpperCase(),
      emoji: item.emoji,
      label,
      value: item.points,
      description:
        item.rarity === 'joker'
          ? 'A wild card — completes the best possible hand, whatever that takes.'
          : 'A rare card, worth extra points just for showing up.',
      highlightIndices: [item.index],
    });
  }

  for (const item of score.discardedRarity.items) {
    const label =
      item.rarity === 'joker'
        ? item.label // already "<Flavor> Wild", e.g. "Gold Wild" — see discardedRarityBonus()
        : `${item.label} ${rankLabel(item.card.rank)}${suitGlyph(item.card.suit)}`;
    const tierForTag = item.rarity === 'joker' ? (item.jokerTier ?? 'bronze') : item.rarity;
    badges.push({
      key: `discard-rarity-${item.index}`,
      tag: tierForTag.toUpperCase(),
      emoji: '🗑️',
      label: `Discarded ${label}`,
      value: item.points,
      description: 'A bold discard — half credit for letting a rare card go.',
      highlightIndices: [], // discarded cards never appear in the final hand's proof strip
    });
  }

  if (score.handSynergyBonus > 0) {
    // Which rare cards get highlighted depends on which tier of the
    // multiplier fired (scoring.js's scoreRun — DESIGN.md §3n/§3o): if any
    // rare card is genuinely part of the winning combo, highlight just
    // those; otherwise (2+ rare cards, none in combo, but still stacking)
    // highlight all of them, since none is more "responsible" than another.
    const rareIndices = score.rarity.items.map((item) => item.index);
    const comboIndexSet = new Set([...score.handContributingIndices, ...score.runIndices]);
    const inCombo = rareIndices.filter((i) => comboIndexSet.has(i));
    badges.push({
      key: 'synergy',
      tag: 'SYNERGY',
      emoji: '✨',
      label: `×${score.multiplier} Hand-Rarity Synergy`,
      value: score.handSynergyBonus,
      description:
        inCombo.length > 0
          ? 'A rare card is part of the winning combination — the multiplier applies to the WHOLE score.'
          : 'More than one rare card landed in this hand — their bonus stacks, even unused.',
      highlightIndices: inCombo.length > 0 ? inCombo : rareIndices,
    });
  }

  if (score.pity > 0) {
    badges.push({
      key: 'pity',
      tag: 'PITY',
      emoji: '🎗️',
      label: 'Pity Points',
      value: score.pity,
      description: 'A small consolation bonus for a low-scoring run.',
      highlightIndices: [],
    });
  }

  // `!== 0`, not `> 0` — Double or Nothing (§4e) can drive this NEGATIVE
  // (×0 wipes the whole additive total). Every other modifier only ever
  // multiplies UP, so this was `> 0` until that modifier exposed the gap:
  // a hidden negative badge would silently understate `score.total` in the
  // UI, since the running count-up total below is an accumulation of
  // exactly the badges shown, not a re-read of `score.total` itself.
  if (score.modifierBonusAmount !== 0) {
    const busted = score.modifierBonusAmount < 0;
    badges.push({
      key: 'modifier',
      tag: 'MODIFIER',
      emoji: busted ? '💥' : '🧭',
      label: busted ? 'Busted — Nothing' : `×${score.modifierMultiplier} Modifier Multiplier`,
      value: score.modifierBonusAmount,
      description: busted
        ? "Today's modifier wiped your total — the gamble didn't pay off."
        : "Today's modifier multiplied your total.",
      highlightIndices: [],
    });
  }

  // Ascending — smallest first. This is the REVEAL order (owner request:
  // builds suspense toward the biggest number last); the biggest number
  // still ends up visually at the TOP of the list, because revealScore()
  // inserts each new badge above the previous ones rather than below (owner
  // follow-up request) — see insertLineAtTop(). Callers that render without
  // that insertion sequence (the static "already played" path) need to
  // reverse this array themselves to match the same final visual order.
  return badges.sort((a, b) => a.value - b.value);
}

function tagClassName(tag) {
  return `score-badge-tag--${tag.toLowerCase().replace(/\s+/g, '-')}`;
}

// The small "proof" row of all 5 final-hand cards, with the ones that
// actually justify the badge highlighted — the visual half of "like the
// attached picture" (owner request). Omitted entirely when a badge has no
// specific cards to point to (e.g. Pity Points).
//
// `logicalHand` (score.logicalFinalHand, scoring.js) is what actually gets
// rendered — a Joker's slot shows whatever rank/suit it wild-substituted to,
// not its own meaningless dealt card — with a 🃏 marker (from `rawHand`,
// which still has the real `rarity` field) so it doesn't read as an
// ordinary duplicate of that rank/suit.
function miniCardStripHtml(logicalHand, rawHand, highlightIndices) {
  if (!highlightIndices || highlightIndices.length === 0) return '';
  const highlightSet = new Set(highlightIndices);
  const chips = logicalHand
    .map((card, i) => {
      const color = card.suit === 'H' || card.suit === 'D' ? 'mini-card--red' : 'mini-card--black';
      const highlighted = highlightSet.has(i) ? ' mini-card--highlight' : '';
      // isWild(), not `rarity === 'joker'` — that is the LEGACY shape only, so
      // a modern wild (`wild: true`) silently lost its 🃏 marker here while
      // every other renderer showed one. The local name also shadowed the
      // imported isWild, which is what let the mismatch hide in plain sight.
      const wildClass = isWild(rawHand[i]) ? ' mini-card--wild' : '';
      return `<span class="mini-card ${color}${highlighted}${wildClass}">${rankLabel(card.rank)}${suitGlyph(card.suit)}</span>`;
    })
    .join('');
  return `<div class="mini-card-strip">${chips}</div>`;
}

function badgeCardHtml(badge, logicalHand, rawHand, displayValue) {
  // Almost every badge is non-negative, but Double or Nothing's "Busted"
  // badge (§4e) isn't — it's the one score component that can subtract from
  // the running total instead of adding to it, so the sign has to follow
  // `displayValue` rather than always being "+".
  const sign = displayValue < 0 ? '-' : '+';
  return `
    <div class="score-badge-header">
      ${badge.emoji ? `<span class="score-badge-icon">${badge.emoji}</span>` : ''}
      <span class="score-badge-label">${escapeHtml(badge.label)}</span>
      <span class="score-badge-tag ${escapeHtml(tagClassName(badge.tag))}">${escapeHtml(badge.tag)}</span>
      <span class="score-badge-value">${sign}${Math.abs(displayValue).toLocaleString()}</span>
    </div>
    ${badge.description ? `<p class="score-badge-desc">${escapeHtml(badge.description)}</p>` : ''}
    ${miniCardStripHtml(logicalHand, rawHand, badge.highlightIndices)}
  `;
}

// Non-animated version for the "already played today" reload path — the
// suspense only matters the first time. Story block is left empty here;
// renderStoryBlock() fills it in afterward (same helper the animated path
// uses), so voice switching works identically on both paths.
function staticResultHtml(result) {
  const { score, decisionRating: rating, meters, personalityId, newlyUnlocked } = result;
  const ratingPct = Number.isFinite(rating) ? `${Math.round(rating * 100)}%` : '—';
  // buildScoreBadges() returns ascending (reveal order); reversed here since
  // there's no insertion sequence to produce the biggest-on-top layout the
  // animated path ends up with — see that function's comment.
  const badges = [...buildScoreBadges(score, result.finalHand, result.discardIndices)].reverse();

  return `
    <h2 class="hand-label">${escapeHtml(score.handResult.label)}</h2>
    <div class="score-total">${score.total.toLocaleString()}</div>
    ${(() => {
      const grade = gradeForScore(score.total);
      return `<div class="score-grade score-grade--${grade.id}"><span class="score-grade-emoji">${grade.emoji}</span><span class="score-grade-label">${grade.label}</span></div>`;
    })()}
    <ul class="score-breakdown">
      ${badges.map((badge) => `<li class="score-badge">${badgeCardHtml(badge, score.logicalFinalHand, result.finalHand, badge.value)}</li>`).join('')}
    </ul>
    <p class="decision-rating">Decision Rating: <strong>${ratingPct}</strong></p>
    <div class="meters">${staticMetersHtml(meters)}</div>
    <div class="personality-badge">${personalityHtml(personalityId)}</div>
    <div class="story-block" id="story-block"></div>
    ${Array.isArray(newlyUnlocked) && newlyUnlocked.length > 0 ? `<div class="achievements-toast">${achievementsHtml(newlyUnlocked)}</div>` : ''}
  `;
}
