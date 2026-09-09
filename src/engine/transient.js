import {

  buildIndex,

  solveNonlinear,

  captureState,

  applyIc,

  applyNodeset,

  nodeVoltage,

  dcOp,

} from "./circuit.js";

import { zeroVec } from "./matrix.js";



/**

 * Transient analysis — fixed-step or adaptive (LTE via trap vs BE).

 *

 * Options:

 *   tstep, tstop, tmax, method ('trap'|'be'),

 *   adaptive (default false), reltol, abstol,

 *   onProgress, signal

 */

export function transient(circuit, {

  tstep,

  tstop,

  tmax,

  method,

  adaptive,

  reltol,

  abstol,

  onProgress,

  signal,

} = {}) {

  const suggested = tstep ?? circuit.analysis.tstep ?? 1e-5;

  const stop = tstop ?? circuit.analysis.tstop ?? 1e-3;

  const integ = method ?? circuit.options?.method ?? circuit.analysis.method ?? "trap";

  const useAdaptive = adaptive ?? circuit.analysis.adaptive ?? false;

  const maxStep = tmax ?? circuit.analysis.tmax ?? suggested;

  const minStep = Math.max(stop / 1e6, 1e-15);

  const rtol = reltol ?? circuit.options?.reltol ?? 1e-3;

  const atol = abstol ?? circuit.options?.abstol ?? 1e-6;



  if (suggested <= 0 || stop <= 0) throw new Error("tstep and tstop must be > 0");

  if (suggested > stop) throw new Error("tstep must be <= tstop");

  if (maxStep <= 0) throw new Error("tmax must be > 0");



  const index = buildIndex(circuit);

  if (index.n === 0) throw new Error("No unknowns — add nodes other than ground");



  const { x: x0, state: state0, dc } = initTran(circuit, index, {

    step: Math.min(suggested, maxStep),

    integ,

  });



  let x = x0;

  let state = state0;



  const times = [0];

  const series = {};

  for (const name of index.nodeNames) {

    series[`v(${name})`] = [nodeVoltage(index, x, name)];

  }

  for (const d of index.branchDevices) {

    series[`i(${d.name})`] = [x[index.branchIndex.get(d.name)]];

  }



  const pushPoint = (t, xv) => {

    times.push(t);

    for (const name of index.nodeNames) {

      series[`v(${name})`].push(nodeVoltage(index, xv, name));

    }

    for (const d of index.branchDevices) {

      series[`i(${d.name})`].push(xv[index.branchIndex.get(d.name)]);

    }

  };



  if (!useAdaptive) {

    const step = suggested;

    const nSteps = Math.ceil(stop / step);



    for (let s = 0; s < nSteps; s++) {

      if (signal?.aborted) {

        return { times, series, aborted: true, steps: s, dc, method: integ, adaptive: false };

      }



      const t = Math.min((s + 1) * step, stop);

      const { x: xNew, converged, iterations } = solveNonlinear(circuit, index, {

        mode: "tran",

        dt: step,

        t,

        state,

        x0: x,

        method: integ,

      });



      if (!converged) {

        throw new Error(`TRAN failed to converge at t=${t} (${iterations} NR iters)`);

      }



      const prev = state;

      x = xNew;

      state = captureState(circuit, index, x, prev, { dt: step, method: integ });

      pushPoint(t, x);



      if (onProgress && s % 32 === 0) onProgress(t / stop);

    }



    return { times, series, aborted: false, steps: nSteps, dc, method: integ, adaptive: false };

  }



  // --- Adaptive path: primary method + BE companion for LTE ---

  let t = 0;

  let h = Math.min(suggested, maxStep);

  let steps = 0;

  let rejects = 0;

  const maxRejects = 50;



  while (t < stop - minStep * 0.5) {

    if (signal?.aborted) {

      return { times, series, aborted: true, steps, dc, method: integ, adaptive: true };

    }



    let hTry = Math.min(h, maxStep, stop - t);

    if (hTry < minStep) hTry = Math.min(minStep, stop - t);



    const tNew = t + hTry;



    const rTrap = solveNonlinear(circuit, index, {

      mode: "tran",

      dt: hTry,

      t: tNew,

      state,

      x0: x,

      method: integ,

    });



    if (!rTrap.converged) {

      rejects++;

      if (hTry <= minStep * 1.01 || rejects > maxRejects) {

        throw new Error(

          `TRAN failed to converge at t=${tNew} (dt=${hTry}, ${rTrap.iterations} NR iters)`

        );

      }

      h = Math.max(hTry * 0.5, minStep);

      continue;

    }



    // LTE estimate: compare primary solution vs Backward Euler from same state

    const beMethod = integ === "be" ? "trap" : "be";

    const rAlt = solveNonlinear(circuit, index, {

      mode: "tran",

      dt: hTry,

      t: tNew,

      state,

      x0: x,

      method: beMethod,

    });



    let errRatio = 0;

    if (rAlt.converged) {

      errRatio = lteRatio(x, rTrap.x, rAlt.x, rtol, atol);

    } else {

      // Alternate method failed — treat as large error, shrink

      errRatio = 2;

    }



    // Order of difference ~ O(h²) → scale with 1/2; safety factor

    const safety = 0.9;

    let hNew;

    if (errRatio < 1e-14) {

      hNew = hTry * 2;

    } else {

      hNew = hTry * safety * Math.pow(1 / errRatio, 0.5);

    }

    hNew = Math.min(Math.max(hNew, minStep), maxStep);



    if (errRatio > 1.0 && hTry > minStep * 1.01) {

      rejects++;

      if (rejects > maxRejects) {

        throw new Error(`TRAN LTE control failed near t=${t} (dt=${hTry}, err=${errRatio})`);

      }

      h = hNew;

      continue;

    }



    // Accept step

    rejects = 0;

    const prev = state;

    x = rTrap.x;

    state = captureState(circuit, index, x, prev, { dt: hTry, method: integ });

    t = tNew;

    pushPoint(t, x);

    steps++;

    h = hNew;



    if (onProgress && steps % 16 === 0) onProgress(t / stop);

  }



  if (onProgress) onProgress(1);



  return { times, series, aborted: false, steps, dc, method: integ, adaptive: true };

}



