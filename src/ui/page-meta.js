// Per-route <title> and friends (DESIGN.md §11ad).
//
// Owner request: "i want the titles to each page to be different like the
// profile, leaderboard, and normal page."
//
// ── WHAT THIS ACTUALLY BUYS, HONESTLY ───────────────────────────────────────
// The TAB TITLE works immediately and everywhere — that is a browser reading
// document.title, not a crawler. The SEO half is weaker than it looks: this is
// a static single-page app whose body is empty until JavaScript runs (§11w), so
// a crawler's first pass sees index.html's static head on EVERY route. Google
// does execute JS and will pick these up, but on a second pass that can lag by
// days; Bing and most social unfurlers will not see them at all. Real per-route
// SEO needs real per-route HTML — see §11ad for what that would cost.
//
// ── THE PART THAT MATTERS MORE THAN THE TITLE ───────────────────────────────
// index.html hardcodes `<link rel="canonical" href="https://cardle.lol/">`,
// which tells Google that every query-param route IS the homepage. That was
// deliberate and correct while those routes rendered an empty shell to anyone
// without a session — listing them would have put thin duplicates in the index.
// §11ac changed the premise: the boards and profiles now render fully signed
// out. So canonical has to move per route too, or a distinct title is decoration
// on a page Google has been told not to index separately.
//
// Everything here goes through DOM properties and setAttribute, never innerHTML,
// so a username arriving from the URL cannot inject markup into the head.

const SITE = 'https://cardle.lol';
const DEFAULT_TITLE = 'Cardle — Daily Poker Puzzle';

function setMeta(selector, attr, value) {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

/**
 * @param {object} page
 * @param {string} page.title - the full <title>, already including "Cardle".
 * @param {string} [page.description] - falls back to index.html's own.
 * @param {string} page.path - path+query this page canonicalises to, e.g. "/?leaderboard".
 * @param {boolean} [page.noindex] - keep this route out of search results.
 */
export function setPageMeta({ title, description, path, noindex = false }) {
  document.title = title || DEFAULT_TITLE;

  const url = `${SITE}${path ?? '/'}`;
  setMeta('link[rel="canonical"]', 'href', url);
  setMeta('meta[property="og:url"]', 'content', url);
  setMeta('meta[property="og:title"]', 'content', title || DEFAULT_TITLE);
  setMeta('meta[name="twitter:title"]', 'content', title || DEFAULT_TITLE);

  if (description) {
    setMeta('meta[name="description"]', 'content', description);
    setMeta('meta[property="og:description"]', 'content', description);
    setMeta('meta[name="twitter:description"]', 'content', description);
  }

  // Added and removed rather than left in place with a changing value: `noindex`
  // and `index` are not opposites a crawler weighs, and the absence of the tag
  // is the normal, indexable state. Creating it on demand also means index.html
  // ships without one, so the homepage cannot be accidentally de-indexed by a
  // bug in this file — the failure mode worth designing against.
  const existing = document.head.querySelector('meta[name="robots"]');
  if (noindex) {
    const tag = existing ?? document.createElement('meta');
    tag.setAttribute('name', 'robots');
    tag.setAttribute('content', 'noindex, follow');
    if (!existing) document.head.appendChild(tag);
  } else if (existing) {
    existing.remove();
  }
}

// One place that knows what every route is called, so a title and the canonical
// it must agree with cannot drift apart. `username` is whatever ?profile=
// carried; null means the visitor's own profile.
export function metaForRoute(params) {
  if (params.has('admin')) {
    return {
      title: 'Admin — Cardle',
      path: '/?admin',
      noindex: true, // already Disallowed in robots.txt; this covers a crawler that ignores it
    };
  }

  if (params.has('leaderboard')) {
    return {
      title: 'Leaderboards — Cardle',
      description:
        "See today's top Cardle hands, this week's best, all-time high scores and career points — every board is public, no account needed.",
      path: '/?leaderboard',
    };
  }

  if (params.has('profile')) {
    const username = (params.get('profile') || '').trim();
    // NOINDEX, deliberately, even though these render publicly now (§11ac).
    // Three reasons: there is one per player and they are unbounded, which is
    // exactly the thin-content pattern that drags a small site's whole quality
    // signal down; they change every day, so anything indexed is stale; and
    // putting real people's usernames and statistics into search results is a
    // decision about somebody other than the site owner. One line to reverse.
    return {
      title: username ? `${username.toUpperCase()} — Cardle` : 'Your Profile — Cardle',
      path: username ? `/?profile=${encodeURIComponent(username)}` : '/?profile',
      noindex: true,
    };
  }

  return { title: DEFAULT_TITLE, path: '/' };
}
