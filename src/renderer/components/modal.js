import { sanitize } from '../utils/sanitize.js';

const Modal = {
  _overlay: null,
  _box:     null,
  _resolve: null,
  _previousFocus: null,
  _keydownHandler: null,
  _init() {
    if (this._overlay) { return; }
    this._overlay = document.getElementById('modal-overlay');
    this._box     = document.getElementById('modal-box');
    this._overlay.addEventListener('click', e => {
      if (e.target === this._overlay) { this._close(false); }
    });
  },
  _focusables() {
    return Array.from(
      this._box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(el => !el.disabled && el.offsetParent !== null);
  },
  _onKeydown(e) {
    if (!this._resolve) { return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      this._close(false);
      return;
    }
    if (e.key === 'Tab') {
      const focusables = this._focusables();
      if (focusables.length === 0) { return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !this._box.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !this._box.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
  },
  confirm(title, message, { confirmText = 'Confirm', destructive = false } = {}) {
    this._init();
    return new Promise(resolve => {
      this._previousFocus = document.activeElement;
      this._resolve = resolve;
      this._box.innerHTML = `
        <p class="modal-title" id="modal-title">${sanitize(title)}</p>
        <p class="modal-message">${sanitize(message)}</p>
        <div class="modal-actions">
          <button class="btn-ghost btn-sm modal-cancel">Cancel</button>
          <button class="btn-${destructive ? 'destructive' : 'primary'} btn-sm modal-confirm">
            ${sanitize(confirmText)}
          </button>
        </div>`;
      this._overlay.classList.remove('hidden');
      this._keydownHandler = this._onKeydown.bind(this);
      document.addEventListener('keydown', this._keydownHandler, true);
      const focusTarget = destructive
        ? this._box.querySelector('.modal-cancel')
        : this._box.querySelector('.modal-confirm');
      focusTarget.focus();
      this._box.querySelector('.modal-cancel').addEventListener('click',  () => this._close(false));
      this._box.querySelector('.modal-confirm').addEventListener('click', () => this._close(true));
    });
  },
  _close(result) {
    this._overlay?.classList.add('hidden');
    if (this._keydownHandler) {
      document.removeEventListener('keydown', this._keydownHandler, true);
      this._keydownHandler = null;
    }
    const res     = this._resolve;
    this._resolve = null;
    if (this._previousFocus?.isConnected) {
      this._previousFocus.focus();
    }
    this._previousFocus = null;
    res?.(result);
  },
};

export { Modal };