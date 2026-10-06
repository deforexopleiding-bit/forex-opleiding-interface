// api/_lib/onboarding-intake-spiegel.js
//
// DE INTAKE-POT IN HET LMS VULLEN (opdracht van 5 oktober 2026).
//
// Elke actieve onboarding zonder afgeronde intake hoort in de intake-pot van
// het LMS (`hlms_intake`, migratie supabase/hlms_intake.sql in dfo-lms). Dit
// bestand schrijft de CRM-kant van die rij: naam, telefoon, traject,
// startdatum, aangemeld, en of de onboarding nog loopt. Het wordt aangeroepen
// vanuit spiegelOnboarding() — dus bij ELKE schrijfactie op een onboarding,
// via dezelfde helper die alle schrijfpunten al gebruiken.
//
// ── ALLEEN VANAF DE UITROL ───────────────────────────────────────────────
// Een onboarding van vóór INTAKE_POT_VANAF komt er NIET vanzelf in: anders
// staan alle bestaande klanten met een rode afteller van weken in de pot. Die
// zet de hoofdmentor er met de hand in. Bestaat de rij al (met de hand
// toegevoegd), dan wordt hij wél bijgewerkt.
//
// ── ALLEEN DE CRM-KOLOMMEN ───────────────────────────────────────────────
// Claim, gesprek, afronding en actieplan zijn van het LMS. De upsert noemt ze
// niet, dus raakt ze niet.
//
// FAALZACHT: een ontbrekende tabel (migratie nog niet gedraaid) of een fout
// hier laat de onboardingspiegel en de hoofdactie ongemoeid.

import { supabaseAdmin } from '../supabase.js';
import { isTabelOntbreekt } from './factuurstand-spiegel.js';
import { onboardingAfgesloten } from './onboarding-einde.js';
import { vulHandmatigAan } from './onboarding-handmatig.js';
import { vulIncassoAan, inIncasso } from './onboarding-incasso-stand.js';
import { telefoonVoorOnboarding } from './onboarding-telefoon.js';

export const INTAKE_TABEL = 'hlms_intake';

/** Vanaf wanneer onboardings vanzelf in de pot komen. Overschrijfbaar via env. */
export function intakePotVanaf(env = process.env) {
  const v = typeof env.INTAKE_POT_VANAF === 'string' ? env.INTAKE_POT_VANAF.trim() : '';
  return v || '2026-10-06T00:00:00+02:00';
}

/**
 * De stand in de pot, uit de CRM-status. PURE.
 *
 * 'afgerond' alleen als een SESSIE de onboarding afsloot — status 'afgerond'
 * zonder `auto_afgerond_op` is wizard voltooid en hoort open in de pot te
 * blijven (zie onboarding-einde.js).
 */
export function crmStandVoorIntake(ob) {
  const s = String(ob?.status || '').trim().toLowerCase();
  if (ob?.archived_at || s === 'gearchiveerd' || s === 'geannuleerd') return 'vervallen';
  // In incasso-opvolging: niet meer in de pot (6 okt 2026).
  if (inIncasso(ob)) return 'vervallen';
  if (onboardingAfgesloten(ob)) return 'afgerond';
  return 'open';
}

/**
 * ── ALLEEN BIJ EEN LATE START (Maxim, 6 oktober 2026) ─────────────────────
 * Een intake heeft vooral zin als er tijd zit tussen het closen en de start.
 * Start de student binnen INTAKE_POT_MIN_DAGEN dagen na het closen, dan gaat
 * hij NIET vanzelf in de pot maar meteen naar "Klaar voor onboarding" bij zijn
 * mentor. Instelbaar: env INTAKE_POT_MIN_DAGEN (standaard 14). 0 = altijd in
 * de pot (het gedrag van vóór 6 oktober).
 *
 * Geen startdatum bekend → wel in de pot: dan is er niets om op te beslissen,
 * en een intake vangt juist de onduidelijke gevallen op.
 *
 * Het "closen" is het aanmaken van de onboarding (`created_at`): dat gebeurt
 * bij het tekenen van de offerte. Een bestaande rij in de pot blijft staan;
 * de regel beslist alleen over nieuwe rijen.
 */
export const INTAKE_POT_MIN_DAGEN = 14;

export function intakePotMinDagen(env = process.env) {
  const v = Number.parseInt(String(env.INTAKE_POT_MIN_DAGEN ?? ''), 10);
  return Number.isFinite(v) && v >= 0 ? v : INTAKE_POT_MIN_DAGEN;
}

/** Dagen tussen het closen en de start (kalenderdagen, Brussel), of null. PURE. */
export function dagenTotStart(ob) {
  const start = String(ob?.start_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !ob?.created_at) return null;
  const closen = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(new Date(ob.created_at));
  return Math.round((Date.parse(start + 'T00:00:00Z') - Date.parse(closen + 'T00:00:00Z')) / 86_400_000);
}

/** Start deze onboarding zo snel dat een intake overbodig is? PURE. */
export function snelleStart(ob, minDagen = intakePotMinDagen()) {
  if (!minDagen) return false;
  const d = dagenTotStart(ob);
  return d !== null && d <= minDagen;
}

/** Komt deze onboarding vanzelf in de pot? PURE. */
export function hoortVanzelfInPot(ob, vanaf = intakePotVanaf(), minDagen = intakePotMinDagen()) {
  if (!ob?.created_at) return false;
  if (new Date(ob.created_at).getTime() < new Date(vanaf).getTime()) return false;
  return !snelleStart(ob, minDagen);
}

