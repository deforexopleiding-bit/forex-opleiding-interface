// api/mentor-payout-adjustment-save.js
//
// POST → insert/update mentor_payout_adjustments. Na de schrijfactie wordt
// het lopende concept opnieuw berekend zodat de adjustment direct in het
// rapport landt. Definitieve rapporten (goedgekeurd/uitbetaald) worden NIET
// herrekend (skip-pad in core).
//
// Permission: mentor.payout.manage.
//
// Body:
//   { id?: uuid (zonder = insert; met = update),
//     mentor_user_id: uuid,
//     period_month: 'YYYY-MM' | 'YYYY-MM-DD',
//     label: string (1..200),
//     amount_incl: number (mag negatief) }
//
// Response 200:
//   { ok, item: {...}, recompute: <core-output> | { skipped:true, ... } | null }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  computeAndUpsertConcept,
  normalizeMonthStart,
} from './_lib/payout-generate-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const id           = typeof body.id === 'string' ? body.id.trim() : '';
  const mentorUserId = typeof body.mentor_user_id === 'string' ? body.mentor_user_id.trim() : '';
  const monthStart   = normalizeMonthStart(body.period_month);
  const label        = typeof body.label === 'string' ? body.label.trim() : '';
  const amountIncl   = round2(body.amount_incl);

  if (id && !UUID_RE.test(id))                   return res.status(400).json({ error: 'id (uuid) ongeldig' });
  if (!mentorUserId || !UUID_RE.test(mentorUserId)) return res.status(400).json({ error: 'mentor_user_id (uuid) vereist' });
  if (!monthStart)                                return res.status(400).json({ error: 'period_month moet YYYY-MM zijn' });
  if (!label || label.length > 200)               return res.status(400).json({ error: 'label vereist (1..200 chars)' });
  if (!Number.isFinite(amountIncl))               return res.status(400).json({ error: 'amount_incl moet een getal zijn (mag negatief)' });

  try {
    let item;
    if (id) {
      const { data, error } = await supabaseAdmin
        .from('mentor_payout_adjustments')
        .update({ label, amount_incl: amountIncl })
        .eq('id', id)
        .select('id, mentor_user_id, period_month, label, amount_incl')
        .single();
      if (error) throw new Error('adjustment update: ' + error.message);
      item = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('mentor_payout_adjustments')
        .insert({
          mentor_user_id: mentorUserId,
          period_month  : monthStart,
          label,
          amount_incl   : amountIncl,
        })
        .select('id, mentor_user_id, period_month, label, amount_incl')
        .single();
      if (error) throw new Error('adjustment insert: ' + error.message);
      item = data;
    }

    // Recompute van het concept zodat de UI direct het nieuwe totaal ziet.
    // Bij definitieve status returnt de core { skipped:true } — UI toont
    // dat als "rapport al definitief, post is bewaard maar niet meegerekend".
    let recompute = null;
    try {
      recompute = await computeAndUpsertConcept({
        mentorUserId: item.mentor_user_id,
        monthStart  : item.period_month,
        actorId     : user.id,
      });
    } catch (e) {
      console.warn('[mentor-payout-adjustment-save] recompute faalde:', e?.message || e);
      recompute = { error: e?.message || String(e) };
    }

    return res.status(200).json({ ok: true, item, recompute });
  } catch (e) {
    console.error('[mentor-payout-adjustment-save]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
