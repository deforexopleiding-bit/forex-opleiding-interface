// api/follow-up-lead-update.js
//
// POST { lead_id, lead_status?, terugbel_datum?, owner_id? } → update
// een follow_up_leads-rij. Alleen deze tabel; geen andere follow-up-
// entiteiten geraakt.
//
// Business-regel: bij status-transitie naar contact-uitkomst
// (benaderd / niet_bereikbaar / terugbellen) wordt last_contact_at=now.
// updated_at wordt altijd bijgewerkt.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAD_STATUSES = ['nieuw', 'benaderd', 'niet_bereikbaar', 'terugbellen', 'verlengd', 'verloren'];
const CONTACT_STATUSES = new Set(['benaderd', 'niet_bereikbaar', 'terugbellen']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
  if (!leadId || !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id (uuid) vereist' });

  const patch = { updated_at: new Date().toISOString() };
  if (body.lead_status != null) {
    const st = String(body.lead_status);
    if (!LEAD_STATUSES.includes(st)) return res.status(400).json({ error: 'lead_status ongeldig' });
    patch.lead_status = st;
    if (CONTACT_STATUSES.has(st)) patch.last_contact_at = new Date().toISOString();
  }
  if (body.terugbel_datum !== undefined) {
    if (body.terugbel_datum === null || body.terugbel_datum === '') {
      patch.terugbel_datum = null;
    } else {
      const d = new Date(body.terugbel_datum);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'terugbel_datum ongeldig' });
      patch.terugbel_datum = d.toISOString();
    }
  }
  if (body.owner_id !== undefined) {
    if (body.owner_id === null) patch.owner_id = null;
    else if (typeof body.owner_id === 'string' && UUID_RE.test(body.owner_id)) patch.owner_id = body.owner_id;
    else return res.status(400).json({ error: 'owner_id ongeldig' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('follow_up_leads')
      .update(patch)
      .eq('id', leadId)
      .select('id, customer_id, source, lead_name, lead_email, lead_phone, lead_status, terugbel_datum, owner_id, last_contact_at, updated_at')
      .maybeSingle();
    if (error) {
      if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
      throw new Error(error.message);
    }
    if (!data) return res.status(404).json({ error: 'Lead niet gevonden' });
    return res.status(200).json({ ok: true, lead: data });
  } catch (e) {
    console.error('[follow-up-lead-update]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
