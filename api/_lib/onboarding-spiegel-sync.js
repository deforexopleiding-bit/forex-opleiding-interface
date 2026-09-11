// api/_lib/onboarding-spiegel-sync.js
//
// De VERZOENING van de onboarding-spiegel, als gedeelde logica.
//
// Twee ingangen gebruiken dit bestand:
//   - api/cron/onboarding-spiegel-sync.js   — dagelijks 07:20, met CRON_SECRET;
//   - api/onboarding-spiegel-sync-run.js    — de knop in het CRM, met een
//     ingelogde gebruiker en `students.all.view`.
// Eén implementatie, twee ingangen: er is geen tweede versie die kan afwijken.
//
// ── VERZOENEN, NIET BIJWERKEN ────────────────────────────────────────────
// Drie dingen, niet één: TOEVOEGEN wat mist, BIJWERKEN wat er staat,
// VERWIJDEREN wat er niet meer hoort. Alleen bijwerken laat wezen achter van
// elke onboarding die geannuleerd of gearchiveerd is terwijl de spiegel even
// stuk was.
//
// ── LEEG IS NIET HETZELFDE ALS NIET-GELUKT ───────────────────────────────
// Mislukt de bevraging van het CRM of van het LMS, dan stopt de run met 502 en
// verwijdert hij NIETS. Anders zou één storing de hele spiegel legen.
//
// ── DE FOUT MOET TE LEZEN ZIJN ───────────────────────────────────────────
// `spiegelOnboarding()` is faalzacht en schrijft zijn reden naar de log. Dat
// is genoeg voor een cron die 's nachts draait, maar niet voor iemand die op
// een knop drukt en wil weten waaróm de spiegel leeg blijft. Daarom draagt
// `result.errors` de letterlijke melding per onboarding mee, en telt
// `mislukt` los van `geschreven`. Een run die 23 keer stilletjes faalt en
// "ok" zegt is precies hoe we hier terecht zijn gekomen.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import {
  spiegelOnboarding, SPIEGEL_TABEL,
  SPIEGEL_GESCHREVEN, SPIEGEL_VERWIJDERD, SPIEGEL_AFWEZIG,
  BRON_GELEZEN, BRON_ONBEREIKBAAR, BRON_NIET_GECONFIGUREERD,
  MENTOR_GEEN_IN_CRM,
} from './onboarding-spiegel.js';

// Bij ~50 actieve onboardings is dit ruim. Wordt het ooit meer, dan telt
// `overgeslagen_door_limiet` dat zichtbaar op — een stille afkapping is
// precies wat we niet willen.
const CAP = 500;

/** Hoeveel foutmeldingen we meesturen. Genoeg om een patroon te zien. */
const MAX_ERRORS = 20;

/**
 * @param {{dry?: boolean, door?: string}} [opties]
 *   dry  — dezelfde logica, nul schrijfacties.
 *   door — wie het aanzette ('cron' of een e-mailadres), voor de logregels.
 * @returns {Promise<{status: number, result: object}>}
 */