function lteRatio(xPrev, xPrimary, xAlt, rtol, atol) {

  let ratio = 0;

  for (let i = 0; i < xPrimary.length; i++) {

    // |trap − BE| estimates local disagreement; /3 softens BE-dominated bias

    const lte = Math.abs(xPrimary[i] - xAlt[i]) / 3;

    const scale =

      rtol * Math.max(Math.abs(xPrimary[i]), Math.abs(xPrev[i]), Math.abs(xAlt[i])) + atol;

    ratio = Math.max(ratio, lte / scale);

  }

  return ratio;

}



function initTran(circuit, index, { step, integ }) {

  const uic = circuit.analysis.uic ?? false;

  let dc;

  let x;

  let state;



  if (uic) {

    x = applyNodeset(circuit, index, zeroVec(index.n));

    state = { vC: new Map(), iC: new Map(), iL: new Map(), vL: new Map() };

    for (const d of circuit.devices) {

      if (d.type === "C") {

        state.vC.set(d.name, 0);

        state.iC.set(d.name, 0);

      }

      if (d.type === "L") {

        state.iL.set(d.name, 0);

        state.vL.set(d.name, 0);

      }

    }

    ({ state, x } = applyIc(circuit, index, state, x));

    const r0 = solveNonlinear(circuit, index, {

      mode: "tran",

      dt: step,

      t: 0,

      state,

      x0: x,

      method: integ,

    });

    if (!r0.converged) throw new Error("UIC initial point did not converge");

    x = r0.x;

    state = captureState(circuit, index, x, state, { dt: step, method: integ });

    dc = {

      nodes: Object.fromEntries([

        ["0", 0],

        ...index.nodeNames.map((n) => [n, nodeVoltage(index, x, n)]),

      ]),

      currents: Object.fromEntries(

        index.branchDevices.map((d) => [d.name, x[index.branchIndex.get(d.name)]])

      ),

      iterations: r0.iterations,

    };

  } else {

    dc = dcOp(circuit);

    x = dc.x.slice();

    state = captureState(circuit, index, x, {}, { dt: step, method: integ });

    for (const d of circuit.devices) {

      if (d.type === "C") state.iC.set(d.name, 0);

    }

  }



  return { x, state, dc };

}


