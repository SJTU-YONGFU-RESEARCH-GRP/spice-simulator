import { formatEng } from "../units.js";

const COLORS = [
  "#4fb8a7",
  "#6ea8fe",
  "#e6a05c",
  "#c9a0dc",
  "#e07070",
  "#d4c35c",
];

const PAD = { l: 52, r: 16, t: 16, b: 28 };

export class WaveformView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.times = [];
    this.series = {};
    this.selected = [];
    this.hoverT = null;
    this.xScale = "lin";
    this.xUnit = "s";
    this.golden = null;
    this.view = null; // { t0, t1 } or null = full
    this.yView = null; // { y0, y1 } or null = auto
    this.yScale = "lin"; // lin | log
    this.cursorA = null;
    this.cursorB = null;
    this._drag = null;
    this._box = null; // pixel rubber-band { x0,y0,x1,y1 }
    this._moved = false;
    this._autoY = { y0: -1, y1: 1 };
    this.markers = []; // [{ t, label, color? }]
    this.xyMode = false; // first selected = X, rest = Y (parametric)
    this.highlight = null; // signal name to emphasize
    this._legendHits = []; // [{ name, x0, y0, x1, y1 }]
    this.onContextMenu = null; // (e, { t, legendName }) => void
    this.onLegendClick = null; // (name, { ctrl, shift, alt }) => void

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);

    canvas.addEventListener("mousemove", (e) => this._onMove(e));
    canvas.addEventListener("mousedown", (e) => this._onDown(e));
    canvas.addEventListener("mouseup", (e) => this._onUp(e));
    canvas.addEventListener("mouseleave", () => {
      this.hoverT = null;
      this._drag = null;
      this._box = null;
      this.draw();
      this._emitCursors();
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this._onWheel(e);
      },
      { passive: false }
    );
    canvas.addEventListener("dblclick", () => this.fit());
    canvas.addEventListener("contextmenu", (e) => this._onContext(e));
    this.resize();
  }

  setHighlight(name) {
    this.highlight = name || null;
    this.draw();
  }

  _hitLegend(x, y) {
    for (const h of this._legendHits || []) {
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h.name;
    }
    return null;
  }

  _onContext(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const legendName = this._hitLegend(x, y);
    let t = null;
    if (this.times.length && this._inPlot(x, y)) {
      const vis = this._visibleRange();
      const { pad, plotW } = this._plotGeom();
      t = this._xFromPixel(x, pad, plotW, vis.t0, vis.t1);
    }
    this.onContextMenu?.(e, { t, legendName, x, y });
  }

  setData(times, series, selected, opts = {}) {
    this.times = times || [];
    this.series = series || {};
    this.selected = selected?.length
      ? selected
      : Object.keys(this.series).slice(0, 4);
    this.xScale = opts.xScale || "lin";
    this.xUnit = opts.xUnit || "s";
    if ("yScale" in opts) this.yScale = opts.yScale === "log" ? "log" : "lin";
    if ("xyMode" in opts) this.xyMode = !!opts.xyMode;
    if ("golden" in opts) this.golden = opts.golden || null;
    this.view = null;
    this.yView = null;
    this.cursorA = null;
    this.cursorB = null;
    if (!opts.keepMarkers) this.markers = [];
    if (!opts.keepHighlight) this.highlight = null;
    this.draw();
  }

  setXyMode(on) {
    this.xyMode = !!on;
    this.view = null;
    this.yView = null;
    this.cursorA = null;
    this.cursorB = null;
    this.draw();
    this._emitCursors();
  }

  setMarkers(list) {
    this.markers = Array.isArray(list) ? list.filter((m) => Number.isFinite(m?.t)) : [];
    this.draw();
  }

  setCursorT(t, which = "A") {
    const xs = this._xAxisValues();
    if (!xs.length || !Number.isFinite(t)) return;
    const idx = this._nearestXIndex(t);
    const snapped = xs[idx];
    if (which === "B") this.cursorB = snapped;
    else this.cursorA = snapped;
    this.draw();
    this._emitCursors();
  }

  clearCursors() {
    this.cursorA = null;
    this.cursorB = null;
    this.draw();
    this._emitCursors();
  }

  /** Keep zoom span; pan so cursor is centered (HDL-style →C1). */
  gotoCursor(which = "A") {
    const t = which === "B" ? this.cursorB : this.cursorA;
    if (t == null || !this.times.length) return;
    const vis = this._visibleRange();
    const span = vis.t1 - vis.t0;
    const full = this._fullRange();
    if (this.xScale === "log") {
      const mid = Math.log10(Math.max(t, 1e-30));
      const half = (Math.log10(Math.max(vis.t1, 1e-30)) - Math.log10(Math.max(vis.t0, 1e-30))) / 2;
      let nt0 = Math.pow(10, mid - half);
      let nt1 = Math.pow(10, mid + half);
      if (nt0 < full.t0) {
        const s = full.t0 / nt0;
        nt0 *= s;
        nt1 *= s;
      }
      if (nt1 > full.t1) {
        const s = full.t1 / nt1;
        nt0 *= s;
        nt1 *= s;
      }
      this.view = { t0: nt0, t1: nt1 };
    } else {
      let nt0 = t - span / 2;
      let nt1 = t + span / 2;
      if (nt0 < full.t0) {
        nt1 += full.t0 - nt0;
        nt0 = full.t0;
      }
      if (nt1 > full.t1) {
        nt0 -= nt1 - full.t1;
        nt1 = full.t1;
      }
      this.view = { t0: Math.max(full.t0, nt0), t1: Math.min(full.t1, nt1) };
    }
    this.draw();
  }

  fit() {
    this.view = null;
    this.yView = null;
    this.cursorA = null;
    this.cursorB = null;
    this.draw();
    this._emitCursors();
  }

  setYScale(scale) {
    this.yScale = scale === "log" ? "log" : "lin";
    this.yView = null;
    this.draw();
  }

  setGolden(golden) {
    this.golden = golden || null;
    this.draw();
  }

  exportPng(filename = `spice-wave-${Date.now()}.png`) {
    const a = document.createElement("a");
    a.href = this.canvas.toDataURL("image/png");
    a.download = filename;
    a.click();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth || 900;
    const h = Math.max(180, (parent?.clientHeight || 320) - 48);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.draw();
  }

  _plotGeom() {
    const dual = this._dualMode();
    const pad = dual ? { ...PAD, r: 52 } : PAD;
    const plotW = this.w - pad.l - pad.r;
    const plotH = this.h - pad.t - pad.b;
    return { pad, plotW, plotH, dual };
  }

  _isPhaseSeries(name) {
    return typeof name === "string" && /^ph\(/i.test(name);
  }

  _dualMode() {
    if (this.xyMode) return null;
    const left = [];
    const right = [];
    for (const name of this.selected) {
      if (this._isPhaseSeries(name)) right.push(name);
      else left.push(name);
    }
    return left.length && right.length ? { left, right } : null;
  }

  /** @returns {{ xName: string, yNames: string[], xs: number[] } | null} */
  _xySpec() {
    return xyPlotSpec(this.selected, this.series, this.xyMode);
  }

  _xAxisValues() {
    const xy = this._xySpec();
    return xy ? xy.xs : this.times;
  }

  _ySignalNames() {
    const xy = this._xySpec();
    return xy ? xy.yNames : this.selected;
  }

  _xAxisUnit() {
    return this._xySpec() ? "" : this.xUnit;
  }

  _nearestXIndex(t) {
    const xs = this._xAxisValues();
    if (this._xySpec()) return nearestIndexUnsorted(xs, t);
    return nearestIndex(xs, t);
  }

  _fullRange() {
    const xs = this._xAxisValues();
    if (!xs.length) return { t0: 0, t1: 1 };
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const v of xs) {
      if (!Number.isFinite(v)) continue;
      t0 = Math.min(t0, v);
      t1 = Math.max(t1, v);
    }
    if (!Number.isFinite(t0)) return { t0: 0, t1: 1 };
    if (t1 === t0) {
      t0 -= 0.5;
      t1 += 0.5;
    }
    return { t0, t1 };
  }

  _visibleRange() {
    const full = this._fullRange();
    if (!this.view) return full;
    let t0 = this.view.t0;
    let t1 = this.view.t1;
    if (this.xScale === "log") {
      t0 = Math.max(t0, 1e-30);
      t1 = Math.max(t1, t0 * 1.0001);
    }
    if (t1 <= t0) t1 = t0 + 1e-12;
    return { t0, t1 };
  }

  _xOf(t, pad, plotW, t0, t1) {
    if (this.xScale === "log") {
      const l0 = Math.log10(Math.max(t0, 1e-30));
      const l1 = Math.log10(Math.max(t1, 1e-30));
      const lt = Math.log10(Math.max(t, 1e-30));
      return pad.l + ((lt - l0) / (l1 - l0 || 1)) * plotW;
    }
    return pad.l + ((t - t0) / (t1 - t0 || 1)) * plotW;
  }

  _xFromPixel(x, pad, plotW, t0, t1) {
    const u = (x - pad.l) / plotW;
    if (this.xScale === "log") {
      const l0 = Math.log10(Math.max(t0, 1e-30));
      const l1 = Math.log10(Math.max(t1, 1e-30));
      return Math.pow(10, l0 + u * (l1 - l0));
    }
    return t0 + u * (t1 - t0);
  }

  _inPlot(x, y) {
    const { pad, plotW, plotH } = this._plotGeom();
    return x >= pad.l && x <= pad.l + plotW && y >= pad.t && y <= pad.t + plotH;
  }

  _computeAutoY(t0, t1, names = null) {
    const xs = this._xAxisValues();
    let yMin = Infinity;
    let yMax = -Infinity;
    const logY = this.yScale === "log";
    const consider = (ys) => {
      if (!ys) return;
      const n = Math.min(ys.length, xs.length);
      for (let i = 0; i < n; i++) {
        const xv = xs[i];
        if (!Number.isFinite(xv) || xv < t0 || xv > t1) continue;
        const y = ys[i];
        if (!Number.isFinite(y)) continue;
        if (logY && !(y > 0)) continue;
        yMin = Math.min(yMin, y);
        yMax = Math.max(yMax, y);
      }
    };
    const list = names || this._ySignalNames();
    for (const name of list) {
      consider(this.series[name]);
      consider(this.golden?.series?.[name]);
    }
    if (!Number.isFinite(yMin)) {
      return logY ? { y0: 1e-12, y1: 1 } : { y0: -1, y1: 1 };
    }
    if (logY) {
      const l0 = Math.log10(Math.max(yMin, 1e-30));
      const l1 = Math.log10(Math.max(yMax, yMin * 1.0001));
      const pad = (l1 - l0) * 0.08 || 0.5;
      return {
        y0: Math.pow(10, l0 - pad),
        y1: Math.pow(10, l1 + pad),
      };
    }
    if (yMax === yMin) {
      yMax += 0.5;
      yMin -= 0.5;
    }
    const yPad = (yMax - yMin) * 0.08 || 0.1;
    return { y0: yMin - yPad, y1: yMax + yPad };
  }

  _visibleYRange() {
    if (this.yView) {
      let { y0, y1 } = this.yView;
      if (this.yScale === "log") {
        y0 = Math.max(y0, 1e-30);
        y1 = Math.max(y1, y0 * 1.0001);
      }
      return { y0, y1 };
    }
    return this._autoY;
  }

  _yOf(v, pad, plotH, y0, y1) {
    if (this.yScale === "log") {
      const l0 = Math.log10(Math.max(y0, 1e-30));
      const l1 = Math.log10(Math.max(y1, 1e-30));
      const lv = Math.log10(Math.max(v, 1e-30));
      return pad.t + ((l1 - lv) / (l1 - l0 || 1)) * plotH;
    }
    return pad.t + ((y1 - v) / (y1 - y0 || 1)) * plotH;
  }

  _yFromPixel(y, pad, plotH, y0, y1) {
    const u = (y - pad.t) / plotH;
    if (this.yScale === "log") {
      const l0 = Math.log10(Math.max(y0, 1e-30));
      const l1 = Math.log10(Math.max(y1, 1e-30));
      return Math.pow(10, l1 - u * (l1 - l0));
    }
    return y1 - u * (y1 - y0);
  }

  _onWheel(e) {
    if (!this.times.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { pad, plotW, plotH } = this._plotGeom();
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    if (e.shiftKey) {
      const yr = this._visibleYRange();
      const yCursor = this._inPlot(x, y)
        ? this._yFromPixel(y, pad, plotH, yr.y0, yr.y1)
        : (yr.y0 + yr.y1) / 2;
      this._zoomYAround(yCursor, factor);
      return;
    }
    const vis = this._visibleRange();
    const tCursor = this._inPlot(x, PAD.t + 1)
      ? this._xFromPixel(x, pad, plotW, vis.t0, vis.t1)
      : (vis.t0 + vis.t1) / 2;
    this._zoomAround(tCursor, factor);
  }

  _zoomYAround(yCursor, factor) {
    const yr = this._visibleYRange();
    if (this.yScale === "log") {
      const l0 = Math.log10(Math.max(yr.y0, 1e-30));
      const l1 = Math.log10(Math.max(yr.y1, 1e-30));
      const lc = Math.log10(Math.max(yCursor, 1e-30));
      const span = (l1 - l0) * factor;
      const u = (lc - l0) / (l1 - l0 || 1);
      const y0 = Math.pow(10, lc - u * span);
      const y1 = Math.pow(10, lc + (1 - u) * span);
      if (!(y1 > y0)) return;
      this.yView = { y0, y1 };
      this.draw();
      return;
    }
    const span = (yr.y1 - yr.y0) * factor;
    const u = (yCursor - yr.y0) / (yr.y1 - yr.y0 || 1);
    let y0 = yCursor - u * span;
    let y1 = yCursor + (1 - u) * span;
    const minSpan = Math.abs(this._autoY.y1 - this._autoY.y0) * 1e-4 || 1e-12;
    if (y1 - y0 < minSpan) return;
    this.yView = { y0, y1 };
    this.draw();
  }

  _zoomAround(tCursor, factor) {
    const vis = this._visibleRange();
    const full = this._fullRange();
    let t0;
    let t1;
    if (this.xScale === "log") {
      const l0 = Math.log10(Math.max(vis.t0, 1e-30));
      const l1 = Math.log10(Math.max(vis.t1, 1e-30));
      const lc = Math.log10(Math.max(tCursor, 1e-30));
      const span = (l1 - l0) * factor;
      const u = (lc - l0) / (l1 - l0 || 1);
      t0 = Math.pow(10, lc - u * span);
      t1 = Math.pow(10, lc + (1 - u) * span);
    } else {
      const span = (vis.t1 - vis.t0) * factor;
      const u = (tCursor - vis.t0) / (vis.t1 - vis.t0 || 1);
      t0 = tCursor - u * span;
      t1 = tCursor + (1 - u) * span;
    }
    t0 = Math.max(full.t0, t0);
    t1 = Math.min(full.t1, t1);
    if (t1 <= t0) return;
    const minSpan =
      this.xScale === "log" ? full.t0 * 1e-6 || 1e-12 : (full.t1 - full.t0) * 1e-5;
    if (t1 - t0 < minSpan) return;
    this.view = { t0, t1 };
    this.draw();
  }

  _cursorPixelX(t) {
    if (t == null) return null;
    const vis = this._visibleRange();
    const { pad, plotW } = this._plotGeom();
    return this._xOf(t, pad, plotW, vis.t0, vis.t1);
  }

  _hitCursor(x) {
    const hit = (t, which) => {
      const px = this._cursorPixelX(t);
      if (px == null) return null;
      return Math.abs(px - x) <= 7 ? which : null;
    };
    return hit(this.cursorA, "A") || hit(this.cursorB, "B");
  }

  _onDown(e) {
    if (!this.times.length || e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Legend click — highlight / toggle (no plot drag)
    const leg = this._hitLegend(x, y);
    if (leg) {
      this._drag = {
        legend: leg,
        startX: x,
        startY: y,
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      this._moved = false;
      this._box = null;
      return;
    }

    if (!this._inPlot(x, y)) return;
    const vis = this._visibleRange();
    const yr = this._visibleYRange();
    const { pad, plotW } = this._plotGeom();
    const t = this._xFromPixel(x, pad, plotW, vis.t0, vis.t1);

    // Prefer dragging existing cursors (HDL-style)
    if (!e.ctrlKey && !e.metaKey) {
      const hit = this._hitCursor(x);
      if (hit) {
        this._drag = {
          startX: x,
          startY: y,
          startT: t,
          view0: { ...vis },
          y0: { ...yr },
          shift: e.shiftKey,
          box: false,
          cursor: hit,
        };
        this._box = null;
        this._moved = false;
        this.canvas.style.cursor = "ew-resize";
        return;
      }
    }

    this._drag = {
      startX: x,
      startY: y,
      startT: t,
      view0: { ...vis },
      y0: { ...yr },
      shift: e.shiftKey,
      box: e.ctrlKey || e.metaKey,
      cursor: null,
    };
    this._box = null;
    this._moved = false;
  }

  _onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const { pad, plotW, plotH } = this._plotGeom();
    const vis = this._visibleRange();

    if (this._drag && this.times.length) {
      if (this._drag.legend) {
        const dx = x - this._drag.startX;
        const dy = y - this._drag.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._moved = true;
        this.canvas.style.cursor = "pointer";
        return;
      }
      if (this._drag.cursor) {
        const t = this._xFromPixel(x, pad, plotW, vis.t0, vis.t1);
        const xs = this._xAxisValues();
        const snapped = xs[this._nearestXIndex(t)];
        if (this._drag.cursor === "B") this.cursorB = snapped;
        else this.cursorA = snapped;
        this._moved = true;
        this.hoverT = t;
        this.canvas.style.cursor = "ew-resize";
        this.draw();
        this._emitCursors();
        this.onHover?.(
          this._hoverPayload({
            t: this.times[this._nearestXIndex(t)],
            x: snapped,
            values: (() => {
              const vals = {};
              const idx = this._nearestXIndex(t);
              for (const name of this.selected) vals[name] = this.series[name]?.[idx];
              return vals;
            })(),
          })
        );
        return;
      }

      const dx = x - this._drag.startX;
      const dy = y - this._drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._moved = true;
      if (this._moved) {
        if (this._drag.box) {
          const x1 = Math.max(pad.l, Math.min(pad.l + plotW, x));
          const y1 = Math.max(pad.t, Math.min(pad.t + plotH, y));
          this._box = {
            x0: this._drag.startX,
            y0: this._drag.startY,
            x1,
            y1,
          };
          this.canvas.style.cursor = "crosshair";
          this.draw();
          return;
        }
        this.canvas.style.cursor = "grabbing";
        if (this._drag.shift) {
          if (this.yScale === "log") {
            const l0 = Math.log10(Math.max(this._drag.y0.y0, 1e-30));
            const l1 = Math.log10(Math.max(this._drag.y0.y1, 1e-30));
            const dLog = (dy / plotH) * (l1 - l0);
            this.yView = {
              y0: Math.pow(10, l0 + dLog),
              y1: Math.pow(10, l1 + dLog),
            };
          } else {
            const span = this._drag.y0.y1 - this._drag.y0.y0;
            const dyData = (dy / plotH) * span;
            this.yView = {
              y0: this._drag.y0.y0 + dyData,
              y1: this._drag.y0.y1 + dyData,
            };
          }
          this.draw();
          return;
        }
        const full = this._fullRange();
        const span = this._drag.view0.t1 - this._drag.view0.t0;
        if (this.xScale === "log") {
          const l0 = Math.log10(Math.max(this._drag.view0.t0, 1e-30));
          const l1 = Math.log10(Math.max(this._drag.view0.t1, 1e-30));
          const dLog = ((-dx) / plotW) * (l1 - l0);
          let nt0 = Math.pow(10, l0 + dLog);
          let nt1 = Math.pow(10, l1 + dLog);
          if (nt0 < full.t0) {
            const s = full.t0 / nt0;
            nt0 *= s;
            nt1 *= s;
          }
          if (nt1 > full.t1) {
            const s = full.t1 / nt1;
            nt0 *= s;
            nt1 *= s;
          }
          this.view = { t0: nt0, t1: nt1 };
        } else {
          const dt = (-dx / plotW) * span;
          let nt0 = this._drag.view0.t0 + dt;
          let nt1 = this._drag.view0.t1 + dt;
          if (nt0 < full.t0) {
            nt1 += full.t0 - nt0;
            nt0 = full.t0;
          }
          if (nt1 > full.t1) {
            nt0 -= nt1 - full.t1;
            nt1 = full.t1;
          }
          this.view = { t0: nt0, t1: nt1 };
        }
        this.draw();
        return;
      }
    }

    if (!this.times.length || !this._inPlot(x, y)) {
      const leg = this._hitLegend(x, y);
      this.hoverT = null;
      this.canvas.style.cursor = leg ? "pointer" : "crosshair";
      this.draw();
      this.onHover?.(this._hoverPayload(null));
      return;
    }
    const hit = this._hitCursor(x);
    const leg = this._hitLegend(x, y);
    this.canvas.style.cursor = leg ? "pointer" : hit ? "ew-resize" : "crosshair";
    const t = this._xFromPixel(x, pad, plotW, vis.t0, vis.t1);
    this.hoverT = t;
    this.draw();
    const xs = this._xAxisValues();
    const idx = this._nearestXIndex(t);
    const vals = {};
    for (const name of this.selected) {
      vals[name] = this.series[name]?.[idx];
    }
    const xy = this._xySpec();
    this.onHover?.(
      this._hoverPayload({
        t: this.times[idx],
        x: xs[idx],
        values: vals,
        unit: this._xAxisUnit(),
        xy: !!xy,
        xName: xy?.xName,
      })
    );
  }

  _onUp(e) {
    const drag = this._drag;
    const box = this._box;
    this._drag = null;
    this._box = null;
    this.canvas.style.cursor = "crosshair";
    if (!drag || !this.times.length) return;

    if (drag.legend) {
      if (!this._moved) {
        this.onLegendClick?.(drag.legend, {
          ctrl: drag.ctrl,
          shift: drag.shift,
          alt: drag.alt,
        });
      }
      return;
    }

    if (drag.cursor) {
      this._emitCursors();
      return;
    }

    if (drag.box && this._moved && box) {
      this._applyBoxZoom(box);
      return;
    }

    if (this._moved) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const vis = this._visibleRange();
    const { pad, plotW } = this._plotGeom();
    if (!this._inPlot(x, PAD.t + 1)) return;
    const t = this._xFromPixel(x, pad, plotW, vis.t0, vis.t1);
    const xs = this._xAxisValues();
    const idx = this._nearestXIndex(t);
    const snapped = xs[idx];
    if (drag.shift) this.cursorB = snapped;
    else this.cursorA = snapped;
    this.draw();
    this._emitCursors();
  }

  _applyBoxZoom(box) {
    const { pad, plotW, plotH } = this._plotGeom();
    const x0 = Math.min(box.x0, box.x1);
    const x1 = Math.max(box.x0, box.x1);
    const y0p = Math.min(box.y0, box.y1);
    const y1p = Math.max(box.y0, box.y1);
    if (x1 - x0 < 8 || y1p - y0p < 8) {
      this.draw();
      return;
    }
    const vis = this._visibleRange();
    const yr = this._visibleYRange();
    const t0 = this._xFromPixel(x0, pad, plotW, vis.t0, vis.t1);
    const t1 = this._xFromPixel(x1, pad, plotW, vis.t0, vis.t1);
    const yTop = this._yFromPixel(y0p, pad, plotH, yr.y0, yr.y1);
    const yBot = this._yFromPixel(y1p, pad, plotH, yr.y0, yr.y1);
    const full = this._fullRange();
    this.view = {
      t0: Math.max(full.t0, Math.min(t0, t1)),
      t1: Math.min(full.t1, Math.max(t0, t1)),
    };
    this.yView = {
      y0: Math.min(yTop, yBot),
      y1: Math.max(yTop, yBot),
    };
    this.draw();
  }

  _cursorValues(t) {
    if (t == null) return null;
    const xs = this._xAxisValues();
    const idx = this._nearestXIndex(t);
    const values = {};
    for (const name of this.selected) {
      values[name] = this.series[name]?.[idx];
    }
    return { t: this.times[idx], x: xs[idx], values };
  }

  _hoverPayload(hover) {
    const xy = this._xySpec();
    return {
      ...(hover || {}),
      unit: this._xAxisUnit(),
      xy: !!xy,
      xName: xy?.xName,
      cursorA: this._cursorValues(this.cursorA),
      cursorB: this._cursorValues(this.cursorB),
    };
  }

  _emitCursors() {
    this.onHover?.(this._hoverPayload(null));
  }

  _cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  _themeColors() {
    return {
      bg: this._cssVar("--wave-bg", "#0e1311"),
      muted: this._cssVar("--muted", "#8f9a94"),
      grid: this._cssVar("--wave-grid", "#2a3532"),
      axis: this._cssVar("--wave-axis", "#3a4844"),
      accent: this._cssVar("--accent", "#3d9e8c"),
      phase: this._cssVar("--c2", "#f0a05a"),
      c1: this._cssVar("--c1", "#5ec8ff"),
    };
  }

  draw() {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;
    if (!w || !h) return;
    const theme = this._themeColors();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);

    const { pad, plotW, plotH, dual } = this._plotGeom();

    if (!this.times.length || !this.selected.length) {
      ctx.fillStyle = theme.muted;
      ctx.font = "13px Source Sans 3, sans-serif";
      ctx.fillText("Run a simulation to plot signals", pad.l, pad.t + 24);
      return;
    }

    const xy = this._xySpec();
    if (this.xyMode && !xy) {
      ctx.fillStyle = theme.muted;
      ctx.font = "13px Source Sans 3, sans-serif";
      ctx.fillText("XY mode: select ≥2 signals (first = X axis)", pad.l, pad.t + 24);
      return;
    }

    const xs = this._xAxisValues();
    const xUnit = this._xAxisUnit();
    const { t0, t1 } = this._visibleRange();

    const leftNames = dual ? dual.left : this._ySignalNames();
    const rightNames = dual ? dual.right : [];
    // Phase (right) stays linear even when Log Y is on for magnitude
    const savedYScale = this.yScale;
    this._autoY = this._computeAutoY(t0, t1, leftNames);
    const { y0: yMin, y1: yMax } = this._visibleYRange();
    let yMinR = -180;
    let yMaxR = 180;
    if (dual) {
      this.yScale = "lin";
      const autoR = this._computeAutoY(t0, t1, rightNames);
      this.yScale = savedYScale;
      yMinR = autoR.y0;
      yMaxR = autoR.y1;
    }

    const xOf = (t) => this._xOf(t, pad, plotW, t0, t1);
    const yOf = (v) => this._yOf(v, pad, plotH, yMin, yMax);
    const yOfR = (v) => {
      const prev = this.yScale;
      this.yScale = "lin";
      const y = this._yOf(v, pad, plotH, yMinR, yMaxR);
      this.yScale = prev;
      return y;
    };

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
      let val;
      if (this.yScale === "log") {
        const l0 = Math.log10(Math.max(yMin, 1e-30));
        const l1 = Math.log10(Math.max(yMax, 1e-30));
        val = Math.pow(10, l1 - ((l1 - l0) * i) / 4);
      } else {
        val = yMax - ((yMax - yMin) * i) / 4;
      }
      ctx.fillStyle = theme.muted;
      ctx.font = "11px IBM Plex Mono, monospace";
      ctx.textAlign = "right";
      ctx.fillText(formatEng(val, 3), pad.l - 6, y + 4);
      if (dual) {
        const valR = yMaxR - ((yMaxR - yMinR) * i) / 4;
        ctx.textAlign = "left";
        ctx.fillStyle = theme.phase;
        ctx.fillText(formatEng(valR, 3) + "°", pad.l + plotW + 6, y + 4);
      }
    }
    for (let i = 0; i <= 5; i++) {
      let t;
      if (this.xScale === "log") {
        const l0 = Math.log10(Math.max(t0, 1e-30));
        const l1 = Math.log10(Math.max(t1, 1e-30));
        t = Math.pow(10, l0 + ((l1 - l0) * i) / 5);
      } else {
        t = t0 + ((t1 - t0) * i) / 5;
      }
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
      ctx.fillStyle = theme.muted;
      ctx.textAlign = "center";
      ctx.fillText(formatEng(t, 3) + xUnit, x, h - 8);
    }

    ctx.strokeStyle = theme.axis;
    ctx.strokeRect(pad.l, pad.t, plotW, plotH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, plotW, plotH);
    ctx.clip();

    const plotNames = this._ySignalNames();
    plotNames.forEach((name, ci) => {
      const color = COLORS[ci % COLORS.length];
      const onRight = dual && this._isPhaseSeries(name);
      const mapY = onRight ? yOfR : yOf;
      const useLog = !onRight && this.yScale === "log";
      const gys = this.golden?.series?.[name];
      const gxs = xy
        ? this.golden?.series?.[xy.xName]
        : this.golden?.times;
      if (gys && gxs?.length) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        let gStarted = false;
        const gn = Math.min(gys.length, gxs.length);
        for (let i = 0; i < gn; i++) {
          const gv = gys[i];
          const gx = gxs[i];
          if (!Number.isFinite(gx) || !Number.isFinite(gv)) {
            gStarted = false;
            continue;
          }
          if (useLog && !(gv > 0)) {
            gStarted = false;
            continue;
          }
          const x = xOf(gx);
          const y = mapY(gv);
          if (!gStarted) {
            ctx.moveTo(x, y);
            gStarted = true;
          } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      const ys = this.series[name];
      if (!ys) return;
      const hi = this.highlight;
      const dim = hi && hi !== name;
      ctx.strokeStyle = color;
      ctx.globalAlpha = dim ? 0.22 : 1;
      ctx.lineWidth = hi === name ? 2.6 : 1.6;
      ctx.beginPath();
      let started = false;
      const n = Math.min(ys.length, xs.length);
      for (let i = 0; i < n; i++) {
        const xv = xs[i];
        const yv = ys[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
          started = false;
          continue;
        }
        if (useLog && !(yv > 0)) {
          started = false;
          continue;
        }
        const x = xOf(xv);
        const y = mapY(yv);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
    ctx.restore();

    this._legendHits = [];
    const legend = xy ? [xy.xName + " (X)", ...plotNames] : plotNames;
    legend.forEach((name, ci) => {
      const color = COLORS[(xy ? Math.max(0, ci - 1) : ci) % COLORS.length];
      const isXAxis = xy && ci === 0;
      const sigName = isXAxis ? xy.xName : name;
      const col = isXAxis ? theme.muted : color;
      const hi = this.highlight === sigName;
      ctx.fillStyle = col;
      ctx.textAlign = "left";
      ctx.font = hi
        ? "bold 11px IBM Plex Mono, monospace"
        : "11px IBM Plex Mono, monospace";
      const gName = sigName;
      const label =
        isXAxis
          ? name
          : this.golden?.series?.[gName]
            ? `${name} (+g)`
            : name;
      const lx = pad.l + 8 + ci * 130;
      const ly = pad.t + 14;
      ctx.fillText(label, lx, ly);
      const tw = ctx.measureText(label).width;
      this._legendHits.push({
        name: sigName,
        x0: lx - 2,
        y0: ly - 11,
        x1: lx + tw + 4,
        y1: ly + 3,
        isXAxis,
      });
      if (hi && !isXAxis) {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(lx, ly + 2);
        ctx.lineTo(lx + tw, ly + 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });

    const drawCursor = (t, color, tag) => {
      if (t == null) return;
      const x = xOf(t);
      if (x < pad.l - 1 || x > pad.l + plotW + 1) return;
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = "10px IBM Plex Mono, monospace";
      ctx.textAlign = "center";
      ctx.fillText(tag, x, pad.t + plotH - 4);
    };
    drawCursor(this.cursorA, theme.c2 || "#e6a05c", "A");
    drawCursor(this.cursorB, theme.c1 || "#6ea8fe", "B");

    if (this.markers?.length && !xy) {
      ctx.font = "10px IBM Plex Mono, monospace";
      ctx.textAlign = "left";
      let yi = 0;
      for (const m of this.markers) {
        const x = xOf(m.t);
        if (x < pad.l - 1 || x > pad.l + plotW + 1) continue;
        ctx.strokeStyle = m.color || "#c9a0dc";
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(x, pad.t);
        ctx.lineTo(x, pad.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = m.color || "#c9a0dc";
        const label = m.label || formatEng(m.t, 3);
        ctx.fillText(label, x + 3, pad.t + 12 + (yi % 4) * 12);
        yi++;
      }
    }

    if (this.hoverT != null) {
      const x = xOf(this.hoverT);
      ctx.strokeStyle = theme.muted;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this._box) {
      const bx0 = Math.min(this._box.x0, this._box.x1);
      const by0 = Math.min(this._box.y0, this._box.y1);
      const bw = Math.abs(this._box.x1 - this._box.x0);
      const bh = Math.abs(this._box.y1 - this._box.y0);
      ctx.fillStyle = "color-mix(in srgb, " + theme.accent + " 18%, transparent)";
      // canvas doesn't support color-mix — use rgba fallback
      ctx.fillStyle = "rgba(61,158,140,0.14)";
      ctx.fillRect(bx0, by0, bw, bh);
      ctx.strokeStyle = theme.accent;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(bx0, by0, bw, bh);
      ctx.setLineDash([]);
    }
  }
}

function nearestIndex(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

function nearestIndexUnsorted(arr, t) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!Number.isFinite(v)) continue;
    const d = Math.abs(v - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** First selected → X axis when xyMode; rest are Y traces. */
export function xyPlotSpec(selected, series, xyMode) {
  if (!xyMode || !selected || selected.length < 2) return null;
  const xName = selected[0];
  const xs = series?.[xName];
  if (!xs?.length) return null;
  return { xName, yNames: selected.slice(1), xs };
}
