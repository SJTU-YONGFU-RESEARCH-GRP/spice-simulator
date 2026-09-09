/** Simplified Ebers–Moll BJT (NPN / PNP) for DC / TRAN / AC linearization */

export function bjtParams(model) {
  const p = model?.params || {};
  const type = (model?.type || "NPN").toUpperCase();
  return {
    isP: type === "PNP",
    Is: p.is ?? 1e-15,
    Bf: p.bf ?? p.beta ?? 100,
    Br: p.br ?? 1,
    Vt: p.vt ?? 0.026,
    Vaf: p.vaf ?? p.va ?? 0,
    Cje: Math.max(0, p.cje ?? 0),
    Vje: p.vje ?? p.pe ?? 0.75,
    Mje: p.mje ?? p.me ?? 0.33,
    Cjc: Math.max(0, p.cjc ?? 0),
    Vjc: p.vjc ?? p.pc ?? 0.75,
    Mjc: p.mjc ?? p.mc ?? 0.33,
    FC: p.fc ?? 0.5,
    Tf: Math.max(0, p.tf ?? 0),
    Re: Math.max(0, p.re ?? 0),
    Rc: Math.max(0, p.rc ?? 0),
    Rb: Math.max(0, p.rb ?? 0),
    IKF: Math.max(0, p.ikf ?? p.ik ?? 0),
  };
}

/** Intrinsic C/B/E nodes when series R present. */
export function bjtIntNodes(d, params) {
  return {
    nc: params.Rc > 0 ? `${d.name}#c` : d.nc,
    nb: params.Rb > 0 ? `${d.name}#b` : d.nb,
    ne: params.Re > 0 ? `${d.name}#e` : d.ne,
    rc: params.Rc > 0 ? { ext: d.nc, mid: `${d.name}#c`, r: params.Rc } : null,
    rb: params.Rb > 0 ? { ext: d.nb, mid: `${d.name}#b`, r: params.Rb } : null,
    re: params.Re > 0 ? { ext: d.ne, mid: `${d.name}#e`, r: params.Re } : null,
  };
}

/**
 * Evaluate currents and small-signal params.
 * Ic into collector, Ib into base (physical terminal currents).
 */
export function bjtEval(params, vc, vb, ve) {
  const { isP, Is, Bf, Br, Vt, Vaf } = params;
  const s = isP ? -1 : 1;
  const Vbe = s * (vb - ve);
  const Vbc = s * (vb - vc);
  const Vce = s * (vc - ve);

  const VbeL = Math.max(-1.5, Math.min(Vbe, 0.9));
  const VbcL = Math.max(-1.5, Math.min(Vbc, 0.9));

  const expBe = Math.exp(VbeL / Vt);
  const expBc = Math.exp(VbcL / Vt);

  const Ibf = (Is / Bf) * (expBe - 1);
  const Ibr = (Is / Br) * (expBc - 1);
  let Ict = Is * (expBe - expBc);

  // Forward knee current IKF
  const IKF = params.IKF || 0;
  if (IKF > 0 && Ict > 0) {
    Ict = Ict / Math.sqrt(1 + Ict / IKF);
  }

  let early = 1;
  if (Vaf > 0) early = 1 + Math.max(Vce, 0) / Vaf;
  Ict *= early;

  const IcN = Ict - Ibr;
  const IbN = Ibf + Ibr;

  const gpi = Math.max(((Is / Bf) / Vt) * expBe, 1e-12);
  const gmu = Math.max(((Is / Br) / Vt) * expBc, 1e-12);
  const gmF = (Is / Vt) * expBe * early;
  const gmR = (Is / Vt) * expBc * early;
  const go = Vaf > 0 ? Math.max((Is * (expBe - expBc)) / Vaf, 0) : 0;

  return {
    Ic: s * IcN,
    Ib: s * IbN,
    gpi,
    gmu,
    gmF,
    gmR,
    go,
    s,
    Vbe: VbeL,
    Vbc: VbcL,
  };
}

/** SPICE-style junction C at voltage vd. */
function junctionC(C0, Vj, M, FC, vd) {
  if (!(C0 > 0)) return 0;
  const vj = Math.max(Vj || 0.75, 1e-3);
  const m = M ?? 0.33;
  const fc = Math.min(Math.max(FC ?? 0.5, 0), 0.95);
  let cj;
  if (vd < fc * vj) {
    const arg = Math.max(1e-6, 1 - vd / vj);
    cj = C0 * Math.pow(arg, -m);
  } else {
    const arg = 1 - fc;
    const sarg = Math.pow(arg, -(m + 1));
    const f2 = C0 * sarg;
    const f3 = (C0 * m * sarg * arg) / vj;
    cj = f2 + f3 * vd;
  }
  return Math.min(Math.max(cj, 0), C0 * 1e6);
}

/**
 * BE / BC capacitances (F): junction + forward diffusion Tf·gmF on BE.
 */
export function bjtCaps(params, Vbe, Vbc, gmF) {
  const cje = junctionC(params.Cje, params.Vje, params.Mje, params.FC, Vbe);
  const cjc = junctionC(params.Cjc, params.Vjc, params.Mjc, params.FC, Vbc);
  const cdiff = params.Tf > 0 ? params.Tf * Math.max(gmF, 0) : 0;
  return { cbe: cje + cdiff, cbc: cjc };
}

/**
 * Stamp BJT into MNA using node voltages vc,vb,ve and eval at that point.
 */
export function stampBjt(G, rhs, ci, bi, ei, vc, vb, ve, ev) {
  const { Ic, Ib, gpi, gmu, gmF, gmR, go, s } = ev;

  const gcc = gmR + gmu + go;
  const gcb = gmF - gmR - gmu;
  const gce = -(gmF + go);
  const gbc = -gmu;
  const gbb = gpi + gmu;
  const gbe = -gpi;

  const add = (i, j, g) => {
    if (i >= 0 && j >= 0) G[i][j] += g;
  };

  add(ci, ci, gcc);
  add(ci, bi, gcb);
  add(ci, ei, gce);
  add(bi, ci, gbc);
  add(bi, bi, gbb);
  add(bi, ei, gbe);
  add(ei, ci, -(gcc + gbc));
  add(ei, bi, -(gcb + gbb));
  add(ei, ei, -(gce + gbe));

  void s;

  const Iceq = Ic - (gcc * vc + gcb * vb + gce * ve);
  const Ibeq = Ib - (gbc * vc + gbb * vb + gbe * ve);
  const Ieeq = -(Iceq + Ibeq);

  if (ci >= 0) rhs[ci] -= Iceq;
  if (bi >= 0) rhs[bi] -= Ibeq;
  if (ei >= 0) rhs[ei] -= Ieeq;
}
