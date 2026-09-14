// api/cron-opvolging-zoom-opwarm.js
//
// DE OPWARMRONDE — een geboekte zoomcall wordt de dag erna werk.
//
// Tussen het boeken en de calldag staat er vandaag niemand in Daves lijst. De
// drie bestaande wegen beginnen allemaal pas op of ná de calldag: het
// spraakbericht vóór 09:00, cron-opvolging-zoom-nabel om 12:00, en daarna de
// no-show-flow. Gemeten op 14 september: 40 openstaande afspraken in de
// toekomst, gemiddeld 13,6 dagen vooruit geboekt, 29 daarvan zeven dagen of
// verder. Daar komen de no-shows vandaan.
//
// Deze cron maakt daar één ronde van: zodra iemand een zoomcall boekt komt hij
// de dag erna in de lijst voor een bevestigingsgesprek. Bevestigd betekent
// kaart dicht, en hij komt NIET terug.
//
// ── WAAROM EEN CRON EN GEEN HOOK IN HET BOEK-ENDPOINT ────────────────────
// Een zoomcall ontstaat via de boekingslink, via de cockpit, via 'Opnieuw
// inplannen' in de werklijst en via een verzetting (die maakt een nieuwe rij
// met parent_appointment_id). Een hook per weg is vier keer hetzelfde bouwen
// en vier keer kunnen vergeten. Deze cron kijkt naar de AFSPRAAKRIJ, dus
// verzette en opnieuw geboekte calls komen er vanzelf in.
//
// ── DE BESLISSING STAAT NIET HIER ────────────────────────────────────────
// _lib/opvolging-zoom-opwarm.js draagt de regels als pure functies met tests.
// Hier alleen het lezen, schrijven en tellen.
//
// ── WAT HET NIET DOET ────────────────────────────────────────────────────
// Geen belpogingen, geen uitkomsten, niets naar GHL of Zoom. Alleen kaarten
// aanmaken langs hetzelfde pad als api/opvolging-taak-create.js, en kaarten
// sluiten of bijwerken die hun reden verloren hebben.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth), zelfde patroon als
// de andere opvolging-crons. GET (Vercel cron) + POST (debug).
//
// Schrijft uitsluitend in opvolging_taken. follow_up_appointments wordt alleen
// gelezen.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import {
  REDEN, SOORT, SOURCE, MAX_ACHTERSTAND_PER_DAG,
  bepaalOpwarmActie, kiesInstroom, dagInZone,
} from './_lib/opvolging-zoom-opwarm.js';

