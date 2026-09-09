/**
 * Resizable split panes — vertical (left|right) and horizontal (top/bottom).
 * Inspired by IDE-style HDL simulator layouts.
 */
export function initWorkspaceSplitters(workspace) {
  if (!workspace) return () => {};

  const KEY = "spice.ui.split";
  let colLeft = 0.4;
  let rowTop = 0.62;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved?.colLeft > 0.15 && saved.colLeft < 0.85) colLeft = saved.colLeft;
    if (saved?.rowTop > 0.25 && saved.rowTop < 0.9) rowTop = saved.rowTop;
  } catch {
    /* ignore */
  }

  const apply = () => {
    workspace.style.setProperty("--col-left", `${colLeft * 100}%`);
    workspace.style.setProperty("--row-top", `${rowTop * 100}%`);
  };
  apply();

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ colLeft, rowTop }));
    } catch {
      /* ignore */
    }
  };

  const bind = (el, axis) => {
    if (!el) return;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const rect = workspace.getBoundingClientRect();
      const onMove = (ev) => {
        if (axis === "x") {
          colLeft = Math.min(0.78, Math.max(0.18, (ev.clientX - rect.left) / rect.width));
        } else {
          rowTop = Math.min(0.88, Math.max(0.28, (ev.clientY - rect.top) / rect.height));
        }
        apply();
      };
      const onUp = () => {
        el.releasePointerCapture(e.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        save();
        workspace.dispatchEvent(new CustomEvent("splitresize"));
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });
  };

  bind(workspace.querySelector("[data-split='x']"), "x");
  bind(workspace.querySelector("[data-split='y']"), "y");

  return { apply, save };
}
