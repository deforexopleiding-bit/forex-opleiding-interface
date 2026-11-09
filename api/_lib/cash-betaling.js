// api/_lib/cash-betaling.js
//
// CASHBETALING REGISTREREN (beslissing Maxim, 6 nov 2026).
//
// Een contante betaling op een open factuur. De factuur blijft staan en wordt
// NIET gecrediteerd. Alles loopt via de GEWONE betaalflow
// (registerPaymentInternal): Teamleader invoices.registerPayment (TL-first) →
// payments-rij → invoices-stand → LMS-factuurstand → FACTUURMOTOR
// (releaseProportionalForPaidAmount) → audit. De commissie volgt dus zonder
// uitzondering wat er betaald is; er is geen apart commissiepad voor cash.
//
// Extra t.o.v. een gewone betaling:
//   * betaalmethode 'cash' lokaal (payments.payment_method) én in Teamleader
//     (payment_method_id op registerPayment, zie zoekCashBetaalmethode);
//   * wie het geld ontving + verplichte notitie + ontvangstbewijs
//     (tabel cash_ontvangsten, migratie 2026-11-06-cash-ontvangsten.sql);
//   * een tweede auditregel finance_invoice.register_cash.
//
// Er wordt NIETS verstuurd: geen mail, geen WhatsApp. Het ontvangstbewijs is
// een PDF die je zelf downloadt (api/finance-cash-ontvangstbewijs.js).
//
// Crediteren en commissie zijn los van elkaar: een (volledig) gecrediteerde
// factuur telt nooit als betaald (factuur-betaald.js) en krijgt hier ook geen
// cashbetaling.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';
import { registerPaymentInternal, RegisterPaymentError } from './register-payment-internal.js';
import { isVolledigGecrediteerd, openBedrag } from './factuur-betaald.js';
import { CASH } from './betaalmethode.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
export const NOTITIE_MIN = 5;
export const NOTITIE_MAX = 1000;
const NAAM_MAX = 120;
const DUBBEL_MINUTEN = 10;

export class CashBetalingError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Vandaag in Brussel (YYYY-MM-DD). */
export function vandaagBrussel(nu = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
}

/**
 * Puur: controleer de invoer. Geeft { ok, waarde } of { ok:false, fouten }.
 */
export function valideerCashInvoer(body, { vandaag = vandaagBrussel() } = {}) {
  const fouten = {};
  const invoiceId = String(body?.invoice_id || '').trim();
  if (!UUID_RE.test(invoiceId)) fouten.invoice_id = 'Factuur ontbreekt';
  const bedrag = Number(body?.amount);
  if (!Number.isFinite(bedrag) || bedrag <= 0) fouten.amount = 'Bedrag moet groter zijn dan 0';
  else if (Math.abs(r2(bedrag) - bedrag) > 1e-9) fouten.amount = 'Maximaal twee cijfers na de komma';
  const datum = String(body?.paid_at || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || Number.isNaN(new Date(datum + 'T00:00:00Z').getTime())) fouten.paid_at = 'Datum ontbreekt (JJJJ-MM-DD)';
  else if (datum > vandaag) fouten.paid_at = 'De datum van ontvangst ligt in de toekomst';
  const door = String(body?.ontvangen_door || '').trim();
  if (!door) fouten.ontvangen_door = 'Vul in wie het geld ontving';
  else if (door.length > NAAM_MAX) fouten.ontvangen_door = `Maximaal ${NAAM_MAX} tekens`;
  const notitie = String(body?.notitie || '').trim();
  if (notitie.length < NOTITIE_MIN) fouten.notitie = `Een notitie is verplicht (minstens ${NOTITIE_MIN} tekens)`;
  else if (notitie.length > NOTITIE_MAX) fouten.notitie = `Maximaal ${NOTITIE_MAX} tekens`;
  const doorUser = body?.ontvangen_door_user_id && UUID_RE.test(String(body.ontvangen_door_user_id)) ? String(body.ontvangen_door_user_id) : null;
  if (Object.keys(fouten).length) return { ok: false, fouten };
  return { ok: true, waarde: { invoiceId, bedrag: r2(bedrag), datum, door, doorUser, notitie, bevestigDubbel: body?.bevestig_dubbel === true } };
}

