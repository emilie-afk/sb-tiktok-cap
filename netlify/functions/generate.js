// Succulents Box — Caption Generator
// Netlify serverless function
// Env vars required: PASSWORD, SHEET_ID, ANTHROPIC_API_KEY

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { pin, description } = JSON.parse(event.body || '{}');

    // ── 1. PIN check
    if (!pin || pin !== process.env.PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid PIN' }) };
    }

    if (!description || description.trim().length < 3) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a description.' }) };
    }

    // ── 2. Fetch live Google Sheet data
    const rows = await fetchSheetData();

    // ── 3. Analyse 2026 content
    const analysis = analyzeData(rows);

    // ── 4. Generate caption with Claude
    const result = await generateCaption(description.trim(), analysis);

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error('generate error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Something went wrong. Try again.' }) };
  }
};

// ─────────────────────────────────────────────
// Fetch Google Sheet via the gviz JSON endpoint
// Sheet must be set to "Anyone with the link can view"
// ─────────────────────────────────────────────
async function fetchSheetData() {
  const sheetId = process.env.SHEET_ID;
  if (!sheetId) throw new Error('SHEET_ID env var not set');

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&sheet=Sheet1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);

  const text = await res.text();

  // Google wraps the JSON in: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
  const jsonStr = text
    .replace(/^[^(]+\(/, '')   // strip everything up to the first (
    .replace(/\);\s*$/, '');   // strip trailing );

  const data = JSON.parse(jsonStr);
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
// Call Claude Haiku to write the caption
// ─────────────────────────────────────────────
async function generateCaption(description, analysis) {
  const { topHashtags, sampleCaptions } = analysis;

  const examples = sampleCaptions
    .slice(0, 6)
    .map((c, i) => `${i + 1}. ${c.slice(0, 140)}`)
    .join('\n');

  const prompt = `You write TikTok captions for Succulents Box, a succulent plant subscription brand.

STYLE RULES (based on 2026 top-performing videos):
- Open with the plant genus name (Echeveria, Haworthia, Sedum, String of Pearls…) OR a punchy hook word (Easy, Beautiful, How to…)
- Caption body: 120–160 characters, no hashtags in the body
- Include 1–2 emojis placed naturally — not at the very end as a pile
- Tip or educational angle performs best: "If your X keeps doing Y, here's the fix…"
- Conversational and warm tone, not corporate
- Do NOT use em dashes (—) anywhere in the caption
- Do NOT use #fyp

TOP HASHTAGS FROM LIVE 2026 DATA (use 5–7 of these, most relevant to the video):
${topHashtags.join(' ')}

EXAMPLE CAPTIONS FROM REAL 2026 VIDEOS:
${examples}

VIDEO TO CAPTION:
"${description}"

Reply in exactly this format — nothing else, no intro text:
CAPTION: [caption here]
HASHTAGS: [5–7 hashtags space-separated]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} ${err}`);
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
