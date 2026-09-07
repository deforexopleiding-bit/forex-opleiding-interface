// api/cron/onboarding-eerste-sessie-afronden.js
//
// Dagelijkse cron — sluit een onboarding automatisch af zodra de EERSTE
// sessie van die student in het LMS op 'afgerond' staat.
//
// ── DE REGEL (Maxim, 7 september 2026) ───────────────────────────────────
// De VROEGSTE AFGERONDE sessie van een student sluit diens onboarding af.
// Let op: niet "de eerste sessie mits afgerond". Was de eerste een no-show,
// dan sluit die niets (daar komt een signaal uit) en doet de eerstvolgende
// sessie die wél afgerond raakt het alsnog — anders zou één gemiste eerste
// call de onboarding voor altijd open laten staan.
// Geen soort-onderscheid: er bestaat geen 'kennismakingsgesprek' en geen
// Alpha/Delta. Elke coachingsessie telt, en de vroegste is de eerste.
//
// Was die eerste sessie een NO-SHOW, dan sluit er niets. Dan komt er een
// signaal met een eigen type (`eerste_call_no_show`), want daar moet iemand
// kort op zitten om te voorkomen dat het een wanbetaler wordt. Dat deel zit
// in api/cron/noshow-detect.js, waar de no-show-signalen sowieso ontstaan.
//
// ── WAT ER WORDT VASTGELEGD, EN WAAROM ───────────────────────────────────
// Niet alleen dát de onboarding afgerond is, maar WELKE sessie dat deed:
//   auto_afgerond_sessie_id   het hlms_sessie-id
//   auto_afgerond_sessie_op   de start_tijd van die sessie
//   auto_afgerond_op          het moment van afsluiten
//
// Een onboarding die 'afgerond' zegt zonder aanwijsbare oorzaak is precies
// het schermsoort dat dit project al twee keer een halve dag gekost heeft.
// Deze drie velden staan ook in het detailscherm, niet alleen in de databank.
//
// ── GEEN TERUGWERKENDE VLOEDGOLF ─────────────────────────────────────────
// Watermerk in app_settings (`onboarding_autocomplete_since`), zelfde patroon
// als noshow-detect: ontbreekt het watermerk, dan zet de eerste run het op nu
// en doet verder NIETS. Zonder die rem zou een eerste uitrol in één klap de
// hele historie afsluiten alsof er vandaag van alles gebeurde.
//
// METEN VOORDAT JE AANZET:
//   GET ?dry=1&since=2026-01-01T00:00:00Z
// Droogloop over een zelfgekozen periode: exact dezelfde logica, nul
// schrijfacties. `since` werkt ALLEEN samen met dry=1, zodat een echte run
// nooit per ongeluk breder kan lopen dan het watermerk.
//
// AUTH: Authorization: Bearer ${CRON_SECRET}. 401 zonder.

import { supabaseAdmin } from '../supabase.js';
import { haalAfgerondeEersteSessies, BRON_GELEZEN } from '../_lib/dfo-lms-sessies.js';

const SETTING_KEY = 'onboarding_autocomplete_since';
const FETCH_CAP   = 500;

// Statussen waarbij we niets meer doen.
const NIET_MEER_AANRAKEN = new Set(['gearchiveerd', 'geannuleerd']);

async function readWatermark() {
  const { data } = await supabaseAdmin
    .from('app_settings').select('value').eq('key', SETTING_KEY).maybeSingle();
  if (!data) return null;
  const v = data.value;
  if (v && typeof v === 'object' && typeof v.iso === 'string') return v.iso;
  if (typeof v === 'string') return v;
  return null;
}

