# Poker Daily Browser Game Design Prompt

I want you to act as an experienced indie game designer, UX designer, and senior JavaScript developer.

I am creating a browser game inspired by RNGDLE, but instead of rolling random numbers, the game revolves around building the strongest possible poker hand. My goal is **not** to make an online poker game or gambling simulator. I want to create a daily puzzle game that players become excited to return to every day.

Think of this as "Wordle meets Balatro meets RNGDLE."

## Primary Goals

The game should be:

* Extremely easy to understand.
* Playable in 2–5 minutes.
* Difficult to master.
* Highly replayable.
* Addictive without feeling unfair.
* Something players check every day after the daily reset.
* Social and shareable.
* Competitive through leaderboards and streaks.
* Mobile-first while also looking great on desktop.

I don't want luck to completely determine the outcome. The game should reward smart decisions, pattern recognition, and calculated risk.

---

# Core Gameplay

Players begin every run with five random playing cards.

Example:

K♠

K♥

8♦

5♣

2♠

The player may discard up to three cards.

After locking in their decision, replacement cards are drawn.

The resulting five-card hand is scored.

The player only gets one chance per daily challenge.

I also want an unlimited mode that generates random seeds so people can continue playing after finishing the daily puzzle.

---

# Scoring

Traditional poker hands determine the base score.

Example:

Royal Flush – 1000

Straight Flush – 800

Four of a Kind – 650

Full House – 500

Flush – 350

Straight – 300

Three of a Kind – 180

Two Pair – 100

Pair – 40

High Card – 0

Then bonus points are awarded for additional achievements.

Examples:

+5 per Ace

+2 per Face Card

+25 Same Color

+15 Consecutive Cards

+10 No Discards Used

+20 Perfect Draw

+50 Daily Modifier Completed

Help me design a scoring system that rewards optimization instead of just getting lucky.

---

# Daily Modifiers

Every day should include one modifier that changes strategy.

Examples:

Flush Frenzy
Flushes score double.

Wild Wednesday
One random rank becomes wild.

Lowball
The weakest poker hand wins.

One Swap
Exactly one discard is allowed.

Locked Card
One starting card cannot be discarded.

Blackout
Only black suits count for flushes.

Reverse Rankings
High Card becomes the strongest hand.

Suit Bonus
One randomly selected suit gives bonus points.

Please design many more modifiers that are balanced, interesting, and encourage different decision-making every day.

---

# Progression

I want long-term progression without making the game pay-to-win.

Ideas include:

Daily streaks

XP

Player level

Achievements

Titles

Badges

Statistics

Favorite hand

Highest score

Longest streak

Best draw

Collection book of every poker hand made

Rare achievements

Seasonal events

Please expand this system and make progression feel rewarding for months.

---

# Social Features

One of my favorite parts of RNGDLE is the poem generator.

After each game, players receive a funny, unique summary generated from the events of their run that they can easily copy and share.

For example, instead of simply saying:

"I got a Full House."

The game might generate something playful like:

"Two kings stood proudly while an eight found unexpected family. Fortune smiled after one brave discard."

Or:

"I chased greatness, threw away certainty, and the river answered with glory."

Every possible game should produce a different summary using templates, variables, and interesting descriptions of what happened during the run.

Help me design a procedural "poker story" generator that creates short, memorable, and sometimes funny recaps. It should become part of the game's identity the same way RNGDLE's poems are.

Players should also be able to share:

* Their score
* Their final hand
* Daily modifier
* Streak
* Generated poker story
* Emoji summary (similar to Wordle)

without revealing the exact solution.

---

# Addictive Gameplay

One of the biggest goals is making players genuinely excited for the daily reset.

Help me identify the psychological hooks that make games like Wordle, RNGDLE, Balatro, Luck Be a Landlord, and Vampire Survivors so compelling.

Suggest mechanics that create:

"Just one more run."

"I can't wait until tomorrow."

"I almost had it."

"I wonder what today's modifier will be."

without relying on predatory mechanics or microtransactions.

---

# User Experience

Design a clean, polished interface.

I want:

Animated card flips

Satisfying draw animations

Great sound effects

Juicy UI feedback

Confetti for rare hands

Smooth transitions

Beautiful poker cards

Dark mode

Light mode

Responsive mobile design

Fast loading

Accessibility support

Keyboard shortcuts

The game should feel premium despite running entirely in the browser.

---

# Technical Requirements

Eventually I want to build this using:

* HTML
* CSS
* JavaScript

No frameworks unless there's a compelling reason.

The architecture should be modular and easy to expand with future modifiers, achievements, events, cosmetics, and game modes.

---

# What I Want From You

Do not start coding immediately.

First, act as a game designer.

Challenge weak ideas.

Suggest improvements.

Point out flaws.

Recommend better mechanics.

Brainstorm features I haven't considered.

Identify ways to maximize replayability while keeping the game fair.

Help me make this feel like a polished indie game instead of just "draw poker in a browser."

Once we've finalized the design document, then we'll move on to implementing the game step by step with clean, maintainable code.
