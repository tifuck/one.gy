// The app's title bar (main/window.js): drag area, history buttons and the
// window title; the window's own minimize / maximize / close are the native
// overlay on the right. It reports its colours so the overlay matches.
const bar = window.onegyTitlebar;
const els = {
  back: document.getElementById('back'),
  forward: document.getElementById('forward'),
  reload: document.getElementById('reload'),
  title: document.getElementById('title'),
};
let theme = null;

for (const name of ['back', 'forward', 'reload']) els[name].addEventListener('click', () => bar.command(name));

bar.onState((s) => {
  els.title.textContent = s.title || 'ONE.GY';
  document.title = els.title.textContent;
  els.back.disabled = !s.canGoBack;
  els.forward.disabled = !s.canGoForward;
  els.reload.disabled = !s.canReload;
  const t = s.theme === 'frost' ? 'frost' : 'frost-dark';
  if (t === theme) return;
  theme = t;
  document.documentElement.dataset.theme = t;
  const css = getComputedStyle(document.body);
  bar.colors({ color: css.backgroundColor, symbolColor: css.color });
});
