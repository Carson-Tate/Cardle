import { rankLabel, suitGlyph } from '../core/deck.js';
import { RARITY_BY_ID } from '../core/rarity.js';

const RED_SUITS = new Set(['H', 'D']);

/**
 * Builds a minimalist card element — flat color, thin border, no
 * gloss/gradient (DESIGN.md §10). Face-down cards show only the themed back.
 * A card with a rarity tier (src/core/rarity.js) gets a matching border/glow
 * class; a Joker-rarity card shows a jester face instead of its underlying
 * rank/suit — what it "counts as" is an internal wild-substitution detail
 * (hand-evaluator.js), not something the player needs to see.
 *
 * Rarity styling is only ever applied when faceUp — a face-down card must
 * look identical regardless of what it's hiding, or its back would spoil
 * the reveal before the flip even starts (owner-reported bug).
 */
export function createCardElement(card, { faceUp = true, selected = false, locked = false, marked = false, onClick } = {}) {
  const el = document.createElement('button');
  el.type = 'button';
  const jokerFlavor = card.rarity === 'joker' ? (RARITY_BY_ID[card.jokerTier] ?? RARITY_BY_ID.bronze) : null;
  const rarityClass = faceUp && card.rarity ? ` card--rarity-${card.rarity}` : '';
  const jokerTierClass = faceUp && jokerFlavor ? ` card--joker-tier-${jokerFlavor.id}` : '';
  // Locked Card (Daily Modifiers, DESIGN.md §4) — this slot can't be
  // discarded today, so it's never clickable regardless of `onClick`, and
  // gets its own visual marker (a 🔒 badge) distinct from the rarity badge.
  const lockedClass = faceUp && locked ? ' card--locked' : '';
  // Held Card (§4f) — the OPPOSITE of locked despite looking similar: this slot
  // is still fully discardable and still clickable. The badge is an offer (keep
  // me and the whole score multiplies), not a restriction, so it deliberately
  // does not disable the button the way `locked` does.
  const markedClass = faceUp && marked ? ' card--marked' : '';
  el.className =
    'card' +
    (faceUp ? ' card--face-up' : ' card--face-down') +
    (selected ? ' card--selected' : '') +
    rarityClass +
    jokerTierClass +
    lockedClass +
    markedClass;

  if (faceUp) {
    if (card.rarity === 'joker') {
      el.innerHTML = `
        <span class="card__joker-face">🃏</span>
        <span class="card__joker-label">${jokerFlavor.label.toUpperCase()} WILD</span>
        ${locked ? '<span class="card__lock-badge">🔒</span>' : ''}
        ${marked ? '<span class="card__held-badge">⭐</span>' : ''}
      `;
      el.setAttribute(
        'aria-label',
        `${jokerFlavor.label} Wild${locked ? ', locked in, cannot be discarded' : selected ? ', marked for discard' : ''}${
          marked ? ', starred - keep it to multiply your score' : ''
        }`,
      );
    } else {
      const color = RED_SUITS.has(card.suit) ? 'card--red' : 'card--black';
      el.classList.add(color);
      const badge = card.rarity ? `<span class="card__rarity-badge">${RARITY_BY_ID[card.rarity].emoji}</span>` : '';
      const lockBadge = locked ? '<span class="card__lock-badge">🔒</span>' : '';
      const heldBadge = marked ? '<span class="card__held-badge">⭐</span>' : '';
      el.innerHTML = `
        <span class="card__corner card__corner--top">${rankLabel(card.rank)}${suitGlyph(card.suit)}</span>
        <span class="card__center">${suitGlyph(card.suit)}</span>
        <span class="card__corner card__corner--bottom">${rankLabel(card.rank)}${suitGlyph(card.suit)}</span>
        ${badge}
        ${lockBadge}
        ${heldBadge}
      `;
      const rarityLabel = card.rarity ? `, ${RARITY_BY_ID[card.rarity].label} rarity` : '';
      const stateLabel = locked ? ', locked in, cannot be discarded' : selected ? ', marked for discard' : '';
      const heldLabel = marked ? ', starred - keep it to multiply your score' : '';
      el.setAttribute('aria-label', `${rankLabel(card.rank)} of ${suitName(card.suit)}${rarityLabel}${stateLabel}${heldLabel}`);
    }
  } else {
    el.innerHTML = '<span class="card__back-pattern"></span>';
    el.setAttribute('aria-label', 'Face-down card');
  }

  if (onClick && !locked) {
    el.addEventListener('click', onClick);
  }
  if (locked) {
    el.disabled = true;
  }

  return el;
}

function suitName(suit) {
  return { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' }[suit];
}
