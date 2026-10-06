// api/_lib/intake-gesprek-stand.js
//
// DE STAND VAN HET INTAKEGESPREK, uit de intake-pot van het LMS (`hlms_intake`,
// opdracht van 5 oktober 2026) — voor het CRM-onboardingoverzicht en het
// detailscherm. Alleen lezen: claimen, registreren en afronden gebeuren in het
// LMS.
//
// LET OP de naam: het CRM gebruikt "intake" al voor de START-STATUS
// (`mentor_intake_status`, `intake_status`). Dit is iets anders — het korte
// intakegesprek binnen 48 uur na het closen. Op het scherm heet het daarom
// "Intakegesprek".
//
// Drie toestanden, en ze zijn alle drie verschillend:
//   - status 'gelezen'      → per id een stand, of geen sleutel = niet in de pot;
//   - status 'tabel-ontbreekt' → hlms_intake.sql is nog niet gedraaid;
//   - status 'onbereikbaar' / 'niet-geconfigureerd' → we weten het niet.
// Het scherm toont bij de laatste twee NIETS als "geen intake".

import { getDfoLmsClient } from './dfo-lms-db.js';
import { isTabelOntbreektFout } from './coaching-earnings.js';

const IN_CHUNK = 100;
const UUR = 3_600_000;

/** De stand van één rij, PURE. */
export function intakeGesprekStand(rij, personeelNaam = new Map(), nu = Date.now()) {
  if (!rij) return null;
  const naam = (id) => (id ? personeelNaam.get(String(id)) || null : null);
  const aangemeld = Date.parse(rij.aangemeld_op || '');
  const teLaat = !rij.afgerond_op && rij.crm_stand === 'open'
    && Number.isFinite(aangemeld) && nu - aangemeld > 48 * UUR;
  let stand = 'vrij';
  // Sinds 6 okt 2026 twee stappen: "Intake klaar" van de mentor (afgerond_op)
  // en de goedkeuring door de hoofdmentor (goedgekeurd_op). Ontbreekt de
  // kolom (migratie nog niet gedraaid: `goedgekeurd_op` undefined), dan geldt
  // afgerond als afgerond, zoals het tot dan werkte.
  const goedkeuringBekend = rij.goedgekeurd_op !== undefined;
  if (rij.afgerond_op && goedkeuringBekend && !rij.goedgekeurd_op) stand = 'ter_goedkeuring';
  else if (rij.afgerond_op) stand = 'afgerond';
  else if (rij.gesprek_op) stand = 'ingepland';
  else if (rij.geclaimd_door) stand = 'geclaimd';
  return {
    stand,
    te_laat: teLaat,
    aangemeld_op: rij.aangemeld_op || null,
    geclaimd_naam: naam(rij.geclaimd_door),
    gesprek_op: rij.gesprek_op || null,
    afgerond_op: rij.afgerond_op || null,
    afgerond_naam: naam(rij.afgerond_door),
    goedgekeurd_op: rij.goedgekeurd_op || null,
    uitkomst: rij.uitkomst || null,
    actieplan: rij.actieplan || null,
  };
}

/**
 * @param {string[]} onboardingIds
 * @returns {Promise<{ status: string, fout?: string, gesprekken: Record<string, object> }>}
 */
export async function intakeGesprekkenVoor(onboardingIds, deps = {}) {
  const lms = deps.lmsClient || getDfoLmsClient();
  if (!lms) return { status: 'niet-geconfigureerd', gesprekken: {} };
  const ids = Array.from(new Set((onboardingIds || []).filter(Boolean).map(String)));
  if (!ids.length) return { status: 'gelezen', gesprekken: {} };
  try {
    const rijen = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const deel = ids.slice(i, i + IN_CHUNK);
      const basis = 'crm_onboarding_id, aangemeld_op, crm_stand, geclaimd_door, gesprek_op, afgerond_door, afgerond_op, uitkomst, actieplan';
      let { data, error } = await lms.from('hlms_intake').select(basis + ', goedgekeurd_op').in('crm_onboarding_id', deel);
      // Vóór hlms_telefoon_en_intake_notitie.sql bestaat goedgekeurd_op niet.
      if (error && /goedgekeurd_op/.test(String(error.message || ''))) {
        ({ data, error } = await lms.from('hlms_intake').select(basis).in('crm_onboarding_id', deel));
      }
      if (error) {
        if (isTabelOntbreektFout(error)) return { status: 'tabel-ontbreekt', gesprekken: {} };
        return { status: 'onbereikbaar', fout: error.message || String(error.code || 'onbekend'), gesprekken: {} };
      }
      rijen.push(...(Array.isArray(data) ? data : []));
    }
    // De namen: een tweede, kleine vraag. Mislukt die, dan blijven de namen
    // leeg ("een mentor") - de stand zelf klopt nog.
    const personeelIds = Array.from(new Set(rijen.flatMap((r) => [r.geclaimd_door, r.afgerond_door]).filter(Boolean)));
    const namen = new Map();
    if (personeelIds.length) {
      const { data, error } = await lms.from('hlms_personeel').select('id, naam').in('id', personeelIds);
      if (!error) for (const p of data || []) namen.set(String(p.id), p.naam || null);
      else console.warn('[intake-gesprek-stand] namen niet gelezen:', error.message);
    }
    const nu = deps.nu ?? Date.now();
    const gesprekken = {};
    for (const r of rijen) gesprekken[String(r.crm_onboarding_id)] = intakeGesprekStand(r, namen, nu);
    return { status: 'gelezen', gesprekken };
  } catch (e) {
    console.error('[intake-gesprek-stand]', e?.message || e);
    return { status: 'onbereikbaar', fout: e?.message || String(e), gesprekken: {} };
  }
}
