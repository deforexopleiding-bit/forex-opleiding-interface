// api/mentor-payout-mark-paid.js
//
// Fase 3 — Markeer-uitbetaald. Voert de definitieve groeboek-mutatie uit:
//   - mentor_payouts.status        → 'uitbetaald'
//   - mentor_payouts.paid_at       → now()
//   - mentor_ledger_entries.status → 'uitbetaald' (alle vrijgegeven entries
//                                   in de periode)
//   - mentor_ledger_entries.payout_id → payout_id
//
// Permission: mentor.payout.manage.
//
// Body: { payout_id: uuid }
//
// De volledige groeboek-mutatie zit in de Postgres-functie `mark_payout_paid`
// (atomair binnen één transactie). Deze handler doet alleen auth + validatie
// + de RPC + foutmapping. Buiten de RPC raakt deze code GEEN andere tabellen
// aan — een gedeeltelijke schrijfactie hier zou de ledger desync'en met de
// payouts-rij, en dat moet onmogelijk zijn.
//
// Foutmapping (op basis van Postgres error.message):
//   'not_found'                → 404 'rapport niet gevonden'
//   begint met 'bad_status'    → 409 'alleen een goedgekeurd rapport ...'
//                                (de actuele status wordt mee-getoond)
//   begint met 'bonus_drift'   → 409 'bonusbedrag is gewijzigd sinds
//                                goedkeuren — keur opnieuw goed'
//                                (code BONUS_DRIFT zodat de UI er
//                                specifiek op kan reageren)
//   anders                     → 500 met de raw message.
//
// Response 200: { ok:true, status:'uitbetaald', ledger_marked:<int> }
// 'ledger_marked' komt rechtstreeks uit de RPC en is het aantal
// ledger-entries dat naar 'uitbetaald' is gezet.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createNotification } from './_lib/notify.js';

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
    const { data, error } = await supabaseAdmin.rpc('mark_payout_paid', {
      p_payout_id: payoutId,
      p_actor    : user.id,
    });
    if (error) {
      const raw = String(error.message || error.details || '').trim();
      if (raw === 'not_found') {
        return res.status(404).json({ error: 'rapport niet gevonden' });
      }
      if (raw.startsWith('bad_status')) {
        // PG-conventie: 'bad_status:<huidige>'. Pakt ook 'bad_status' zonder suffix.
        const m = raw.match(/^bad_status[:\s]*(.*)$/);
        const current = (m && m[1]) ? m[1].trim() : '';
        return res.status(409).json({
          error  : 'alleen een goedgekeurd rapport kan op uitbetaald',
          code   : 'BAD_STATUS',
          status : current || null,
        });
      }
      if (raw.startsWith('bonus_drift')) {
        return res.status(409).json({
          error: 'bonusbedrag is gewijzigd sinds goedkeuren — keur opnieuw goed',
          code : 'BONUS_DRIFT',
        });
      }
      return res.status(500).json({ error: raw || 'Interne fout' });
    }

    // De RPC kan { ledger_marked: <int> } of een direct integer retourneren —
    // beide vormen defensief afvangen.
    let ledgerMarked = 0;
    if (data && typeof data === 'object' && 'ledger_marked' in data) {
      ledgerMarked = Number(data.ledger_marked) || 0;
    } else if (Number.isFinite(Number(data))) {
      ledgerMarked = Number(data);
    }

    // Fail-soft dual-write: mentor notificeren dat de uitbetaling is
    // verwerkt. mentor_user_id ophalen uit de payout-rij; extra select
    // is cheap en fail-soft (fout logt alleen).
    try {
      const { data: prow } = await supabaseAdmin
        .from('mentor_payouts')
        .select('mentor_user_id, period_month')
        .eq('id', payoutId)
        .maybeSingle();
      if (prow && prow.mentor_user_id) {
        const NL_MONTHS_LOCAL = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
        let periodNL = '';
        if (typeof prow.period_month === 'string') {
          const m = prow.period_month.match(/^(\d{4})-(\d{2})/);
          if (m) periodNL = (NL_MONTHS_LOCAL[parseInt(m[2], 10) - 1] || m[2]) + ' ' + m[1];
        }
        createNotification({
          toUserId:   prow.mentor_user_id,
          type:       'payout.paid',
          title:      'Uitbetaling gedaan' + (periodNL ? (' · ' + periodNL) : ''),
          body:       'Je uitbetaling is verwerkt',
          linkUrl:    '/modules/mentor-dashboard.html',
          entityType: 'payout',
          entityId:   payoutId,
          createdBy:  user.id,
        }).catch(() => {});
      }
    } catch (_) { /* fail-soft */ }

    return res.status(200).json({
      ok            : true,
      status        : 'uitbetaald',
      ledger_marked : ledgerMarked,
    });
  } catch (e) {
    console.error('[mentor-payout-mark-paid]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
