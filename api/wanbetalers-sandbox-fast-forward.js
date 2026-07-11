// api/wanbetalers-sandbox-fast-forward.js
// POST { days } → backdate stage_changed_at, factuur-vervaldatums en
// dunning_log-timestamps voor de is_test-customer, zodat engine/bulk-
// condities meteen triggeren zonder wachten. Super_admin only.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const days = Math.max(1, Math.min(365, Number(body.days) || 7));

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });

    // 1) Backdate factuur-vervaldatums met N dagen extra (openstaand →
    //    ouder worden). We doen SELECT + per-rij UPDATE want PostgREST
    //    ondersteunt geen "SET col = col - interval" expressie.
    const { data: invs } = await supabaseAdmin
      .from('invoices').select('id, due_date, issue_date')
      .eq('customer_id', customer.id).eq('is_test', true);
    let invUpdated = 0;
    for (const inv of invs || []) {
      const patch = {};
      if (inv.due_date)   patch.due_date   = _shiftIso(inv.due_date, -days);
      if (inv.issue_date) patch.issue_date = _shiftIso(inv.issue_date, -days);
      if (Object.keys(patch).length === 0) continue;
      const { error } = await supabaseAdmin.from('invoices').update(patch).eq('id', inv.id);
      if (!error) invUpdated++;
    }

    // 2) Pipeline: backdate stage_changed_at + last_activity_at.
    const shiftMs = days * 24 * 3600 * 1000;
    const { data: pipe } = await supabaseAdmin
      .from('dunning_pipeline_customers').select('id, stage_changed_at, last_activity_at')
      .eq('customer_id', customer.id).maybeSingle();
    if (pipe) {
      const patch = {};
      if (pipe.stage_changed_at) patch.stage_changed_at = new Date(new Date(pipe.stage_changed_at).getTime() - shiftMs).toISOString();
      if (pipe.last_activity_at) patch.last_activity_at = new Date(new Date(pipe.last_activity_at).getTime() - shiftMs).toISOString();
      if (Object.keys(patch).length > 0) {
        await supabaseAdmin.from('dunning_pipeline_customers').update(patch).eq('id', pipe.id);
      }
    }

    // 3) Cooldown-reset: verwijder recente 'bulk_reminder_sent'-logs voor
    //    deze klant zodat de engine niet meer denkt dat 'ie recent is
    //    aangemaand (cooldown-check kijkt naar dunning_log.payload.customer_id).
    try {
      await supabaseAdmin.from('dunning_log').delete()
        .eq('event_type', 'bulk_reminder_sent')
        .filter('payload->>customer_id', 'eq', customer.id);
    } catch (e) {
      console.warn('[sandbox-fast-forward] cooldown-log wipe soft-fail', e?.message);
    }

    return res.status(200).json({ ok: true, days, invoices_updated: invUpdated });
  } catch (e) {
    console.error('[sandbox-fast-forward]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

function _shiftIso(dateStr, deltaDays) {
  try {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  } catch (_) { return dateStr; }
}
