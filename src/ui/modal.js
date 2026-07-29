// Generic modal overlay — shared by the help modal, login modal, and
// friends panel (header.js). Only owns the backdrop/close chrome (click
// outside, Escape key, × button); each caller supplies a `render(bodyEl,
// close)` callback to build its own content and wire its own listeners
// (a plain HTML string wouldn't be enough for the login form or friends
// panel, which both need live event handlers, not just static markup).
//
// `onClose` (optional) fires no matter WHICH of the four ways the modal
// closed — the × button, a backdrop click, Escape, or `render`'s own `close`
// callback — so a caller that needs to reset some "this modal is currently
// open" flag (header.js's username-prompt duplicate guard, §11b) only has
// to write that cleanup once instead of duplicating it across every close
// path.
export function openModal({ title, render, onClose }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${title ?? ''}">
      <button type="button" class="modal-close" aria-label="Close">&times;</button>
      ${title ? `<h2 class="modal-title">${title}</h2>` : ''}
      <div class="modal-body"></div>
    </div>
  `;

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeydown);
    onClose?.();
  }

  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);

  document.body.appendChild(overlay);
  render(overlay.querySelector('.modal-body'), close);

  return { close };
}
