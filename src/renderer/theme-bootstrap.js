(function () {
  try {
    var t = localStorage.getItem('ui-theme');
    if (!t) {
      var prefersLight = window.matchMedia
        && window.matchMedia('(prefers-color-scheme: light)').matches;
      t = prefersLight ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch (_) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
