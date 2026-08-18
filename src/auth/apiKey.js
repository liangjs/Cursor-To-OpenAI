const crypto = require('crypto');
const { fetch } = require('undici');

const EXCHANGE_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';
const REFRESH_WINDOW_SECONDS = 300;
const MAX_SESSION_CACHE_ENTRIES = 1000;
const sessions = new Map();

class CursorApiKeyAuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'CursorApiKeyAuthError';
    this.code = code;
    this.status = status;
  }
}

function decodeJwtExpiration(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }

    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const { exp } = JSON.parse(payload);
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

function isAccessTokenUsable(token) {
  const expiresAt = decodeJwtExpiration(token);
  return expiresAt !== null
    && expiresAt - Math.floor(Date.now() / 1000) >= REFRESH_WINDOW_SECONDS;
}

function getBearerCredential(authorization) {
  if (typeof authorization !== 'string') {
    return '';
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function getCookieAccessToken(token) {
  if (token.includes('%3A%3A')) {
    return token.split('%3A%3A')[1];
  }
  if (token.includes('::')) {
    return token.split('::')[1];
  }
  return token;
}

function touchSession(fingerprint, session) {
  sessions.delete(fingerprint);
  sessions.set(fingerprint, session);
}

function evictSessionIfNeeded() {
  while (sessions.size >= MAX_SESSION_CACHE_ENTRIES) {
    const evictable = [...sessions.entries()].find(([, session]) => !session.exchangePromise);
    if (!evictable) {
      return;
    }
    sessions.delete(evictable[0]);
  }
}

function getSession(apiKey) {
  const fingerprint = crypto.createHash('sha256').update(apiKey).digest('hex');
  const existing = sessions.get(fingerprint);
  if (existing) {
    touchSession(fingerprint, existing);
    return { fingerprint, session: existing };
  }

  evictSessionIfNeeded();
  if (sessions.size >= MAX_SESSION_CACHE_ENTRIES) {
    throw new CursorApiKeyAuthError('cursor_auth_session_capacity_exceeded', 'Cursor session capacity exceeded', 503);
  }

  const session = {
    apiKey,
    accessToken: null,
    exchangePromise: null,
  };
  sessions.set(fingerprint, session);
  return { fingerprint, session };
}

async function exchangeAccessToken(session) {
  let response;
  try {
    response = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.apiKey}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
  } catch {
    throw new CursorApiKeyAuthError('cursor_auth_exchange_failed', 'Cursor API key exchange failed', 502);
  }

  if (!response.ok) {
    throw new CursorApiKeyAuthError(
      'cursor_auth_exchange_failed',
      'Cursor API key exchange failed',
      response.status >= 500 ? 502 : 401,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new CursorApiKeyAuthError('cursor_auth_exchange_failed', 'Cursor API key exchange failed', 502);
  }

  if (
    !data
    || typeof data.accessToken !== 'string'
    || !data.accessToken
    || typeof data.refreshToken !== 'string'
    || !data.refreshToken
    || !isAccessTokenUsable(data.accessToken)
  ) {
    throw new CursorApiKeyAuthError('cursor_auth_exchange_failed', 'Cursor API key exchange failed', 502);
  }

  session.accessToken = data.accessToken;
  return session.accessToken;
}

async function getAccessToken(apiKey) {
  const { fingerprint, session } = getSession(apiKey);
  if (isAccessTokenUsable(session.accessToken)) {
    return session.accessToken;
  }

  if (!session.exchangePromise) {
    session.exchangePromise = exchangeAccessToken(session)
      .catch((error) => {
        if (!session.accessToken && sessions.get(fingerprint) === session) {
          sessions.delete(fingerprint);
        }
        throw error;
      })
      .finally(() => {
        session.exchangePromise = null;
      });
  }

  return session.exchangePromise;
}

async function resolveAccessToken(authorization, selection = 'first') {
  const credential = getBearerCredential(authorization);
  if (!credential) {
    throw new CursorApiKeyAuthError('authorization_required', 'Authorization is required', 400);
  }

  if (credential.startsWith('crsr_')) {
    if (!/^crsr_[^,\s]+$/.test(credential)) {
      throw new CursorApiKeyAuthError('cursor_auth_invalid_api_key', 'Invalid Cursor API key', 401);
    }
    return {
      accessToken: await getAccessToken(credential),
      apiKeyMode: true,
    };
  }

  const credentials = credential.split(',').map((value) => value.trim()).filter(Boolean);
  const selected = selection === 'random'
    ? credentials[Math.floor(Math.random() * credentials.length)]
    : credentials[0];
  const accessToken = selected ? getCookieAccessToken(selected) : '';
  if (!accessToken) {
    throw new CursorApiKeyAuthError('authorization_required', 'Authorization is required', 400);
  }

  return { accessToken, apiKeyMode: false };
}

module.exports = {
  CursorApiKeyAuthError,
  resolveAccessToken,
};