let _tabelOntbreektGemeld = false;
let _kolommenOntbrekenGemeld = false;

/** De kolommen die hlms_telefoon_en_intake_notitie.sql toevoegt. */
export const NIEUWE_KOLOMMEN = Object.freeze(['mentor_id', 'bedenktijd_status', 'bedenktijd_vervalt_op', 'bedenktijd_reden']);

/** Is dit "een van de nieuwe kolommen bestaat nog niet"? PURE. */
export function isNieuweKolomOntbreekt(err) {
  const code = String(err?.code || '');
  if (code !== 'PGRST204' && code !== '42703') return false;
  const msg = String(err?.message || '');
  return NIEUWE_KOLOMMEN.some((k) => msg.includes(k));
}

/**
 * @param {object} lms  de dfo-lms-client (service_role)
 * @param {string} onboardingId
 * @returns {Promise<{resultaat: string, fout?: string}>}
 */
export async function spiegelIntake(lms, onboardingId) {
  try {
    const { data: ob, error } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, customer_name, status, archived_at, auto_afgerond_op, auto_afgerond_sessie_id, answers, mentor_user_id, created_at, start_date, dfo_lms_student_id, is_test, traject:onboarding_trajecten(label)')
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) throw new Error('onboarding lezen: ' + error.message);
    if (!ob || ob.is_test) return { resultaat: 'overgeslagen' };
    await vulHandmatigAan(supabaseAdmin, ob);
    await vulIncassoAan(supabaseAdmin, ob);

    const { data: bestaand, error: bErr } = await lms
      .from(INTAKE_TABEL).select('crm_onboarding_id').eq('crm_onboarding_id', ob.id).maybeSingle();
    if (bErr) {
      if (isTabelOntbreekt(bErr)) {
        if (!_tabelOntbreektGemeld) {
          console.warn('[intake-spiegel] hlms_intake bestaat nog niet (migratie hlms_intake.sql) — overgeslagen');
          _tabelOntbreektGemeld = true;
        }
        return { resultaat: 'tabel-ontbreekt' };
      }
      throw new Error('hlms_intake lezen: ' + bErr.message);
    }
    if (!bestaand && !hoortVanzelfInPot(ob)) {
      return { resultaat: snelleStart(ob) ? 'snelle-start' : 'van-voor-de-uitrol' };
    }
    // Een nieuwe rij voor een onboarding die al dicht is: niet nodig.
    if (!bestaand && crmStandVoorIntake(ob) !== 'open') return { resultaat: 'niet-open' };

    // Het nummer uit de gedeelde afleiding (klant → WhatsApp → lead →
    // afspraak → wizard), niet meer alleen customers.phone (6 okt 2026).
    const { telefoon } = await telefoonVoorOnboarding(supabaseAdmin, ob);

    // De vaste mentor en de bedenktijd (6 okt 2026): de pot laat alleen de
    // toegewezen mentor claimen, en toont de bedenktijd met de regel "één
    // bericht en één belletje is genoeg". Dynamisch geïmporteerd: de spiegel
    // importeert dit bestand ook.
    const { intakeExtras } = await import('./onboarding-spiegel.js');
    const extras = await intakeExtras(ob);

    const rij = {
      ...extras,
      crm_onboarding_id: ob.id,
      student_id: ob.dfo_lms_student_id || null,
      naam: ob.customer_name || null,
      telefoon,
      traject_label: ob.traject?.label || null,
      start_datum: ob.start_date || null,
      aangemeld_op: ob.created_at,
      crm_stand: crmStandVoorIntake(ob),
      crm_bijgewerkt_op: new Date().toISOString(),
    };
    // Een met de hand toegevoegde rij houdt zijn eigen aangemeld-moment: dat
    // is het moment van toevoegen, zodat er geen rode afteller met
    // terugwerkende kracht ontstaat.
    if (bestaand) delete rij.aangemeld_op;
    // Niets gevonden: een bestaand nummer (bv. met de hand ingevuld bij "In de
    // pot zetten") blijft staan. Nooit een nummer wegschrijven door een leegte.
    if (!rij.telefoon) delete rij.telefoon;

    const schrijf = (r) => (bestaand
      ? lms.from(INTAKE_TABEL).update(r).eq('crm_onboarding_id', ob.id)
      : lms.from(INTAKE_TABEL).upsert(r, { onConflict: 'crm_onboarding_id' }));
    let { error: upErr } = await schrijf(rij);
    // Vóór hlms_telefoon_en_intake_notitie.sql bestaan mentor_id en de
    // bedenktijdkolommen niet: dan zonder, zodat de pot blijft lopen.
    if (upErr && isNieuweKolomOntbreekt(upErr)) {
      if (!_kolommenOntbrekenGemeld) {
        console.warn('[intake-spiegel] mentor_id/bedenktijd ontbreken op hlms_intake — draai hlms_telefoon_en_intake_notitie.sql');
        _kolommenOntbrekenGemeld = true;
      }
      const zonder = { ...rij };
      for (const k of NIEUWE_KOLOMMEN) delete zonder[k];
      ({ error: upErr } = await schrijf(zonder));
    }
    if (upErr) throw new Error('hlms_intake schrijven: ' + upErr.message);
    return { resultaat: bestaand ? 'bijgewerkt' : 'aangemaakt' };
  } catch (e) {
    console.warn('[intake-spiegel] ' + onboardingId + ': ' + (e?.message || e));
    return { resultaat: 'mislukt', fout: e?.message || String(e) };
  }
}
