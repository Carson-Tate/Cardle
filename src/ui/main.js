import { initBoard } from './board.js';
import { initHeader } from './header.js';
import { initProfile } from './profile.js';

initHeader(document);

// `?profile` swaps the daily board for the profile page (DESIGN.md §11d). The
// site header stays put either way — it's shared chrome, and its logo is how
// you get back. See profile.js for why this is a query param rather than a
// real path.
const app = document.getElementById('app');
if (new URLSearchParams(window.location.search).has('profile')) {
  initProfile(app);
} else {
  initBoard(app);
}
