// The update toast (main/window.js notice view, bottom right of the window):
// the updater's state when it needs the user, with the one step left. Later
// or Close hides it until the state or version changes; Settings > General
// keeps the same actions. It reports its height so the view fits the card.
const bridge = window.onegyUpdate;
const els = Object.fromEntries(['wrap', 'card', 'title', 'text', 'bar', 'actions', 'later', 'go', 'close']
  .map((id) => [id, document.getElementById(id)]));
let dismissed = null;
let shownKey = null;

const named = (s) => (s.version ? `ONE.GY ${s.version}` : 'A new version of ONE.GY');
const COPY = {
  available: (s) => ({ title: 'Update available', text: `${named(s)} is out. Install it now; ONE.GY restarts and opens where you left off.`, action: 'Update and restart' }),
  installing: (s) => ({ title: 'Updating ONE.GY…', text: `Installing ${s.version || 'the update'}. ONE.GY restarts when it is done.`, busy: true }),
  ready: (s) => ({ title: 'Update ready', text: `${named(s)} is ready. Restart to use it; you'll be back where you left off.`, action: 'Restart now' }),
  error: (s) => ({ title: 'Update failed', text: s.error, action: 'Try again', bad: true }),
};

// Only what needs the user: a failed background check waits in Settings.
const copyFor = (s) => (s && COPY[s.state] && !(s.state === 'error' && s.failed !== 'install') ? COPY[s.state](s) : null);

function report() {
  bridge.size(els.wrap.hidden ? 0 : Math.ceil(els.wrap.getBoundingClientRect().height));
}

function render(s) {
  document.documentElement.dataset.theme = s.theme === 'frost' ? 'frost' : 'frost-dark';
  const c = copyFor(s);
  const key = c ? `${s.state}:${s.version}` : null;
  els.wrap.hidden = !c || key === dismissed;
  if (!els.wrap.hidden) {
    els.title.textContent = c.title;
    els.text.textContent = c.text;
    els.card.classList.toggle('is-error', Boolean(c.bad));
    els.bar.hidden = !c.busy;
    els.actions.hidden = Boolean(c.busy);
    els.go.textContent = c.action || '';
    els.go.disabled = false;
    // Replays the entrance when a new card comes up.
    if (key !== shownKey) els.card.getAnimations().forEach((a) => { a.cancel(); a.play(); });
  }
  shownKey = els.wrap.hidden ? null : key;
  report();
}

const dismiss = () => {
  dismissed = shownKey;
  els.wrap.hidden = true;
  shownKey = null;
  report();
};
els.later.addEventListener('click', dismiss);
els.close.addEventListener('click', dismiss);
els.go.addEventListener('click', () => {
  els.go.disabled = true;
  bridge.install();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.wrap.hidden) dismiss(); });

bridge.onState(render);
