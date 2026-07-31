import { createCardElement } from './card-view.js';

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Animates a number counting up (or down) inside an element's text content.
 * Ease-out cubic so it settles rather than stopping abruptly.
 */
export function animateCountUp(el, from, to, duration, { prefix = '', suffix = '' } = {}) {
  return new Promise((resolve) => {
    // Hand-rank scores can now reach into the tens of millions (odds-
    // proportional HAND_RANKS, hand-evaluator.js), so every rendered value
    // gets thousands-separators rather than a long unbroken digit string —
    // toLocaleString() is a no-op for small numbers (no suffix param, this
    // stays an exact count, not an abbreviation like "54.8M").
    if (from === to || !Number.isFinite(to)) {
      el.textContent = `${prefix}${Number.isFinite(to) ? to.toLocaleString() : '—'}${suffix}`;
      resolve();
      return;
    }
    const start = performance.now();
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(from + (to - from) * eased);
      el.textContent = `${prefix}${value.toLocaleString()}${suffix}`;
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });
}

// Spawns a small glowing spark from each of `fromEls`'s current on-screen
// position, converging on `toEl` (owner request: "cool animations on the
// actual cards showing the points come off the cards that gave the points
// and add into the total"). Purely visual glue between a card and the score
// — no text on the spark itself, since the badge's own count-up and the
// running total already show the actual numbers; showing a full "+N" on
// every contributing card would misleadingly imply each card independently
// earned the whole amount (e.g. all 5 cards in a Flush). Resolves once every
// spark has landed, so callers can time the total's count-up to start right
// as the sparks arrive. No-op (resolves immediately) if there's nothing to
// fly from — badges with no specific card attribution (Pity Points,
// Modifier Multiplier) just skip this and keep their plain count-up.
export function flySparks(fromEls, toEl, { duration = 550, stagger = 70 } = {}) {
  const origins = fromEls.filter(Boolean);
  if (origins.length === 0 || !toEl) return Promise.resolve();

  const toRect = toEl.getBoundingClientRect();
  const endX = toRect.left + toRect.width / 2;
  const endY = toRect.top + toRect.height / 2;

  const flights = origins.map(
    (fromEl, i) =>
      new Promise((resolve) => {
        const fromRect = fromEl.getBoundingClientRect();
        const startX = fromRect.left + fromRect.width / 2;
        const startY = fromRect.top + fromRect.height / 2;

        const spark = document.createElement('div');
        spark.className = 'score-spark';
        spark.style.left = `${startX}px`;
        spark.style.top = `${startY}px`;
        spark.style.setProperty('--dx', `${endX - startX}px`);
        spark.style.setProperty('--dy', `${endY - startY}px`);
        spark.style.setProperty('--spark-duration', `${duration}ms`);
        spark.style.animationDelay = `${i * stagger}ms`;
        document.body.appendChild(spark);

        spark.addEventListener(
          'animationend',
          () => {
            spark.remove();
            resolve();
          },
          { once: true },
        );
      }),
  );

  return Promise.all(flights);
}

// Low-level single flip-swap: rotates `el` out, swaps in whatever
// `buildNewEl()` returns, rotates it in. Shared by both stages of
// flipReplaceCard below so "turn to the back" and "turn to the front" are
// literally the same motion, just with different content.
function flipSwap(el, buildNewEl, duration) {
  return new Promise((resolve) => {
    el.style.setProperty('--flip-duration', `${duration}ms`);
    el.classList.add('card--flip-out');
    setTimeout(() => {
      const newEl = buildNewEl();
      newEl.style.setProperty('--flip-duration', `${duration}ms`);
      newEl.classList.add('card--flip-in');
      el.replaceWith(newEl);
      // Force a layout pass so the browser registers the starting transform
      // before we remove it — otherwise the flip-in transition never plays.
      void newEl.offsetWidth;
      newEl.classList.remove('card--flip-in');
      setTimeout(() => resolve(newEl), duration);
    }, duration);
  });
}

