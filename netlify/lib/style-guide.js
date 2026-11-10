// style-guide.js — the private caption style guide (style rules and output format).
// Stored in the server-only Netlify environment variable CAPTION_STYLE_GUIDE
// (scope: Functions), as single-line JSON: { "version": 1, "template": "..." }.
// Never in Git or the published site. Shape: docs/style-guide.example.json.
// Placeholders: {{topHashtags}}, {{examples}}, {{description}}.

const { validTemplate, fill } = require('./template');

const ENV_NAME = 'CAPTION_STYLE_GUIDE';
const VARS = ['topHashtags', 'examples', 'description'];

function parseGuide(raw) {
  let g;
  try { g = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!g || typeof g !== 'object' || !validTemplate(g.template, VARS, ['description'])) return null;
  return g;
}

function loadGuide(env) {
  return env[ENV_NAME] ? parseGuide(env[ENV_NAME]) : null;
}

function captionPrompt(g, { topHashtags, examples, description }) {
  return fill(g.template, { topHashtags, examples, description });
}

module.exports = { loadGuide, parseGuide, captionPrompt, ENV_NAME };
