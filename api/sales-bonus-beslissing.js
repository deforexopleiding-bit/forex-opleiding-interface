// api/sales-bonus-beslissing.js
// POST — een admin beslist per sales-bonus, of kent een bonus met de hand toe.
// super_admin / admin. Elke actie wordt gelogd in agent_audit_log
// (action 'sales.bonus.beslissing' / 'sales.bonus.toekennen'); het
// controle-overzicht (api/sales-bonus-overview.js) leest die terug.
//
// Body:
//   { actie: 'beslis', bonus_id, beslissing: 'houden'|'ongeldig'|'aanpassen',
//     reden, bedrag?, ontvanger_id? }
//       houden    → enkel gelogd (bonus blijft; telt verder naar betaling)
//       ongeldig  → bonus voided (al uitbetaald → clawback_pending + melding)
//       aanpassen → nieuw bedrag en/of andere ontvanger (niet bij 'paid')
//   { actie: 'toekennen', deal_id | quote_reference, ontvanger_id, bedrag, reden,
//     basis?, telt_volledig? }
//       uitzondering: nieuwe bonus op een deal. Met basis telt hij naar
//       betaling (zoals elke bonus); zonder basis + telt_volledig telt hij meteen.
//
// Regels Maxim (6 nov 2026): NIETS gebeurt automatisch; dit endpoint voert
// alleen uit wat een admin per bonus kiest.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { voidBonusById } from './_lib/sales-bonus.js';
import { AUDIT_BESLISSING, AUDIT_TOEKENNING } from './_lib/sales-bonus-stand.js';

