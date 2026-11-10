// Checks that this site's function environment variables fit Netlify's 4 KB
// limit for functions (AWS Lambda counts every variable's name + value).
// Prints only names and sizes — never values. Run on a machine signed in to
// the Netlify CLI and linked to this site:
//
//   netlify env:list --json --context production --scope functions | node scripts/check-env-budget.mjs
//   (repeat with --context deploy-preview for previews)
//
// Pass extra planned variables to include them, e.g. a guide not set yet:
//   ... | node scripts/check-env-budget.mjs --plan CAPTION_STYLE_GUIDE=/path/outside/repo/guide.value
import { readFileSync } from 'node:fs';

const LIMIT = 4096;
const input = readFileSync(0, 'utf8').trim();
let vars;
try { vars = JSON.parse(input || '{}'); } catch { console.error('Expected JSON from `netlify env:list --json`.'); process.exit(2); }
const sizes = new Map(Object.entries(vars).map(([k, v]) => [k, Buffer.byteLength(k) + Buffer.byteLength(String(v)) + 2]));
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plan' && args[i + 1]) {
    const [k, file] = args[++i].split('=');
    sizes.set(k, Buffer.byteLength(k) + Buffer.byteLength(readFileSync(file, 'utf8')) + 2);
  }
}
let total = 0;
for (const [k, n] of [...sizes].sort((a, b) => b[1] - a[1])) { total += n; console.log(`${k.padEnd(28)} ${String(n).padStart(5)} bytes`); }
const verdict = total <= LIMIT - 512 ? 'fits' : total <= LIMIT ? 'fits, but under 512 bytes to spare' : 'TOO LARGE';
console.log(`${'TOTAL'.padEnd(28)} ${String(total).padStart(5)} / ${LIMIT} bytes → ${verdict}`);
process.exit(total <= LIMIT ? 0 : 1);
