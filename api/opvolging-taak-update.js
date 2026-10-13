// api/opvolging-taak-update.js
//
// POST → één taak bijwerken vanuit het scherm "Wat nu?".
//
// Body: { taak_id, actie, ... }
//   actie 'later_vandaag'   → later = true
//   actie 'verplaats'       { due }            → andere dag; zonder poging vandaag
//                                                telt dat als uitgesteld_zonder_poging
//   actie 'ingepland'       { afspraak_ref }   → status ingepland
//   actie 'agenda_gestuurd' → status wacht_inplanning + agenda_doorgestuurd_at
//   actie 'terug_in_lijst'  → het spiegelbeeld daarvan: status open,
//                             agenda_doorgestuurd_at leeg, due vandaag
//   actie 'archiveer'       { archief_reden }  → status gearchiveerd (reden verplicht)
//   actie 'notitie'         { notitie }
//
// Alleen voor leadkaarten (Leads bellen):
//   actie 'uitkomst'        { uitkomst: geen_gehoor|voicemail|gesproken|foutief_nummer }
//                             → wat er gebeurde aan de lijn. Geen gehoor/voicemail
//                               zet de laatste call recht ('gesproken' is bij een
//                               voicemail een opgenomen lijn, geen gesprek) en laat
//                               de belcadans de volgende ronde kiezen. Foutief
//                               nummer rondt de kaart meteen af.
//   actie 'opnieuw_om'      { wanneer: ISO | 'vanavond' | 'morgen' } → volgende
//                             poging op een zelfgekozen moment
//
// Nieuw endpoint. Schrijft uitsluitend in opvolging_taken.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { terugInLijstPatch } from './_lib/opvolging-terug-in-lijst.js';
import { isLeadkaart } from './_lib/opvolging-lijst.js';
import {
  REDEN_CODE_TERUGBELLEN, valideerAfronden, AFROND_CATEGORIEEN,
  UITKOMSTEN, logErbij, momentInZone, dagPlusN, START_UUR, belPlan,
} from './_lib/opvolging-leads-pot.js';
import { corrigeerLaatsteCall } from './_lib/opvolging-leads-uitkomst.js';

