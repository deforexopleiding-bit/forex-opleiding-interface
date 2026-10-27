// api/_lib/onboarding-startcode.js
//
// DE STARTCODE van een onboarding — de sleutel waarmee de klant zijn
// onboarding opent op www.deforexopleiding.nl/onboarding.
//
//   · 8 tekens uit ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (geen 0/O/1/I: die lees je
//     verkeerd van een scherm of uit een mail).
//   · Opgeslagen ZONDER streepje (onboardings.startcode), getoond als XXXX-XXXX.
//   · 32^8 ≈ 1,1 biljoen mogelijkheden; samen met de rate limit op de portal
//     (40 pogingen per uur per IP) is raden kansloos.
//
// genereer / normaliseer / formatteer zijn PUUR. kenStartcodeToe praat met de
// databank en is fail-soft: zonder kolom (migratie nog niet gedraaid) geeft hij
// null terug en gaat de aanmelding gewoon door.
//
// Het alfabet staat ook in docs/sql-migrations/2026-10-27-onboarding-portal.sql
// (backfill) en in de website (dfo-website app/onboarding) — wijzig ze samen.

import crypto from 'node:crypto';

export const STARTCODE_ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const STARTCODE_LENGTE = 8;
const GELDIG_RE = new RegExp(`^[${STARTCODE_ALFABET}]{${STARTCODE_LENGTE}}$`);
const MAX_POGINGEN = 5;

/** Een nieuwe willekeurige code (zonder streepje). crypto.randomInt is uniform. */
export function genereer() {
  let s = '';
  for (let i = 0; i < STARTCODE_LENGTE; i++) {
    s += STARTCODE_ALFABET[crypto.randomInt(STARTCODE_ALFABET.length)];
  }
  return s;
}

/**
 * Invoer van een klant → de opgeslagen vorm, of null als het geen geldige code
 * is. Hoofdletters, spaties en streepjes (ook en/em-dash) eruit. Een teken
 * buiten het alfabet (bv. een O of 0) maakt de code ongeldig — we "verbeteren"
 * niets, anders zou een tikfout stil een ándere onboarding kunnen openen.
 */
export function normaliseer(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s\-‐-―]/g, '');
  return GELDIG_RE.test(s) ? s : null;
}

/** De opgeslagen code → XXXX-XXXX voor mail en scherm. Ongeldig → ''. */
export function formatteer(code) {
  const s = normaliseer(code);
  return s ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
}

function isKolomOntbreekt(error) {
  return !!error && (String(error.code) === '42703' || /startcode/i.test(error.message || '') && /column|kolom|schema cache/i.test(error.message || ''));
}

/**
 * Zorg dat deze onboarding een startcode heeft en geef hem terug.
 * Heeft hij er al één, dan blijft die (een code wijzigt nooit vanzelf: hij
 * staat in mails die al verstuurd zijn).
 *
 * @param {object} db         supabase-client (service role)
 * @param {string} onboardingId
 * @returns {Promise<string|null>} de code, of null (kolom ontbreekt / fout)
 */
export async function kenStartcodeToe(db, onboardingId, { maak = genereer } = {}) {
  if (!db || !onboardingId) return null;
  try {
    const { data: ob, error: leesFout } = await db
      .from('onboardings').select('id, startcode').eq('id', onboardingId).maybeSingle();
    if (leesFout) {
      if (isKolomOntbreekt(leesFout)) {
        console.warn('[onboarding-startcode] kolom startcode ontbreekt nog — draai 2026-10-27-onboarding-portal.sql');
      } else {
        console.error('[onboarding-startcode] lezen:', leesFout.message);
      }
      return null;
    }
    if (!ob) return null;
    if (ob.startcode) return ob.startcode;

    for (let poging = 1; poging <= MAX_POGINGEN; poging++) {
      const code = maak();
      const { data: gezet, error } = await db
        .from('onboardings').update({ startcode: code })
        .eq('id', onboardingId).is('startcode', null)
        .select('startcode');
      if (!error) {
        if (Array.isArray(gezet) && gezet.length) return gezet[0].startcode || code;
        // Geen rij geraakt: intussen door een ander pad gezet. Lees die.
        const { data: nu } = await db.from('onboardings').select('startcode').eq('id', onboardingId).maybeSingle();
        return nu?.startcode || null;
      }
      if (String(error.code) === '23505') continue; // botsing → nieuwe code
      if (isKolomOntbreekt(error)) {
        console.warn('[onboarding-startcode] kolom startcode ontbreekt nog — draai 2026-10-27-onboarding-portal.sql');
      } else {
        console.error('[onboarding-startcode] schrijven:', error.message);
      }
      return null;
    }
    console.error('[onboarding-startcode] na ' + MAX_POGINGEN + ' botsingen geen code voor', onboardingId);
    return null;
  } catch (e) {
    console.error('[onboarding-startcode] exception:', e?.message || e);
    return null;
  }
}
