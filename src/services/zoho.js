'use strict';

/**
 * Zoho Books OAuth2 client.
 *
 * Env vars required:
 *   ZOHO_CLIENT_ID      – from api-console.zoho.com
 *   ZOHO_CLIENT_SECRET  – from api-console.zoho.com
 *   ZOHO_REFRESH_TOKEN  – initial refresh token (seed value; DB takes over after first use)
 *   ZOHO_ORG_ID         – 689159620
 *   ZOHO_ACCOUNTS_URL   – optional, default https://accounts.zoho.com
 *
 * Refresh token persistence:
 *   The current refresh token is stored in the app_config table under the key
 *   'zoho_refresh_token'. On startup, initZohoTokens() loads it from the DB
 *   (falling back to the ZOHO_REFRESH_TOKEN env var). Whenever Zoho returns a
 *   new refresh token in an OAuth response, it is saved to the DB automatically,
 *   so the token chain never breaks across server restarts or Render deployments.
 */

const db = require('../db/index');

const ZOHO_ACCOUNTS_URL =
  process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_BASE_URL = 'https://www.zohoapis.com/books/v3';

// ── In-memory token cache ─────────────────────────────────────────────────────
let _cachedToken    = null;
let _tokenExpiresAt = 0;
let _refreshToken   = process.env.ZOHO_REFRESH_TOKEN || null; // overwritten by DB on init

// ── Refresh token persistence ─────────────────────────────────────────────────

/**
 * Load the refresh token from the DB on startup.
 * Falls back to ZOHO_REFRESH_TOKEN env var if the DB has no stored value.
 * Call this once from server.js before handling any requests.
 */
async function initZohoTokens() {
  try {
    const result = await db.query(
      "SELECT value FROM app_config WHERE key = 'zoho_refresh_token'",
    );
    if (result.rows.length > 0) {
      _refreshToken = result.rows[0].value;
      console.log('[zoho] Refresh token loaded from database');
    } else if (_refreshToken) {
      // Seed the DB with the env var value so future restarts use the DB path
      await _saveRefreshToken(_refreshToken);
      console.log('[zoho] Refresh token seeded from env var into database');
    } else {
      console.warn('[zoho] No refresh token in DB or env — Zoho calls will fail until one is configured');
    }
  } catch (err) {
    console.error('[zoho] Failed to load refresh token from DB:', err.message);
    // Fall through — _refreshToken may still be set from env var
  }
}

/**
 * Persist a new refresh token to the DB and update the in-memory value.
 */
async function _saveRefreshToken(token) {
  _refreshToken = token;
  try {
    await db.query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('zoho_refresh_token', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [token],
    );
    console.log('[zoho] New refresh token saved to database');
  } catch (err) {
    console.error('[zoho] Failed to save refresh token to DB:', err.message);
  }
}

// ── Access token management ───────────────────────────────────────────────────

/**
 * Exchange the current refresh token for a new access token.
 * If Zoho returns a new refresh token in the response, it is saved automatically.
 */
async function refreshAccessToken() {
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET } = process.env;

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !_refreshToken) {
    throw new Error(
      'Missing Zoho OAuth credentials. Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN env vars.',
    );
  }

  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: _refreshToken,
  });

  const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(data)}`);
  }

  // Cache the new access token with a 60-second safety buffer
  _cachedToken    = data.access_token;
  _tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;

  console.log(`[zoho] Access token refreshed — expires in ${data.expires_in}s`);

  // If Zoho rotated the refresh token, persist the new one immediately
  if (data.refresh_token && data.refresh_token !== _refreshToken) {
    console.log('[zoho] New refresh token received — persisting');
    await _saveRefreshToken(data.refresh_token);
  }

  return _cachedToken;
}

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt) {
    return _cachedToken;
  }
  return refreshAccessToken();
}

// ── Zoho API write helper ─────────────────────────────────────────────────────

/**
 * Make an authenticated write request (PUT/POST/PATCH) to the Zoho Books API.
 * Body is serialised as JSON. Retries once on 401.
 */
async function makeZohoWrite(method, endpoint, body = {}) {
  const orgId = process.env.ZOHO_ORG_ID || '689159620';
  const url   = `${ZOHO_BASE_URL}${endpoint}?organization_id=${orgId}`;

  const doFetch = (token) =>
    fetch(url, {
      method,
      headers: {
        Authorization:  `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      body: JSON.stringify(body),
    });

  let token  = await getAccessToken();
  let result = await doFetch(token);

  if (result.status === 401) {
    console.log('[zoho] 401 — refreshing token and retrying');
    token  = await refreshAccessToken();
    result = await doFetch(token);
  }

  if (!result.ok) {
    const text = await result.text();
    throw new Error(`Zoho API ${method} ${result.status} on ${endpoint}: ${text}`);
  }

  return result.json();
}

// ── Zoho API request helper ───────────────────────────────────────────────────

/**
 * Make an authenticated GET request to the Zoho Books API.
 * Retries once on 401 with a freshly fetched token.
 */
async function makeZohoRequest(endpoint, params = {}) {
  const orgId = process.env.ZOHO_ORG_ID || '689159620';
  const qs    = new URLSearchParams({ organization_id: orgId, ...params });
  const url   = `${ZOHO_BASE_URL}${endpoint}?${qs}`;

  const doFetch = (token) =>
    fetch(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept:        'application/json',
      },
    });

  let token = await getAccessToken();
  let result = await doFetch(token);

  if (result.status === 401) {
    console.log('[zoho] 401 received — refreshing token and retrying');
    token  = await refreshAccessToken();
    result = await doFetch(token);
  }

  if (!result.ok) {
    const text = await result.text();
    throw new Error(`Zoho API ${result.status} on ${endpoint}: ${text}`);
  }

  return result.json();
}

module.exports = { initZohoTokens, refreshAccessToken, makeZohoRequest, makeZohoWrite };
