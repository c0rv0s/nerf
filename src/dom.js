// Small DOM helpers shared by the game shell and HUD. They avoid needless
// layout work when a value has not changed and keep null-safe UI updates terse.
export const byId = (id) => document.getElementById(id);

export function setText(el, value) {
  if (!el) return;
  const next = String(value);
  if (el.textContent !== next) el.textContent = next;
}

export function setStyle(el, property, value) {
  if (!el) return;
  const next = value == null ? '' : String(value);
  if (el.style[property] !== next) el.style[property] = next;
}

export function setClass(el, value) {
  if (!el) return;
  if (el.className !== value) el.className = value;
}
