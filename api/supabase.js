import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL) {
  console.warn('[supabase] SUPABASE_URL not set');
}

// Anon client — for user-aware browser endpoints; RLS enforced via JWT
export const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_ANON_KEY || '',
  { auth: { persistSession: false } }
);

// Admin client — service role, bypasses RLS; use only in cron + privileged ops
export const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

/**
 * Per-request user-aware Supabase client.
 * Passes the Bearer JWT so RLS auth.uid() evaluates correctly.
 * Falls back to anon client if no valid Bearer token present.
 *
 * Usage:
 *   const supabase = createUserClient(req);
 *   const { data } = await supabase.from('table').select('*');
 */
export function createUserClient(req) {
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return supabase;
  const token = authHeader.slice(7);
  return createClient(
    process.env.SUPABASE_URL || '',
    process.env.SUPABASE_ANON_KEY || '',
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  );
}

// Rollen die toegang geven tot het admin panel + admin-endpoints
const ADMIN_ROLES = ['super_admin', 'admin', 'manager'];

/**
 * Verify Bearer token belongs to an active admin.
 * Returns { user, profile } on success, null otherwise.
 *
 * Usage:
 *   const admin = await verifyAdmin(req);
 *   if (!admin) return res.status(403).json({ error: 'Admin only' });
 */
export async function verifyAdmin(req) {
  const authHeader = req.headers?.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  if (!profile || !ADMIN_ROLES.includes(profile.role) || !profile.is_active) return null;
  return { user, profile };
}

/**
 * Hard CRON_SECRET check. Use at the top of every cron handler:
 *   const cronAuth = checkCronAuth(req);
 *   if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);
 */
export function checkCronAuth(req) {
  if (!process.env.CRON_SECRET) {
    return { ok: false, status: 500, body: { error: 'CRON_SECRET not configured' } };
  }
  const authHeader = req.headers?.authorization || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  return { ok: true };
}
