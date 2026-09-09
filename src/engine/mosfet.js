/** Level-1 MOSFET + overlap/channel C + optional RD/RS. */

export function mosParams(model, device) {
  const p = model?.params || {};
  const type = (model?.type || "NMOS").toUpperCase();
  const isP = type === "PMOS";
  return {
    isP,
    Vto: p.vto ?? p.vt0 ?? (isP ? -0.7 : 0.7),
    Kp: p.kp ?? 2e-5,
    Lambda: p.lambda ?? 0,
    W: device.w ?? p.w ?? 10e-6,
    L: device.l ?? p.l ?? 1e-6,
    Cgso: Math.max(0, p.cgso ?? 0),
    Cgdo: Math.max(0, p.cgdo ?? 0),
    Cgbo: Math.max(0, p.cgbo ?? 0),
    Cox: Math.max(0, p.cox ?? 0),
    Rd: Math.max(0, p.rd ?? 0),
    Rs: Math.max(0, p.rs ?? 0),
  };
}

/** Internal drain/source nodes when RD/RS > 0. */
export function mosIntNodes(d, params) {
  return {
    nd: params.Rd > 0 ? `${d.name}#d` : d.nd,
    ns: params.Rs > 0 ? `${d.name}#s` : d.ns,
    ng: d.ng,
    rd: params.Rd > 0 ? { ext: d.nd, mid: `${d.name}#d`, r: params.Rd } : null,
    rs: params.Rs > 0 ? { ext: d.ns, mid: `${d.name}#s`, r: params.Rs } : null,
  };
}

export function mosEval(params, vd, vg, vs) {
  const { isP, Vto, Kp, Lambda, W, L } = params;
  const beta = Kp * (W / L);

  const s = isP ? -1 : 1;
  const vds = s * (vd - vs);
  const vgs = s * (vg - vs);
  const vt = s * Vto;

  let Id = 0;
  let gm = 0;
  let gds = 0;
  let region = "off";

  if (vgs <= vt) {
    region = "off";
  } else if (vds < vgs - vt) {
    region = "lin";
    const von = vgs - vt;
    const id0 = beta * (von * vds - 0.5 * vds * vds);
    const clm = 1 + Lambda * vds;
    Id = id0 * clm;
    gm = beta * vds * clm;
    gds = beta * (von - vds) * clm + id0 * Lambda;
  } else {
    region = "sat";
    const von = vgs - vt;
    const id0 = 0.5 * beta * von * von;
    const clm = 1 + Lambda * vds;
    Id = id0 * clm;
    gm = beta * von * clm;
    gds = id0 * Lambda;
  }

  return { Id: s * Id, gm, gds, region };
}

export function mosCaps(params, region) {
  const { W, L, Cgso, Cgdo, Cgbo, Cox } = params;
  const cgsO = Cgso * W;
  const cgdO = Cgdo * W;
  const cgbO = Cgbo * L;
  const cchan = Cox * W * L;
  let cgs = cgsO;
  let cgd = cgdO;
  let cgb = cgbO;
  if (cchan > 0) {
    if (region === "off") {
      cgb += cchan;
    } else if (region === "lin") {
      cgs += cchan / 2;
      cgd += cchan / 2;
    } else {
      cgs += (2 / 3) * cchan;
    }
  }
  return { cgs, cgd, cgb };
}
