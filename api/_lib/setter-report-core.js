// api/_lib/setter-report-core.js
//
// Setter-maandrapport — spiegel van _lib/payout-generate-core.js (mentoren),
// maar met twee bronnen:
//   1. VASTE VERGOEDING — setter_config.monthly_fee (incl. btw). Telt voor
//      maand M als de regeling actief is en effective_from <= de 1e van M
//      (een start halverwege de maand krijgt die maand geen vergoeding).
//   2. COMMISSIE — setter_ledger_entries (PR B) met status 'vrijgegeven',
//      nog niet aan een ander rapport gekoppeld, en betaal_datum < de 1e van
//      M+1. Dus maand M zelf PLUS achterblijvers uit eerdere maanden die pas
//      na het afsluiten van dat rapport geboekt werden (late sync,
//      terug-gedateerde betaling). Negatieve correcties (creditnota) tellen
//      gewoon mee.
// Alle bedragen incl. btw.
//
// computeAndUpsertSetterReport({ db, setterId, monthStart, actorId }):
//   - bestaand rapport goedgekeurd/uitbetaald → skipped (nooit overschrijven);
//   - anders concept updaten/aanmaken, regels volledig herbouwen
//     (delete-all + insert), grootboekregels koppelen via
//     setter_ledger_entries.monthly_report_id (eerst de eigen koppelingen
//     los, dan opnieuw — zelfde aanpak als de mentor-ledger-koppeling).
//   - Niet atomair (PostgREST): faalt het halverwege, dan herstelt de
//     volgende herberekening het.
//
// Migratie: docs/sql-migrations/2026-10-01-setter-maandrapport.sql. Ontbreekt
// die, dan gooit dit een Error met code 'MIGRATIE_ONTBREEKT'.

import { round2 } from './setter-sale-plan.js';

const MONTH_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const n = (v) => Number(v) || 0;

