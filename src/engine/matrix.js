/** Dense real + complex matrix helpers for small MNA systems */

export function zeros(n) {
  return Array.from({ length: n }, () => Array(n).fill(0));
}

export function zeroVec(n) {
  return Array(n).fill(0);
}

export function czeros(n) {
  return Array.from({ length: n }, () =>
    Array.from({ length: n }, () => ({ re: 0, im: 0 }))
  );
}

export function czeroVec(n) {
  return Array.from({ length: n }, () => ({ re: 0, im: 0 }));
}

export function cadd(a, b) {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function csub(a, b) {
  return { re: a.re - b.re, im: a.im - b.im };
}

export function cmul(a, b) {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
}

export function cdiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

export function cabs(a) {
  return Math.hypot(a.re, a.im);
}

export function carg(a) {
  return Math.atan2(a.im, a.re);
}

/** Solve A x = b via Gaussian elimination with partial pivoting. Mutates A,b. */
export function solve(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let max = Math.abs(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(A[row][col]);
      if (v > max) {
        max = v;
        pivot = row;
      }
    }
    if (max < 1e-18) throw new Error("Singular matrix (floating node or bad stamps?)");

    if (pivot !== col) {
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }

    const diag = A[col][col];
    for (let row = col + 1; row < n; row++) {
      const f = A[row][col] / diag;
      if (f === 0) continue;
      for (let j = col; j < n; j++) A[row][j] -= f * A[col][j];
      b[row] -= f * b[col];
    }
  }

  const x = zeroVec(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

/** Complex GE with partial pivoting. Mutates A, b. */
export function solveComplex(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let max = cabs(A[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = cabs(A[row][col]);
      if (v > max) {
        max = v;
        pivot = row;
      }
    }
    if (max < 1e-18) throw new Error("Singular complex matrix in AC analysis");

    if (pivot !== col) {
      [A[col], A[pivot]] = [A[pivot], A[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }

    const diag = A[col][col];
    for (let row = col + 1; row < n; row++) {
      const f = cdiv(A[row][col], diag);
      if (f.re === 0 && f.im === 0) continue;
      for (let j = col; j < n; j++) A[row][j] = csub(A[row][j], cmul(f, A[col][j]));
      b[row] = csub(b[row], cmul(f, b[col]));
    }
  }

  const x = czeroVec(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s = csub(s, cmul(A[i][j], x[j]));
    x[i] = cdiv(s, A[i][i]);
  }
  return x;
}

export function copyMat(A) {
  return A.map((row) => row.slice());
}

export function copyVec(v) {
  return v.slice();
}

export function copyCMat(A) {
  return A.map((row) => row.map((c) => ({ re: c.re, im: c.im })));
}

export function copyCVec(v) {
  return v.map((c) => ({ re: c.re, im: c.im }));
}

/**
 * Eigenvalues of a real n×n matrix via unshifted QR (sufficient for small MNA).
 * Returns [{ re, im }, ...] unsorted.
 */
export function eigenvaluesReal(Ain, maxIter = 200) {
  const n = Ain.length;
  if (!n) return [];
  let A = Ain.map((row) => row.slice());
  // Balance lightly
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let j = 0; j < n; j++) r += Math.abs(A[i][j]);
    if (r > 0 && Math.abs(r - 1) > 0.1) {
      const s = Math.sqrt(r);
      for (let j = 0; j < n; j++) A[i][j] /= s;
      for (let j = 0; j < n; j++) A[j][i] *= s;
    }
  }

  for (let it = 0; it < maxIter; it++) {
    const { Q, R } = qrDecompose(A);
    A = matMul(R, Q);
    // Check subdiagonal decay
    let done = true;
    for (let i = 1; i < n; i++) {
      if (Math.abs(A[i][i - 1]) > 1e-10 * (Math.abs(A[i][i]) + Math.abs(A[i - 1][i - 1]) + 1e-30)) {
        done = false;
        break;
      }
    }
    if (done) break;
  }

  const eigs = [];
  for (let i = 0; i < n; ) {
    if (i === n - 1 || Math.abs(A[i + 1][i]) < 1e-10 * (Math.abs(A[i][i]) + Math.abs(A[i + 1][i + 1]) + 1e-30)) {
      eigs.push({ re: A[i][i], im: 0 });
      i++;
    } else {
      // 2×2 block
      const a = A[i][i];
      const b = A[i][i + 1];
      const c = A[i + 1][i];
      const d = A[i + 1][i + 1];
      const tr = a + d;
      const det = a * d - b * c;
      const disc = tr * tr - 4 * det;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        eigs.push({ re: 0.5 * (tr + s), im: 0 });
        eigs.push({ re: 0.5 * (tr - s), im: 0 });
      } else {
        const s = Math.sqrt(-disc);
        eigs.push({ re: 0.5 * tr, im: 0.5 * s });
        eigs.push({ re: 0.5 * tr, im: -0.5 * s });
      }
      i += 2;
    }
  }
  return eigs;
}

function qrDecompose(A) {
  const n = A.length;
  const R = A.map((row) => row.slice());
  const Q = zeros(n);
  for (let i = 0; i < n; i++) Q[i][i] = 1;
  for (let k = 0; k < n - 1; k++) {
    // Householder on column k
    let norm = 0;
    for (let i = k; i < n; i++) norm += R[i][k] * R[i][k];
    norm = Math.sqrt(norm);
    if (norm < 1e-30) continue;
    const sign = R[k][k] >= 0 ? 1 : -1;
    const u0 = R[k][k] + sign * norm;
    const u = zeroVec(n);
    u[k] = u0;
    for (let i = k + 1; i < n; i++) u[i] = R[i][k];
    let un2 = 0;
    for (let i = k; i < n; i++) un2 += u[i] * u[i];
    if (un2 < 1e-30) continue;
    // R := (I - 2uu^T/un2) R
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = k; i < n; i++) dot += u[i] * R[i][j];
      const s = (2 * dot) / un2;
      for (let i = k; i < n; i++) R[i][j] -= s * u[i];
    }
    // Q := Q (I - 2uu^T/un2)
    for (let j = 0; j < n; j++) {
      let dot = 0;
      for (let i = k; i < n; i++) dot += u[i] * Q[j][i];
      const s = (2 * dot) / un2;
      for (let i = k; i < n; i++) Q[j][i] -= s * u[i];
    }
  }
  return { Q, R };
}

function matMul(A, B) {
  const n = A.length;
  const C = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < n; j++) C[i][j] += aik * B[k][j];
    }
  }
  return C;
}
