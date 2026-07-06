// Client-side auth guard for /user/* pages. Fetches the session once and exposes
// the result as window.meReady for app.js to reuse. Redirects to /login if the
// visitor is not authenticated.
window.meReady = (async function () {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (res.status === 401) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.replace('/login?next=' + next);
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('[guard] /api/me failed', e);
    return null;
  }
})();
