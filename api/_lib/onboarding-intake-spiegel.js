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
  if (onboardingAfgesloten(ob)) return 'afgerond';
  return 'open';
}

/** Komt deze onboarding vanzelf in de pot? PURE. */
export function hoortVanzelfInPot(ob, vanaf = intakePotVanaf()) {
  if (!ob?.created_at) return false;
  return new Date(ob.created_at).getTime() >= new Date(vanaf).getTime();
}

let _tabelOntbreektGemeld = false;

/**
 * @param {object} lms  de dfo-lms-client (service_role)
 * @param {string} onboardingId
 * @returns {Promise<{resultaat: string, fout?: string}>}
 */
export async function spiegelIntake(lms, onboardingId) {
  try {
    const { data: ob, error } = await supabaseAdmin
      .from('onboardings')
      .select('id, customer_id, customer_name, status, archived_at, auto_afgerond_op, auto_afgerond_sessie_id, created_at, start_date, dfo_lms_student_id, is_test, traject:onboarding_trajecten(label)')
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) throw new Error('onboarding lezen: ' + error.message);
    if (!ob || ob.is_test) return { resultaat: 'overgeslagen' };

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
    if (!bestaand && !hoortVanzelfInPot(ob)) return { resultaat: 'van-voor-de-uitrol' };
    // Een nieuwe rij voor een onboarding die al dicht is: niet nodig.
    if (!bestaand && crmStandVoorIntake(ob) !== 'open') return { resultaat: 'niet-open' };

    let telefoon = null;
    if (ob.customer_id) {
      const { data: klant } = await supabaseAdmin
        .from('customers').select('phone').eq('id', ob.customer_id).maybeSingle();
      telefoon = klant?.phone ? String(klant.phone).trim() || null : null;
    }

    const rij = {
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

    const { error: upErr } = bestaand
      ? await lms.from(INTAKE_TABEL).update(rij).eq('crm_onboarding_id', ob.id)
      : await lms.from(INTAKE_TABEL).upsert(rij, { onConflict: 'crm_onboarding_id' });
    if (upErr) throw new Error('hlms_intake schrijven: ' + upErr.message);
    return { resultaat: bestaand ? 'bijgewerkt' : 'aangemaakt' };
  } catch (e) {
    console.warn('[intake-spiegel] ' + onboardingId + ': ' + (e?.message || e));
    return { resultaat: 'mislukt', fout: e?.message || String(e) };
  }
}
