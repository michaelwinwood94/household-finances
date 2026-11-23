// Shared interface helpers: display settings, toasts with Undo, info tips, busy buttons,
// friendly errors, offline banner, search overlay, phone "More" menu and app install.
const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
                set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } } };
export { store };

// ---------- display settings ----------
const DEFAULT_PREFS = { size: 'm', font: 'standard', theme: 'light', privacy: false };
export const prefs = { ...DEFAULT_PREFS, ...store.get('displayPrefs', {}) };
const FONT_LINKS = {
  lexend: 'https://fonts.googleapis.com/css2?family=Lexend:wght@400;700&display=swap',
  dyslexic: 'https://fonts.cdnfonts.com/css/opendyslexic',
};
export function applyPrefs() {
  const h = document.documentElement;
  h.dataset.size = prefs.size; h.dataset.font = prefs.font;
  const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  h.dataset.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('privacy', !!prefs.privacy);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#173a34' : '#1f4e46');
  const href = FONT_LINKS[prefs.font];
  if (href && !document.querySelector(`link[data-font="${prefs.font}"]`)) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.dataset.font = prefs.font; document.head.appendChild(l);
  }
  const eye = $('#privacy-btn'); if (eye) { eye.setAttribute('aria-pressed', !!prefs.privacy); eye.title = prefs.privacy ? 'Show amounts' : 'Hide amounts'; eye.textContent = prefs.privacy ? '🙈' : '👁'; }
}
export function setPref(k, v, onChange) { prefs[k] = v; store.set('displayPrefs', prefs); applyPrefs(); onChange?.(); }
export function settingsMenu(onChange) {
  const pop = $('#settings-pop');
  const opt = (k, v, label) => `<button class="${prefs[k] === v ? 'on' : ''}" data-k="${k}" data-v="${v}">${label}</button>`;
  pop.innerHTML = `<h3>Display</h3>
    <div class="pref"><span>Text size</span><div class="seg">${opt('size', 'm', 'A')}${opt('size', 'l', '<span style="font-size:1.15em">A</span>')}${opt('size', 'xl', '<span style="font-size:1.3em">A</span>')}</div></div>
    <div class="pref"><span>Font</span><div class="seg">${opt('font', 'standard', 'Standard')}${opt('font', 'lexend', 'Easy read')}${opt('font', 'dyslexic', 'Dyslexia')}</div></div>
    <div class="pref"><span>Theme</span><div class="seg">${opt('theme', 'light', 'Light')}${opt('theme', 'dark', 'Dark')}${opt('theme', 'auto', 'Auto')}</div></div>
    <div class="pref"><span>Amounts</span><div class="seg">${opt('privacy', false, 'Show')}${opt('privacy', true, 'Hide')}</div></div>
    <p class="hint">Saved on this device.</p>`;
  pop.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    const v = b.dataset.v === 'true' ? true : b.dataset.v === 'false' ? false : b.dataset.v;
    setPref(b.dataset.k, v, onChange); settingsMenu(onChange);
  });
}

// ---------- toasts (with optional action) ----------
let toastTimer;
export function toast(msg, opts = {}) {
  const { ms = 3000, action, onAction, kind } = typeof opts === 'number' ? { ms: opts } : opts;
  const t = $('#toast');
  t.className = 'toast show' + (kind ? ' ' + kind : '');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action)}</button>` : ''}`;
  if (action) { t.style.pointerEvents = 'auto'; $('.toast-btn', t).onclick = () => { clearTimeout(toastTimer); t.classList.remove('show'); onAction?.(); }; }
  else t.style.pointerEvents = 'none';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Hide something now, really delete it after a few seconds unless Undo is pressed. */
export function softDelete({ hide, restore, commit, label = 'Deleted' }) {
  hide(); let undone = false;
  const ms = 6000;
  toast(label, { ms, action: 'Undo', onAction: () => { undone = true; restore(); toast('Restored'); } });
  setTimeout(async () => { if (!undone) { try { await commit(); } catch { restore(); } } }, ms + 100);
}

