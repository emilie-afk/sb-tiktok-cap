// Succulents Box — Caption Generator
// Netlify serverless function
// Env vars required: PASSWORD, SESSION_SECRET, SHEET_ID, ANTHROPIC_API_KEY, CAPTION_STYLE_GUIDE (private style guide)
// Access: an expiring HttpOnly session cookie from /.netlify/functions/session (sign-in with the PIN).

const { loadGuide, captionPrompt } = require('../lib/style-guide');
const S = require('../lib/session');

const MAX_DESCRIPTION = 1000;

function createHandler(deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetch || fetch;
  const now = deps.now || Date.now;

  return async (event) => {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
      // ── 1. Session check — before the guide, the sheet or the model is touched.
      //       No valid session (or PASSWORD / SESSION_SECRET not configured) → 401.
      if (!S.verify(env, event.headers || {}, now())) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not signed in' }) };
      }

      // ── 2. Private style guide, loaded only after the session check.
      //       Missing → clear error before the sheet or the model is touched.
      const guide = loadGuide(env);
      if (!guide) {
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'Style guide is not configured on the server. Ask an admin to set it up.' }) };
      }

      let input;
      try { input = JSON.parse(event.body || '{}'); } catch { input = {}; }
      const { description } = input || {};

      if (typeof description !== 'string' || description.trim().length < 3) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a description.' }) };
      }
      if (description.length > MAX_DESCRIPTION) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Description is too long.' }) };
      }

      // ── 3. Fetch live Google Sheet data (sheet ID stays server-side)
      const rows = await fetchSheetData(env, fetchImpl);

      // ── 4. Analyse 2026 content
      const analysis = analyzeData(rows);

      // ── 5. Generate caption with Claude — only the caption and hashtags are returned
      const result = await generateCaption(description.trim(), analysis, guide, env, fetchImpl);

      return { statusCode: 200, headers, body: JSON.stringify(result) };

    } catch (err) {
      // Log only the stage, never sheet contents, URLs or provider responses.
      console.error('generate error:', (err && err.stage) || 'unexpected');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Something went wrong. Try again.' }) };
    }
  };
}

function stageError(stage) {
  const e = new Error(stage);
  e.stage = stage;
  return e;
}

exports.handler = createHandler();
exports.createHandler = createHandler;

// ─────────────────────────────────────────────
// Fetch Google Sheet via the gviz JSON endpoint
// Sheet must be set to "Anyone with the link can view"
// ─────────────────────────────────────────────
async function fetchSheetData(env, fetchImpl) {
  const sheetId = env.SHEET_ID;
  if (!sheetId) throw stageError('sheet_not_configured');

  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:json&sheet=Sheet1`;
  let res;
  try { res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) }); }
  catch { throw stageError('sheet_unreachable'); }
  if (!res.ok) throw stageError('sheet_status_' + res.status);

  const text = await res.text();

  // Google wraps the JSON in: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
  const jsonStr = text
    .replace(/^[^(]+\(/, '')   // strip everything up to the first (
    .replace(/\);\s*$/, '');   // strip trailing );

  let data;
  try { data = JSON.parse(jsonStr); } catch { throw stageError('sheet_unparseable'); }
  const cols = data.table.cols.map(c => c.label || c.id);

  const rows = data.table.rows
    .filter(r => r && r.c)
    .map(row => {
      const obj = {};
      row.c.forEach((cell, i) => {
        obj[cols[i]] = cell ? cell.v : null;
      });
      return obj;
    });

  return rows;
}

// ─────────────────────────────────────────────
// Analyse rows — extract 2026 hashtags & captions
// ─────────────────────────────────────────────
function analyzeData(rows) {
  const rows2026 = rows.filter(r => {
    const d = r['date_posted'] || '';
    return String(d).includes('2026');
  });

  const hashtagCounts = {};
  const captions = [];

  for (const row of rows2026) {
    const caption = String(row['caption'] || '');
    captions.push(caption);

    const tags = caption.match(/#[a-zA-Z0-9_]+/g) || [];
    tags.forEach(t => {
      const tl = t.toLowerCase();
      hashtagCounts[tl] = (hashtagCounts[tl] || 0) + 1;
    });
  }

  // Top 20 hashtags by frequency
  const topHashtags = Object.entries(hashtagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag]) => tag);

  // Sample captions: strip hashtags, keep substantial ones
  const sampleCaptions = captions
    .map(c => c.replace(/#\S+/g, '').replace(/\n/g, ' ').trim())
    .filter(c => c.length > 40)
    .slice(0, 8);

  return { topHashtags, sampleCaptions, count: rows2026.length };
}

// ─────────────────────────────────────────────
// Call Claude Haiku to write the caption (prompt from the private guide)
// ─────────────────────────────────────────────
async function generateCaption(description, analysis, guide, env, fetchImpl) {
  const { topHashtags, sampleCaptions } = analysis;

  const examples = sampleCaptions
    .slice(0, 6)
    .map((c, i) => `${i + 1}. ${c.slice(0, 140)}`)
    .join('\n');

  const prompt = captionPrompt(guide, { topHashtags: topHashtags.join(' '), examples, description });

  if (!env.ANTHROPIC_API_KEY) throw stageError('model_not_configured');
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    throw stageError('model_status_' + res.status);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  const captionMatch = text.match(/CAPTION:\s*(.+)/);
  const hashtagsMatch = text.match(/HASHTAGS:\s*(.+)/);

  const caption = (captionMatch ? captionMatch[1].trim() : text.trim())
    .replace(/—/g, '-');  // strip any em dashes that slip through

  return {
    caption,
    hashtags: hashtagsMatch ? hashtagsMatch[1].trim() : topHashtags.slice(0, 6).join(' ')
  };
}
