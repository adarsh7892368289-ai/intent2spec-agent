'use strict';

import { dispatch, getState, subscribe } from '../state.js';

// A native <select> of detected, launchable browsers. Reflects state.availableBrowsers
// and dispatches BROWSER_SELECTED. Renders into the given slot; multiple instances
// stay in sync via the shared state subscription.
export function createBrowserSelector(slot) {
  if (!slot) {
    return;
  }
  slot.classList.add('browser-selector');

  const field = document.createElement('div');
  field.className = 'form-field';

  const label = document.createElement('label');
  label.className = 'label';
  label.textContent = 'Browser';

  const select = document.createElement('select');
  select.className = 'input';
  select.setAttribute('aria-label', 'Browser engine');

  field.appendChild(label);
  field.appendChild(select);
  slot.replaceChildren(field);

  function render(state) {
    const browsers = state.availableBrowsers ?? [];
    const selected = state.selectedBrowser;

    if (state.browserDetectionState === 'loading') {
      select.innerHTML = '<option>Detecting browsers…</option>';
      select.disabled = true;
      return;
    }
    if (state.browserDetectionState === 'error') {
      select.innerHTML = '<option>Detection failed</option>';
      select.disabled = true;
      return;
    }

    select.disabled = false;
    const launchable = browsers.filter((b) => b.isLaunchable);
    select.innerHTML = '';
    for (const b of launchable) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.displayName;
      if (selected && selected.id === b.id) {
        opt.selected = true;
      }
      select.appendChild(opt);
    }
    if (launchable.length === 0) {
      select.innerHTML = '<option>No launchable browsers found</option>';
      select.disabled = true;
    }
  }

  select.addEventListener('change', () => {
    const browsers = getState().availableBrowsers ?? [];
    const chosen = browsers.find((b) => b.id === select.value) ?? null;
    dispatch('BROWSER_SELECTED', { browser: chosen });
  });

  subscribe(render);
  render(getState());
}
