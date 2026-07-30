import { initBoard } from './board.js';
import { initHeader } from './header.js';
import { initProfile } from './profile.js';
import { initAdmin } from './admin.js';
import { initLeaderboard } from './leaderboard.js';
import { verifySignInLink } from '../state/auth.js';

const params = new URLSearchParams(window.location.search);

// SIGN-IN LINK CALLBACK (DESIGN.md §11o). The emailed button lands here as
// `/?token_hash=...&type=magiclink`; see supabase/email-templates/magic-link.html
// for why the link points at our own domain rather than Supabase's verify
// endpoint.
//
// AWAITED BEFORE ANYTHING RENDERS, so the page never paints a signed-out header
// and then swaps it a beat later — the arriving player should just be logged in.
// This is a top-level await on a CDN-backed module, which is the shape that once
// bricked the whole game (§11a: an unreachable esm.sh left every importer
// un-evaluated). Two things make it safe here: it only runs when `token_hash` is
// present, so ordinary loads never await anything; and it cannot throw, so a
// Supabase or network failure still falls through to a fully playable board.
let signInError = null;
if (params.has('token_hash')) {
  try {
    await verifySignInLink(params.get('token_hash'), params.get('type') ?? 'magiclink');
  } catch (error) {
    signInError = error?.message ?? 'That sign-in link did not work.';
  }
  // Strip the credential from the URL either way: a reload must not retry an
  // already-redeemed token (which would fail and look like a broken link), and
  // a one-time token has no business sitting in the address bar, the back
  // history, or an outgoing Referer header.
  const clean = new URL(window.location.href);
  clean.searchParams.delete('token_hash');
  clean.searchParams.delete('type');
  window.history.replaceState({}, '', clean);
}

// Passed the failure (if any) so a dead link says so, rather than dumping the
// player on a logged-out home page with no explanation.
initHeader(document, { signInError });

// Query params rather than real paths (DESIGN.md §11d): this is a static
// single-page app with no router, so a path would need a Vercel rewrite plus
// matching dev-server handling — the exact area that produced the "unstyled
// page" deployment bug (§11a). Params need zero server config and behave
// identically locally and deployed.
//
//   ?admin                  — admin tools (authorized by Postgres, not here)
//   ?leaderboard            — the four score boards
//   ?profile                — your own profile
//   ?profile=<username>     — someone else's, read-only (§11j)
//
// Routing is NOT an access check. The admin page decides what to render and the
// database decides what any of its actions may do; see admin.js and
// supabase/migrations/004-admin-foundation.sql.
const app = document.getElementById('app');
if (params.has('admin')) {
  initAdmin(app);
} else if (params.has('leaderboard')) {
  initLeaderboard(app);
} else if (params.has('profile')) {
  // `?profile` (no value) is your own; `?profile=name` is someone else's.
  const username = params.get('profile');
  initProfile(app, { username: username || null });
} else {
  initBoard(app);
}
