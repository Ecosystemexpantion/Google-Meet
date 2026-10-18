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
