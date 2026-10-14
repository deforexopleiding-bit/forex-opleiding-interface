// api/lms-factuurstand-nu.js
// Machine-route voor het LMS (dfo-lms): DE FACTUURSTAND VAN ÉÉN STUDENT, NU.
// Server-naar-server, GEEN CORS — het geheim mag nooit in een browser.
//
//   POST { student_id } → { ok, code:'ok', message, data: {
//          resultaat, bron_status, vervallen_aantal, open_aantal, bijgewerkt_op,
//          tl_ververst, tl_fouten } }
//
// Auth: header `x-dfo-secret` = DFO_LMS_PUSH_SECRET of DFO_LMS_AGENDA_SECRET
// (dezelfde regel als api/lms-onboarding-sessie.js). Geen van beide → 503.
//
// ── WAAROM (Maxim, 14 oktober 2026 — P2) ─────────────────────────────────
// Een student betaalde; het LMS bleef hem blokkeren tot de nachtelijke
// spiegel. De knop "Nu ophalen" in het LMS (hoofdmentor, admin,
// administratie) vraagt hier om de stand van die ene student meteen opnieuw
// te berekenen, zonder op de volgende ronde te wachten.
//
// ── WAT ER GEBEURT ────────────────────────────────────────────────────────
//   1. De klant bij de student zoeken — dezelfde koppeling als de spiegel
//      (zoekKlantKandidaten + kiesKlant).
//   2. De OPEN facturen van die klant opnieuw uit Teamleader lezen
//      (upsertInvoiceFromTl, dezelfde helper als de uurlijkse finance-sync).
//      Zo komt een betaling die in TL al staat meteen binnen. Hooguit
//      TL_MAX facturen en een tijdsbudget: een TL dat hapert, mag de knop niet
//      laten hangen. Een fout per factuur telt mee en breekt niets af.
//   3. De spiegel voor deze ene student opnieuw schrijven
//      (spiegelFactuurstandVoorStudent) — de enige schrijver van
//      hlms_crm_factuurstand blijft api/_lib/factuurstand-spiegel.js.
//
// Er gaat NIETS naar de klant. Joost en de aanmaanmotor merken het alleen
// doordat de facturen kloppen.

import { supabaseAdmin } from './supabase.js';
import { machineToegang } from './lms-onboarding-sessie.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';
import { OPEN_INVOICE_STATUSES } from './_lib/dunning-pipeline.js';
import {
  maakContext, spiegelFactuurstandVoorStudent, zoekKlantKandidaten, kiesKlant, STUDENT_KOLOMMEN,
} from './_lib/factuurstand-spiegel.js';

export const TL_MAX = 25;
export const TL_BUDGET_MS = 20_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function antwoord(res, status, ok, code, message, data = null) {
  return res.status(status).json({ ok, code, message, data });
}

/**
 * De open facturen van één klant opnieuw uit Teamleader. Gooit nooit.
 * `upsert` is injecteerbaar voor de toets.
 */
export async function verversTlFacturen(customerId, { db = supabaseAdmin, upsert = upsertInvoiceFromTl, nu = () => Date.now() } = {}) {
  const uit = { ververst: 0, fouten: 0, gelezen: true };
  if (!customerId) return uit;
  const { data, error } = await db.from('invoices')
    .select('id, tl_invoice_id')
    .eq('customer_id', customerId)
    .in('status', OPEN_INVOICE_STATUSES)
    .not('tl_invoice_id', 'is', null)
    .limit(TL_MAX);
  if (error) {
    console.error('[lms-factuurstand-nu] open facturen lezen:', error.message);
    return { ...uit, gelezen: false };
  }
  const start = nu();
  for (const f of data || []) {
    if (nu() - start > TL_BUDGET_MS) break;
    try {
      await upsert(f.tl_invoice_id);
      uit.ververst += 1;
    } catch (e) {
      uit.fouten += 1;
      if (uit.fouten <= 3) console.error('[lms-factuurstand-nu] TL', f.tl_invoice_id, e?.message || e);
    }
  }
  return uit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const toegang = machineToegang(req.headers['x-dfo-secret']);
  if (toegang === 'niet_geconfigureerd') {
    return antwoord(res, 503, false, 'niet_geconfigureerd', 'De factuurbrug is niet geconfigureerd.');
  }
  if (toegang !== 'ok') {
    return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang tot de factuurbrug.');
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen POST is toegestaan.');
  }
  const studentId = String(req.body?.student_id || '').trim();
  if (!UUID.test(studentId)) {
    return antwoord(res, 400, false, 'ongeldige_student', 'Geef een geldig student_id mee.');
  }

  try {
    const ctx = await maakContext();
    if (!ctx.lms) {
      return antwoord(res, 503, false, 'lms_niet_geconfigureerd', 'DFO_LMS_SUPABASE_URL/KEY ontbreekt.');
    }
    const { data: student, error } = await ctx.lms.from('hlms_student').select(STUDENT_KOLOMMEN).eq('id', studentId).maybeSingle();
    if (error) return antwoord(res, 502, false, 'lms_onbereikbaar', 'De student kon niet gelezen worden in het LMS.');
    if (!student) return antwoord(res, 404, false, 'student_onbekend', 'Deze student bestaat niet in het LMS.');

    //  De klant zoeken, en dan eerst zijn open facturen uit Teamleader.
    let tl = { ververst: 0, fouten: 0, gelezen: false };
    try {
      const keuze = kiesKlant(await zoekKlantKandidaten(student, ctx));
      if (keuze.customer_id) tl = await verversTlFacturen(keuze.customer_id);
    } catch (e) {
      console.error('[lms-factuurstand-nu] klant zoeken:', e?.message || e);
    }

    const spiegel = await spiegelFactuurstandVoorStudent(student, ctx);
    const rij = spiegel.rij || {};
    return antwoord(res, 200, true, 'ok', 'De factuurstand is opnieuw berekend.', {
      resultaat: spiegel.resultaat,
      bron_status: spiegel.bron_status,
      vervallen_aantal: rij.vervallen_aantal ?? null,
      open_aantal: rij.open_aantal ?? null,
      bijgewerkt_op: rij.bijgewerkt_op ?? null,
      tl_ververst: tl.ververst,
      tl_fouten: tl.fouten,
    });
  } catch (e) {
    console.error('[lms-factuurstand-nu] onverwacht:', e?.message || e);
    return antwoord(res, 500, false, 'onverwacht', 'Er ging iets mis bij het herberekenen.');
  }
}