async function writeWatermark(iso) {
  const row = { key: SETTING_KEY, value: { iso }, updated_by_user_id: null };
  const { data: existing } = await supabaseAdmin
    .from('app_settings').select('key').eq('key', SETTING_KEY).maybeSingle();
  if (existing) {
    const { error } = await supabaseAdmin.from('app_settings').update(row).eq('key', SETTING_KEY);
    if (error) throw new Error('watermark update: ' + error.message);
  } else {
    const { error } = await supabaseAdmin.from('app_settings').insert(row);
    if (error) throw new Error('watermark insert: ' + error.message);
  }
}

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
    ok: true, dry, initialized: false,
    bron: 'hlms_sessie', bron_status: null,
    watermark_before: null, watermark_after: null,
    // Alles wat buiten de filter viel wordt geteld: een cron die alleen zegt
    // wat hij deed en niet wat hij oversloeg, stelt ten onrechte gerust.
    afgeronde_sessies: 0, eerdere_afgeronde_buiten_venster: 0, zonder_bubble_koppeling: 0,
    kandidaten: 0, afgesloten: 0,
    geen_onboarding: 0, al_afgerond: 0, al_automatisch: 0, niet_aanraken: 0,
    voorbeelden: [], errors: [],
  };

  try {
    const watermark = await readWatermark();
    result.watermark_before = watermark;

    // Alleen in een droogloop mag een eigen periode meegegeven worden.
    const sinceParam = dry && typeof req.query?.since === 'string'
      ? req.query.since.trim() : '';
    const sinds = sinceParam || watermark;

    // EERSTE RUN — watermerk zetten en stoppen. Geen inhaalslag.
    if (!sinds) {
      const nowIso = new Date().toISOString();
      if (!dry) await writeWatermark(nowIso);
      result.initialized = true;
      result.watermark_after = nowIso;
      return res.status(200).json(result);
    }

    const bron = await haalAfgerondeEersteSessies({ sindsIso: sinds, limiet: FETCH_CAP });
    result.bron_status             = bron.bron_status;
    result.afgeronde_sessies       = bron.totaal_afgerond;
    result.eerdere_afgeronde_buiten_venster = bron.eerdere_afgeronde_buiten_venster;
    result.zonder_bubble_koppeling = bron.zonder_bubble_koppeling;

    // MISLUKTE BEVRAGING IS GEEN LEGE UITKOMST. Stoppen zonder het watermerk
    // te verzetten, zodat een storing geen sessies definitief overslaat.
    if (bron.bron_status !== BRON_GELEZEN) {
      result.ok = false;
      result.error = 'sessies niet gelezen (' + bron.bron_status + '): '
        + (bron.fout || 'reden onbekend');
      console.error('[onboarding-eerste-sessie]', result.error);
      return res.status(502).json(result);
    }

    result.kandidaten = bron.sessies.length;
    let highestMs = new Date(sinds).getTime() || 0;

    for (const sess of bron.sessies) {
      try {
        const sdMs = new Date(sess.start_tijd).getTime();

        // Onboarding zoeken via de brug bubble_user_id.
        const { data: ob, error: obErr } = await supabaseAdmin
          .from('onboardings')
          .select('id, status, archived_at, customer_name, auto_afgerond_sessie_id')
          .eq('bubble_user_id', sess.bubble_user_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (obErr) throw new Error('onboarding lookup: ' + obErr.message);

        if (!ob?.id) { result.geen_onboarding++; continue; }

        // IDEMPOTENT — drie afzonderlijke redenen om niets te doen.
        //
        // `auto_afgerond_sessie_id` is de sterkste: staat die gevuld, dan
        // heeft deze cron zijn werk al gedaan. Ook wanneer iemand de
        // onboarding daarna handmatig heropende laten we 'm met rust — een
        // mens die bewust heropent mag niet door dezelfde sessie opnieuw
        // dichtgetrokken worden.
        if (ob.auto_afgerond_sessie_id) { result.al_automatisch++; continue; }
        if (ob.archived_at || NIET_MEER_AANRAKEN.has(String(ob.status || '').toLowerCase())) {
          result.niet_aanraken++; continue;
        }
        if (String(ob.status || '').toLowerCase() === 'afgerond') { result.al_afgerond++; continue; }

        if (result.voorbeelden.length < 20) {
          result.voorbeelden.push({
            onboarding_id: ob.id,
            klant: ob.customer_name || null,
            status_nu: ob.status,
            sessie_id: sess.id,
            sessie_op: sess.start_tijd,
          });
        }

        if (dry) { result.afgesloten++; if (sdMs > highestMs) highestMs = sdMs; continue; }

        const nowIso = new Date().toISOString();
        const { data: upd, error: updErr } = await supabaseAdmin
          .from('onboardings')
          .update({
            status: 'afgerond',
            completed_at: nowIso,
            auto_afgerond_sessie_id: sess.id,
            auto_afgerond_sessie_op: sess.start_tijd,
            auto_afgerond_op: nowIso,
            updated_at: nowIso,
          })
          .eq('id', ob.id)
          // Optimistische sluiting: als een andere run of een mens tussendoor
          // al iets deed, raakt deze update niets.
          .is('auto_afgerond_sessie_id', null)
          .select('id')
          .maybeSingle();
        if (updErr) throw new Error('onboarding afsluiten: ' + updErr.message);
        if (upd?.id) result.afgesloten++;
        else         result.al_automatisch++;

        if (sdMs > highestMs) highestMs = sdMs;
      } catch (e) {
        const msg = e?.message || String(e);
        console.error('[onboarding-eerste-sessie] rij mislukt', sess?.id, msg);
        result.errors.push({ sessie_id: sess?.id || null, error: msg });
      }
    }

    // Watermerk vooruit — nooit in een droogloop.
    const oudMs = new Date(sinds).getTime() || 0;
    if (!dry && highestMs > oudMs) {
      const nextIso = new Date(highestMs).toISOString();
      try {
        await writeWatermark(nextIso);
        result.watermark_after = nextIso;
      } catch (e) {
        result.errors.push({ error: 'watermerk verzetten mislukt: ' + (e?.message || e) });
        result.watermark_after = watermark;
      }
    } else {
      result.watermark_after = watermark;
    }

    return res.status(200).json(result);
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[onboarding-eerste-sessie]', msg);
    result.ok = false;
    result.error = msg;
    return res.status(500).json(result);
  }
}
