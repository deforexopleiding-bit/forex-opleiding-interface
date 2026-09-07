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
// ── HET WATERMERK VERZET OP EEN BESLUIT, NIET OP EEN SCHRIJFACTIE ────────
// Overslaan is ook een besluit. Stond dit alleen op de schrijf-tak (zoals in
// de eerste versie), dan gebeurden er twee dingen: op een ochtend waarin alle
// rijen werden overgeslagen liep het watermerk helemaal niet vooruit, en een
// overgeslagen rij die vóór een geschreven rij lag raakte er alsnog áchter
// zonder ooit verwerkt te zijn. Dat laatste is geen randgeval — de meeste
// studenten met een afgeronde sessie hebben (nog) geen onboardingrij.
//
// Alleen een echte FOUT houdt het watermerk tegen, en dan voor de hele rest
// van de ronde: de rijen komen oplopend binnen, dus doorschuiven over een
// mislukte rij heen maakt die definitief kwijt.
//
// ── AANLEIDING EN OORZAAK ────────────────────────────────────────────────
// De lezer geeft per student twee sessies terug: de OORZAAK (de vroegste
// afgeronde sessie, ook van vóór het watermerk — die maakte het onboarden af)
// en de AANLEIDING (de sessie binnen het venster die ons erop attendeerde).
// Vastleggen doen we de oorzaak, het watermerk verzetten op de aanleiding.
// Zouden we het watermerk op de oorzaak zetten, dan wilde dat terug in de
// tijd en kwam dezelfde rij elke ochtend opnieuw langs.
//
// ── DE TITEL VAN DE SLUITENDE SESSIE ─────────────────────────────────────
// `auto_afgerond_sessie_titel` legt vast WAT er sloot, niet alleen wanneer.
// Reden: de regel kijkt naar status 'afgerond' en niet naar het soort sessie,
// dus een testsessie die per ongeluk op afgerond wordt gezet sluit een echte
// onboarding. Er komt BEWUST geen filter op woorden in die titel — raden op
// een titel is precies het soort regel dat later stil de verkeerde kant op
// valt. Wat er wel gebeurt: wie het dossier opent ziet meteen wat er sloot.
//
// Het is nadrukkelijk geen alarm. Er gaat geen bericht uit bij een
// automatische afsluiting; dat is een aparte beslissing.
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
    afgeronde_sessies: 0, gesloten_op_eerdere_sessie: 0, zonder_bubble_koppeling: 0,
    // De titel van de sluitende sessie is sierwerk voor het dossier, maar of
    // hij GELEZEN is blijft een eigen feit — anders is 'geen titel' niet te
    // onderscheiden van 'titel niet opgehaald'.
    titels_gelezen: null, titels_fout: null,
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
    result.gesloten_op_eerdere_sessie = bron.gesloten_op_eerdere_sessie;
    result.titels_gelezen             = bron.titels_gelezen ?? null;
    result.titels_fout                = bron.titels_fout ?? null;
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
    // Zodra één rij FAALT gaat het watermerk niet verder, ook niet voor de
    // rijen erna. De bevraging is oplopend gesorteerd, dus doorschuiven over
    // een mislukte rij heen zou die rij definitief kwijtmaken — en dat is
    // precies de stille vorm van gegevensverlies die we hier aan het
    // opruimen zijn. Liever zichtbaar blijven staan: de fout staat in
    // `errors` én in de log, en morgen komt dezelfde rij terug.
    let blokkade = false;

    for (const sess of bron.sessies) {
      // Het watermerk verzet mee op de AANLEIDING (de sessie die in het
      // venster viel), niet op de oorzaak. De oorzaak mag van vóór het
      // watermerk zijn; die als watermerk gebruiken zou het terug in de tijd
      // willen zetten en de rij eeuwig laten terugkomen.
      const aanleidingMs = new Date(sess.aanleiding_op || sess.start_tijd).getTime();

      // Is deze rij tot een BESLUIT gekomen? Overslaan is ook een besluit.
      //
      // Dit stond eerder alleen op de schrijf-tak, en dat was fout: de
      // bevraging is oplopend gesorteerd met een limiet, dus een overgeslagen
      // sessie die vóór een geschreven sessie ligt raakte alsnog áchter het
      // watermerk — zonder ooit verwerkt te zijn. Bovendien liep het watermerk
      // helemaal niet meer vooruit op een ochtend waarin alles werd
      // overgeslagen, en dat is hier de regel en niet de uitzondering: de
      // meeste studenten met een afgeronde sessie hebben geen onboardingrij.
      //
      // Alleen een echte FOUT laat het watermerk staan, zodat die rij morgen
      // opnieuw langskomt.
      let afgehandeld = false;
      try {
        // Onboarding zoeken via de brug bubble_user_id.
        const { data: ob, error: obErr } = await supabaseAdmin
          .from('onboardings')
          .select('id, status, archived_at, customer_name, auto_afgerond_sessie_id')
          .eq('bubble_user_id', sess.bubble_user_id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (obErr) throw new Error('onboarding lookup: ' + obErr.message);

        // IDEMPOTENT — vier afzonderlijke redenen om niets te doen. Als keten
        // en niet als reeks `continue`s, zodat het besluit ná de try nog
        // bereikt wordt.
        //
        // `auto_afgerond_sessie_id` is de sterkste: staat die gevuld, dan
        // heeft deze cron zijn werk al gedaan. Ook wanneer iemand de
        // onboarding daarna handmatig heropende laten we 'm met rust — een
        // mens die bewust heropent mag niet door dezelfde sessie opnieuw
        // dichtgetrokken worden.
        if (!ob?.id) {
          result.geen_onboarding++;
        } else if (ob.auto_afgerond_sessie_id) {
          result.al_automatisch++;
        } else if (ob.archived_at || NIET_MEER_AANRAKEN.has(String(ob.status || '').toLowerCase())) {
          result.niet_aanraken++;
        } else if (String(ob.status || '').toLowerCase() === 'afgerond') {
          result.al_afgerond++;
        } else {
          if (result.voorbeelden.length < 20) {
            result.voorbeelden.push({
              onboarding_id: ob.id,
              klant: ob.customer_name || null,
              status_nu: ob.status,
              sessie_id: sess.id,
              sessie_op: sess.start_tijd,
              sessie_titel: sess.titel || null,
              // Zichtbaar maken wanneer de oorzaak ouder is dan het watermerk.
              op_eerdere_sessie: !!sess.op_eerdere_sessie,
              aanleiding_op: sess.aanleiding_op || null,
            });
          }

          if (dry) {
            result.afgesloten++;
          } else {
            const nowIso = new Date().toISOString();
            const { data: upd, error: updErr } = await supabaseAdmin
              .from('onboardings')
              .update({
                status: 'afgerond',
                completed_at: nowIso,
                auto_afgerond_sessie_id: sess.id,
                auto_afgerond_sessie_op: sess.start_tijd,
                // Mag leeg zijn: de titel stuurt niets aan. Dat 'ie ontbreekt
                // staat in titels_gelezen, niet in deze kolom.
                auto_afgerond_sessie_titel: sess.titel || null,
                auto_afgerond_op: nowIso,
                updated_at: nowIso,
              })
              .eq('id', ob.id)
              // Optimistische sluiting: als een andere run of een mens
              // tussendoor al iets deed, raakt deze update niets.
              .is('auto_afgerond_sessie_id', null)
              .select('id')
              .maybeSingle();
            if (updErr) throw new Error('onboarding afsluiten: ' + updErr.message);
            if (upd?.id) result.afgesloten++;
            else         result.al_automatisch++;
          }
        }

        afgehandeld = true;
      } catch (e) {
        const msg = e?.message || String(e);
        console.error('[onboarding-eerste-sessie] rij mislukt', sess?.id, msg);
        result.errors.push({ sessie_id: sess?.id || null, error: msg });
        blokkade = true;
      }

      if (!blokkade && afgehandeld && aanleidingMs > highestMs) highestMs = aanleidingMs;
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
