import { initBoard } from './board.js';
import { initHeader } from './header.js';
import { initProfile } from './profile.js';
import { initAdmin } from './admin.js';
import { initLeaderboard } from './leaderboard.js';

initHeader(document);

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
const params = new URLSearchParams(window.location.search);
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
