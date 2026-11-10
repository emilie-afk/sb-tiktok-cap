// Run: npm test  (node:test; mocked sheet and model, fictional values only)
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../netlify/functions/generate.js');

const SHEET_ID = 'FICTIONAL_SHEET_ID_abcdefghijklmnop';
const GUIDE = JSON.stringify(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'style-guide.example.json'), 'utf8')));
const ENV = { PASSWORD: 'fictional-pin', SESSION_SECRET: 'fictional-session-secret-0123456789abcdef', SHEET_ID, ANTHROPIC_API_KEY: 'test-key-not-real', CAPTION_STYLE_GUIDE: GUIDE };
const S = require('../netlify/lib/session.js');
const sessionHandler = require('../netlify/functions/session.js');
const COOKIE = S.COOKIE + '=' + S.issue(ENV).value;   // a valid session for ENV

function gviz(rows) {
  const table = {
    cols: [{ label: 'date_posted' }, { label: 'caption' }, { label: 'views' }],
    rows: rows.map((r) => ({ c: [{ v: r[0] }, { v: r[1] }, { v: r[2] }] })),
  };
  return '/*O_o*/\ngoogle.visualization.Query.setResponse(' + JSON.stringify({ table }) + ');';
}
const ROWS = [
  ['2026-03-01', 'Echeveria care tip: water only when the soil is fully dry, your rosettes will thank you 🌵 #succulents #plantcare #echeveria', 'PRIVATE_METRIC_123'],
  ['2026-04-02', 'Haworthia loves bright indirect light and very little water, perfect desk buddy for beginners 🌱 #haworthia #succulents', 'PRIVATE_METRIC_456'],
  ['2025-12-01', 'Old 2025 row that should be ignored entirely by the analysis step here #old', 'PRIVATE_METRIC_789'],
];

function mocks({ sheet = gviz(ROWS), modelStatus = 200, modelText = 'CAPTION: Echeveria tip 🌵 water less\nHASHTAGS: #succulents #echeveria #plantcare' } = {}) {
  const calls = { sheet: 0, model: 0, modelBody: null };
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://docs.google.com/')) { calls.sheet++; return new Response(sheet, { status: 200 }); }
    if (String(url).startsWith('https://api.anthropic.com/')) {
      calls.model++; calls.modelBody = init.body;
      return new Response(modelStatus === 200 ? JSON.stringify({ content: [{ text: modelText }] }) : 'provider detail ' + SHEET_ID, { status: modelStatus });
    }
    throw new Error('unexpected url');
  };
  return { fetch, calls };
}
const post = ({ pin, ...body }, cookie = pin === 'fictional-pin' ? COOKIE : '') => ({ httpMethod: 'POST', headers: cookie ? { cookie } : {}, body: JSON.stringify(body) });

test('unauthenticated requests stop before the guide, the sheet and the model', async () => {
  const forged = [
    '',                                                     // no session
    S.COOKIE + '=fictional-pin',                            // the PIN itself is not a session
    S.COOKIE + '=v1.9999999999.' + 'A'.repeat(43),          // forged signature
    S.COOKIE + '=' + S.issue({ ...ENV, SESSION_SECRET: 'another-secret-another-secret-123456' }).value,
    S.COOKIE + '=' + S.issue(ENV, Date.now() - 13 * 3600 * 1000).value,   // expired
  ];
  for (const cookie of forged) {
    const m = mocks();
    const r = await createHandler({ env: ENV, fetch: m.fetch })(post({ description: 'echeveria video' }, cookie));
    assert.equal(r.statusCode, 401, cookie);
    assert.equal(m.calls.sheet + m.calls.model, 0);
  }
  // a valid cookie stops working when PASSWORD or SESSION_SECRET is missing or changed
  for (const env of [{ ...ENV, PASSWORD: '' }, { ...ENV, PASSWORD: undefined }, { ...ENV, PASSWORD: 'new-pin' }, { ...ENV, SESSION_SECRET: '' }]) {
    const m = mocks();
    const r = await createHandler({ env, fetch: m.fetch })(post({ description: 'echeveria video' }, COOKIE));
    assert.equal(r.statusCode, 401);
    assert.equal(m.calls.sheet + m.calls.model, 0);
  }
  // guide is not loaded either: an invalid guide still yields 401, not 503
  const r = await createHandler({ env: { ...ENV, CAPTION_STYLE_GUIDE: 'not json' }, fetch: mocks().fetch })(post({ description: 'echeveria video' }, ''));
  assert.equal(r.statusCode, 401);
  // the old PIN-in-body request no longer works
  const legacy = await createHandler({ env: ENV, fetch: mocks().fetch })({ httpMethod: 'POST', body: JSON.stringify({ pin: 'fictional-pin', description: 'echeveria video' }) });
  assert.equal(legacy.statusCode, 401);
});

