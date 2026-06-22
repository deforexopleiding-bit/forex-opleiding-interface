// api/mentor-payout-reopen.js
//
// Heropen — zet een goedgekeurd rapport terug naar 'concept' zodat finance
// nog wijzigingen kan doorvoeren. Geen ledger-mutatie nodig (bij 'goedgekeurd'
// is nog niks definitief geboekt; pas bij 'uitbetaald' raken ledger-entries
// gekoppeld — zie mentor-payout-revert voor dat scenario).
//
// Permission: mentor.payout.manage.
//
// Body: { payout_id: uuid }
//
// Flow:
//   1) Laad payout. Alleen vanuit 'goedgekeurd' → 409 anders met passende msg
//      ('concept': "al bewerkbaar"; 'uitbetaald': "eerst terugdraaien").
//   2) UPDATE mentor_payouts SET status='concept', approved_at=null,
//      approved_by=null WHERE id=payout_id AND status='goedgekeurd'.
//      Affected rows controleren — 0 → 409 STATE_RACE.
//   3) computeAndUpsertConcept fail-soft (verse cijfers nu het weer concept is).
//
// Response 200: { ok:true, status:'concept' }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeAndUpsertConcept } from './_lib/payout-generate-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const payoutId = typeof body.payout_id === 'string' ? body.payout_id.trim() : '';
  if (!payoutId || !UUID_RE.test(payoutId)) {
    return res.status(400).json({ error: 'payout_id (uuid) vereist' });
  }

  try {
    // 1) Laad payout.
    const { data: payout, error: loadErr } = await supabaseAdmin
      .from('mentor_payouts')
      .select('id, mentor_user_id, period_month, status')
      .eq('id', payoutId)
      .maybeSingle();
    if (loadErr) throw new Error('payout load: ' + loadErr.message);
    if (!payout) return res.status(404).json({ error: 'Rapport niet gevonden' });

    if (payout.status !== 'goedgekeurd') {
      const msg = payout.status === 'concept'
        ? 'al bewerkbaar (status=concept)'
        : payout.status === 'uitbetaald'
          ? 'eerst terugdraaien (status=uitbetaald)'
          : `kan niet heropenen vanuit status=${payout.status}`;
      return res.status(409).json({
        error : msg,
        code  : 'BAD_STATUS',
        status: payout.status,
      });
    }

    // 2) Status-wissel met race-bescherming: alleen UPDATE als status nog
    //    'goedgekeurd' is. Affected rows controleren via .select().
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('mentor_payouts')
      .update({
        status      : 'concept',
        approved_at : null,
        approved_by : null,
      })
      .eq('id', payoutId)
      .eq('status', 'goedgekeurd')
      .select('id, mentor_user_id, period_month, status');
    if (updErr) throw new Error('payouts update: ' + updErr.message);
    if (!updated || updated.length === 0) {
      // Status veranderde tussen check en update (race).
      return res.status(409).json({
        error: 'status is intussen gewijzigd, ververs en probeer opnieuw',
        code : 'STATE_RACE',
      });
    }

    // 3) Recompute concept fail-soft — verse cijfers nu het weer bewerkbaar is.
    try {
      await computeAndUpsertConcept({
        mentorUserId: payout.mentor_user_id,
        monthStart  : payout.period_month,
        actorId     : user.id,
      });
    } catch (e) {
      console.warn('[mentor-payout-reopen] recompute faalde:', e?.message || e);
    }

    return res.status(200).json({ ok: true, status: 'concept' });
  } catch (e) {
    console.error('[mentor-payout-reopen]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