const ABORT_MS = 25_000;
/** Hoe ver vooruit kijken we? Ruim boven wat er in de praktijk geboekt wordt. */
const VOORUIT_DAGEN = 180;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const startedAt = Date.now();
  const vandaag = dagInZone(startedAt);

  const summary = {
    dag            : vandaag,
    afspraken      : 0,
    kandidaten     : 0,
    aangemaakt     : 0,
    aangemaakt_vers: 0,
    bijgewerkt     : 0,
    gesloten       : 0,
    gesloten_reden : {},
    wachtrij       : 0,
    dagquota       : MAX_ACHTERSTAND_PER_DAG,
    achterstand_vandaag_al: 0,
    overgeslagen   : {},
    errors         : [],
    duration_ms    : 0,
  };

  try {
    // ── De bestaande opwarmkaarten, in één lezing ───────────────────────
    // ALLE statussen. Een gearchiveerde kaart is geschiedenis en mag nooit
    // opnieuw ontstaan: bevestigd is dicht, en dicht blijft dicht. Zou dit
    // alleen de open kaarten lezen, dan stond elke bevestigde lead morgen weer
    // in de lijst.
    const kaarten = await leesKaarten();
    const kaartPerAfspraak = new Map();
    for (const k of kaarten) {
      const aid = k.bron_ref && k.bron_ref.appointment_id;
      if (aid && !kaartPerAfspraak.has(String(aid))) kaartPerAfspraak.set(String(aid), k);
    }

    // Hoeveel ACHTERSTAND-kaarten zijn er vandaag al bijgekomen? Verse
    // boekingen tellen niet mee — die zijn gewone instroom en kennen geen
    // maximum.
    summary.achterstand_vandaag_al = kaarten.filter((k) =>
      k.bron_ref && k.bron_ref.achterstand === true
      && dagInZone(Date.parse(k.created_at || 0)) === vandaag).length;

    // ── De afspraken ────────────────────────────────────────────────────
    // Twee verzamelingen, en allebei zijn ze nodig:
    //   · alle toekomstige scheduled calls — daar komen nieuwe kaarten uit;
    //   · de afspraken achter de OPEN kaarten — die kunnen intussen
    //     geannuleerd, verzet of voorbij zijn, en dan moet de kaart dicht.
    // Zonder die tweede lezing zou een kaart van een geannuleerde call blijven
    // staan, en dan belt Dave over iets wat niet meer bestaat.
    const afspraken = await leesToekomstigeAfspraken(startedAt);
    const bekend = new Set(afspraken.map((a) => String(a.id)));
    const openIds = kaarten
      .filter((k) => String(k.status || '') !== 'gearchiveerd')
      .map((k) => k.bron_ref && k.bron_ref.appointment_id)
      .filter(Boolean).map(String)
      .filter((id) => !bekend.has(id));
    if (openIds.length) afspraken.push(...await leesAfsprakenOpId(openIds));
    summary.afspraken = afspraken.length;

    // ── De beslissing per afspraak ──────────────────────────────────────
    const teMaken = [];
    for (const a of afspraken) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'afgebroken voor het einde' });
        break;
      }
      try {
        const taak = kaartPerAfspraak.get(String(a.id)) || null;
        const besluit = bepaalOpwarmActie({ afspraak: a, taak, nu: Date.now() });

        if (besluit.actie === 'niets') {
          if (besluit.reden) {
            summary.overgeslagen[besluit.reden] = (summary.overgeslagen[besluit.reden] || 0) + 1;
          }
          continue;
        }
        if (besluit.actie === 'aanmaken') { teMaken.push({ afspraak: a, besluit }); continue; }
        if (besluit.actie === 'bijwerken') {
          await werkBij(taak, besluit);
          summary.bijgewerkt += 1;
          continue;
        }
        // sluiten
        await sluit(taak, besluit);
        summary.gesloten += 1;
        summary.gesloten_reden[besluit.archief_reden] =
          (summary.gesloten_reden[besluit.archief_reden] || 0) + 1;
      } catch (e) {
        // Per afspraak vangen: één rij die weigert mag de rest niet laten
        // liggen. De CHECK-constraint op `reden` is de meest waarschijnlijke
        // oorzaak zolang de migratie niet gedraaid is, en die fout hoort per
        // rij zichtbaar te zijn en niet als één stille nul.
        summary.errors.push({ appointment_id: a.id, error: e?.message || String(e) });
        console.error('[cron-opvolging-zoom-opwarm] afspraak faalde', a.id, e?.message || e);
      }
    }

    // ── De dripfeed ─────────────────────────────────────────────────────
    summary.kandidaten = teMaken.length;
    const keuze = kiesInstroom({
      kandidaten: teMaken.map((x) => ({
        id: x.afspraak.id, scheduled_at: x.afspraak.scheduled_at, vers: x.besluit.vers, x,
      })),
      alGemaaktVandaag: summary.achterstand_vandaag_al,
    });
    summary.wachtrij = keuze.wachtrij.length;

    for (const k of keuze.nu) {
      try {
        await maakKaart({ afspraak: k.x.afspraak, besluit: k.x.besluit });
        summary.aangemaakt += 1;
        if (k.x.besluit.vers) summary.aangemaakt_vers += 1;
      } catch (e) {
        summary.errors.push({ appointment_id: k.id, error: e?.message || String(e) });
        console.error('[cron-opvolging-zoom-opwarm] kaart faalde', k.id, e?.message || e);
      }
    }

    // DE WACHTRIJ HOORT IN HET LOG. Zonder dit getal is 'er kwamen er vandaag
    // tien bij' niet te onderscheiden van 'er waren er tien', en weet niemand
    // wanneer de achterstand weg is.
    if (summary.wachtrij > 0) {
      console.log('[cron-opvolging-zoom-opwarm] ' + summary.wachtrij
        + ' afspraak(en) wachten nog op een opwarmkaart (dagquota '
        + MAX_ACHTERSTAND_PER_DAG + ', vandaag al ' + summary.achterstand_vandaag_al
        + ' uit de achterstand). Eerstvolgende: '
        + keuze.wachtrij.slice(0, 3).map((k) => k.scheduled_at).join(', '));
    }
  } catch (e) {
    console.error('[cron-opvolging-zoom-opwarm] fataal:', e?.message || e);
    summary.errors.push({ phase: 'fataal', error: e?.message || String(e) });
    summary.duration_ms = Date.now() - startedAt;
    return res.status(500).json({ ok: false, summary });
  }

  summary.duration_ms = Date.now() - startedAt;
  console.log('[cron-opvolging-zoom-opwarm] klaar', JSON.stringify(summary));
  return res.status(200).json({ ok: true, summary });
}

