import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { metaForRoute } from '../src/ui/page-meta.js';

// metaForRoute is pure — it reads URLSearchParams and returns a plain object —
// so it is testable in Node even though it lives in ui/. setPageMeta is the half
// that touches document.head and is covered by the browser checks instead.

const route = (query) => metaForRoute(new URLSearchParams(query));

describe('metaForRoute', () => {
  test('every route has its own title — the whole point of the request', () => {
    const titles = ['', 'leaderboard', 'profile', 'profile=CAR', 'admin'].map((q) => route(q).title);
    assert.equal(new Set(titles).size, titles.length, `duplicate titles: ${titles.join(' | ')}`);
    for (const title of titles) assert.match(title, /Cardle/, `"${title}" should still say Cardle`);
  });

  test('the homepage keeps the title and canonical a crawler already indexed', () => {
    const home = route('');
    assert.equal(home.title, 'Cardle — Daily Poker Puzzle');
    assert.equal(home.path, '/');
    assert.ok(!home.noindex, 'the homepage must never be noindexed');
  });

  // The canonical is what actually decides whether a distinct title gets a
  // distinct entry in the index — index.html's static one points every route
  // back at "/", so a route that forgets to move it is decoration.
  test('each route canonicalises to itself, not to the homepage', () => {
    assert.equal(route('leaderboard').path, '/?leaderboard');
    assert.equal(route('profile').path, '/?profile');
    assert.equal(route('profile=CAR').path, '/?profile=CAR');
    assert.equal(route('admin').path, '/?admin');
  });

  test('the leaderboard is indexable and carries its own description', () => {
    const board = route('leaderboard');
    assert.ok(!board.noindex, 'the leaderboard is public since §11ac and should be indexed');
    assert.match(board.description, /leaderboard|board|scores|hands/i);
  });

  // Unbounded, daily-changing, and about people other than the site owner.
  test('profiles and admin stay out of the index', () => {
    assert.equal(route('profile').noindex, true);
    assert.equal(route('profile=CAR').noindex, true);
    assert.equal(route('admin').noindex, true);
  });

  test("a viewed player's name is in the title, uppercased like every other surface", () => {
    assert.equal(route('profile=car').title, 'CAR — Cardle');
    assert.equal(route('profile=Dylan').title, 'DYLAN — Cardle');
  });

  test('an empty ?profile= is your own profile, not a player called nothing', () => {
    assert.equal(route('profile=').title, 'Your Profile — Cardle');
    assert.equal(route('profile=%20%20').title, 'Your Profile — Cardle');
    assert.equal(route('profile=').path, '/?profile');
  });

  // The username reaches a URL, so it has to survive the round trip. A name is
  // constrained to ^[A-Za-z0-9_]{3,20}$ by the schema, but this path also serves
  // whatever somebody types into the address bar.
  test('a username with URL-significant characters is encoded in the canonical', () => {
    const odd = route('profile=' + encodeURIComponent('a&b=c'));
    assert.ok(!odd.path.includes('&b='), `unencoded ampersand in ${odd.path}`);
    assert.match(odd.path, /a%26b%3Dc/i);
  });

  test('admin wins over any other param, matching main.js routing order', () => {
    // main.js checks ?admin first; if these disagreed the tab would name one
    // page while another rendered.
    assert.equal(route('admin&leaderboard').title, 'Admin — Cardle');
    assert.equal(route('admin&profile=CAR').title, 'Admin — Cardle');
  });

  test('an unrelated query param still resolves to the homepage', () => {
    // ?test and the sign-in callback's ?token_hash both land here.
    assert.equal(route('test').title, 'Cardle — Daily Poker Puzzle');
    assert.equal(route('token_hash=abc&type=magiclink').path, '/');
  });
});
