// Prints the private style guide as the single-line value for its Netlify
// environment variable, after checking its shape and size.
//
//   node scripts/guide-env-value.mjs /path/outside/the/repo/style-guide.json > /path/outside/the/repo/guide.value
//
// Then set it as a server-only variable (scope: Functions only, not Builds):
//   Netlify → Site configuration → Environment variables → Add a variable →
//   key as printed below, paste the value, Scopes: Functions, Deploy contexts: all.
// Changing environment variables needs a redeploy to take effect.
// Netlify functions share a 4 KB limit for ALL environment variables together.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseGuide, ENV_NAME } = require('../netlify/lib/style-guide.js');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/guide-env-value.mjs <style-guide.json>'); process.exit(2); }
const raw = readFileSync(file, 'utf8');
if (!parseGuide(raw)) { console.error('Invalid style guide file (see docs/style-guide.example.json).'); process.exit(1); }
const value = JSON.stringify(JSON.parse(raw));
const bytes = Buffer.byteLength(value) + ENV_NAME.length;
console.error(`${ENV_NAME}: ${bytes} bytes of the 4,096-byte function environment budget (other variables count too).`);
if (bytes > 3000) console.error('Warning: large. Check that all function environment variables together stay under 4 KB.');
process.stdout.write(value);