/** 'YYYY-MM' of 'YYYY-MM-DD' → 'YYYY-MM-01' (null bij ongeldig). */
export function normalizeMonthStart(s) {
  const m = MONTH_RE.exec(String(s || '').trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (y < 2020 || y > 2100 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}

/** 'YYYY-MM-01' → 'YYYY-(MM+1)-01'. */
export function nextMonthStart(monthStart) {
  const [y, mo] = monthStart.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
}

/** Vorige maand t.o.v. now (UTC). */
export function previousMonthStart(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  return m === 0 ? `${y - 1}-12-01` : `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Cron-guard: alleen op de 1e van de maand (UTC). */
export function isEersteVanDeMaandUTC(d = new Date()) {
  return d.getUTCDate() === 1;
}

/** Vaste vergoeding voor maand M. */
export function vasteVergoeding(cfg, monthStart) {
  if (!cfg || !cfg.is_active) return 0;
  const fee = round2(cfg.monthly_fee);
  if (fee <= 0) return 0;
  const vanaf = cfg.effective_from ? String(cfg.effective_from).slice(0, 10) : null;
  if (vanaf && vanaf > monthStart) return 0;
  return fee;
}

/** Welke grootboekregels horen in het rapport van M? */
export function selecteerRegels(entries, { monthStart, reportId = null }) {
  const grens = nextMonthStart(monthStart);
  return (entries || []).filter((e) => {
    if (e.status !== 'vrijgegeven') return false;
    if (e.monthly_report_id && e.monthly_report_id !== reportId) return false;
    const d = String(e.betaal_datum || e.created_at || '').slice(0, 10);
    return !!d && d < grens;
  });
}

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
export function maandNaam(monthStart) {
  const [y, mo] = String(monthStart).split('-').map(Number);
  return `${MAANDEN[mo - 1]} ${y}`;
}

/**
 * Pure opbouw van het rapport: totalen + regels (zonder report_id).
 * @returns {{ fee_total, commission_total, total, lines: Array, entry_ids: string[] }}
 */
export function bouwRapport({ cfg, monthStart, entries, reportId = null, labels = {} }) {
  const fee = vasteVergoeding(cfg, monthStart);
  const gekozen = selecteerRegels(entries, { monthStart, reportId })
    .sort((a, b) => String(a.betaal_datum || a.created_at).localeCompare(String(b.betaal_datum || b.created_at)));
  const lines = [];
  if (fee > 0) {
    lines.push({ kind: 'vaste_vergoeding', label: `Vaste maandvergoeding ${maandNaam(monthStart)}`, amount: fee, position: 0 });
  }
  gekozen.forEach((e, i) => {
    const d = String(e.betaal_datum || e.created_at || '').slice(0, 10) || null;
    const klant = e.customer_id ? labels[e.customer_id] : null;
    const eerder = d && d < monthStart ? ` (betaald ${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)})` : '';
    lines.push({
      kind: n(e.amount) < 0 ? 'correctie' : 'commissie',
      label: [klant, e.note].filter(Boolean).join(' · ') + eerder || 'Commissie',
      ledger_entry_id: e.id,
      invoice_id: e.invoice_id || null,
      deal_id: e.deal_id || null,
      customer_id: e.customer_id || null,
      betaal_datum: d,
      basis: e.basis == null ? null : round2(e.basis),
      pct: e.pct == null ? null : n(e.pct),
      amount: round2(e.amount),
      position: i + 1,
    });
  });
  const commission = round2(gekozen.reduce((s, e) => s + n(e.amount), 0));
  return {
    fee_total: fee,
    commission_total: commission,
    total: round2(fee + commission),
    lines,
    entry_ids: gekozen.map((e) => e.id),
  };
}

// Ontbrekende tabel/kolom: Postgres 42P01/42703, PostgREST schema-cache
// PGRST205 (tabel) / PGRST204 (kolom).
const MIGRATIE_CODES = new Set(['42P01', '42703', 'PGRST204', 'PGRST205']);
export function migratieFout(error) {
  if (MIGRATIE_CODES.has(error?.code)) {
    const e = new Error('Migratie 2026-10-01-setter-maandrapport.sql is nog niet gedraaid');
    e.code = 'MIGRATIE_ONTBREEKT';
    return e;
  }
  return null;
}
function check(error, label) {
  if (!error) return;
  throw migratieFout(error) || new Error(`${label}: ${error.message}`);
}

export async function computeAndUpsertSetterReport({ db, setterId, monthStart, actorId = null, skipEmpty = false }) {
  const month = normalizeMonthStart(monthStart);
  if (!setterId) throw new Error('computeAndUpsertSetterReport: setterId vereist');
  if (!month) throw new Error('computeAndUpsertSetterReport: monthStart moet YYYY-MM(-01) zijn');

  const { data: cfg, error: cfgErr } = await db.from('setter_config')
    .select('user_id, pct, is_active, effective_from, monthly_fee').eq('user_id', setterId).maybeSingle();
  check(cfgErr, 'setter_config');

  const { data: existing, error: exErr } = await db.from('setter_monthly_reports')
    .select('id, status').eq('setter_user_id', setterId).eq('period_month', month).maybeSingle();
  check(exErr, 'setter_monthly_reports');
  if (existing && (existing.status === 'goedgekeurd' || existing.status === 'uitbetaald')) {
    return { skipped: true, reason: 'al definitief', setter_user_id: setterId, report_id: existing.id, status: existing.status };
  }

  const { data: entries, error: entErr } = await db.from('setter_ledger_entries')
    .select('id, deal_id, customer_id, invoice_id, basis, pct, amount, status, note, created_at, betaal_datum, monthly_report_id')
    .eq('setter_user_id', setterId).eq('status', 'vrijgegeven');
  check(entErr, 'setter_ledger_entries');

  const custIds = [...new Set((entries || []).map((e) => e.customer_id).filter(Boolean))];
  const labels = {};
  if (custIds.length) {
    const { data: c } = await db.from('customers').select('id, first_name, last_name, company_name, is_company').in('id', custIds);
    for (const x of (c || [])) labels[x.id] = x.is_company ? (x.company_name || null) : ([x.first_name, x.last_name].filter(Boolean).join(' ') || null);
  }

  const r = bouwRapport({ cfg, monthStart: month, entries: entries || [], reportId: existing?.id || null, labels });
  if (!existing && skipEmpty && r.lines.length === 0) {
    return { skipped: true, reason: 'leeg (geen vergoeding, geen commissie)', setter_user_id: setterId, report_id: null, status: null };
  }

  const nowIso = new Date().toISOString();
  const kolommen = { fee_total: r.fee_total, commission_total: r.commission_total, total: r.total, generated_at: nowIso, updated_at: nowIso };
  let reportId;
  if (existing) {
    // Status-guard in de WHERE: een parallelle goedkeuring wint.
    const { data: upd, error } = await db.from('setter_monthly_reports')
      .update(kolommen).eq('id', existing.id).eq('status', 'concept').select('id');
    check(error, 'rapport update');
    if (!upd || !upd.length) return { skipped: true, reason: 'tijdens herberekening definitief geworden', setter_user_id: setterId, report_id: existing.id };
    reportId = existing.id;
    const { error: delErr } = await db.from('setter_monthly_report_lines').delete().eq('report_id', reportId);
    check(delErr, 'regels verwijderen');
    const { error: unlinkErr } = await db.from('setter_ledger_entries')
      .update({ monthly_report_id: null }).eq('monthly_report_id', reportId).eq('status', 'vrijgegeven');
    check(unlinkErr, 'grootboek ontkoppelen');
  } else {
    const { data: ins, error } = await db.from('setter_monthly_reports')
      .insert({ setter_user_id: setterId, period_month: month, status: 'concept', created_by: actorId, ...kolommen })
      .select('id').single();
    check(error, 'rapport insert');
    reportId = ins.id;
  }

  if (r.entry_ids.length) {
    const { error: linkErr } = await db.from('setter_ledger_entries')
      .update({ monthly_report_id: reportId }).in('id', r.entry_ids).is('monthly_report_id', null);
    check(linkErr, 'grootboek koppelen');
  }
  if (r.lines.length) {
    const { error: lineErr } = await db.from('setter_monthly_report_lines')
      .insert(r.lines.map((l) => ({ report_id: reportId, ...l })));
    check(lineErr, 'regels insert');
  }

  return {
    skipped: false, setter_user_id: setterId, report_id: reportId, status: 'concept', period_month: month,
    fee_total: r.fee_total, commission_total: r.commission_total, total: r.total, lines: r.lines.length,
  };
}

/** Setters waarvoor de cron een rapport maakt: actieve setter_config. */
export async function actieveSetters(db) {
  const { data, error } = await db.from('setter_config').select('user_id, is_active').eq('is_active', true);
  check(error, 'setter_config');
  return [...new Set((data || []).map((r) => r.user_id).filter(Boolean))];
}
