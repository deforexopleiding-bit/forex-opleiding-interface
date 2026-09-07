// api/cron/onboarding-spiegel-sync.js
//
// Dagelijkse VERZOENING van de onboarding-spiegel in het LMS.
//
// ── DIT IS DE WAARHEID, NIET DE VANGNET ──────────────────────────────────
// De aanroepen van `spiegelOnboarding()` vanuit endpoints zijn er zodat het
// scherm meteen klopt. Deze cron bepaalt wat WAAR is. Die volgorde is met
// opzet zo: er zijn twintig schrijfpunten op `onboardings`, en bij twintig is
// het geen kwestie óf er ooit eentje de spiegel vergeet, maar wanneer. Zou
// het gebeurtenis-schrijven de hoofdweg zijn, dan is een vergeten aanroep een
// blijvende afwijking die niemand ziet. Nu is het hooguit een dag vertraging.
//
// ── VERZOENEN, NIET BIJWERKEN ────────────────────────────────────────────
// Drie dingen, niet één:
//   - TOEVOEGEN wat mist,
//   - BIJWERKEN wat er staat,
//   - VERWIJDEREN wat er niet meer hoort.
// Alleen bijwerken laat wezen achter van elke onboarding die geannuleerd of
// gearchiveerd is terwijl de spiegel even stuk was. En omdat de verwachte
// verzameling wordt afgeleid uit het CRM (`status != 'geannuleerd' AND
// archived_at IS NULL AND dfo_lms_student_id IS NOT NULL`), kan een
// geannuleerde onboarding er per definitie niet in zitten — "verdwijnt
// overal" is dus een gevolg van de definitie en niet van een opruimactie die
// iemand kan vergeten.
//
// ── LEEG IS NIET HETZELFDE ALS NIET-GELUKT ───────────────────────────────
// Mislukt de bevraging van het CRM of van het LMS, dan stopt deze run met
// 502 en verwijdert hij NIETS. Anders zou één storing de hele spiegel legen —
// precies de fout die deze week drie keer is opgeruimd.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.
// DROOGLOOP: ?dry=1 — dezelfde logica, nul schrijfacties.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from '../_lib/dfo-lms-db.js';
import {
  spiegelOnboarding, SPIEGEL_TABEL,
  SPIEGEL_GESCHREVEN, SPIEGEL_VERWIJDERD, SPIEGEL_AFWEZIG, SPIEGEL_MISLUKT,
  BRON_GELEZEN, BRON_ONBEREIKBAAR, BRON_NIET_GECONFIGUREERD,
} from '../_lib/onboarding-spiegel.js';

// Bij ~50 actieve onboardings is dit ruim. Wordt het ooit meer dan dit, dan
// telt `overgeslagen_door_limiet` dat zichtbaar op — een stille afkapping is
// precies wat we niet willen.
const CAP = 500;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const secret = process.env.CRON_SECRET || null;
  const auth   = req.headers['authorization'] || '';
  if (!secret || auth !== ('Bearer ' + secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dry = String(req.query?.dry || '') === '1';

  const result = {
    ok: true, dry,
    bron: 'onboardings', bron_status: null,
    verwacht: 0, aanwezig: 0,
    geschreven: 0, verwijderd: 0, afwezig: 0, mislukt: 0,
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
      console.error('[spiegel-sync]', result.error);
      return res.status(502).json(result);
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
      console.error('[spiegel-sync]', result.error);
      return res.status(502).json(result);
    }

    let ids = (verwacht || []).map((r) => r.id).filter(Boolean);
    if (ids.length > CAP) {
      result.overgeslagen_door_limiet = ids.length - CAP;
      ids = ids.slice(0, CAP);
      console.warn('[spiegel-sync] limiet geraakt — ' +
        result.overgeslagen_door_limiet + ' onboardings niet verwerkt deze ronde');
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
      console.error('[spiegel-sync]', result.error);
      return res.status(502).json(result);
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
        if      (uit.resultaat === SPIEGEL_GESCHREVEN) result.geschreven++;
        else if (uit.resultaat === SPIEGEL_VERWIJDERD) result.verwijderd++;
        else if (uit.resultaat === SPIEGEL_AFWEZIG)    result.afwezig++;
        else {
          result.mislukt++;
          if (result.errors.length < 10) {
            result.errors.push({ onboarding_id: id, error: uit.fout || 'onbekend' });
          }
        }
      } catch (e) {
        // spiegelOnboarding gooit niet, maar mocht dat ooit veranderen dan
        // stopt één rij nooit de hele ronde.
        result.mislukt++;
        console.error('[spiegel-sync] rij mislukt', id, e?.message || e);
        if (result.errors.length < 10) {
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
        console.error('[spiegel-sync] overtollige rij niet weg te krijgen',
          overtollig, e?.message || e);
        if (result.errors.length < 10) {
          result.errors.push({ crm_onboarding_id: overtollig, error: e?.message || String(e) });
        }
      }
    }

    return res.status(200).json(result);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[spiegel-sync]', msg);
    result.ok = false;
    result.error = msg;
    return res.status(500).json(result);
  }
}
