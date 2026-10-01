// api/setter-reports.js
//
// Setter-maandrapporten (tab Rapporten in de Commissie-module).
//
// GET  ?setter_user_id=<uuid>   (optioneel; default: user zelf)
//   → { setter_user_id, reports: [{ id, period_month, status, fee_total,
//       commission_total, total, generated_at, approved_at, paid_at, lines:[…] }] }
//   Gate: setter.ledger.view; een andere setter vereist setter.ledger.admin.
//
// POST { action, … }   Gate: setter.payout.manage
//   - generate  { setter_user_id, month: 'YYYY-MM' } → concept maken/herberekenen
//   - approve   { report_id }  concept → (herberekenen) → goedgekeurd
//   - mark_paid { report_id }  goedgekeurd → uitbetaald; gekoppelde
//                              grootboekregels → 'uitbetaald' + paid_at
//   - reopen    { report_id }  goedgekeurd → concept (uitbetaald blijft dicht)
// Minimale spiegel van mentor-payout-generate/-approve/-mark-paid/-revert
// (zonder mail).
//
// Zonder migratie 2026-10-01-setter-maandrapport.sql: GET → 200
// { reports: [], migratie_nodig: true }; POST → 503.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeAndUpsertSetterReport, normalizeMonthStart, migratieFout } from './_lib/setter-report-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lijst(res, setterId) {
  const { data: reports, error } = await supabaseAdmin.from('setter_monthly_reports')
    .select('id, setter_user_id, period_month, status, fee_total, commission_total, total, generated_at, approved_at, paid_at')
    .eq('setter_user_id', setterId).order('period_month', { ascending: false }).limit(36);
  if (error) {
    if (migratieFout(error)) return res.status(200).json({ setter_user_id: setterId, reports: [], migratie_nodig: true });
    throw new Error('rapporten: ' + error.message);
  }
  const ids = (reports || []).map((r) => r.id);
  let lines = [];
  if (ids.length) {
    const { data, error: lErr } = await supabaseAdmin.from('setter_monthly_report_lines')
      .select('id, report_id, kind, label, invoice_id, deal_id, customer_id, betaal_datum, basis, pct, amount, position')
      .in('report_id', ids).order('position', { ascending: true });
    if (lErr) throw new Error('regels: ' + lErr.message);
    lines = data || [];
  }
  const num = (v) => Number(v) || 0;
  return res.status(200).json({
    setter_user_id: setterId,
    reports: (reports || []).map((r) => ({
      ...r,
      fee_total: num(r.fee_total), commission_total: num(r.commission_total), total: num(r.total),
      lines: lines.filter((l) => l.report_id === r.id).map((l) => ({ ...l, amount: num(l.amount), basis: l.basis == null ? null : num(l.basis) })),
    })),
  });
}