/** Een dag na `dag` (YYYY-MM-DD). */
const dagNa = (dag) => {
  const d = new Date(dag + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const isoDag = (d) => new Date(d).toISOString().slice(0, 10);

// DE DAG ZOALS DAVE HEM ZIET, niet zoals UTC hem telt.
//
// `isoDag` hierboven is UTC en geeft tussen 00:00 en 02:00 Amsterdamse tijd de
// dag van gisteren terug — dezelfde val die de nachtelijke doorrol een dag liet
// overslaan (zie api/_lib/opvolging-doorrol.js). Voor 'terug in de lijst' is
// dat het verschil tussen een kaart die vandaag op het scherm staat en een die
// er gisteren op had moeten staan.
//
// `isoDag` zelf laat ik staan: die bepaalt ook het telvenster van 'verplaats',
// en dat is een aparte wijziging met een eigen meting.
const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const b = req.body || {};
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });

  // Elke mutatie op een kaart is 'afronden' in de zin van dit scherm: de kaart
  // krijgt een uitkomst en verdwijnt, verschuift of wacht. Archiveren zit
  // hieronder nog een keer apart — zie de archiveer-tak.
  if (!(await requirePermission(req, 'opvolging.taak.afronden'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.taak.afronden)' });
  }

  const vandaag = isoDag(Date.now());
  const patch = { updated_at: new Date().toISOString() };

  try {
    // maybeSingle, niet single. .single() geeft bij NUL rijen een FOUT
    // ('Cannot coerce the result to a single JSON object'), die naar de catch
    // ging — waardoor de 404 hieronder er wel stond maar nog nooit gedraaid
    // had. Dave kreeg dan een 500 met een databasezin erin, en dat leest als
    // 'het systeem is stuk' in plaats van 'die kaart bestaat niet meer'.
    // api/opvolging-aanmelding-actie.js deed dit al goed; die twee buren
    // spraken elkaar tegen, en dat is geen keuze maar een fout.
    const { data: taak, error: leesErr } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).maybeSingle();
    if (leesErr) throw leesErr;
    if (!taak) return res.status(404).json({ error: 'Deze taak bestaat niet (meer).' });

    const lead = isLeadkaart(taak);

    if (b.actie === 'later_vandaag') {
      patch.later = true;
      // LEADKAART: 'later vandaag' = over 3 uur opnieuw aan de beurt in de
      // Belrij. Tot dan staat hij in afkoeling, niet bovenaan.
      if (lead) {
        patch.later = false;
        patch.volgende_poging_at = new Date(Date.now() + 3 * 3600000).toISOString();
        patch.uitkomst_log = logErbij(taak, { soort: 'opnieuw', tekst: 'Later vandaag nog eens', wanneer: patch.volgende_poging_at });
      }

    } else if (b.actie === 'verplaats') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due || '')) return res.status(400).json({ error: 'due ontbreekt' });
      // LEADKAART: 'moet later terugkomen' is een afspraak MET de lead. Wat hij
      // zei is verplicht, en de dag ligt minstens morgen — 'later vandaag' is
      // een andere knop. Op de afgesproken dag staat hij bovenaan in de pot
      // Terugbellen (reden_code), los van de volle pot Nieuw.
      if (isLeadkaart(taak)) {
        const wat = String(b.terugbel_notitie || '').trim();
        if (!wat) return res.status(400).json({ error: 'Schrijf op wat de lead zei — anders weet je op die dag niet waarom je belt.' });
        if (b.due < dagNa(dagInZone(Date.now()))) return res.status(400).json({ error: 'Kies een dag vanaf morgen.' });
        patch.terugbel_notitie = wat.slice(0, 1000);
        patch.reden_code = REDEN_CODE_TERUGBELLEN;
        patch.volgende_poging_at = null;
        // De afgesproken dag in het logboek: daarvandaan tellen de rondes van
        // deze afspraak (de nachtelijke doorrol verschuift `due` later naar
        // vandaag, dus die is geen betrouwbare startdag).
        patch.uitkomst_log = logErbij(taak, { soort: 'terugbel', due: b.due, tekst: 'Terugbellen op ' + b.due + ': ' + wat.slice(0, 200) });
      }
      // Geteld worden alleen echte pogingen van vandaag; het doorschuiven zelf telt niet mee.
      const { count } = await supabaseAdmin
        .from('opvolging_pogingen')
        .select('id', { count: 'exact', head: true })
        .eq('taak_id', b.taak_id)
        .in('soort', ['call', 'whatsapp', 'spraakbericht'])
        .gte('tijdstip', vandaag + 'T00:00:00Z');
      if (!count) patch.uitgesteld_zonder_poging = (taak.uitgesteld_zonder_poging || 0) + 1;
      patch.due = b.due;
      patch.later = false;

    } else if (b.actie === 'ingepland') {
      patch.status = 'ingepland';
      patch.afspraak_ref = b.afspraak_ref || null;
      patch.afspraak_gevonden_at = new Date().toISOString();

    } else if (b.actie === 'agenda_gestuurd') {
      patch.status = 'wacht_inplanning';
      patch.agenda_doorgestuurd_at = new Date().toISOString();

    } else if (b.actie === 'terug_in_lijst') {
      // HET SPIEGELBEELD VAN 'agenda_gestuurd', en dat is meer dan een datum.
      // De knop postte tot 9 september 'verplaats' met due=vandaag; dat liet de
      // status op wacht_inplanning staan en deed dus niets zichtbaars — de due
      // stond al op vandaag. Sofia Vanat en Shudino Andrade zaten daardoor vast
      // zonder weg terug. Zie _lib/opvolging-terug-in-lijst.js.
      const terug = terugInLijstPatch({ vandaag: dagInZone(Date.now()) });
      if (!terug) return res.status(400).json({ error: 'geen geldige dag' });
      Object.assign(patch, terug);

    } else if (b.actie === 'archiveer') {
      // Archiveren heeft een eigen sleutel: het haalt een lead definitief uit
      // de lijst, en dat is een zwaardere beslissing dan hem verzetten.
      if (!(await requirePermission(req, 'opvolging.taak.archiveren'))) {
        return res.status(403).json({ error: 'Geen rechten (opvolging.taak.archiveren)' });
      }
      // LEADKAART: afronden = weggooien, en Maxim moet achteraf kunnen nagaan of
      // er genoeg moeite gedaan is. Categorie en uitleg zijn dus allebei
      // verplicht; de uitleg wordt de archief_reden.
      if (isLeadkaart(taak)) {
        const fout = valideerAfronden({ categorie: b.archief_categorie, notitie: b.archief_reden });
        if (fout) return res.status(400).json({ error: fout, categorieen: Object.keys(AFROND_CATEGORIEEN) });
        patch.archief_categorie = String(b.archief_categorie);
        patch.uitkomst_log = logErbij(taak, { soort: 'afgerond', tekst: 'Afgerond: ' + (AFROND_CATEGORIEEN[b.archief_categorie] || b.archief_categorie) });
      }
      const reden = (b.archief_reden || '').trim();
      if (!reden) return res.status(400).json({ error: 'archief_reden is verplicht' });
      patch.status = 'gearchiveerd';
      patch.archief_reden = reden;
      patch.gearchiveerd_at = new Date().toISOString();

    } else if (b.actie === 'notitie') {
      patch.notitie = b.notitie || null;

    } else if (b.actie === 'uitkomst') {
      if (!lead) return res.status(400).json({ error: 'uitkomst bestaat alleen voor Leads bellen' });
      const u = String(b.uitkomst || '');
      if (!Object.prototype.hasOwnProperty.call(UITKOMSTEN, u)) {
        return res.status(400).json({ error: 'onbekende uitkomst', uitkomsten: Object.keys(UITKOMSTEN) });
      }
      if (u === 'foutief_nummer' && !(await requirePermission(req, 'opvolging.taak.archiveren'))) {
        return res.status(403).json({ error: 'Geen rechten (opvolging.taak.archiveren)' });
      }
      const correctie = await corrigeerLaatsteCall(supabaseAdmin, { taakId: taak.id, uitkomst: u, nuMs: Date.now() });
      const noot = String(b.notitie || '').trim().slice(0, 500);
      patch.uitkomst_log = logErbij(taak, {
        soort: u, tekst: UITKOMSTEN[u] + (noot ? ' — ' + noot : ''), call: correctie.actie,
      });
      if (u === 'geen_gehoor' || u === 'voicemail') {
        // De cadans beslist: volgende ronde volgt uit de belpogingen zelf.
        patch.volgende_poging_at = null;
        patch.later = false;
      }
      if (u === 'foutief_nummer') {
        patch.status = 'gearchiveerd';
        patch.archief_categorie = 'foutief_nummer';
        patch.archief_reden = 'Foutief nummer — vastgesteld bij het bellen op ' + dagInZone(Date.now()) + '.' + (noot ? ' ' + noot : '');
        patch.gearchiveerd_at = new Date().toISOString();
      }

    } else if (b.actie === 'opnieuw_om') {
      if (!lead) return res.status(400).json({ error: 'opnieuw_om bestaat alleen voor Leads bellen' });
      const vandaagAms = dagInZone(Date.now());
      let ms;
      if (b.wanneer === 'vanavond') ms = momentInZone(vandaagAms, 18);
      else if (b.wanneer === 'morgen') ms = momentInZone(dagPlusN(vandaagAms, 1), START_UUR);
      else ms = Date.parse(String(b.wanneer || ''));
      if (!Number.isFinite(ms) || ms <= Date.now() || ms > Date.now() + 30 * 86400000) {
        return res.status(400).json({ error: 'Kies een moment in de komende 30 dagen.' });
      }
      patch.volgende_poging_at = new Date(ms).toISOString();
      patch.later = false;
      patch.uitkomst_log = logErbij(taak, { soort: 'opnieuw', tekst: 'Opnieuw proberen', wanneer: patch.volgende_poging_at });

    } else {
      return res.status(400).json({ error: 'onbekende actie' });
    }

    // Ook hier maybeSingle: raakt de update nul rijen — de kaart is tussen het
    // lezen en het schrijven weggehaald, bijvoorbeeld in een tweede tabblad —
    // dan is dat een 404 en geen 500.
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken').update(patch).eq('id', b.taak_id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Deze taak bestaat niet (meer).' });
    // Na een uitkomst wil het scherm meteen weten wanneer de volgende ronde is.
    let plan = null;
    if (lead && (b.actie === 'uitkomst' || b.actie === 'opnieuw_om' || b.actie === 'later_vandaag')) {
      try {
        const { data: pog } = await supabaseAdmin.from('opvolging_pogingen').select('*')
          .eq('taak_id', data.id).order('tijdstip', { ascending: true }).limit(500);
        plan = belPlan({ kaart: data, pogingen: pog || [], nuMs: Date.now() });
      } catch (e) { console.warn('[opvolging-taak-update] plan (soft):', e?.message || e); }
    }
    return res.status(200).json({ success: true, taak: data, plan });
  } catch (e) {
    // De echte tekst in het log, een generieke zin naar buiten. e.message
    // rechtstreeks doorsturen zette databasetaal op Daves scherm.
    console.error('[opvolging-taak-update]', b.actie, e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
