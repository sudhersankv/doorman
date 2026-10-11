'use strict';
/**
 * Tiny .env loader (no dependency on dotenv). Parses KEY=VALUE lines into process.env
 * without overriding variables that are already set. Ignores blank lines and `#` comments,
 * strips surrounding single/double quotes and an optional `export ` prefix.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Parse .env text into an object.
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else { const hash = v.indexOf(' #'); if (hash >= 0) v = v.slice(0, hash).trim(); }
    out[m[1]] = v;
  }
  return out;
}

/**
 * Load a .env file into process.env (existing vars win). Silent when the file is missing.
 * @param {string} [file] defaults to <repo root>/.env
 * @returns {Record<string,string>} the parsed values
 */
function loadEnv(file = path.join(__dirname, '..', '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const parsed = parseEnv(text);
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] == null || process.env[k] === '') process.env[k] = v;
  return parsed;
}

loadEnv();

module.exports = { parseEnv, loadEnv };
