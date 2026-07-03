// api/sales-retention-mark.js
// POST { customer_id: uuid, not_renewing: true|false } → zet handmatig
// customers.retention_not_renewing + retention_marked_by/at.
//
// Fail-soft bij ontbrekende migratie: als de kolommen niet bestaan,
// return 501 met een expliciete melding ("migratie nodig") zodat de
// frontend een duidelijke hint kan tonen.
//
// Permission: sales.customer.view OF sales.tab.retentie.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // sales.customer.view OF sales.tab.retentie.
  let allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (sales.customer.view of sales.tab.retentie)' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId  = typeof body.customer_id === 'string' ? body.customer_id.trim() : '';
  const notRenewing = body.not_renewing === true;
  if (!customerId || !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  }

  try {
    const nowIso = new Date().toISOString();
    const update = notRenewing
      ? {
          retention_not_renewing: true,
          retention_marked_by   : user.id,
          retention_marked_at   : nowIso,
        }
      : {
          retention_not_renewing: false,
          retention_marked_by   : null,
          retention_marked_at   : null,
        };

    const { data, error } = await supabaseAdmin
      .from('customers')
      .update(update)
      .eq('id', customerId)
      .select('id, retention_not_renewing, retention_marked_by, retention_marked_at')
      .maybeSingle();

    if (error) {
      if (error.code === '42703') {
        // Kolommen ontbreken → migratie nodig.
        return res.status(501).json({
          error: 'Kolom customers.retention_not_renewing ontbreekt — migratie vereist',
          code : 'MIGRATION_REQUIRED',
        });
      }
      console.error('[sales-retention-mark] update:', error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: 'Klant niet gevonden' });

    return res.status(200).json({ ok: true, customer: data });
  } catch (e) {
    console.error('[sales-retention-mark]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
