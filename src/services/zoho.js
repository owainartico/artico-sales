'use strict';

/**
 * Zoho Books OAuth2 client.
 *
 * Env vars required:
 *   ZOHO_CLIENT_ID      – from api-console.zoho.com
 *   ZOHO_CLIENT_SECRET  – from api-console.zoho.com
 *   ZOHO_REFRESH_TOKEN  – long-lived refresh token
 *   ZOHO_ORG_ID         – 689159620
 *   ZOHO_ACCOUNTS_URL   – optional, default https://accounts.zoho.com
 *                         Override to https://accounts.zoho.com.au if on AU data centre.
 *
 * NOTE: This app uses native fetch (Node.js >= 18). If you see
 *       "fetch is not defined", add node-fetch as a dependency.
 */

const ZOHO_ACCOUNTS_URL =
  process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const ZOHO_BASE_URL = 'https://www.zohoapis.com/books/v3';

// ── In-memory token cache ────────────────────────────────────────────────────
let _cachedToken = null;
let _tokenExpiresAt = 0;

/**
 * Exchange the refresh token for a new access token and cache it.
 * Throws if the exchange fails.
 */
async function refreshAccessToken() {
  const { ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN } =
    process.env;

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error(
      'Missing Zoho OAuth credentials. Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN env vars.'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: ZOHO_REFRESH_TOKEN,
  });

  const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json();

  if (!data.access_token) {
    throw new Error(
      `Zoho token refresh failed: ${JSON.stringify(data)}`
    );
  }

  // Cache with a 60-second safety buffer before actual expiry (default 3600s)
  _cachedToken = data.access_token;
  _tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;

  console.log(
    `[zoho] Access token refreshed — expires in ${data.expires_in}s`
  );
  return _cachedToken;
}

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiresAt) {
    return _cachedToken;
  }
  return refreshAccessToken();
}

/**
 * Make an authenticated GET request to the Zoho Books API.
 *
 * @param {string} endpoint  – path, e.g. '/contacts'
 * @param {object} params    – additional query params (org_id is added automatically)
 * @returns {Promise<object>} – parsed JSON body
 *
 * Retries once on 401 with a freshly fetched token.
 */
async function makeZohoRequest(endpoint, params = {}) {
  const orgId = process.env.ZOHO_ORG_ID || '689159620';
  const qs = new URLSearchParams({ organization_id: orgId, ...params });
  const url = `${ZOHO_BASE_URL}${endpoint}?${qs}`;

  const doFetch = (token) =>
    fetch(url, {
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: 'application/json',
      },
    });

  let token = await getAccessToken();
  let res = await doFetch(token);

  if (res.status === 401) {
    console.log('[zoho] 401 received — refreshing token and retrying');
    token = await refreshAccessToken();
    res = await doFetch(token);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoho API ${res.status} on ${endpoint}: ${body}`);
  }

  return res.json();
}

module.exports = { refreshAccessToken, makeZohoRequest };
