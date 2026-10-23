// ─── Token / moderation API client ────────────────────────
const CFG = window.EEM26_CONFIG || {};

export function endpoint() {
  return (CFG.CLASSROOM_API || `${CFG.SUPABASE_URL}/functions/v1/classroom`).replace(/\/+$/, '');
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export async function api(action, params = {}) {
  const headers = { 'Content-Type': 'application/json' };
  let res;
  try {
    res = await fetch(endpoint(), { method: 'POST', headers, body: JSON.stringify({ action, ...params }) });
  } catch (err) {
    throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error || 'error', body.message || body.error || `HTTP ${res.status}`);
  return body;
}

// Optional Supabase client (landing page "session is live" flag).
export function supabaseClient() {
  if (!CFG.SUPABASE_URL || !window.supabase) return null;
  try { return window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY); }
  catch { return null; }
}

// Presenter sign-in and "class in progress" survive the app or browser being
// closed in the background (sessionStorage would be wiped), for half a day.
const KEEP_MS = 12 * 3600e3;
export const keep = {
  get(key) {
    try {
      const v = JSON.parse(localStorage.getItem(key) || 'null');
      if (v && v.exp > Date.now()) return v.v;
      localStorage.removeItem(key);
    } catch { /* storage unavailable */ }
    return null;
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify({ v: value, exp: Date.now() + KEEP_MS })); } catch { /* storage unavailable */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  },
};
