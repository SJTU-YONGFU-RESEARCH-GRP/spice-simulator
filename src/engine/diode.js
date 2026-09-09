/** Diode Shockley + Rs/BV + Cjo/TT + IKF/ISR recombination. */

export function diodeParams(model) {
  const p = model?.params || {};
  return {
    Is: p.is ?? 1e-14,
    N: p.n ?? 1,
    Vt: p.vt ?? 0.026,
    Rs: Math.max(0, p.rs ?? 0),
    BV: p.bv ?? p.vb ?? 0,
    Ibv: p.ibv ?? p.ibreak ?? null,
    Cjo: Math.max(0, p.cjo ?? p.cj0 ?? p.cj ?? 0),
    Vj: p.vj ?? p.pb ?? 1,
    M: p.m ?? p.mj ?? 0.5,
    FC: p.fc ?? 0.5,
    TT: Math.max(0, p.tt ?? 0),
    IKF: Math.max(0, p.ikf ?? p.ik ?? 0),
    ISR: Math.max(0, p.isr ?? 0),
    NR: p.nr ?? 2,
  };
}

/**
 * Evaluate diode current and conductance at junction voltage vd.
 * @returns {{ Id: number, Gd: number, vdUsed: number }}
 */
export function diodeEval(params, vd) {
  const { Is, N, Vt, BV, IKF, ISR, NR } = params;
  const nVt = N * Vt;
  const Ibv = params.Ibv != null ? params.Ibv : Is;

  if (BV > 0 && vd < -BV) {
    const over = -vd - BV;
    const e = Math.exp(Math.min(over / Math.max(nVt, 1e-3), 12));
    const Id = -Ibv * (e - 1);
    const Gd = Math.max((Ibv * e) / Math.max(nVt, 1e-3), 1e-12);
    return { Id, Gd, vdUsed: vd };
  }

  const vdLim = Math.max(-1.5, Math.min(vd, 0.9));
  const expTerm = Math.exp(vdLim / nVt);
  let Id = Is * (expTerm - 1);
  let Gd = Math.max((Is * expTerm) / nVt, 1e-12);

  // High-injection knee (SPICE-ish): Id → Id / sqrt(1 + Id/IKF)
  if (IKF > 0 && Id > 0) {
    const x = Id / IKF;
    const den = Math.sqrt(1 + x);
    const Id2 = Id / den;
    // d(Id2)/dId = (1 + x/2) / (1+x)^{3/2}
    const dId2_dId = (1 + 0.5 * x) / Math.pow(1 + x, 1.5);
    Gd = Math.max(Gd * dId2_dId, 1e-12);
    Id = Id2;
  }

  // Recombination current ISR*(exp(vd/(NR·Vt))−1)
  if (ISR > 0) {
    const nrVt = Math.max(NR, 0.1) * Vt;
    const er = Math.exp(vdLim / nrVt);
    Id += ISR * (er - 1);
    Gd += Math.max((ISR * er) / nrVt, 0);
  }

  return { Id, Gd, vdUsed: vdLim };
}

/**
 * Junction + diffusion capacitance at bias (SPICE3-style Cjo/Vj/M/FC + TT·Gd).
 */
export function diodeCapacitance(params, vd, Gd) {
  const cdiff = params.TT > 0 ? params.TT * Math.max(Gd, 0) : 0;
  const Cjo = params.Cjo || 0;
  if (!(Cjo > 0)) return cdiff;

  const Vj = Math.max(params.Vj || 1, 1e-3);
  const M = params.M ?? 0.5;
  const FC = Math.min(Math.max(params.FC ?? 0.5, 0), 0.95);
  let cj;
  if (vd < FC * Vj) {
    const arg = Math.max(1e-6, 1 - vd / Vj);
    cj = Cjo * Math.pow(arg, -M);
  } else {
    const arg = 1 - FC;
    const sarg = Math.pow(arg, -(M + 1));
    const f2 = Cjo * sarg;
    const f3 = (Cjo * M * sarg * arg) / Vj;
    cj = f2 + f3 * vd;
  }
  cj = Math.min(Math.max(cj, 0), Cjo * 1e6);
  return cdiff + cj;
}

/** Internal series-R node name for a diode instance. */
export function diodeRsNode(d) {
  return `${d.name}#rs`;
}
