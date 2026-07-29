// Flavor vocabulary for the poker story generator (DESIGN.md §6). Kept
// separate from templates so the same words can be reused across the
// generator and, later, theme-specific vocabulary injection.

export const RANK_VOCAB = {
  14: { name: 'ace', plural: 'aces', flavor: 'legends' },
  13: { name: 'king', plural: 'kings', flavor: 'royalty' },
  12: { name: 'queen', plural: 'queens', flavor: 'nobility' },
  11: { name: 'jack', plural: 'jacks', flavor: 'the knaves' },
  10: { name: 'ten', plural: 'tens', flavor: 'the perfect ten' },
  9: { name: 'nine', plural: 'nines', flavor: 'the niner' },
  8: { name: 'eight', plural: 'eights', flavor: 'the eight' },
  7: { name: 'seven', plural: 'sevens', flavor: 'lucky seven' },
  6: { name: 'six', plural: 'sixes', flavor: 'the sixer' },
  5: { name: 'five', plural: 'fives', flavor: 'the nickel' },
  4: { name: 'four', plural: 'fours', flavor: 'the square' },
  3: { name: 'three', plural: 'threes', flavor: 'the trey' },
  2: { name: 'two', plural: 'twos', flavor: 'the deuce' },
};

export const SUIT_VOCAB = {
  S: 'shadow',
  H: 'passion',
  D: 'fortune',
  C: 'iron',
};

const COUNT_WORD = { 2: 'Two', 3: 'Three', 4: 'Four' };

export function countWord(count) {
  return COUNT_WORD[count] ?? String(count);
}