export async function draaiSpiegelSync({ dry = false, door = 'cron' } = {}) {
  const result = {
    ok: true, dry, door,
    bron: 'onboardings', bron_status: null,
    verwacht: 0, aanwezig: 0,
    geschreven: 0, verwijderd: 0, afwezig: 0, mislukt: 0,
    // ── DE MENTOR APART ────────────────────────────────────────────────
    // Een leeg mentorveld in het LMS heeft twee heel verschillende
    // betekenissen: er is er nog geen toegewezen in het CRM (normaal), of
    // er staat er wel een maar we konden 'm niet vertalen naar
    // hlms_personeel (mankement). Allebei schreven ze NULL, en dus was het
    // verschil niet te zien zonder de twee databanken naast elkaar te
    // leggen. Nu telt het apart, en de niet-vertaalbare gevallen komen met
    // naam en reden mee.
    mentor_gespiegeld: 0, mentor_geen_in_crm: 0, mentor_niet_vertaald: 0,
    mentor_open: [],
    overtollig_verwijderd: 0,
    overgeslagen_door_limiet: 0,
    errors: [],
  };

  try {
    const lms = getDfoLmsClient();
    if (!lms) {
      result.ok = false;
      result.bron_status = BRON_NIET_GECONFIGUREERD;
      result.error = 'DFO_LMS_SUPABASE_URL/KEY ontbreekt';
      console.error('[spiegel-sync/' + door + ']', result.error);
      return { status: 502, result };
    }

    // ── 1) De VERWACHTE verzameling, uit het CRM ────────────────────────
    const { data: verwacht, error: vErr } = await supabaseAdmin
      .from('onboardings')
      .select('id')
      .neq('status', 'geannuleerd')
      .is('archived_at', null)
      .not('dfo_lms_student_id', 'is', null)
      .limit(CAP + 1);
    if (vErr) {
      result.ok = false;
      result.bron_status = BRON_ONBEREIKBAAR;
      result.error = 'onboardings lezen: ' + vErr.message;
      console.error('[spiegel-sync/' + door + ']', result.error);
      return { status: 502, result };
    }

    let ids = (verwacht || []).map((r) => r.id).filter(Boolean);
    if (ids.length > CAP) {
      result.overgeslagen_door_limiet = ids.length - CAP;
      ids = ids.slice(0, CAP);
      console.warn('[spiegel-sync/' + door + '] limiet geraakt — '
        + result.overgeslagen_door_limiet + ' onboardings niet verwerkt deze ronde');
    }
    result.verwacht = ids.length;
    result.bron_status = BRON_GELEZEN;

    // ── 2) Wat er NU in het LMS staat ───────────────────────────────────
    const { data: aanwezig, error: aErr } = await lms
      .from(SPIEGEL_TABEL).select('crm_onboarding_id');
    if (aErr) {
      // Kunnen we niet lezen wat er staat, dan weten we ook niet wat
      // overtollig is. Stoppen — nooit verwijderen op grond van een
      // mislukte lezing.
      result.ok = false;
      result.bron_status = BRON_ONBEREIKBAAR;
      result.error = 'spiegel lezen: ' + aErr.message;
      console.error('[spiegel-sync/' + door + ']', result.error);
      return { status: 502, result };
    }
    const aanwezigeIds = new Set(
      (aanwezig || []).map((r) => String(r.crm_onboarding_id)).filter(Boolean));
    result.aanwezig = aanwezigeIds.size;

    // ── 3) Toevoegen + bijwerken, per rij, met eigen try/catch ──────────
    for (const id of ids) {
      aanwezigeIds.delete(String(id));
      if (dry) continue;
      try {
        const uit = await spiegelOnboarding(id);

        if (uit.mentor) {
          if (uit.mentor.id) {
            result.mentor_gespiegeld++;
          } else if (uit.mentor.reden === MENTOR_GEEN_IN_CRM) {
            result.mentor_geen_in_crm++;
          } else {
            // Hier staat in het CRM WEL een mentor. Dat dit misgaat is een
            // mankement en hoort niet stil te blijven.
            result.mentor_niet_vertaald++;
            console.warn('[spiegel-sync/' + door + '] mentor niet vertaald voor '
              + id + ': ' + uit.mentor.reden);
            if (result.mentor_open.length < MAX_ERRORS) {
              result.mentor_open.push({ onboarding_id: id, reden: uit.mentor.reden });
            }
          }
        }

        if      (uit.resultaat === SPIEGEL_GESCHREVEN) result.geschreven++;
        else if (uit.resultaat === SPIEGEL_VERWIJDERD) result.verwijderd++;
        else if (uit.resultaat === SPIEGEL_AFWEZIG)    result.afwezig++;
        else {
          result.mislukt++;
          if (result.errors.length < MAX_ERRORS) {
            result.errors.push({ onboarding_id: id, error: uit.fout || 'onbekend' });
          }
        }
      } catch (e) {
        // spiegelOnboarding gooit niet, maar mocht dat ooit veranderen dan
        // stopt één rij nooit de hele ronde.
        result.mislukt++;
        console.error('[spiegel-sync/' + door + '] rij mislukt', id, e?.message || e);
        if (result.errors.length < MAX_ERRORS) {
          result.errors.push({ onboarding_id: id, error: e?.message || String(e) });
        }
      }
    }

    // ── 4) Wat overblijft in `aanwezigeIds` hoort er niet meer ──────────
    // Geannuleerd, gearchiveerd, of de onboarding bestaat niet meer. Dit is
    // het stuk dat een puur-bijwerkende sync zou overslaan.
    for (const overtollig of aanwezigeIds) {
      if (dry) { result.overtollig_verwijderd++; continue; }
      try {
        const { error } = await lms
          .from(SPIEGEL_TABEL).delete().eq('crm_onboarding_id', overtollig);
        if (error) throw new Error(error.message);
        result.overtollig_verwijderd++;
      } catch (e) {
        result.mislukt++;
        console.error('[spiegel-sync/' + door + '] overtollige rij niet weg te krijgen',
          overtollig, e?.message || e);
        if (result.errors.length < MAX_ERRORS) {
          result.errors.push({ crm_onboarding_id: overtollig, error: e?.message || String(e) });
        }
      }
    }

    console.log('[spiegel-sync/' + door + '] klaar — verwacht=' + result.verwacht
      + ' geschreven=' + result.geschreven + ' mislukt=' + result.mislukt
      + ' verwijderd=' + result.overtollig_verwijderd
      + ' mentor(gespiegeld/geen-in-crm/niet-vertaald)='
      + result.mentor_gespiegeld + '/' + result.mentor_geen_in_crm + '/'
      + result.mentor_niet_vertaald
      + (dry ? ' (droogloop)' : ''));

    return { status: 200, result };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[spiegel-sync/' + door + ']', msg);
    result.ok = false;
    result.error = msg;
    return { status: 500, result };
  }
}