/**
 * Puur: mag deze factuur een cashbetaling krijgen? Geeft null of een fout.
 * Deelbetaling mag; meer dan het openstaande bedrag niet.
 */
export function controleerFactuur(inv, bedrag) {
  if (!inv) return new CashBetalingError(404, 'FACTUUR_ONBEKEND', 'Factuur niet gevonden');
  const st = String(inv.status || '').toLowerCase();
  if (st === 'concept' || st === 'draft') return new CashBetalingError(409, 'FACTUUR_CONCEPT', 'Een concept-factuur kan geen betaling krijgen');
  if (st === 'credited' || isVolledigGecrediteerd(inv)) return new CashBetalingError(409, 'FACTUUR_GECREDITEERD', 'Deze factuur is gecrediteerd: daar hoort geen betaling op');
  if (!inv.tl_invoice_id) return new CashBetalingError(409, 'GEEN_TEAMLEADER', 'Factuur heeft geen Teamleader-id: de betaling kan niet gesynchroniseerd worden');
  const open = openBedrag(inv);
  if (open <= 0.005) return new CashBetalingError(409, 'NIET_OPEN', 'Deze factuur staat niet meer open');
  if (bedrag > open + 0.005) return new CashBetalingError(400, 'TE_VEEL', `Het bedrag is hoger dan wat openstaat (€ ${open.toFixed(2)})`, { open });
  return null;
}

const CASH_NAAM = /\b(cash|contant(en)?|kas|baar)\b/i;

