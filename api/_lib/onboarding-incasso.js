// api/_lib/onboarding-incasso.js
//
// NAAR INCASSO-OPVOLGING (Maxim, 6 oktober 2026) — NIET annuleren.
//
// Aanleiding: Ebenezer Adjei. Bedenktijd voorbij (annuleren kan niet meer),
// geen contact, en hij zit al in de wanbetalers-pipeline. Zo'n onboarding
// stond intussen gewoon tussen de actieve: bij zijn mentor in "Klaar voor
// onboarding", in de intake-pot en in de actieve lijst van het CRM.
//
// ── WAT "NAAR INCASSO" DOET ─────────────────────────────────────────────
//   - `onboardings.incasso_op / _door / _reden` worden gezet (migratie
//     docs/sql-migrations/2026-10-06-onboarding-incasso.sql);
//   - de onboarding verdwijnt uit de actieve lijsten: de spiegel naar het LMS
//     haalt hem weg (geen Klaar-kaart meer), de intake-pot zet hem op
//     'vervallen', en het overzicht toont hem in een eigen groep "Incasso";
//   - een regel op de tijdlijn.
// ── WAT HET NIET DOET ────────────────────────────────────────────────────
//   - NIET annuleren: status, facturen, abonnementen, offertes, Bubble- en
//     LMS-toegang blijven zoals ze zijn;
//   - de aanmaningsmotor blijft gewoon lopen (die kijkt naar facturen, niet
//     naar de onboarding);
//   - er gaat NIETS naar de klant.
//
// ── TERUG ACTIEF ────────────────────────────────────────────────────────
// Start de klant toch (bv. na de deurwaarder), dan zet de hoofdmentor hem
// terug met een nieuwe startdatum. Dat loopt via de BESTAANDE
// startdatum-route (zetStartdatumOnboarding: zelfde controle "minstens drie
// dagen vooruit", zelfde melding aan de mentor), daarna wordt
// `incasso_terug_op` gezet. De geschiedenis blijft: incasso_op wordt niet
// gewist.

import { supabaseAdmin } from '../supabase.js';

import { vulIncassoAan, inIncasso, isIncassoKolomOntbreekt } from './onboarding-incasso-stand.js';

export { vulIncassoAan, inIncasso, isIncassoKolomOntbreekt, INCASSO_KOLOMMEN } from './onboarding-incasso-stand.js';

async function tijdlijn(db, onboardingId, note, doorUserId) {
  const { error } = await db.from('onboarding_mentor_updates').insert({
    onboarding_id: onboardingId, kind: 'note', status: null, note, created_by: doorUserId,
  });
  if (error) console.error('[onboarding-incasso] tijdlijn ' + onboardingId + ': ' + error.message);
}

/**
 * Zet een onboarding in incasso-opvolging. Idempotent.
 * @returns {Promise<{status: number, body: object}>}
 */
export async function zetNaarIncasso({ onboardingId, reden, door, doorUserId = null, db = supabaseAdmin }) {
  const r = String(reden || '').trim();
  if (r.length < 5) return { status: 400, body: { error: 'Geef een reden (minstens 5 tekens).', code: 'reden_verplicht' } };
  const { data: ob, error } = await db.from('onboardings')
    .select('id, status, archived_at').eq('id', onboardingId).maybeSingle();
  if (error) return { status: 500, body: { error: 'Onboarding lezen: ' + error.message } };
  if (!ob) return { status: 404, body: { error: 'Onboarding niet gevonden.' } };
  const s = String(ob.status || '').toLowerCase();
  if (ob.archived_at || s === 'gearchiveerd' || s === 'geannuleerd') {
    return { status: 409, body: { error: 'Onboarding is gearchiveerd of geannuleerd.', code: 'niet_actief' } };
  }
  await vulIncassoAan(db, ob);
  if (inIncasso(ob)) return { status: 200, body: { ok: true, al_in_incasso: true } };

  const nu = new Date().toISOString();
  const { error: upErr } = await db.from('onboardings')
    .update({ incasso_op: nu, incasso_door: String(door || 'onbekend').slice(0, 200), incasso_reden: r.slice(0, 1000) })
    .eq('id', onboardingId);
  if (upErr) {
    if (isIncassoKolomOntbreekt(upErr)) {
      return { status: 503, body: { error: 'Naar incasso kan pas na de migratie 2026-10-06-onboarding-incasso.sql.', code: 'migratie_ontbreekt' } };
    }
    return { status: 500, body: { error: 'Naar incasso: ' + upErr.message } };
  }
  await tijdlijn(db, onboardingId,
    'Naar incasso-opvolging gezet door ' + (door || 'onbekend') + '. Reden: ' + r.slice(0, 1000)
    + ' — niet geannuleerd: facturen, toegang en aanmaningen blijven zoals ze zijn.', doorUserId);
  const { spiegelNaActie } = await import('./onboarding-spiegel.js');
  await spiegelNaActie(onboardingId, 'naar-incasso');
  return { status: 200, body: { ok: true, incasso_op: nu } };
}

/**
 * Terug actief, met een nieuwe startdatum (via de bestaande startdatum-route).
 * @returns {Promise<{status: number, body: object}>}
 */
export async function activeerUitIncasso({ onboardingId, startDatum, door, doorUserId = null, db = supabaseAdmin, zetStartdatum = null }) {
  const { data: ob, error } = await db.from('onboardings')
    .select('id, status, archived_at').eq('id', onboardingId).maybeSingle();
  if (error) return { status: 500, body: { error: 'Onboarding lezen: ' + error.message } };
  if (!ob) return { status: 404, body: { error: 'Onboarding niet gevonden.' } };
  await vulIncassoAan(db, ob);
  if (!inIncasso(ob)) return { status: 409, body: { error: 'Deze onboarding staat niet in incasso-opvolging.', code: 'niet_in_incasso' } };

  // EERST de startdatum: weigert het CRM die (te vroeg, ongeldig), dan blijft
  // de onboarding in incasso en is er niets half gebeurd.
  const zet = zetStartdatum || (await import('./onboarding-acties.js')).zetStartdatumOnboarding;
  const sd = await zet({ onboardingId, startDatum, doorUserId });
  if (!(sd.status >= 200 && sd.status < 300)) return sd;

  const nu = new Date().toISOString();
  const { error: upErr } = await db.from('onboardings')
    .update({ incasso_terug_op: nu, incasso_terug_door: String(door || 'onbekend').slice(0, 200) })
    .eq('id', onboardingId);
  if (upErr) return { status: 500, body: { error: 'Terug activeren: ' + upErr.message } };
  await tijdlijn(db, onboardingId,
    'Terug actief uit incasso-opvolging, gezet door ' + (door || 'onbekend') + '. Nieuwe startdatum: ' + startDatum + '.', doorUserId);
  const { spiegelNaActie } = await import('./onboarding-spiegel.js');
  await spiegelNaActie(onboardingId, 'uit-incasso');
  return { status: 200, body: { ok: true, start_date: startDatum, incasso_terug_op: nu } };
}
