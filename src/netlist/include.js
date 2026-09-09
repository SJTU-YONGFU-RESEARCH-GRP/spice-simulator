/**
 * Expand .include / .inc "path" directives.
 * Browser: fetch relative to page (or opts.baseUrl).
 * opts.files: Map/object of path → text for virtual libs / file picker.
 */

export async function expandIncludes(text, opts = {}) {
  const files = normalizeFiles(opts.files);
  const baseUrl = opts.baseUrl || (typeof location !== "undefined" ? location.href : "");
  const maxDepth = opts.maxDepth ?? 8;
  return expand(text, baseUrl, files, 0, maxDepth, new Set());
}

function normalizeFiles(files) {
  const map = new Map();
  if (!files) return map;
  if (files instanceof Map) {
    for (const [k, v] of files) map.set(normPath(k), String(v));
  } else {
    for (const [k, v] of Object.entries(files)) map.set(normPath(k), String(v));
  }
  return map;
}

function normPath(p) {
  return String(p).replace(/\\/g, "/").replace(/^["']|["']$/g, "").trim();
}

async function expand(text, baseUrl, files, depth, maxDepth, stack) {
  if (depth > maxDepth) throw new Error(".include nesting too deep");
  const lines = text.split(/\r?\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = stripComment(raw).trim();
    const low = t.toLowerCase();
    if (!low.startsWith(".include") && !low.startsWith(".inc")) {
      out.push(raw);
      continue;
    }
    const m = t.match(/^\.(?:include|inc)\s+(.+)$/i);
    if (!m) throw new Error(`.include needs a path (near line ${i + 1})`);
    let path = normPath(m[1]);
    if (stack.has(path)) throw new Error(`.include cycle: ${path}`);

    let body = files.get(path) || files.get(path.toLowerCase());
    if (body == null) {
      // try basename
      const base = path.split("/").pop();
      body = files.get(base) || files.get(base?.toLowerCase());
    }
    if (body == null && baseUrl && typeof fetch === "function") {
      try {
        const url = new URL(path, baseUrl).href;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body = await res.text();
      } catch (e) {
        throw new Error(`.include '${path}' failed: ${e.message || e}`);
      }
    }
    if (body == null) {
      throw new Error(`.include '${path}' not found (add via Library or place under ./lib/)`);
    }

    stack.add(path);
    const nested = await expand(body, new URL(path, baseUrl || "file:///").href, files, depth + 1, maxDepth, stack);
    stack.delete(path);
    out.push(`* begin .include ${path}`);
    out.push(nested.replace(/\s*$/, ""));
    out.push(`* end .include ${path}`);
  }
  return out.join("\n");
}

function stripComment(line) {
  const s = line.indexOf(";");
  return s >= 0 ? line.slice(0, s) : line;
}
