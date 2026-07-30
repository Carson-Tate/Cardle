import { initBoard } from './board.js';
import { initHeader } from './header.js';
import { initProfile } from './profile.js';
import { initAdmin } from './admin.js';

initHeader(document);

// `?profile` / `?admin` swap the daily board for another view (DESIGN.md
// §11d/§11f). The site header stays put either way — it's shared chrome, and its
// logo is how you get back. See profile.js for why these are query params
// rather than real paths.
//
// Routing to ?admin is NOT an access check: the admin page decides what to
// render, and Postgres decides what any of its actions may actually do. See
// admin.js and supabase/migrations/004-admin-foundation.sql.
const app = document.getElementById('app');
const params = new URLSearchParams(window.location.search);
if (params.has('admin')) {
  initAdmin(app);
} else if (params.has('profile')) {
  initProfile(app);
} else {
  initBoard(app);
}
