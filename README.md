
## Private style guide (not in Git)

The writing guide (voice, rules, examples, prompt template) is confidential and
lives only in the server-only environment variable `CAPTION_STYLE_GUIDE` (scope: **Functions**).
The prompt is assembled on the server after the password check, and only the
generated text is returned. If the variable is missing or invalid, the tool
answers 503 "Style guide is not configured" before any paid model call.

Setup (owner approval required; it changes production configuration):
1. Keep the real guide JSON **outside** this repository. Shape: `docs/style-guide.example.json` (fictional).
2. `node scripts/guide-env-value.mjs /path/to/guide.json > /path/outside/repo/guide.value`
   (checks the shape and the 4 KB function-environment budget).
3. Netlify → Site configuration → Environment variables → add `CAPTION_STYLE_GUIDE`, paste the value,
   Scopes: **Functions only**, all deploy contexts. Redeploy.

Other settings: PASSWORD (the PIN), SESSION_SECRET (random, at least 32 characters,
different from other secrets), SHEET_ID, ANTHROPIC_API_KEY. Sign-in sends the PIN once to
`/.netlify/functions/session`, which sets an expiring HttpOnly session cookie (12 h); the
PIN is no longer stored in the browser. Changing PASSWORD or SESSION_SECRET signs everyone out.

Check the 4 KB function-environment budget (prints names and sizes only):
`netlify env:list --json --context production --scope functions | node scripts/check-env-budget.mjs --plan CAPTION_STYLE_GUIDE=/path/outside/repo/guide.value`

Tests: `npm test` (mocked model, fictional guide and credentials). The browser test runs when
Playwright is installed (`npm i -D playwright && npx playwright install chromium`) and is skipped otherwise.

Preview check (no paid model call): `PREVIEW_PASSWORD=<password> node scripts/preview-check.mjs https://deploy-preview-N--<site>.netlify.app --guide /path/outside/repo/guide.json`
— confirms unauthenticated requests are refused, sign-in works, the function can read the private
guide (400 for a deliberately incomplete request; 503 means missing or unreadable), and the
published page contains no guide text (prints counts only).
