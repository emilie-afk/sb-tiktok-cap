// Browser test of the real page against the real functions (mocked sheet and model, fictional values).
// Needs Playwright and Chrome/Chromium; skipped when Playwright isn't installed.
// Set CHROME_PATH to use an installed Chrome instead of Playwright's Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }

const ROOT = path.join(__dirname, '..');
const GUIDE = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'style-guide.example.json'), 'utf8')));
const ENV = { PASSWORD: 'fictional-pin', SESSION_SECRET: 'fictional-session-secret-0123456789abcdef', SHEET_ID: 'FICTIONAL_SHEET', ANTHROPIC_API_KEY: 'test-key-not-real', CAPTION_STYLE_GUIDE: GUIDE };

test('PIN sign-in uses a server session; nothing stored; captions still work', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async () => {
  const sheet = 'x(' + JSON.stringify({ table: { cols: [{ label: 'date_posted' }, { label: 'caption' }], rows: [{ c: [{ v: '2026-03-01' }, { v: 'Echeveria care tip: water only when the soil is fully dry 🌵 #succulents #echeveria' }] }] } }) + ');';
  const calls = { sheet: 0, model: 0 };
  const fetch = async (u) => String(u).includes('docs.google.com') ? (calls.sheet++, new Response(sheet)) : (calls.model++, new Response(JSON.stringify({ content: [{ text: 'CAPTION: Echeveria tip 🌵\nHASHTAGS: #succulents #echeveria' }] })));
  const fns = {
    '/.netlify/functions/session': require('../netlify/functions/session.js').createHandler({ env: ENV }),
    '/.netlify/functions/generate': require('../netlify/functions/generate.js').createHandler({ env: ENV, fetch }),
  };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(ROOT, 'index.html'))); }
    const fn = fns[req.url]; if (!fn) { res.writeHead(404); return res.end(); }
    const r = await fn({ httpMethod: req.method, headers: req.headers, body }); res.writeHead(r.statusCode, r.headers); res.end(r.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { if (!window.name) { sessionStorage.setItem('sbx_pin', 'old-raw-pin'); window.name = 'seeded'; } });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${server.address().port}/`);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('sbx_pin')), null, 'old stored PIN removed');
    await page.fill('#pin-input', 'wrong'); await page.click('#pin-screen button');
    await page.waitForFunction(() => document.getElementById('pin-error').textContent.includes('Wrong PIN'));
    assert.ok(await page.isVisible('#pin-screen'));
    await page.fill('#pin-input', ENV.PASSWORD); await page.click('#pin-screen button');
    await page.waitForSelector('#main-screen', { state: 'visible' });
    assert.equal(await page.evaluate(() => sessionStorage.length + localStorage.length), 0, 'nothing stored in the browser');
    assert.equal(await page.evaluate(() => document.cookie), '', 'cookie not readable by scripts');
    await page.reload(); await page.waitForSelector('#main-screen', { state: 'visible' });
    await page.fill('#description', 'repotting an echeveria'); await page.click('#generate-btn');
    await page.waitForSelector('#output-section', { state: 'visible' });
    assert.equal(await page.textContent('#caption-output'), 'Echeveria tip 🌵');
    assert.equal(await page.textContent('#hashtags-output'), '#succulents #echeveria');
    assert.deepEqual(calls, { sheet: 1, model: 1 });
    // session gone (e.g. expired) → back to the PIN screen with a clear message, no sheet/model use
    await ctx.clearCookies();
    await page.click('#generate-btn');
    await page.waitForSelector('#pin-screen', { state: 'visible' });
    assert.match(await page.textContent('#pin-error'), /session ended/i);
    assert.deepEqual(calls, { sheet: 1, model: 1 });
  } finally { await browser.close(); server.close(); }
});
