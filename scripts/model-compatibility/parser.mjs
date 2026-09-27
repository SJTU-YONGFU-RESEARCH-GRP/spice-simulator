/** Conservative model-card parser: retain source, order, duplicates and locations. */
export const diagnostic = (code, severity, message, details = {}) => ({ code, severity, message, ...details });

export function numericValue(text) {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|mil|[tgkmunpf])?([a-z]*)$/i.exec(text);
  if (!match) return null;
  // Do not accept a broken exponent as an ignored unit suffix.
  if (!match[2] && /^e/i.test(match[3])) return null;
  const scale = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, mil: 25.4e-6, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  const value = Number(match[1]) * (scale[match[2]?.toLowerCase()] ?? 1);
  return Number.isFinite(value) ? value : null;
}

function stripComment(line) {
  let quote = null, depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (!depth && (c === ';' || c === '$')) return line.slice(0, i);
  }
  return line;
}

function parseParameters(body, line, diagnostics) {
  const parameters = [];
  let text = body.trim();
  if (text.startsWith('(')) {
    if (!text.endsWith(')')) diagnostics.push(diagnostic('SPICE_PARSE_002', 'error', 'Unclosed model parentheses.', { line }));
    else text = text.slice(1, -1);
  }
  let position = 0;
  while (position < text.length) {
    const separator = /^[\s,]+/.exec(text.slice(position));
    if (separator) position += separator[0].length;
    if (position >= text.length) break;
    const name = /^([a-z_][\w.$]*)\s*=\s*/i.exec(text.slice(position));
    if (!name) {
      diagnostics.push(diagnostic('SPICE_PARSE_003', 'error', 'Expected parameter=value.', { line, evidence: text.slice(position, position + 80) }));
      break;
    }
    position += name[0].length;
    const start = position;
    const first = text[position];
    if (first === '{' || first === "'" || first === '"') {
      const close = first === '{' ? '}' : first;
      let depth = 1;
      position++;
      while (position < text.length && depth) {
        if (first === '{' && text[position] === '{') depth++;
        if (text[position] === close) depth--;
        position++;
      }
      if (depth) diagnostics.push(diagnostic('SPICE_PARSE_002', 'error', 'Unclosed expression or quote.', { line, parameter: name[1].toUpperCase() }));
    } else {
      while (position < text.length && !/[\s,]/.test(text[position])) position++;
    }
    const value = text.slice(start, position);
    const parameter = { name: name[1].toUpperCase(), value, line, index: parameters.length };
    if (parameters.some(p => p.name === parameter.name)) diagnostics.push(diagnostic('MODEL_PARAM_002', 'warning', 'Duplicate parameter; engine precedence may differ.', { line, parameter: parameter.name }));
    if (!value) diagnostics.push(diagnostic('SPICE_PARSE_003', 'error', 'Missing parameter value.', { line, parameter: parameter.name }));
    parameters.push(parameter);
  }
  return parameters;
}

export function parseModels(source) {
  const diagnostics = [], statements = [], models = [], dependencies = [], context = [];
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*\*/.test(raw) || !raw.trim()) continue;
    const text = stripComment(raw).trim();
    if (!text) continue;
    if (text.startsWith('+')) {
      if (!current) diagnostics.push(diagnostic('SPICE_PARSE_004', 'error', 'Orphan continuation.', { line: i + 1 }));
      else { current.text += ' ' + text.slice(1).trim(); current.source += '\n' + raw; }
    } else { current = { text, source: raw, line: i + 1 }; statements.push(current); }
  }
  let libraryDepth = 0;
  const subcircuits = [];
  const scopeError = (message, line) => diagnostics.push(diagnostic('SPICE_PARSE_007', 'error', message, { line }));
  for (const statement of statements) {
    const { text, line } = statement;
    if (/^\.subckt\b/i.test(text)) {
      const declaration = /^\.subckt\s+([^\s()=]+)\s+\S+/i.exec(text);
      if (!declaration) scopeError('Malformed .subckt declaration.', line);
      if (subcircuits.length) scopeError('Nested .subckt scope is not supported; runtime skipped.', line);
      subcircuits.push({ name: declaration?.[1], line });
      continue;
    }
    if (/^\.ends\b/i.test(text)) {
      const ending = /^\.ends(?:\s+(\S+))?\s*$/i.exec(text);
      const opened = subcircuits.pop();
      if (!opened) scopeError('Unmatched .ends.', line);
      else if (!ending || (ending[1] && ending[1].toLowerCase() !== opened.name?.toLowerCase())) scopeError('.ends does not match its .subckt.', line);
      continue;
    }
    if (/^\.lib\b/i.test(text)) libraryDepth++;
    if (/^\.endl\b/i.test(text)) libraryDepth--;
    if (/^\.(include|inc|lib)\b/i.test(text)) dependencies.push({ line, directive: text });
    if (/^\.param\b/i.test(text) && !subcircuits.length && libraryDepth === 0) context.push(statement.source);
    if (!/^\.model\b/i.test(text)) continue;
    const match = /^\.model\s+([^\s()]+)\s+([a-z][\w]*)\b(.*)$/i.exec(text);
    if (!match) { diagnostics.push(diagnostic('SPICE_PARSE_001', 'error', 'Malformed .MODEL declaration.', { line, evidence: text })); continue; }
    const issues = [];
    const parameters = parseParameters(match[3], line, issues);
    const valueOf = name => parameters.find(p => p.name === name)?.value ?? null;
    const levelText = valueOf('LEVEL');
    models.push({ name: match[1], type: match[2].toUpperCase(), level: levelText === null ? null : numericValue(levelText),
      levelText, version: valueOf('VERSION'), parameterCount: parameters.length,
      parameterNames: [...new Set(parameters.map(p => p.name))].sort(), parameters,
      line, scoped: subcircuits.length > 0 || libraryDepth !== 0, source: statement.source, diagnostics: issues });
  }
  for (const opened of subcircuits) scopeError('Unclosed .subckt scope.', opened.line);
  const names = new Set();
  for (const model of models) {
    if (names.has(model.name.toLowerCase())) model.diagnostics.push(diagnostic('SPICE_PARSE_005', 'warning', 'Duplicate model name; selection is ambiguous.', { line: model.line }));
    names.add(model.name.toLowerCase());
  }
  if (!models.length && !diagnostics.length) diagnostics.push(diagnostic('SPICE_PARSE_006', 'warning', 'No .MODEL cards; subcircuit execution is not covered.'));
  return { models, dependencies, context, diagnostics };
}
