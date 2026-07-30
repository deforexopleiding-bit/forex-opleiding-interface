// api/finance-dunning-paused-list.js
// GET → read-only lijst van dunning-runs die gepauzeerd zijn door een
// actief gesprek (paused_by_conversation_id IS NOT NULL). Voor de nieuwe
// Acties-werkcentrum-sectie "Gepauzeerd (in gesprek)".
//
// Data-shape per rij:
//   {
//     run_id, customer_id, customer_name,
//     conversation_id,
//     paused_since,                 // dunning_workflow_runs.updated_at
//     reminder_count,               // paused_conversation_reminder_count
//     last_reminder_at,             // paused_conversation_last_reminder_at
//     conversation_updated_at,      // wc.updated_at
//     conversation_status           // wc.status
//   }
//
// Permission: finance.dunning.view (lezen genoeg; geen mutaties).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  try {
    // 1) Alle paused runs met paused_by_conversation_id.
    const { data: runs, error: runsErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, customer_id, paused_by_conversation_id, paused_conversation_reminder_count, paused_conversation_last_reminder_at, updated_at')
      .eq('status', 'paused')
      .not('paused_by_conversation_id', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(200);
    if (runsErr) throw new Error('runs lookup: ' + runsErr.message);
    if (!runs?.length) return res.status(200).json({ items: [], count: 0 });

    // 2) Klant + gesprek in aparte queries (voorkomt PostgREST embed-complexity).
    const custIds = Array.from(new Set(runs.map((r) => r.customer_id).filter(Boolean)));
    const convIds = Array.from(new Set(runs.map((r) => r.paused_by_conversation_id).filter(Boolean)));

    const [{ data: custs }, { data: convs }] = await Promise.all([
      supabaseAdmin.from('customers')
        .select('id, first_name, last_name, company_name, is_company, email')
        .in('id', custIds),
      supabaseAdmin.from('whatsapp_conversations')
        .select('id, status, updated_at')
        .in('id', convIds),
    ]);
    const custById = new Map((custs || []).map((c) => [c.id, c]));
    const convById = new Map((convs || []).map((c) => [c.id, c]));

    const items = runs.map((r) => {
      const cust = custById.get(r.customer_id) || null;
      const conv = convById.get(r.paused_by_conversation_id) || null;
      return {
        run_id:                    r.id,
        customer_id:               r.customer_id,
        customer_name:             cust ? customerDisplayName(cust, '(zonder naam)') : '(onbekend)',
        customer_email:            cust?.email || null,
        conversation_id:           r.paused_by_conversation_id,
        paused_since:              r.updated_at,
        reminder_count:            r.paused_conversation_reminder_count || 0,
        last_reminder_at:          r.paused_conversation_last_reminder_at || null,
        conversation_updated_at:   conv?.updated_at || null,
        conversation_status:       conv?.status || null,
      };
    });

    return res.status(200).json({ items, count: items.length });
  } catch (e) {
    console.error('[finance-dunning-paused-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
