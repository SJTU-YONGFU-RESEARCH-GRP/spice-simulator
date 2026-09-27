import { diagnostic, numericValue } from './parser.mjs';

export const CAPABILITIES = [
  { levels: [1], family: 'MOS1' }, { levels: [2], family: 'MOS2' },
  { levels: [3], family: 'MOS3' }, { levels: [8, 49], family: 'BSIM3' },
  { levels: [14, 54], family: 'BSIM4' },
].map(row => ({ ...row, upstream: 'ngspice family mapping', shippedWasm: 'UNVERIFIED' }));

// Deliberately partial vocabulary, not a claim that every other parameter is illegal.
const COMMON = 'LEVEL VERSION TNOM TOX U0 VTO KP GAMMA PHI LAMBDA RD RS RSH CGSO CGDO CGBO CBD CBS PB MJ MJSW CJSW CJ IS JS NJS XJ LD NSUB NSS TPG';
const BSIM3 = 'VTH0 TOXM VSAT K1 K2 K3 K3B W0 NLX DVT0 DVT1 DVT2 DVT0W DVT1W DVT2W UTE UA UB UC UA1 UB1 UC1 RDSW PRWG PRWB WR DWG DWB PCLM PDIBLC1 PDIBLC2 PDIBLCB PSCBE1 PSCBE2 PVAG DELTA ETA0 ETAB DSUB CIT CDSC CDSCB CDSCD NFACTOR NOFF VOFF VOFFCV CAPMOD XPART CGSL CGDL CKAPPA ACM CALCACM NQSMOD ELM NGATE KT1 KT2 KT1L LINT WINT LL LLC LLN LW LWC LWN WL WLC WLN WW WWC WWN DLC DWC DROUT A0 A1 A2 AGS B0 B1 ALPHA0 ALPHA1 BETA0 IJTH MOBMOD BINUNIT PARAMCHK LMIN LMAX WMIN WMAX NOIMOD EM EF AF KF JSW PBSW PBSWG MJSWG CJSWG NJ XTI';
const BSIM4 = BSIM3 + ' EOT TOXE TOXP EPSROX RDSMOD RGATEMOD PERMOD ACNQSMOD TRNQSMOD IGCMOD IGBMOD GEOMOD RGEOMOD MINV MINVCV CKAPPAS CKAPPAD RDSWMIN VFBSDOFF DVTP0 DVTP1';
const vocabulary = words => new Set((COMMON + ' ' + words).split(/\s+/));
const known = { MOS1: vocabulary(''), MOS2: vocabulary('UEXP UCRIT UTRA VMAX NEFF'), MOS3: vocabulary('THETA ETA KAPPA VMAX'), BSIM3: vocabulary(BSIM3), BSIM4: vocabulary(BSIM4) };

export function analyzeModel(model, parsed) {
  const diagnostics = [...parsed.diagnostics, ...model.diagnostics];
  const mos = ['NMOS', 'PMOS'].includes(model.type);
  const effectiveLevel = model.levelText === null && mos ? 1 : model.level;
  const capability = CAPABILITIES.find(row => row.levels.includes(effectiveLevel));
  const family = mos ? capability?.family ?? 'UNKNOWN' : model.type;
  let unsupported = !mos || !capability;
  if (!mos) diagnostics.push(diagnostic('MODEL_TYPE_001', 'warning', 'Device type has no runtime fixture.', { deviceType: model.type }));
  if (mos && model.levelText === null) diagnostics.push(diagnostic('MODEL_LEVEL_002', 'warning', 'Missing LEVEL; MOS default LEVEL=1 assumed.'));
  if (mos && model.levelText !== null && (model.level === null || !Number.isInteger(model.level))) diagnostics.push(diagnostic('MODEL_LEVEL_003', 'error', 'LEVEL must be a numeric integer.'));
  else if (mos && !capability) diagnostics.push(diagnostic('MODEL_LEVEL_001', 'error', 'LEVEL is outside the analyzer capability matrix.', { level: effectiveLevel }));
  for (const p of model.parameters) {
    const expression = /^[{'"]/.test(p.value);
    if (expression) diagnostics.push(diagnostic('MODEL_PARAM_004', 'warning', 'Expression retained for the engine; static value unverified.', { parameter: p.name }));
    else if (!(p.name === 'VERSION' && /^\d+(?:\.\d+)+$/.test(p.value)) && numericValue(p.value) === null) diagnostics.push(diagnostic('MODEL_PARAM_003', 'error', 'Malformed numeric value.', { parameter: p.name, evidence: p.value }));
    const vocabulary = known[family];
    if (vocabulary && !vocabulary.has(p.name) && !(family.startsWith('BSIM') && /^[LWP]/.test(p.name) && vocabulary.has(p.name.slice(1)))) diagnostics.push(diagnostic('MODEL_PARAM_001', 'warning', 'Parameter not in the partial family vocabulary; engine evidence required.', { parameter: p.name }));
  }
  if (parsed.dependencies.length || model.scoped) diagnostics.push(diagnostic('MODEL_DEP_001', 'warning', 'Include/lib or scoped model requires context resolution; runtime skipped.'));
  const invalid = diagnostics.some(d => d.severity === 'error' && d.code !== 'MODEL_LEVEL_001');
  const status = invalid ? 'INVALID' : unsupported ? 'UNSUPPORTED' : diagnostics.some(d => d.severity === 'warning') ? 'WARNING' : 'PASS';
  return { status, family, effectiveLevel, diagnostics };
}
