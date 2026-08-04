// The "?" beside Decision Rating (owner request: "have a ? icon next to it
// explaining why it scores what it scores").
//
// The point of this panel is the SECOND line under each heading, not the
// first. A definition alone ("Luck is how kind the deck was") does not answer
// the question a player actually has, which is why THIS run got THIS number —
// and until the Skill/Luck rework these dials genuinely could not answer that,
// because Skill was measuring the draw and would have had to say so. Every
// figure below is the real input the meter was computed from, not a
// re-description of the output.

import { openModal } from './modal.js';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const pct = (value) => `${Math.round(value)}%`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Ranks read better than raw expected values, which are in the tens of
// thousands and mean nothing to anyone who has not read hand-evaluator.js.
function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function skillSection(explain) {
  const { skill, choiceRank, choiceCount, discardedCount } = explain;
  if (!Number.isFinite(skill)) {
    return `<p>Every option open to you was worth exactly the same, so there was no decision to
      grade — which is what a Double or Nothing day is, since the wager locks in without a discard.
      Showing 0% would blame you for a choice you were never offered.</p>`;
  }
  const held = discardedCount === 0 ? 'holding pat' : `discarding ${plural(discardedCount, 'card', 'cards')}`;
  const rankLine = Number.isFinite(choiceRank) && Number.isFinite(choiceCount)
    ? `Your play — ${held} — came <strong>${ordinal(choiceRank)} of the ${choiceCount}</strong>
       you could legally have made.`
    : '';
  const verdict = skill >= 100
    ? 'That was the best one available. Nothing you could have thrown was worth more.'
    : skill >= 75
      ? 'Close to the top of the list.'
      : skill >= 25
        ? 'There was clearly better on the table.'
        : 'Most of the other options were worth more than this one.';
  return `<p>Where your discard ranked among the discards you could have made, priced by expected
    value before a single card moved. <strong>100% means you found the best one.</strong></p>
    <p>${rankLine} ${verdict}</p>
    <p class="meters-help-note">This is decided entirely by your starting hand and what you chose to
    throw. What you then drew cannot move it, up or down.</p>`;
}

function luckSection(explain) {
  const { luck, dealQuality, drawPercentile, dealMeasuredPat } = explain;
  if (!Number.isFinite(luck)) return '<p>Not measured this round.</p>';
  const dealLine = Number.isFinite(dealQuality)
    ? `<li><strong>The deal:</strong> stronger than ${pct(dealQuality)} of possible starting hands,
       ${dealMeasuredPat
         ? 'scored as dealt — no discard was allowed today, so these five cards were the whole hand.'
         : 'measured by what a perfect player could get out of it.'}</li>`
    : '';
  const drawLine = Number.isFinite(drawPercentile)
    ? `<li><strong>The draw:</strong> of every combination that could have come off the deck for
       that exact discard, yours beat ${pct(drawPercentile)} of them.</li>`
    : `<li><strong>The draw:</strong> you held pat, so there was no draw to be lucky about — the
       deal is the whole story here.</li>`;
  return `<p>Everything you did <em>not</em> decide, from the two places the deck gets a say:</p>
    <ul>${dealLine}${drawLine}</ul>
    <p class="meters-help-note">Counted exactly, by checking every hand that could have come —
    not estimated.</p>`;
}

function riskSection(explain) {
  const { risk, discardedCount, maxDiscards, originalHandLabel, originalHandScore, wagered } = explain;
  // A taken Double or Nothing is the largest bet in the game — the whole score,
  // doubled or wiped — and Risk cannot see it: the meter is built entirely out
  // of how many cards you threw, and a wager round throws none. Saying "nothing
  // was at stake" to someone who just gambled their entire run would be the
  // most obviously false sentence on the panel, so this names the limit instead
  // of papering over it.
  if (wagered) {
    return `<p>How much you gambled, counted in cards. This measures discards only, and a Double or
      Nothing round has none — so it reads <strong>0%</strong> even though you had your whole score
      on the line. The wager is the real risk you took today; this dial simply does not measure it.</p>`;
  }
  if (discardedCount === 0) {
    return `<p>How much you gambled. You kept all five cards, so nothing was at stake — <strong>0%</strong>.</p>`;
  }
  const hand = originalHandLabel ? escapeHtml(originalHandLabel) : 'your opening hand';
  const worth = Number.isFinite(originalHandScore) && originalHandScore > 0
    ? `You were breaking up ${hand}, worth ${originalHandScore.toLocaleString()} on its own — the
       more a hand is already worth, the more it costs to walk away from it.`
    : `${hand} was worth nothing on its own, so there was little to lose by breaking it up.`;
  return `<p>How much you gambled: how many of your cards you let go, weighted by how much the hand
    you broke up was already worth.</p>
    <p>You threw <strong>${discardedCount} of the ${maxDiscards}</strong> you were allowed. ${worth}</p>
    <p class="meters-help-note">Risk is not a grade. A high number is not a mistake and a low one is
    not caution — it only describes what you put on the line.</p>`;
}

/**
 * @param {object} explain - the `metersExplain` block board.js stores with the
 *   run, plus the meter values themselves. Every field is optional: a run
 *   recorded before this panel existed still opens, and simply says less.
 */
export function openMetersHelp(explain = {}) {
  openModal({
    title: 'How this run was rated',
    className: 'modal--meters-help',
    render: (body) => {
      // "Skill — —" is what a bare em dash produces after the heading's own
      // dash, and it reads as a typo rather than as an absence.
      const heading = (value) => (Number.isFinite(value) ? `— ${pct(value)}` : '<span class="meters-help-absent">not measured</span>');
      body.innerHTML = `
        <section class="meters-help-section">
          <h3>🎯 Skill ${heading(explain.skill)}</h3>
          ${skillSection(explain)}
        </section>
        <section class="meters-help-section">
          <h3>🍀 Luck ${heading(explain.luck)}</h3>
          ${luckSection(explain)}
        </section>
        <section class="meters-help-section">
          <h3>🎲 Risk ${heading(explain.risk)}</h3>
          ${riskSection(explain)}
        </section>
        <p class="meters-help-footer">Decision Rating is the same number as Skill — it is the one
        the game keeps, and the one that feeds your XP.</p>
      `;
    },
  });
}
