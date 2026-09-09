/**
 * Expand .subckt / .ends definitions and X instances into flat netlist lines.
 * Built-in OPAMP: high-gain VCVS if user references OPAMP without defining it.
 */

const BUILTIN = {
  OPAMP: {
    ports: ["plus", "minus", "out"],
    body: ["E__oa out 0 plus minus 100000", "R__oa out 0 1G"],
  },
};

/**
 * @param {string} text - after .param expansion
 * @returns {string}
 */
export function expandSubcircuits(text) {
  const lines = text.split(/\r?\n/);
  const subckts = new Map(Object.entries(BUILTIN).map(([k, v]) => [k, { ...v, body: [...v.body] }]));

  // First pass: collect .subckt definitions (remove from stream)
  const top = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const t = stripComment(raw).trim();
    const low = t.toLowerCase();
    if (low.startsWith(".subckt")) {
      const parts = tokenize(t);
      const name = (parts[1] || "").toUpperCase();
      const ports = parts.slice(2);
      const body = [];
      i++;
      while (i < lines.length) {
        const t2 = stripComment(lines[i]).trim();
        if (t2.toLowerCase().startsWith(".ends")) {
          i++;
          break;
        }
        if (t2 && !t2.startsWith("*")) body.push(lines[i]);
        i++;
      }
      if (!name) throw new Error(".subckt needs a name");
      subckts.set(name, { ports, body });
      continue;
    }
    top.push(raw);
    i++;
  }

  // Expand X instances (may nest one level — iterate)
  let current = top;
  for (let pass = 0; pass < 8; pass++) {
    const { lines: next, expanded } = expandXOnce(current, subckts);
    current = next;
    if (!expanded) break;
  }
  return current.join("\n");
}

function expandXOnce(lines, subckts) {
  const out = [];
  let expanded = false;
  for (const raw of lines) {
    const t = stripComment(raw).trim();
    if (!t || t.startsWith("*") || t.startsWith(".")) {
      out.push(raw);
      continue;
    }
    const parts = tokenize(t);
    const head = parts[0] || "";
    if (head[0]?.toUpperCase() !== "X") {
      out.push(raw);
      continue;
    }
    // Xname n1 n2 … nN subname  — last token must be a known .subckt
    if (parts.length < 3) throw new Error(`${head}: need nodes and subckt name`);
    const subName = parts[parts.length - 1].toUpperCase();
    if (!subckts.has(subName)) {
      // Not an instance call (e.g. already-expanded X1_E__oa …)
      out.push(raw);
      continue;
    }
    const nodes = parts.slice(1, -1).map(normalizeNode);
    const def = subckts.get(subName);
    if (nodes.length !== def.ports.length) {
      throw new Error(
        `${head}: ${subName} expects ${def.ports.length} ports (${def.ports.join(",")}), got ${nodes.length}`
      );
    }
    expanded = true;
    const prefix = head.replace(/^X/i, "U") + "_";
    const portMap = new Map();
    def.ports.forEach((p, idx) => portMap.set(p.toLowerCase(), nodes[idx]));
    portMap.set("0", "0");
    portMap.set("gnd", "0");

    out.push(`* expanded ${head} -> ${subName}`);
    for (const bline of def.body) {
      out.push(remapSubLine(bline, prefix, portMap));
    }
  }
  return { lines: out, expanded };
}

function remapSubLine(line, prefix, portMap) {
  const commentIdx = line.indexOf(";");
  const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";
  let code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
  const parts = tokenize(code.trim());
  if (!parts.length) return line;

  const head = parts[0];
  const kind = head[0].toUpperCase();
  parts[0] = kind + prefix + head.slice(1);

  if (kind === "K") {
    // Remap coupled inductor instance names
    if (parts[1]) parts[1] = remapDevName(parts[1], prefix);
    if (parts[2]) parts[2] = remapDevName(parts[2], prefix);
    return parts.join(" ") + comment;
  }

  const nodeCount = nodeArity(kind, parts);
  for (let i = 1; i <= nodeCount && i < parts.length; i++) {
    const low = parts[i].toLowerCase();
    if (portMap.has(low)) parts[i] = portMap.get(low);
    else if (parts[i] !== "0") parts[i] = prefix + parts[i];
  }

  return parts.join(" ") + comment;
}

function remapDevName(name, prefix) {
  const n = String(name);
  if (!n) return n;
  return n[0] + prefix + n.slice(1);
}

function nodeArity(kind, parts) {
  if (kind === "K") return 0;
  if ("RCLVID".includes(kind)) return 2;
  if (kind === "E" || kind === "G" || kind === "S") return 4;
  if (kind === "F" || kind === "H" || kind === "W") return 3; // n+ n- Vname
  if (kind === "M") return parts.length >= 6 && !parts[5].includes("=") ? 4 : 3;
  if (kind === "Q") return parts.length >= 6 ? 4 : 3;
  if (kind === "X") return Math.max(0, parts.length - 2);
  return 2;
}

function stripComment(line) {
  const s = line.indexOf(";");
  return s >= 0 ? line.slice(0, s) : line;
}

function normalizeNode(n) {
  const s = String(n);
  if (s === "gnd" || s === "GND" || s === "ground") return "0";
  return s;
}

function tokenize(line) {
  const normalized = line
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ") ")
    .replace(/,\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = [];
  let cur = "";
  let depth = 0;
  for (const ch of normalized) {
    if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