/**
 * Pops a green "+N XP" beside `fromEl`, holds it, then flies it into `toEl`
 * (owner request: XP should "pop up like green next to the total points right
 * after all the animations are done and flow into the name on the top right").
 *
 * Deliberately NOT reusing flySparks: that fires a burst of anonymous dots to
 * show WHERE points came from, while this is one legible number the player is
 * meant to read before it moves. Same underlying idea — a fixed-position element
 * animated between two live `getBoundingClientRect()`s, so it lands correctly
 * regardless of scroll position or layout.
 *
 * Resolves once the pill has landed, so the caller can flash the target as it
 * arrives. A missing target resolves immediately rather than throwing: the XP
 * bar is absent for a signed-out player, and a missing decoration must never
 * break the end of a run.
 *
 * @param {HTMLElement} fromEl - what it pops out beside (the score total)
 * @param {HTMLElement|null} toEl - what it flies into (the header nameplate)
 * @param {number} amount - XP earned
 * @param {{popMs?: number, holdMs?: number, flyMs?: number}} [timing]
 * @returns {Promise<void>}
 */
/**
 * The rectangle a block element's TEXT actually occupies, rather than the box
 * the element reserves. For centred text in a full-width block the two differ by
 * the whole panel width, which is the difference between "beside the number" and
 * "off at the edge of the card".
 *
 * Falls back to the element box when the element has no text to measure.
 */
function textInkRect(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  } catch {
    // Range can throw on a detached node; the element box is a fine fallback.
  }
  return el.getBoundingClientRect();
}

export function flyXpGain(fromEl, toEl, amount, { popMs = 380, holdMs = 620, flyMs = 1000 } = {}) {
  if (!fromEl || !Number.isFinite(amount) || amount <= 0) return Promise.resolve();

  const pill = document.createElement('div');
  pill.className = 'xp-gain';
  pill.textContent = `+${Math.round(amount).toLocaleString()} XP`;
  // aria-hidden: the same number is already announced in the result panel, and a
  // decoration that flies across the screen should not be read out twice.
  pill.setAttribute('aria-hidden', 'true');
  document.body.appendChild(pill);

  // The INK, not the element box. `.score-total` is a block, so its box spans
  // the whole result panel and "just right of it" would put the pill out at the
  // panel edge, nowhere near the centred digits the player is looking at. A
  // Range over the text contents measures the digits themselves.
  const from = textInkRect(fromEl);
  // `.xp-gain` is translated by -50% in both axes so the flight offsets can be
  // computed between box CENTRES — which means `left` here is the pill's centre,
  // not its left edge, and half its width has to be added to clear the digits.
  const pillWidth = pill.getBoundingClientRect().width;
  const gap = 12;
  const wanted = from.right + gap + pillWidth / 2;
  // Clamped so a wide number on a narrow screen cannot push it off-screen.
  const maxCentre = window.innerWidth - pillWidth / 2 - 8;
  pill.style.left = `${Math.min(wanted, maxCentre)}px`;
  pill.style.top = `${from.top + from.height / 2}px`;

  return new Promise((resolve) => {
    const finish = () => {
      pill.remove();
      resolve();
    };

    pill.classList.add('xp-gain--pop');
    setTimeout(() => {
      if (!toEl) {
        // Nowhere to fly to (signed out, or the bar has not loaded): fade the
        // pill where it is rather than sending it to the top-left corner, which
        // is where an un-measured target would put it.
        pill.classList.add('xp-gain--fade');
        setTimeout(finish, 300);
        return;
      }
      // Measured NOW, not before the hold: the header is sticky and the page may
      // have been scrolled while the pill was on screen.
      const to = toEl.getBoundingClientRect();
      const pillRect = pill.getBoundingClientRect();
      pill.style.setProperty('--fly-x', `${to.left + to.width / 2 - (pillRect.left + pillRect.width / 2)}px`);
      pill.style.setProperty('--fly-y', `${to.top + to.height / 2 - (pillRect.top + pillRect.height / 2)}px`);
      pill.style.setProperty('--fly-duration', `${flyMs}ms`);
      pill.classList.add('xp-gain--fly');
      setTimeout(finish, flyMs);
    }, popMs + holdMs);
  });
}

