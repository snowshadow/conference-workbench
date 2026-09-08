export const THEMES = [
  { id: 'cyan', name: '经典青', description: '原有青色与柔和深蓝' },
  { id: 'deep-sea', name: '深海奶白', description: '深海蓝与柔奶白' },
  { id: 'lagoon', name: '青瓷藏蓝', description: '青色、浅青与两层深蓝' },
  { id: 'sky', name: '晴空明黄', description: '晴空蓝与明黄' },
  { id: 'iris', name: '鸢尾浅黄', description: '鸢尾紫与浅黄' },
];

const STORAGE_KEY = 'meeting-workbench:theme';
const DEFAULT_THEME = 'cyan';
const listeners = new Set();
let currentTheme = DEFAULT_THEME;

function normalizeTheme(value) {
  return THEMES.some(theme => theme.id === value) ? value : DEFAULT_THEME;
}

function applyTheme(value) {
  const next = normalizeTheme(value);
  document.documentElement.dataset.theme = next;
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  const browserColor = document.querySelector('meta[name="theme-color"]');
  if (canvas && browserColor) browserColor.content = canvas;
  if (currentTheme !== next) {
    currentTheme = next;
    listeners.forEach(listener => listener());
  }
  return next;
}

export function initializeTheme() {
  let saved;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* A blocked preference store must not prevent startup. */ }
  applyTheme(saved);
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) {
      let next;
      try { next = localStorage.getItem(STORAGE_KEY); } catch { return; }
      applyTheme(next);
    }
  });
}

export const getTheme = () => currentTheme;
export function subscribeTheme(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function selectTheme(value) {
  const next = applyTheme(value);
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* The selection still applies to this page. */ }
}