test('sign-in endpoint: right PIN sets an HttpOnly session cookie; wrong PIN or missing config refused', async () => {
  const h = sessionHandler.createHandler({ env: ENV });
  const ok = await h({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'fictional-pin' }) });
  assert.equal(ok.statusCode, 200);
  const c = ok.headers['Set-Cookie'];
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=43200']) assert.ok(c.includes(attr), attr);
  assert.ok(!c.includes('fictional-pin'));
  const cookie = c.split(';')[0];
  assert.equal((await h({ httpMethod: 'GET', headers: { cookie } })).statusCode, 200);
  assert.equal((await h({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'wrong' }) })).statusCode, 401);
  assert.equal((await sessionHandler.createHandler({ env: { ...ENV, SESSION_SECRET: '' } })({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ password: 'fictional-pin' }) })).statusCode, 503);
  // the issued cookie works for caption generation
  const m = mocks();
  assert.equal((await createHandler({ env: ENV, fetch: m.fetch })(post({ description: 'echeveria video' }, cookie))).statusCode, 200);
});

test('caption workflow works and returns only caption + hashtags', async () => {
  const m = mocks();
  const r = await createHandler({ env: ENV, fetch: m.fetch })(post({ pin: 'fictional-pin', description: 'repotting an echeveria' }));
  assert.equal(r.statusCode, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(Object.keys(body).sort(), ['caption', 'hashtags']);
  assert.equal(body.caption, 'Echeveria tip 🌵 water less');
  assert.equal(body.hashtags, '#succulents #echeveria #plantcare');
  for (const leak of [SHEET_ID, 'docs.google.com', 'PRIVATE_METRIC', 'test-key-not-real']) assert.ok(!r.body.includes(leak), leak);
  const prompt = JSON.parse(m.calls.modelBody).messages[0].content;
  assert.ok(prompt.includes('repotting an echeveria'));
  assert.ok(!prompt.includes('PRIVATE_METRIC'), 'only captions/hashtags go to the model');
  assert.ok(!prompt.includes('Old 2025 row'));
});

test('errors and logs never reveal the sheet ID, URL, rows or provider responses', async () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    for (const m of [mocks({ sheet: 'not json ' + SHEET_ID + ' PRIVATE_METRIC_123' }), mocks({ modelStatus: 500 })]) {
      const r = await createHandler({ env: ENV, fetch: m.fetch })(post({ pin: 'fictional-pin', description: 'echeveria video' }));
      assert.equal(r.statusCode, 500);
      for (const leak of [SHEET_ID, 'docs.google.com', 'PRIVATE_METRIC', 'provider detail']) assert.ok(!r.body.includes(leak), leak);
    }
    const noSheet = mocks();
    await createHandler({ env: { ...ENV, SHEET_ID: '' }, fetch: noSheet.fetch })(post({ pin: 'fictional-pin', description: 'echeveria video' }));
    assert.equal(noSheet.calls.model, 0);
  } finally { console.error = orig; }
  const all = logged.join('\n');
  for (const leak of [SHEET_ID, 'docs.google.com', 'PRIVATE_METRIC', 'provider detail']) assert.ok(!all.includes(leak), 'log: ' + leak);
});

test('input bounds', async () => {
  const m = mocks();
  const h = createHandler({ env: ENV, fetch: m.fetch });
  assert.equal((await h(post({ pin: 'fictional-pin', description: 'x'.repeat(1001) }))).statusCode, 400);
  assert.equal((await h(post({ pin: 'fictional-pin', description: { a: 1 } }))).statusCode, 400);
  assert.equal((await h({ httpMethod: 'GET' })).statusCode, 405);
  assert.equal(m.calls.model, 0);
});

test('browser page holds no sheet ID or URL', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!/docs\.google\.com|spreadsheets|SHEET_ID|ANTHROPIC/i.test(html));
  assert.ok(!/sessionStorage\.setItem|localStorage\.setItem/.test(html), 'PIN never stored in the browser');
  assert.ok(!/JSON\.stringify\(\{ pin/.test(html), 'PIN not sent with each request');
});

test('missing or invalid style guide: clear 503 before the sheet or the model', async () => {
  for (const g of [undefined, '', 'not json', JSON.stringify({ template: 'no placeholders' })]) {
    const m = mocks();
    const r = await createHandler({ env: { ...ENV, CAPTION_STYLE_GUIDE: g }, fetch: m.fetch })(post({ pin: 'fictional-pin', description: 'echeveria video' }));
    assert.equal(r.statusCode, 503);
    assert.match(JSON.parse(r.body).error, /Style guide is not configured/);
    assert.equal(m.calls.sheet + m.calls.model, 0);
  }
});

test('prompt is the guide filled with hashtags, examples and the description; guide never returned', async () => {
  const m = mocks();
  const r = await createHandler({ env: ENV, fetch: m.fetch })(post({ pin: 'fictional-pin', description: 'repotting an echeveria' }));
  const prompt = JSON.parse(m.calls.modelBody).messages[0].content;
  assert.equal(prompt, 'FICTIONAL TEMPLATE. Write a short caption.\nHASHTAGS TO CHOOSE FROM:\n#succulents #plantcare #echeveria #haworthia\nEXAMPLES:\n1. Echeveria care tip: water only when the soil is fully dry, your rosettes will thank you 🌵\n2. Haworthia loves bright indirect light and very little water, perfect desk buddy for beginners 🌱\nVIDEO:\n"repotting an echeveria"\nReply exactly as:\nCAPTION: [caption]\nHASHTAGS: [hashtags]');
  assert.ok(!r.body.includes('FICTIONAL TEMPLATE'));
});
