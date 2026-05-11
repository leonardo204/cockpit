// Runs before React hydrates (see app/layout.tsx <Script strategy="beforeInteractive">).
// Two jobs:
//   1. Apply the persisted theme class to <html> before first paint to avoid FOUC.
//   2. Unregister any leftover Service Workers from the PWA era (PWA has been removed).
(function () {
  try {
    var theme = localStorage.getItem('theme') || 'dark';
    var resolved = theme;
    if (theme === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.add(resolved);
  } catch (e) {}

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.unregister(); });
    });
  }
})();
