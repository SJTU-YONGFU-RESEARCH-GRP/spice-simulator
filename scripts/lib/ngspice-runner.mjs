// Shared Node adapter for the shipped Emscripten engine. One invocation per process.
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseRaw(text) {
  const lines = text.split(/\r?\n/);
  let plotname = null;
  for (const l of lines) {
    const m = l.match(/^Plotname:\s*(.*)$/);
    if (m) plotname = m[1].trim();
  }
  const vi = lines.findIndex((l) => /^Variables:/.test(l));
  const si = lines.findIndex((l) => /^Values:/.test(l));
  const variables = [];
  for (let i = vi + 1; i >= 0 && i < si; i++) {
    const m = lines[i].match(/^\s*(\d+)\s+(\S+)/);
    if (m) variables.push({ index: Number(m[1]), name: m[2] });
  }
  const points = [];
  let cur = null;
  if (si >= 0) {
    for (let i = si + 1; i < lines.length; i++) {
      const raw = lines[i];
      const m = raw.match(/^\s*(\d+)\t(.*)$/);
      if (m) {
        if (cur) points.push(cur);
        cur = [m[2]];
      } else {
        const v = raw.replace(/^\s+/, '').trim();
        if (v !== '' && cur) cur.push(v);
      }
    }
    if (cur) points.push(cur);
  }
  return { plotname, variables, points };
}

export async function runDeck(c, vendor) {
  const stdout = [], stderr = [];
  let exitStatus = null, exception = null;
  const dir = mkdtempSync(join(tmpdir(), 'ngspice-deck-'));
  const modulePath = join(dir, 'ngspice.mjs');
  try {
    copyFileSync(vendor, modulePath); // .mjs forces ESM regardless of package type
    const { default: createNgspiceModule } = await import(pathToFileURL(modulePath).href);
    const mod = await createNgspiceModule({ print: (s) => stdout.push(String(s)), printErr: (s) => stderr.push(String(s)) });

    const mkdirp = (p) => {
      let acc = '';
      for (const seg of p.split('/').filter(Boolean)) {
        acc += '/' + seg;
        try { mod.FS.mkdir(acc); } catch {}
      }
    };
    mkdirp('/proc/self');
    mkdirp('/usr/local/share/ngspice/scripts');
    mkdirp('/models');
    // Missing /proc/meminfo makes ngspice abort with a misleading memory error.
    mod.FS.writeFile('/proc/meminfo',
      'MemTotal:       16777216 kB\nMemFree:        8388608 kB\nMemAvailable:   8388608 kB\n');
    mod.FS.writeFile('/proc/self/statm', '0 0 0 0 0 0 0\n');
    mod.FS.writeFile('/usr/local/share/ngspice/scripts/spinit',
      'set filetype=ascii\nset ngbehavior=lt\n');
    // Extra files the case needs inside the virtual FS. The corner cases put the
    // artifact's own model library at the path the executor's constant resolves
    // to, so the deck text is the deck the application would assemble.
    for (const [p, text] of Object.entries(c.files ?? {})) {
      mkdirp(p.slice(0, p.lastIndexOf('/')));
      mod.FS.writeFile(p, text);
    }
    mod.FS.writeFile('/circuit.cir', c.deck.trim());
    try { mod.FS.unlink('/out.raw'); } catch {}
    mod.noExitRuntime = true;

    const argvOf = (list) => {
      const ptrs = list.map((s) => mod.stringToUTF8OnStack(s));
      const argv = mod.stackAlloc((list.length + 1) * 4);
      for (let i = 0; i < ptrs.length; i++) mod.HEAP32[(argv >> 2) + i] = ptrs[i];
      mod.HEAP32[(argv >> 2) + ptrs.length] = 0;
      return { argc: list.length, argv };
    };
    try {
      const { argc, argv } = argvOf(['ngspice', '-b', '-r', '/out.raw', '/circuit.cir']);
      exitStatus = mod._main(argc, argv) ?? 0; // Emscripten may signal exit through an ExitStatus exception.
    } catch (error) {
      if (typeof error?.status === "number") exitStatus = error.status;
      else exception = String(error?.message ?? error);
    }

    let raw = null;
    try { raw = mod.FS.readFile('/out.raw', { encoding: 'utf8' }); } catch {}
    return { exitStatus, exception, stdout, stderr, rawPresent: !!raw,
      parsed: raw ? parseRaw(raw) : { plotname: null, variables: [], points: [] } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