export const BONUS_ADMIN_ROLLEN = ['super_admin', 'admin'];
const BESLISSINGEN = ['houden', 'ongeldig', 'aanpassen'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

async function log(action, payload, userId) {
  const { error } = await supabaseAdmin.from('agent_audit_log').insert({
    agent_name: 'sales', action, payload, result: {}, status: 'success', triggered_by: userId,
  });
  if (error) console.error('[sales-bonus-beslissing] audit-log FAIL:', error.message, action, payload);
  return !error;
}

async function actieveOntvanger(id) {
  if (!isUuid(id)) return null;
  const { data } = await supabaseAdmin.from('profiles').select('id, full_name, role, is_active').eq('id', id).maybeSingle();
  return data && data.is_active !== false ? data : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin || !BONUS_ADMIN_ROLLEN.includes(admin.profile?.role)) {
    return res.status(403).json({ error: 'Alleen super_admin of admin.' });
  }
  const userId = admin.user.id;
  const b = req.body || {};
  const reden = String(b.reden || '').trim();
  if (reden.length < 3) return res.status(400).json({ error: 'Geef een reden (min. 3 tekens).', code: 'REDEN_VERPLICHT' });
  if (reden.length > 500) return res.status(400).json({ error: 'Reden is te lang (max. 500 tekens).' });

  try {
    if (b.actie === 'beslis') {
      if (!isUuid(b.bonus_id)) return res.status(400).json({ error: 'bonus_id ontbreekt' });
      if (!BESLISSINGEN.includes(b.beslissing)) return res.status(400).json({ error: 'Kies houden, ongeldig of aanpassen.' });
      const { data: bonus, error: bErr } = await supabaseAdmin.from('bonuses')
        .select('id, deal_id, sales_user_id, amount, status').eq('id', b.bonus_id).maybeSingle();
      if (bErr) return res.status(500).json({ error: 'bonus lezen: ' + bErr.message });
      if (!bonus) return res.status(404).json({ error: 'Bonus niet gevonden' });
      if (bonus.status === 'voided') return res.status(409).json({ error: 'Deze bonus is al ongeldig.', code: 'AL_ONGELDIG' });
      const oud = { amount: r2(bonus.amount), sales_user_id: bonus.sales_user_id, status: bonus.status };

      if (b.beslissing === 'houden') {
        const ok = await log(AUDIT_BESLISSING, { bonus_id: bonus.id, beslissing: 'houden', reden, oud }, userId);
        if (!ok) return res.status(500).json({ error: 'Beslissing kon niet gelogd worden.' });
        return res.status(200).json({ ok: true, beslissing: 'houden' });
      }

      if (b.beslissing === 'ongeldig') {
        const r = await voidBonusById(bonus.id, { reason: `beslissing admin: ${reden}`, source: 'sales-bonus-beslissing' });
        if (!r.ok) return res.status(404).json({ error: 'Bonus niet gevonden' });
        const ok = await log(AUDIT_BESLISSING, { bonus_id: bonus.id, beslissing: 'ongeldig', reden, oud, clawback: !!r.clawback }, userId);
        return res.status(200).json({ ok: true, beslissing: 'ongeldig', clawback: !!r.clawback, gelogd: ok });
      }

      // aanpassen
      if (bonus.status === 'paid') {
        return res.status(409).json({ error: 'Al uitbetaald: aanpassen kan niet. Maak hem ongeldig (terugvorderen) of laat hem staan.', code: 'AL_UITBETAALD' });
      }
      const patch = {};
      if (b.bedrag != null && b.bedrag !== '') {
        const n = r2(b.bedrag);
        if (!(n > 0)) return res.status(400).json({ error: 'Bedrag moet groter dan 0 zijn (anders: ongeldig).' });
        if (n !== oud.amount) patch.amount = n;
      }
      if (b.ontvanger_id && b.ontvanger_id !== bonus.sales_user_id) {
        const p = await actieveOntvanger(b.ontvanger_id);
        if (!p) return res.status(400).json({ error: 'Onbekende of niet-actieve ontvanger.' });
        patch.sales_user_id = p.id;
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Niets gewijzigd: geef een nieuw bedrag of een andere ontvanger.' });
      const { data: upd, error: uErr } = await supabaseAdmin.from('bonuses')
        .update(patch).eq('id', bonus.id).neq('status', 'voided').neq('status', 'paid')
        .select('id, amount, sales_user_id').maybeSingle();
      if (uErr) return res.status(500).json({ error: 'bonus aanpassen: ' + uErr.message });
      if (!upd) return res.status(409).json({ error: 'De bonus veranderde intussen; ververs en probeer opnieuw.' });
      const ok = await log(AUDIT_BESLISSING, { bonus_id: bonus.id, beslissing: 'aanpassen', reden, oud, nieuw: { amount: r2(upd.amount), sales_user_id: upd.sales_user_id } }, userId);
      return res.status(200).json({ ok: true, beslissing: 'aanpassen', bonus: upd, gelogd: ok });
    }

    if (b.actie === 'toekennen') {
      let deal = null;
      const kol = 'id, customer_id, quote_reference, archived_at';
      if (isUuid(b.deal_id)) {
        ({ data: deal } = await supabaseAdmin.from('deals').select(kol).eq('id', b.deal_id).maybeSingle());
      } else if (b.quote_reference) {
        const { data } = await supabaseAdmin.from('deals').select(kol).eq('quote_reference', String(b.quote_reference).trim()).limit(2);
        if ((data || []).length > 1) return res.status(400).json({ error: 'Dit offertenummer komt meer dan eens voor: geef de deal-id.' });
        deal = (data || [])[0] || null;
      }
      if (!deal) return res.status(404).json({ error: 'Deal niet gevonden (deal-id of offertenummer).' });
      const p = await actieveOntvanger(b.ontvanger_id);
      if (!p) return res.status(400).json({ error: 'Kies een actieve ontvanger.' });
      const bedrag = r2(b.bedrag);
      if (!(bedrag > 0)) return res.status(400).json({ error: 'Bedrag moet groter dan 0 zijn.' });
      const basis = b.basis != null && b.basis !== '' ? r2(b.basis) : null;
      if (basis != null && !(basis > 0)) return res.status(400).json({ error: 'Basis moet groter dan 0 zijn (of leeg laten).' });
      const teltVolledig = basis == null ? b.telt_volledig === true : false;
      if (basis == null && !teltVolledig) {
        return res.status(400).json({ error: 'Geef een basis (bonus telt naar betaling) of kies "telt meteen volledig".', code: 'BASIS_OF_VOLLEDIG' });
      }
      const { data: actief } = await supabaseAdmin.from('bonuses').select('id').eq('deal_id', deal.id).neq('status', 'voided').limit(1).maybeSingle();
      if (actief) return res.status(409).json({ error: 'Deze deal heeft al een actieve bonus: pas die aan in plaats van een tweede toe te kennen.', code: 'AL_BONUS', bonus_id: actief.id });
      const { data: nieuw, error: iErr } = await supabaseAdmin.from('bonuses')
        .insert({ deal_id: deal.id, sales_user_id: p.id, amount: bedrag, status: 'pending' }).select('id, deal_id, sales_user_id, amount, status').single();
      if (iErr) {
        if (iErr.code === '23505') return res.status(409).json({ error: 'Deze deal heeft al een actieve bonus.', code: 'AL_BONUS' });
        return res.status(500).json({ error: 'bonus aanmaken: ' + iErr.message });
      }
      const ok = await log(AUDIT_TOEKENNING, { bonus_id: nieuw.id, deal_id: deal.id, ontvanger_id: p.id, bedrag, basis, telt_volledig: teltVolledig, reden }, userId);
      if (!ok) console.error('[sales-bonus-beslissing] toekenning ZONDER log:', nieuw.id);
      return res.status(200).json({ ok: true, bonus: nieuw, gelogd: ok });
    }

    return res.status(400).json({ error: "actie moet 'beslis' of 'toekennen' zijn" });
  } catch (e) {
    console.error('[sales-bonus-beslissing]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
