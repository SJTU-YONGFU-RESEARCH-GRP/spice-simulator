import { readFileSync } from 'node:fs';
import { runDeck } from '../lib/ngspice-runner.mjs';

// Private worker protocol: stdout marker survives incidental Emscripten logging.
try {
  const { deck, files, vendor } = JSON.parse(readFileSync(0, 'utf8'));
  const result = await runDeck({ deck, files }, vendor);
  process.stdout.write('\nMODEL_PROBE_RESULT=' + JSON.stringify(result) + '\n');
  process.exit(0);
} catch (error) {
  process.stdout.write('\nMODEL_PROBE_RESULT=' + JSON.stringify({ toolError: String(error.message ?? error) }) + '\n');
  process.exit(0);
}