async function laadRapport(id) {
  const { data, error } = await supabaseAdmin.from('setter_monthly_reports')
    .select('id, setter_user_id, period_month, status').eq('id', id).maybeSingle();
  if (error) throw migratieFout(error) || new Error('rapport: ' + error.message);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'setter.ledger.view'))) {
        return res.status(403).json({ error: 'Geen rechten (setter.ledger.view)' });
      }
      const requested = String(req.query?.setter_user_id || '').trim();
      let setterId = user.id;
      if (requested && requested !== user.id) {
        if (!UUID_RE.test(requested)) return res.status(400).json({ error: 'setter_user_id ongeldig' });
        if (!(await requirePermission(req, 'setter.ledger.admin'))) {
          return res.status(403).json({ error: 'Alleen setter.ledger.admin mag andere setters bekijken' });
        }
        setterId = requested;
      }
      return await lijst(res, setterId);
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'GET of POST' });
    }
    if (!(await requirePermission(req, 'setter.payout.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (setter.payout.manage)' });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const action = String(body.action || '');

    if (action === 'generate') {
      const setterId = String(body.setter_user_id || '');
      const month = normalizeMonthStart(body.month);
      if (!UUID_RE.test(setterId)) return res.status(400).json({ error: 'setter_user_id (uuid) vereist' });
      if (!month) return res.status(400).json({ error: 'month (YYYY-MM) vereist' });
      const r = await computeAndUpsertSetterReport({ db: supabaseAdmin, setterId, monthStart: month, actorId: user.id });
      if (r.skipped) return res.status(409).json({ error: `Rapport is al ${r.status}`, code: 'AL_DEFINITIEF', ...r });
      return res.status(200).json({ ok: true, ...r });
    }

    const reportId = String(body.report_id || '');
    if (!UUID_RE.test(reportId)) return res.status(400).json({ error: 'report_id (uuid) vereist' });
    const rapport = await laadRapport(reportId);
    if (!rapport) return res.status(404).json({ error: 'Rapport niet gevonden' });
    const nowIso = new Date().toISOString();

    if (action === 'approve') {
      if (rapport.status !== 'concept') return res.status(409).json({ error: `al ${rapport.status}`, status: rapport.status });
      // Eerst herberekenen: nooit goedkeuren op een verouderde snapshot.
      const r = await computeAndUpsertSetterReport({ db: supabaseAdmin, setterId: rapport.setter_user_id, monthStart: rapport.period_month, actorId: user.id });
      if (r.skipped) return res.status(409).json({ error: 'Rapport werd tijdens herberekening definitief', code: 'REFRESH_RACE' });
      const { data, error } = await supabaseAdmin.from('setter_monthly_reports')
        .update({ status: 'goedgekeurd', approved_at: nowIso, approved_by: user.id, updated_at: nowIso })
        .eq('id', reportId).eq('status', 'concept').select('id, status, total, approved_at');
      if (error) throw new Error('goedkeuren: ' + error.message);
      if (!data?.length) return res.status(409).json({ error: 'Status gewijzigd door iemand anders', code: 'RACE' });
      return res.status(200).json({ ok: true, ...data[0] });
    }

    if (action === 'mark_paid') {
      if (rapport.status !== 'goedgekeurd') return res.status(409).json({ error: `Alleen een goedgekeurd rapport kan uitbetaald worden (nu: ${rapport.status})` });
      const { data, error } = await supabaseAdmin.from('setter_monthly_reports')
        .update({ status: 'uitbetaald', paid_at: nowIso, paid_by: user.id, updated_at: nowIso })
        .eq('id', reportId).eq('status', 'goedgekeurd').select('id, status, total, paid_at');
      if (error) throw new Error('uitbetalen: ' + error.message);
      if (!data?.length) return res.status(409).json({ error: 'Status gewijzigd door iemand anders', code: 'RACE' });
      // Grootboek mee: de regels in dit rapport zijn nu uitbetaald.
      const { error: lErr } = await supabaseAdmin.from('setter_ledger_entries')
        .update({ status: 'uitbetaald', paid_at: nowIso })
        .eq('monthly_report_id', reportId).eq('status', 'vrijgegeven');
      if (lErr) {
        console.error('[setter-reports] grootboek uitbetaald zetten faalde', reportId, lErr.message);
        return res.status(200).json({ ok: true, ...data[0], waarschuwing: 'Rapport uitbetaald, maar grootboekregels niet bijgewerkt: ' + lErr.message });
      }
      return res.status(200).json({ ok: true, ...data[0] });
    }

    if (action === 'reopen') {
      if (rapport.status !== 'goedgekeurd') return res.status(409).json({ error: `Alleen een goedgekeurd rapport kan heropend worden (nu: ${rapport.status})` });
      const { data, error } = await supabaseAdmin.from('setter_monthly_reports')
        .update({ status: 'concept', approved_at: null, approved_by: null, updated_at: nowIso })
        .eq('id', reportId).eq('status', 'goedgekeurd').select('id, status');
      if (error) throw new Error('heropenen: ' + error.message);
      if (!data?.length) return res.status(409).json({ error: 'Status gewijzigd door iemand anders', code: 'RACE' });
      return res.status(200).json({ ok: true, ...data[0] });
    }

    return res.status(400).json({ error: 'action moet generate | approve | mark_paid | reopen zijn' });
  } catch (e) {
    if (e?.code === 'MIGRATIE_ONTBREEKT') return res.status(503).json({ error: e.message, code: e.code });
    console.error('[setter-reports]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
