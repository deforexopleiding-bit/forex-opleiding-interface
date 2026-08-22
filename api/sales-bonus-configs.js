// api/sales-bonus-configs.js
// CRUD op sales_bonus_configs — bewerkbaar percentage + threshold per verkoper.
// GET    → { configs: [{id, user_id, percentage, threshold_amount, active_from, active_until, profile: {full_name, email, role}}, ...] }
//          + { candidates: [{id, full_name, email, role}] } — profiles waar role in ('sales', 'admin', 'manager', 'super_admin') zonder actieve config.
// POST   { user_id, percentage, threshold_amount, active_from? } → insert nieuwe config.
// PATCH  ?id=UUID { percentage?, threshold_amount?, active_until? } → update.
// DELETE ?id=UUID → soft-delete via active_until = today (behoud historische bonusberekeningen).
//
// Auth: super_admin only (via profiles.role check). Schrijven via supabaseAdmin ná gate;
// RLS op sales_bonus_configs staat aan sinds finance-fase-1-fundament migratie.

import { createUserClient, supabaseAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANDIDATE_ROLES = ['sales', 'admin', 'manager', 'super_admin'];

async function isSuperAdmin(userId) {
  if (!userId) return false;
  const { data } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'super_admin';
}

function cleanBody(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const out = {};
  if (b.user_id !== undefined) out.user_id = typeof b.user_id === 'string' && UUID_RE.test(b.user_id) ? b.user_id : null;
  if (b.percentage !== undefined) {
    const n = Number(b.percentage);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out.percentage = Math.round(n * 100) / 100;
  }
  if (b.threshold_amount !== undefined) {
    const n = Number(b.threshold_amount);
    if (Number.isFinite(n) && n >= 0) out.threshold_amount = Math.round(n * 100) / 100;
  }
  if (b.active_from !== undefined && b.active_from) {
    const d = String(b.active_from).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.active_from = d;
  }
  if (b.active_until !== undefined) {
    if (b.active_until === null || b.active_until === '') out.active_until = null;
    else {
      const d = String(b.active_until).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.active_until = d;
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  try {
    if (req.method === 'GET') {
      // Read = super_admin only (bonus-config is finance-gevoelig).
      if (!(await isSuperAdmin(user.id))) return res.status(403).json({ error: 'Alleen super_admin' });
      const { data: configs, error: cErr } = await supabaseAdmin.from('sales_bonus_configs')
        .select('id, user_id, percentage, threshold_amount, active_from, active_until, created_at, updated_at')
        .order('active_from', { ascending: false });
      if (cErr) throw cErr;
      const userIds = [...new Set((configs || []).map(c => c.user_id).filter(Boolean))];
      let profByUser = {};
      if (userIds.length) {
        const { data: profs } = await supabaseAdmin.from('profiles')
          .select('id, full_name, email, role').in('id', userIds);
        for (const p of profs || []) profByUser[p.id] = p;
      }
      const configsWithProfile = (configs || []).map(c => ({ ...c, profile: profByUser[c.user_id] || null }));
      // Candidates: alle actieve profiles met candidate-role, MINUS die al een actieve config hebben.
      const { data: cands } = await supabaseAdmin.from('profiles')
        .select('id, full_name, email, role')
        .in('role', CANDIDATE_ROLES).eq('is_active', true).order('full_name');
      const today = new Date().toISOString().slice(0, 10);
      const activeUserIds = new Set(configsWithProfile.filter(c => !c.active_until || c.active_until >= today).map(c => c.user_id));
      const candidates = (cands || []).filter(p => !activeUserIds.has(p.id));
      return res.status(200).json({ configs: configsWithProfile, candidates });
    }

    if (!(await isSuperAdmin(user.id))) return res.status(403).json({ error: 'Alleen super_admin mag bonus-configs wijzigen' });

    if (req.method === 'POST') {
      const f = cleanBody(req.body);
      if (!f.user_id) return res.status(400).json({ error: 'user_id (UUID) verplicht' });
      if (f.percentage == null) return res.status(400).json({ error: 'percentage verplicht (0..100)' });
      if (f.threshold_amount == null) return res.status(400).json({ error: 'threshold_amount verplicht (>=0)' });
      const row = { user_id: f.user_id, percentage: f.percentage, threshold_amount: f.threshold_amount,
                    active_from: f.active_from || new Date().toISOString().slice(0, 10) };
      const { data, error } = await supabaseAdmin.from('sales_bonus_configs')
        .insert(row).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, config: data });
    }

    if (req.method === 'PATCH') {
      const id = String(req.query?.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (UUID) vereist' });
      const f = cleanBody(req.body);
      const patch = {};
      if (f.percentage != null)       patch.percentage       = f.percentage;
      if (f.threshold_amount != null) patch.threshold_amount = f.threshold_amount;
      if ('active_until' in f)        patch.active_until     = f.active_until;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Geen velden om te wijzigen' });
      patch.updated_at = new Date().toISOString();
      const { data, error } = await supabaseAdmin.from('sales_bonus_configs')
        .update(patch).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, config: data });
    }

    if (req.method === 'DELETE') {
      // Soft-delete via active_until = today (behoud historische bonusberekeningen die deze config gebruikten).
      const id = String(req.query?.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (UUID) vereist' });
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabaseAdmin.from('sales_bonus_configs')
        .update({ active_until: today, updated_at: new Date().toISOString() })
        .eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, config: data });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sales-bonus-configs]', req.method, e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