/** Puur: kies de cash-methode uit de lijst van Teamleader. */
export function kiesCashMethode(lijst = []) {
  const actief = (lijst || []).filter((m) => m && m.id && String(m.status || 'active').toLowerCase() !== 'archived');
  const hits = actief.filter((m) => CASH_NAAM.test(String(m.name || '')));
  if (!hits.length) return null;
  return { id: String(hits[0].id), naam: String(hits[0].name || ''), meerdere: hits.length > 1 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tlPost(path, body, poging = 0) {
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && poging < 3) { await sleep(2000 * 2 ** poging); return tlPost(path, body, poging + 1); }
  return r;
}

/**
 * Welke Teamleader-betaalmethode is "cash"?
 *   1. app_settings 'teamleader_cash_payment_method_id' ({ id, naam? }) — vast ingesteld;
 *   2. anders Teamleader paymentMethods.list, naam cash/contant/kas.
 * Geeft { id, naam, bron } of { id:null, reden }. Gooit nooit.
 */
export async function zoekCashBetaalmethode(db = supabaseAdmin) {
  try {
    const { data } = await db.from('app_settings').select('value').eq('key', 'teamleader_cash_payment_method_id').maybeSingle();
    const v = data?.value;
    const id = typeof v === 'string' ? v : v?.id;
    if (id) return { id: String(id), naam: (v && v.naam) || 'Cash (vast ingesteld)', bron: 'instelling' };
  } catch (e) {
    console.warn('[cash-betaling] app_settings:', e?.message || e);
  }
  try {
    const r = await tlPost('/paymentMethods.list', { page: { size: 100, number: 1 } });
    const tekst = await r.text().catch(() => '');
    if (!r.ok) return { id: null, reden: `Teamleader paymentMethods.list gaf HTTP ${r.status}` };
    let lijst = [];
    try { lijst = JSON.parse(tekst)?.data || []; } catch { lijst = []; }
    const m = kiesCashMethode(lijst);
    if (!m) return { id: null, reden: `Geen betaalmethode "cash" of "contant" in Teamleader (gevonden: ${lijst.map((x) => x.name).filter(Boolean).join(', ') || 'geen'})` };
    return { id: m.id, naam: m.naam, bron: 'teamleader', meerdere: m.meerdere };
  } catch (e) {
    return { id: null, reden: 'Kon Teamleader niet bereiken voor de betaalmethodes: ' + (e?.message || e) };
  }
}

/** Bestaat de tabel cash_ontvangsten? (migratie gedraaid) */
export async function cashTabelActief(db = supabaseAdmin) {
  const { error } = await db.from('cash_ontvangsten').select('id', { count: 'exact', head: true }).limit(1);
  if (!error) return true;
  const msg = String(error.message || '');
  if (['42P01', 'PGRST205'].includes(String(error.code || '')) || /does not exist|could not find the table|schema cache/i.test(msg)) return false;
  throw new Error('cash_ontvangsten: ' + msg);
}

/**
 * Registreer een cashbetaling. Volgorde: invoer → tabel → factuur → dubbel →
 * Teamleader-methode → gewone betaalflow (TL-first) → ontvangstbewijs → audit.
 *
 * @returns {{ invoice_id, status, amount_paid, payment_db_id, bewijs: {id, bewijsnummer}|null,
 *             teamleader: { betaling:'geregistreerd', betaalmethode:'overgenomen'|'niet_overgenomen', methode_naam, reden } ,
 *             waarschuwingen: string[] }}
 */
export async function registreerCashBetaling(body, { userId = null, ipAddress = null, db = supabaseAdmin, vandaag } = {}) {
  const v = valideerCashInvoer(body, { vandaag: vandaag || vandaagBrussel() });
  if (!v.ok) throw new CashBetalingError(400, 'ONGELDIG', Object.values(v.fouten)[0], { fouten: v.fouten });
  const { invoiceId, bedrag, datum, door, doorUser, notitie, bevestigDubbel } = v.waarde;

  if (!(await cashTabelActief(db))) {
    throw new CashBetalingError(503, 'CASH_NIET_ACTIEF', 'Cashbetalingen zijn nog niet actief: migratie 2026-11-06-cash-ontvangsten.sql is niet gedraaid. Er is niets geregistreerd.');
  }

  const { data: inv, error: invErr } = await db.from('invoices')
    .select('id, customer_id, invoice_number, tl_invoice_id, amount_total, amount_paid, credited_amount, status')
    .eq('id', invoiceId).maybeSingle();
  if (invErr) throw new CashBetalingError(500, 'DB', 'Factuur lezen mislukt: ' + invErr.message);
  const fout = controleerFactuur(inv, bedrag);
  if (fout) throw fout;

  // Dubbelklik / twee keer hetzelfde bonnetje: zelfde factuur, bedrag en datum
  // in de laatste minuten → eerst bevestigen.
  if (!bevestigDubbel) {
    const sinds = new Date(Date.now() - DUBBEL_MINUTEN * 60000).toISOString();
    const { data: recent } = await db.from('cash_ontvangsten').select('id, bewijsnummer')
      .eq('invoice_id', invoiceId).eq('bedrag', bedrag).eq('ontvangen_op', datum).gte('created_at', sinds).limit(1);
    if (recent && recent.length) {
      throw new CashBetalingError(409, 'MOGELIJK_DUBBEL', `Er is net al een cashbetaling van € ${bedrag.toFixed(2)} op deze datum geregistreerd (${recent[0].bewijsnummer}). Is dit een tweede betaling?`, { bewijsnummer: recent[0].bewijsnummer });
    }
  }

  const methode = await zoekCashBetaalmethode(db);
  const waarschuwingen = [];
  if (!methode.id) waarschuwingen.push(`Betaalmethode niet naar Teamleader: ${methode.reden}. De betaling zelf staat wel in Teamleader; de methode "contant" staat enkel in het CRM.`);
  if (methode.meerdere) waarschuwingen.push(`Meerdere cash-methodes in Teamleader; "${methode.naam}" gebruikt.`);

  let res;
  try {
    res = await registerPaymentInternal({
      invoiceId, amount: bedrag, paidAt: datum,
      paymentMethodId: CASH,
      tlPaymentMethodId: methode.id || null,
      source: 'manual',
      userId, ipAddress,
    });
  } catch (e) {
    if (e instanceof RegisterPaymentError) {
      const status = e.kind === 'validation' ? 400 : e.kind === 'tl_client' ? 422 : e.kind === 'db' ? 500 : 502;
      const tlTekst = String(e.details?.tl_response || e.details?.tl_response_date_only || '');
      const msg = methode.id && /payment_method/i.test(tlTekst)
        ? `Teamleader weigerde de betaalmethode "${methode.naam}" (HTTP ${e.details?.tl_status}). Er is niets geregistreerd.`
        : e.message;
      throw new CashBetalingError(status, 'BETAALFLOW_' + String(e.kind).toUpperCase(), msg, { tl_status: e.details?.tl_status, tl_response: tlTekst || undefined });
    }
    throw e;
  }

  // Ontvangstbewijs. Teamleader + payments zijn hier al gemuteerd: een fout
  // stopt niets meer, maar wordt luid gemeld (en staat in de audit).
  let bewijs = null;
  const { data: rij, error: bErr } = await db.from('cash_ontvangsten').insert({
    payment_id: res.payment_db_id, invoice_id: inv.id, customer_id: inv.customer_id,
    bedrag, ontvangen_op: datum, ontvangen_door: door, ontvangen_door_user_id: doorUser,
    notitie, geregistreerd_door: userId,
    tl_betaalmethode_id: methode.id || null, tl_betaalmethode_naam: methode.id ? methode.naam : null,
  }).select('id, bewijsnummer').single();
  if (bErr) {
    console.error('[cash-betaling] ontvangstbewijs insert:', bErr.message);
    waarschuwingen.push('De betaling is geregistreerd, maar het ontvangstbewijs kon niet bewaard worden: ' + bErr.message);
  } else {
    bewijs = rij;
  }

  try {
    const { error: aErr } = await db.from('audit_log').insert({
      user_id: userId, action: 'finance_invoice.register_cash', entity_type: 'invoice', entity_id: inv.id,
      after_json: {
        amount: bedrag, paid_at: datum, payment_method: CASH, ontvangen_door: door, ontvangen_door_user_id: doorUser,
        notitie, payment_db_id: res.payment_db_id, bewijs_id: bewijs?.id || null, bewijsnummer: bewijs?.bewijsnummer || null,
        tl_betaalmethode_id: methode.id || null, tl_betaalmethode_naam: methode.id ? methode.naam : null,
        tl_betaalmethode_reden: methode.id ? null : methode.reden, new_status: res.status, new_amount_paid: res.amount_paid,
      },
      reason_text: `Cashbetaling €${bedrag.toFixed(2)} op factuur ${inv.invoice_number || inv.id}, ontvangen door ${door}${bewijs ? ` (${bewijs.bewijsnummer})` : ''}`,
      ip_address: ipAddress,
    });
    if (aErr) console.error('[cash-betaling] audit:', aErr.message);
  } catch (e) {
    console.error('[cash-betaling] audit:', e?.message || e);
  }

  return {
    invoice_id: inv.id, status: res.status, amount_paid: res.amount_paid, payment_db_id: res.payment_db_id,
    bewijs,
    teamleader: {
      betaling: 'geregistreerd',
      betaalmethode: methode.id ? 'meegestuurd' : 'niet_overgenomen',
      methode_naam: methode.id ? methode.naam : null,
      reden: methode.id ? null : methode.reden,
    },
    waarschuwingen,
  };
}
