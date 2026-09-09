/**
 * Lightweight command palette (Ctrl+K).
 */
export class CommandPalette {
  /**
   * @param {{ commands: () => Array<{ id: string, label: string, hint?: string, run: () => void }> }} opts
   */
  constructor(opts) {
    this.getCommands = opts.commands;
    this._idx = 0;
    this._filtered = [];
    this._build();
  }

  _build() {
    this.root = document.createElement("div");
    this.root.className = "palette-modal";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="palette-backdrop" data-close></div>
      <div class="palette-panel" role="dialog" aria-label="Command palette">
        <input class="palette-input" type="text" placeholder="Type a command…" autocomplete="off" spellcheck="false" />
        <ul class="palette-list"></ul>
        <p class="palette-foot muted">↑↓ navigate · Enter run · Esc close</p>
      </div>
    `;
    document.body.appendChild(this.root);
    this.input = this.root.querySelector(".palette-input");
    this.list = this.root.querySelector(".palette-list");

    this.root.querySelector("[data-close]").addEventListener("click", () => this.close());
    this.input.addEventListener("input", () => this._render());
    this.input.addEventListener("keydown", (e) => this._onKey(e));
  }

  get open() {
    return !this.root.hidden;
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    this.root.hidden = false;
    this.input.value = "";
    this._idx = 0;
    this._render();
    requestAnimationFrame(() => this.input.focus());
  }

  close() {
    this.root.hidden = true;
    this.input.blur();
  }

  _render() {
    const q = this.input.value.trim().toLowerCase();
    const all = this.getCommands() || [];
    this._filtered = q
      ? all.filter(
          (c) =>
            c.label.toLowerCase().includes(q) ||
            (c.hint && c.hint.toLowerCase().includes(q)) ||
            c.id.toLowerCase().includes(q)
        )
      : all.slice();
    if (this._idx >= this._filtered.length) this._idx = Math.max(0, this._filtered.length - 1);

    this.list.innerHTML = "";
    if (!this._filtered.length) {
      const li = document.createElement("li");
      li.className = "palette-empty";
      li.textContent = "No matching commands";
      this.list.appendChild(li);
      return;
    }
    this._filtered.forEach((c, i) => {
      const li = document.createElement("li");
      li.className = "palette-item" + (i === this._idx ? " is-active" : "");
      li.innerHTML = `<span class="palette-label">${esc(c.label)}</span>${
        c.hint ? `<span class="palette-hint">${esc(c.hint)}</span>` : ""
      }`;
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._run(c);
      });
      li.addEventListener("mouseenter", () => {
        this._idx = i;
        this._highlight();
      });
      this.list.appendChild(li);
    });
  }

  _highlight() {
    [...this.list.children].forEach((el, i) => {
      el.classList.toggle("is-active", i === this._idx);
    });
    const active = this.list.children[this._idx];
    active?.scrollIntoView?.({ block: "nearest" });
  }

  _onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this._idx = Math.min(this._filtered.length - 1, this._idx + 1);
      this._highlight();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this._idx = Math.max(0, this._idx - 1);
      this._highlight();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const c = this._filtered[this._idx];
      if (c) this._run(c);
    }
  }

  _run(c) {
    this.close();
    try {
      c.run();
    } catch (err) {
      console.error(err);
    }
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