/** Alle opwarmkaarten, elke status. Zie de opmerking bij de aanroep. */
async function leesKaarten() {
  const { data, error } = await supabaseAdmin
    .from('opvolging_taken')
    .select('id, status, due, notitie, badge_label, bron_ref, created_at')
    .eq('reden', REDEN)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (error) throw new Error('kaarten lezen: ' + error.message);
  return data || [];
}

/** De geboekte zoomcalls die nog moeten komen. */
async function leesToekomstigeAfspraken(nuMs) {
  const totIso = new Date(nuMs + VOORUIT_DAGEN * 86400000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, is_test, created_at')
    .eq('status', 'scheduled')
    .gt('scheduled_at', new Date(nuMs).toISOString())
    .lt('scheduled_at', totIso)
    .not('lead_phone', 'is', null)
    .order('scheduled_at', { ascending: true })
    .limit(500);
  if (error) throw new Error('afspraken lezen: ' + error.message);
  return (data || []).filter((a) => a && a.is_test !== true);
}

/** De afspraken achter de open kaarten, ongeacht status of moment. */
async function leesAfsprakenOpId(ids) {
  const { data, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, is_test, created_at')
    .in('id', ids.slice(0, 500));
  if (error) throw new Error('afspraken op id lezen: ' + error.message);
  return data || [];
}

/**
 * De kaart. Zelfde veldenset als api/opvolging-taak-create.js schrijft — dat
 * endpoint is de gewone weg en deze cron mag daar niet van afwijken, anders
 * leest de kaart in de werklijst anders dan een die Dave zelf maakte.
 */
async function maakKaart({ afspraak, besluit }) {
  const { error } = await supabaseAdmin.from('opvolging_taken').insert({
    naam       : (afspraak.lead_name && String(afspraak.lead_name).trim()) || 'Naamloos',
    email      : afspraak.lead_email || null,
    telefoon   : afspraak.lead_phone || null,
    reden      : REDEN,
    reden_code : null,
    bron       : 'call',
    bron_ref   : {
      appointment_id: afspraak.id,
      start         : afspraak.scheduled_at,
      soort         : SOORT,
      source        : SOURCE,
      // Zonder dit merkteken is een kaart uit de achterstand niet van gewone
      // instroom te onderscheiden, en telt de dagquota morgen de verkeerde
      // kaarten mee.
      ...(besluit.vers ? {} : { achterstand: true }),
    },
    badge_label: besluit.badge_label,
    due        : besluit.due,
    later      : false,
    status     : 'open',
    notitie    : besluit.notitie,
    is_test    : afspraak.is_test === true,
    eigenaar_id: null,
  });
  if (error) throw new Error('kaart aanmaken: ' + error.message);
}

/** Het moment is verschoven: etiket en notitie bij, kaart blijft staan. */
async function werkBij(taak, besluit) {
  const { error } = await supabaseAdmin.from('opvolging_taken').update({
    badge_label: besluit.badge_label,
    due        : besluit.due,
    later      : false,
    bron_ref   : { ...(taak.bron_ref || {}), start: besluit.start },
    notitie    : notitieMetRegel(taak.notitie, besluit.regel),
    updated_at : new Date().toISOString(),
  }).eq('id', taak.id).eq('status', 'open');
  if (error) throw new Error('bijwerken: ' + error.message);
}

/** De kaart is zijn reden kwijt. */
async function sluit(taak, besluit) {
  const { error } = await supabaseAdmin.from('opvolging_taken').update({
    status         : 'gearchiveerd',
    archief_reden  : besluit.archief_reden,
    gearchiveerd_at: new Date().toISOString(),
    notitie        : notitieMetRegel(taak.notitie, besluit.regel),
    updated_at     : new Date().toISOString(),
  }).eq('id', taak.id).neq('status', 'gearchiveerd');
  if (error) throw new Error('sluiten: ' + error.message);
}

/** Nieuwe regel bovenaan, bestaande notitie eronder. Nooit overschrijven. */
function notitieMetRegel(bestaand, regel) {
  const oud = String(bestaand || '').trim();
  if (!regel) return oud || null;
  if (oud.includes(regel)) return oud;
  return oud ? `${regel}\n\n${oud}` : regel;
}
