// Fragment library for the post-game Caption Builder (DESIGN.md §6,
// reworked a second time per owner request — "i dont want it to be a story
// like it was, i want it to be a short phrase," citing a "Caption Builder"
// example: one flowing sentence built from 6 slots, not 3 unrelated lines.
// Six independent flat pools, one word/phrase per slot, joined with single
// spaces into one lowercase sentence: `${opening} ${action} ${object}
// ${connector} ${ending} ${emoji}` — see generator.js. Grammatically loose
// Mad-Libs rules (Opening reads as a subject, Action as a past-tense verb,
// Object as its direct object, Connector as a linking word, Ending as a
// closing clause, Emoji as a trailing punctuation/emoji flourish) so random
// combinations mostly parse as a sentence even though nothing is actually
// tied together — e.g. "today i trusted the river like it owed me money 💀".
//
// Only `ending` reacts to the actual hand (owner: "loosely tied" — Two Pair
// or better counts as a win). Every other slot is fully random regardless
// of what happened this run.
//
// To add a new phrase: append it to the relevant array. Nothing else needs
// to change — the picker UI and the completeness/cap tests both just read
// whatever's here.

export const FRAGMENTS = {
  opening: [
    'today i',
    'the deck',
    'dealer',
    'i',
    'the river',
    'grandma',
    'probability',
    'the flop',
    'my brain',
    'destiny',
    'the universe',
    'my wallet',
    'the table',
    'karma',
    'the shuffle',
    'a stranger',
    'the house',
    'my last two brain cells',
    'the algorithm',
    'fate',
    'the felt',
    'my subconscious',
    'the pot',
    'lady luck',
    'the void',
    'everyone at the table',
  ],

  action: [
    'trusted',
    'called',
    'discarded',
    'chased',
    'manifested',
    'folded',
    'blamed',
    'gaslit',
    'whispered to',
    'stared at',
    'denied',
    'collected',
    'inhaled',
    'summoned',
    'speedran',
    'bluffed',
    'outran',
    'abandoned',
    'worshipped',
    'interrogated',
    'seduced',
    'betrayed',
    'adopted',
    'forgave',
    'underestimated',
    'romanticized',
  ],

  object: [
    'the river',
    'my bluff',
    'three kings',
    'destiny',
    'my last brain cell',
    'a miracle',
    'pure luck',
    'my paycheck',
    "grandma's advice",
    'the dealer',
    'probability',
    'tomorrow',
    'bad decisions',
    'the flop',
    'my rent money',
    'a single deuce',
    'the shuffle',
    'a pair of twos',
    'the pot',
    'my dignity',
    'a false sense of security',
    'the odds',
    'an empty seat',
    'my own hype',
    "a bluff that wasn't",
    'the last card in the deck',
    'my whole',
  ],

  connector: ['like', 'and', 'for', 'because', 'until', 'so', 'before', 'after', 'as if', 'then', 'unless', 'since', 'though', 'while'],

  // The one slot that reacts to the actual hand (owner: "loosely tied" —
  // Two Pair or better counts as a win here, see generator.js's
  // outcomeKeyFor). Everything else above ignores the hand entirely.
  ending: {
    // Bare clauses, deliberately with no leading conjunction of their own —
    // `connector` is the only linking word in the sentence, so an entry
    // here starting with "and" would collide with a non-"and" connector
    // ("unless and here we are"). Every entry needs to read reasonably
    // after ANY connector: "like/and/for/because/until/so/before/after/as
    // if/then/unless/since/though/while" + this.
    good: [
      'it paid off',
      'worth every penny',
      'no regrets',
      'exactly as planned',
      "i'd do it again",
      'i won anyway',
      'it was destiny',
      'that was skill',
      'i never looked back',
      'it somehow worked',
      'the odds got beaten',
      'i got away with it',
      'i felt unstoppable',
      'it finally worked',
    ],
    bad: [
      'i immediately regretted it',
      'he was right',
      'a dream',
      'i lost it all',
      'nobody warned me',
      'here we are',
      'the last time',
      'i paid the price',
      'like a fool',
      "it wasn't",
      'so did my savings',
      'i cried a little',
      'there was no turning back',
      'i learned nothing',
    ],
  },

  emoji: [
    '💀',
    '🙏',
    '😭',
    ':)',
    ':(',
    '...',
    '?!',
    '🃏',
    'no cap',
    "and that's on probability",
    'case closed',
    "the math didn't math",
    'big if true',
    'certified fish behavior',
    'no further questions',
    'we ball',
    'respectfully',
    'bro really',
    'internally screaming',
    'huge if true',
    '😐',
    '🎲',
  ],
};

// Friendly labels for the 6 picker slots in the UI, in display order.
export const SLOT_META = {
  opening: { label: 'Opening' },
  action: { label: 'Action' },
  object: { label: 'Object' },
  connector: { label: 'Connector' },
  ending: { label: 'Ending' },
  emoji: { label: 'Emoji' },
};
