/**
 * Lightweight floating context menu shared by waveform / schematic.
 * items: [{ label, action?, disabled?, danger?, sep? }]
 */
let openEl = null;

export function closeContextMenu() {
  if (openEl) {
    openEl.remove();
    openEl = null;
  }
  document.removeEventListener("pointerdown", onDocDown, true);
  document.removeEventListener("keydown", onKey, true);
}

function onDocDown(e) {
  if (openEl && !openEl.contains(e.target)) closeContextMenu();
}

function onKey(e) {
  if (e.key === "Escape") closeContextMenu();
}

export function showContextMenu(clientX, clientY, items) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");

  for (const it of items) {
    if (it.sep) {
      const hr = document.createElement("div");
      hr.className = "ctx-sep";
      menu.appendChild(hr);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-item" + (it.danger ? " danger" : "");
    btn.textContent = it.label;
    btn.disabled = !!it.disabled;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      try {
        it.action?.();
      } catch {
        /* ignore */
      }
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  openEl = menu;

  const pad = 6;
  const r = menu.getBoundingClientRect();
  let x = clientX;
  let y = clientY;
  if (x + r.width > window.innerWidth - pad) x = window.innerWidth - r.width - pad;
  if (y + r.height > window.innerHeight - pad) y = window.innerHeight - r.height - pad;
  if (x < pad) x = pad;
  if (y < pad) y = pad;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKey, true);
  return menu;
}
