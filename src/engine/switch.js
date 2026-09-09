/** Voltage / current controlled switch (.model x SW | CSW) */

export function switchParams(model) {
  const p = model?.params || {};
  const ron = p.ron ?? 1;
  const roff = p.roff ?? 1e12;
  // Vt/Vh for S (voltage); It/Ih for W (current) — accept both names
  const thr = p.it ?? p.vt ?? 0;
  const hyst = p.ih ?? p.vh ?? 0;
  return {
    vt: thr,
    vh: Math.abs(hyst),
    ron: ron > 0 ? ron : 1e-3,
    roff: roff > 0 ? roff : 1e12,
  };
}

/**
 * Hysteresis: ON when ctrl > thr+hyst (from OFF), OFF when ctrl < thr-hyst (from ON).
 * First evaluation (no prev): ON if ctrl >= thr.
 */
export function switchIsOn(params, ctrl, prevOn) {
  const { vt, vh } = params;
  if (prevOn === undefined) return ctrl >= vt;
  if (prevOn) return ctrl >= vt - vh;
  return ctrl > vt + vh;
}

export function isSwitchModel(type) {
  const t = String(type || "SW").toUpperCase();
  return t === "SW" || t === "CSW";
}