// ---------- busy buttons ----------
export async function busy(btn, fn) {
  if (!btn || btn.disabled) return fn();
  const html = btn.innerHTML; btn.disabled = true; btn.classList.add('is-busy');
  try { const r = await fn(); btn.classList.remove('is-busy'); btn.classList.add('is-done'); setTimeout(() => { btn.classList.remove('is-done'); btn.innerHTML = html; btn.disabled = false; }, 900); return r; }
  catch (e) { btn.classList.remove('is-busy'); btn.innerHTML = html; btn.disabled = false; throw e; }
}

// ---------- friendly error messages ----------
export function friendlyError(err) {
  const m = String(err?.message || err || '');
  if (!navigator.onLine || /Failed to fetch|NetworkError|network|Load failed/i.test(m)) return 'No internet connection — your change wasn’t saved. Check your connection and try again.';
  if (/JWT|expired|not logged in|Auth/i.test(m)) return 'You’ve been signed out. Please sign in again.';
  if (err?.code === '23505' || /duplicate key|already exists/i.test(m)) return 'That already exists — try a different name.';
  if (err?.code === '23514' || /check constraint/i.test(m)) return 'One of the values isn’t allowed (for example a % over 100). Check the form.';
  if (err?.code === '23503' || /foreign key/i.test(m)) return 'This is still being used somewhere else, so it can’t be changed like that.';
  if (/row-level security|permission/i.test(m)) return 'You don’t have permission to change that.';
  if (/timeout|timed out/i.test(m)) return 'That took too long. Please try again.';
  return 'Something went wrong: ' + m;
}
export function watchOnline() {
  const bar = $('#offline-bar');
  const upd = () => bar.classList.toggle('hidden', navigator.onLine);
  addEventListener('online', () => { upd(); toast('Back online'); }); addEventListener('offline', upd); upd();
}

// ---------- info tips (ⓘ) ----------
export const info = text => `<button type="button" class="info" aria-label="How is this worked out?" data-info="${esc(text)}">i</button>`;
export function wireInfoTips() {
  const pop = document.createElement('div'); pop.className = 'info-pop'; pop.setAttribute('role', 'tooltip'); document.body.appendChild(pop);
  document.addEventListener('click', e => {
    const b = e.target.closest('.info');
    if (!b) { pop.classList.remove('show'); return; }
    e.stopPropagation();
    pop.textContent = b.dataset.info; pop.classList.add('show'); pop._at = Date.now();
    const r = b.getBoundingClientRect(), w = Math.min(320, innerWidth - 24);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
    const top = r.bottom + 8; pop.style.top = (top + pop.offsetHeight > innerHeight - 8 ? r.top - pop.offsetHeight - 8 : top) + 'px';
  });
  addEventListener('scroll', () => { if (Date.now() - (pop._at || 0) > 400) pop.classList.remove('show'); }, { passive: true });
}

// ---------- loading placeholders ----------
export const skeleton = (tiles = 4, blocks = 2) => `<div class="sk sk-title"></div><div class="tiles">${'<div class="tile"><div class="sk sk-line"></div><div class="sk sk-big"></div><div class="sk sk-line short"></div></div>'.repeat(tiles)}</div>${'<div class="card"><div class="sk sk-line"></div><div class="sk sk-block"></div></div>'.repeat(blocks)}`;

// ---------- app install (phone home screen) ----------
export function wireInstall() {
  let deferred = null;
  const btn = $('#install-btn');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; btn.classList.remove('hidden'); });
  // iPhone and iPad never fire the install prompt, so show the steps instead.
  if (ios && !standalone) btn.classList.remove('hidden');
  addEventListener('appinstalled', () => btn.classList.add('hidden'));
  btn.onclick = async () => {
    if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; btn.classList.add('hidden'); return; }
    if (ios) toast('On iPhone: tap the Share button in Safari, then "Add to Home Screen".', { ms: 9000 });
    else toast('In your browser menu choose "Add to Home screen" or "Install app".', { ms: 7000 });
  };
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