/**
 * Just the FIRST half of flipReplaceCard: turns a face-up card over to its
 * face-down back and stops there. Split out so board.js can run the whole
 * discard batch's turn-over as one pass and only then start revealing (owner
 * request: "turns over all the discarded cards first from left to right, then
 * reveals from left to right"). flipReplaceCard picks up exactly where this
 * leaves off — it skips its own turn-to-back when the element it's handed is
 * already showing one — so the two still compose into the identical animation,
 * rather than this being a second, divergent copy of the motion.
 *
 * `card` is the incoming REPLACEMENT, not the card being discarded: the back
 * is a back, it shows nothing about the card, and passing it here means the
 * element already carries the right data when the reveal flips it face-up.
 *
 * A no-op returning `oldEl` unchanged if it is already face-down.
 *
 * @param {HTMLElement} oldEl
 * @param {Card} card - the replacement that will later be revealed here
 * @param {number} [duration] - flip duration in ms (default 180)
 * @returns {Promise<HTMLElement>} the face-down element
 */
export async function flipCardToBack(oldEl, card, { duration = 180 } = {}) {
  if (oldEl.classList.contains('card--face-down')) return oldEl;
  return flipSwap(
    oldEl,
    () => {
      const el = createCardElement(card, { faceUp: false });
      el.disabled = true;
      return el;
    },
    duration,
  );
}

/**
 * Reveals `card` in place of `oldEl`, using the same two-stage rhythm
 * everywhere in the app — turn to the actual face-down back (skipped if
 * `oldEl` is already showing its back), hold there for a beat, then turn to
 * the face-up card. This one function drives both the initial deal (cards
 * start already face-down) and a discard's replacement draw (cards start
 * face-up and have to turn over first) — they're not just similar
 * animations, they're the same animation (owner request).
 *
 * @param {HTMLElement} oldEl - the currently-displayed card element
 * @param {Card} card - the card to reveal
 * @param {number} [duration] - the REVEAL flip's duration in ms (default 180)
 * @param {number} [backDuration] - the turn-to-back flip's duration; defaults to
 *   `duration`, but a rarity-paced reveal should pass the common duration here.
 *   The turn-to-back happens while the OLD card is still on screen and says
 *   nothing about what is coming, so slowing it down puts the drama in the wrong
 *   place — see the note in board.js's revealDrawnCards.
 * @param {number} [anticipationMs] - extra pause once the card is face-down,
 *   before the reveal begins. Separate from `holdMs` only so callers can express
 *   "anticipation" and "hold" independently; both happen on the back.
 * @param {number} [holdMs] - how long to sit on the face-down back before revealing (default 250)
 * @param {string|null} [dramaticClass] - CSS class added once the final face-up card lands (see styles.css `.card--reveal-rare`)
 * @param {boolean} [disabled] - whether the resulting face-up element should be disabled (default true)
 * @returns {Promise<HTMLElement>} the new face-up element, so the caller can update its own references
 */
export async function flipReplaceCard(
  oldEl,
  card,
  { duration = 180, backDuration = null, anticipationMs = 0, holdMs = 250, dramaticClass = null, disabled = true } = {},
) {
  let backEl = oldEl;
  if (!oldEl.classList.contains('card--face-down')) {
    backEl = await flipSwap(
      oldEl,
      () => {
        const el = createCardElement(card, { faceUp: false });
        el.disabled = true;
        return el;
      },
      backDuration ?? duration,
    );
  }

  // Both pauses land here, on the face-down back — never on the outgoing card.
  if (anticipationMs > 0) await delay(anticipationMs);
  await delay(holdMs);

  const frontEl = await flipSwap(
    backEl,
    () => {
      const el = createCardElement(card, { faceUp: true });
      el.disabled = disabled;
      return el;
    },
    duration,
  );

  if (dramaticClass) frontEl.classList.add(dramaticClass);
  return frontEl;
}
