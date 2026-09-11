// api/cron-opvolging-annuleringen.js
//
// EEN GEANNULEERDE ZOOMCALL ZONDER NIEUWE AFSPRAAK WORDT WERK.
//
// Maxims regel: is een zoomcall geannuleerd en heeft de lead niet zelf opnieuw
// ingepland, dan hoort hij in Daves werklijst om opnieuw in te plannen. Tot nu
// toe gebeurde er niets — de call stond doorgestreept in de agenda en daarmee
// was het klaar.
//
// Gemeten op 11 september: drie geannuleerde calls van die dag, geen van drieën
// met een nieuwe afspraak, geen van drieën met een opvolgtaak.
//
// ── WAAROM EEN CRON EN GEEN HOOK IN DE ENDPOINTS ────────────────────────
// Een annulering komt via DRIE wegen binnen: api/public-afspraak-annuleren.js
// (de lead klikt zelf op de link), api/follow-up-annuleer-call.js (wij zeggen
// af) en de GHL-poll (het gebeurde in de agenda van GHL). Een hook per weg is
// drie keer hetzelfde bouwen en drie keer kunnen vergeten — en bij een vierde
// weg, die er ooit bijkomt, is het stil.
//
// Deze cron kijkt naar de DATA. Wat er ook geannuleerd heeft, het staat als
// `status = 'cancelled'` in follow_up_appointments, en daar begint dit.
//
// ── WAT HET NIET DOET ────────────────────────────────────────────────────
// Niets naar GHL, geen berichten, geen uitkomsten. Alleen kaarten aanmaken
// langs hetzelfde pad als api/opvolging-taak-create.js, en kaarten sluiten die
// hun reden verloren hebben.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth), zelfde patroon als
// de andere opvolging-crons. GET (Vercel cron) + POST (debug).
//
// Schrijft uitsluitend in opvolging_taken.

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import {
  ANNULERING_VANAF, HERBOEKT_STATUSSEN, REDEN_ZELF,
  annuleerBron, bouwNotitie, bouwBadge, bouwNotitieRegel,
  slaOver, heeftHerboekt, leadAlAfgesloten, momentVan,
} from './_lib/opvolging-annulering.js';

const ZONE = 'Europe/Amsterdam';
const LOPEND = ['open', 'wacht_inplanning'];
/** De reden op de kaart. Nieuw, dus de CHECK-constraint moet mee — zie de migratie. */
const REDEN = 'zoom_geannuleerd';

const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

const cijfers = (s) => {
  const c = String(s == null ? '' : s).replace(/\D/g, '');
  if (!c) return null;
  return c.startsWith('00') ? (c.slice(2) || null) : c;
};

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
    dag: vandaag, bekeken: 0, aangemaakt: 0, gesloten: 0,
    overgeslagen: {
      is_test: 0, uitkomst_al_vastgelegd: 0, geen_nummer: 0, geen_moment: 0,
      voor_de_grens: 0, herboekt: 0, lead_al_afgesloten: 0,
      kaart_bestaat_al: 0, kaart_op_nummer: 0,
    },
    notitie_toegevoegd: 0,
    gesloten_reden: { zelf_opnieuw_ingepland: 0, lead_al_afgesloten: 0 },
    per_reden: {}, errors: [], duration_ms: 0,
  };

  try {
    // ── ALLE AFSPRAKEN VANAF DE GRENS ───────────────────────────────────
    // In één lezing, want we hebben ze twee keer nodig: de geannuleerde om
    // over te oordelen, en álle statussen om te zien of er herboekt is.
    const vanIso = new Date(Date.parse(ANNULERING_VANAF + 'T00:00:00Z') - 3 * 3600 * 1000).toISOString();
    const afspraken = await leesAfspraken(vanIso);
    const geannuleerd = afspraken.filter((a) => String(a.status || '').toLowerCase() === 'cancelled');
    summary.bekeken = geannuleerd.length;

    // De lopende kaarten, één keer gelezen. Binnen de run houden we de lijst
    // bij zodat twee annuleringen voor dezelfde lead niet twee kaarten geven.
    const kaarten = await leesKaarten();

    for (const a of geannuleerd) {
      try {
        const reden = slaOver(a);
        if (reden) { summary.overgeslagen[reden] = (summary.overgeslagen[reden] || 0) + 1; continue; }

        // (a) Heeft hij zelf opnieuw ingepland? Dan is er geen werk.
        if (heeftHerboekt(a, afspraken)) { summary.overgeslagen.herboekt += 1; continue; }

        // (a2) Is deze lead al afgesloten? Dan is 'plan hem opnieuw in' geen
        //      opdracht maar een blunder. Dit staat VOOR de kaart-controles
        //      hieronder, zodat een kaart die er ten onrechte al staat deze
        //      overslaan-reden niet wegdrukt naar `kaart_bestaat_al`.
        if (leadAlAfgesloten(a, afspraken, kaarten)) {
          summary.overgeslagen.lead_al_afgesloten += 1;
          continue;
        }

        // (b) Bestaat er al een kaart uit precies deze afspraak? Alle statussen:
        //     een gearchiveerde kaart betekent dat het al is afgehandeld, en
        //     die opnieuw maken zou het werk laten terugkomen.
        if (kaarten.some((k) => k.bron_ref && String(k.bron_ref.appointment_id || '') === String(a.id))) {
          summary.overgeslagen.kaart_bestaat_al += 1;
          continue;
        }

        // (c) Staat deze lead al op de lijst om een andere reden? Dan geen
        //     tweede kaart, maar wel de mededeling — anders belt Dave hem over
        //     iets anders en hoort hij pas tijdens het gesprek dat de call weg
        //     is.
        const bestaande = kaartOpNummer(kaarten, a.lead_phone);
        if (bestaande) {
          const gelukt = await voegNotitieToe(bestaande, bouwNotitieRegel(a, vandaag));
          summary.overgeslagen.kaart_op_nummer += 1;
          if (gelukt) summary.notitie_toegevoegd += 1;
          continue;
        }

        const kaart = await maakKaart({ afspraak: a, vandaag });
        // Meteen bij de lijst: een tweede annulering voor dezelfde lead in
        // dezelfde run valt nu onder (c) in plaats van een tweede kaart.
        kaarten.push(kaart);
        summary.aangemaakt += 1;
        const bron = annuleerBron(a);
        summary.per_reden[bron] = (summary.per_reden[bron] || 0) + 1;
      } catch (e) {
        // Per afspraak vangen. De CHECK-constraint is de meest waarschijnlijke
        // oorzaak zolang de migratie niet gedraaid is; die fout hoort per rij
        // zichtbaar te zijn en niet als één stille nul.
        summary.errors.push({ appointment_id: a.id, error: e?.message || String(e) });
        console.error('[cron-opvolging-annuleringen] kaart faalde', a.id, e?.message || e);
      }
    }

    // ── DE KAART SLUIT ZICHZELF ─────────────────────────────────────────
    const dicht = await sluitVervallenKaarten(kaarten, afspraken);
    summary.gesloten = dicht.zelf_opnieuw_ingepland + dicht.lead_al_afgesloten;
    summary.gesloten_reden = dicht;
  } catch (e) {
    console.error('[cron-opvolging-annuleringen] fataal:', e?.message || e);
    summary.errors.push({ phase: 'fataal', error: e?.message || String(e) });
    summary.duration_ms = Date.now() - startedAt;
    return res.status(500).json({ ok: false, summary });
  }

  summary.duration_ms = Date.now() - startedAt;
  console.log('[cron-opvolging-annuleringen] klaar', JSON.stringify(summary));
  return res.status(200).json({ ok: true, summary });
}

/** Alle afspraken vanaf de grens — geannuleerd én de rest, voor de herboek-vraag. */
async function leesAfspraken(vanIso) {
  const { data, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, lead_ghl_contact_id, scheduled_at, status, '
          + 'uitkomst, is_test, annulering_reden, annulering_reden_code, annulering_sent_at')
    .gte('scheduled_at', vanIso)
    .order('scheduled_at', { ascending: true })
    .limit(1000);
  if (error) throw new Error('afspraken lezen: ' + error.message);
  return data || [];
}

/** De kaarten die meetellen: lopend, plus alles wat uit een afspraak is ontstaan. */
async function leesKaarten() {
  const { data, error } = await supabaseAdmin
    .from('opvolging_taken')
    // archief_reden hoort erbij: leadAlAfgesloten() leest hem om een
    // gearchiveerde 'geen interesse'-kaart te herkennen.
    .select('id, naam, telefoon, status, reden, reden_code, archief_reden, notitie, bron_ref')
    .order('updated_at', { ascending: false })
    .limit(2000);
  if (error) throw new Error('taken lezen: ' + error.message);
  return data || [];
}

/**
 * Een lopende kaart op dit nummer. Zelfde match als zoekTaak in de webhook:
 * eerst exact, dan de laatste negen cijfers.
 */
function kaartOpNummer(kaarten, telefoon) {
  const doel = cijfers(telefoon);
  if (!doel) return null;
  const staart = doel.length >= 9 ? doel.slice(-9) : null;
  for (const k of kaarten) {
    if (!LOPEND.includes(String(k.status || ''))) continue;
    const c = cijfers(k.telefoon);
    if (!c) continue;
    if (c === doel) return k;
    if (staart && c.length >= 9 && c.slice(-9) === staart) return k;
  }
  return null;
}

/** Fail-soft: de mededeling is waardevol, maar niet ten koste van de run. */
async function voegNotitieToe(kaart, regel) {
  try {
    const oud = String(kaart.notitie || '').trim();
    // Twee runs mogen niet twee keer dezelfde regel opleveren.
    if (oud.includes(regel)) return false;
    const nieuw = oud ? `${regel}\n\n${oud}` : regel;
    const { error } = await supabaseAdmin.from('opvolging_taken')
      .update({ notitie: nieuw, updated_at: new Date().toISOString() })
      .eq('id', kaart.id);
    if (error) throw new Error(error.message);
    kaart.notitie = nieuw;
    return true;
  } catch (e) {
    console.warn('[cron-opvolging-annuleringen] notitie (soft):', e?.message || e);
    return false;
  }
}

/**
 * De kaart. Zelfde velden als api/opvolging-taak-create.js schrijft — dat
 * endpoint is de gewone weg en deze cron mag daar niet van afwijken, anders
 * leest de kaart in de werklijst anders dan een die Dave zelf maakte.
 */
async function maakKaart({ afspraak, vandaag }) {
  const rij = {
    naam       : (afspraak.lead_name && String(afspraak.lead_name).trim()) || 'Naamloos',
    email      : afspraak.lead_email || null,
    telefoon   : afspraak.lead_phone || null,
    reden      : REDEN,
    reden_code : annuleerBron(afspraak),
    bron       : 'call',
    bron_ref   : {
      appointment_id        : afspraak.id,
      start                 : afspraak.scheduled_at,
      soort                 : 'zoom_geannuleerd',
      annulering_reden_code : afspraak.annulering_reden_code || null,
    },
    badge_label: bouwBadge(afspraak),
    due        : vandaag,
    later      : false,
    status     : 'open',
    notitie    : bouwNotitie(afspraak),
    is_test    : afspraak.is_test === true,
    eigenaar_id: null,
  };
  const { data, error } = await supabaseAdmin
    .from('opvolging_taken')
    .insert(rij).select('id, naam, telefoon, status, reden, reden_code, archief_reden, notitie, bron_ref').single();
  if (error) throw new Error('kaart aanmaken: ' + error.message);
  return data;
}

/**
 * SLUIT DE KAARTEN WAARVAN DE REDEN IS VERVALLEN.
 *
 * Twee manieren waarop 'plan hem opnieuw in' geen opdracht meer is:
 *
 *  1. De lead boekt alsnog zelf een nieuwe call. Dan is het al geregeld en
 *     zou Dave iemand bellen over iets wat al staat.
 *  2. De lead blijkt afgesloten — 'geen interesse', 'niet geschikt' of juist
 *     klant geworden. Dat is de ergere van de twee: dan belt Dave iemand op
 *     die net heeft gezegd dat hij niet meer wil, om een nieuwe afspraak te
 *     maken. Precies de valse kaart van 11 september (Jeffrey Biemold).
 *
 * De tweede reden kan ook NA het aanmaken waar worden — Dave legt de uitkomst
 * vast op een andere afspraak, de kaart staat er al. Vandaar dat dit een
 * sluitregel is en niet alleen een overslaan-regel.
 *
 * Alleen ONZE eigen kaarten (reden zoom_geannuleerd) en alleen als ze open
 * staan. Fail-soft per kaart.
 */
async function sluitVervallenKaarten(kaarten, afspraken) {
  const geteld = { zelf_opnieuw_ingepland: 0, lead_al_afgesloten: 0 };
  const open = kaarten.filter((k) => String(k.status || '') === 'open' && String(k.reden || '') === REDEN);
  for (const k of open) {
    const aid = k.bron_ref && k.bron_ref.appointment_id;
    const bron = afspraken.find((a) => String(a.id) === String(aid));
    if (!bron) continue;

    let sleutel = null;
    let tekst = null;
    if (heeftHerboekt(bron, afspraken)) {
      sleutel = 'zelf_opnieuw_ingepland';
      tekst   = 'zelf opnieuw ingepland';
    } else if (leadAlAfgesloten(bron, afspraken, kaarten)) {
      sleutel = 'lead_al_afgesloten';
      tekst   = 'lead al afgesloten (geen interesse / klant)';
    } else {
      continue;
    }

    try {
      const { error } = await supabaseAdmin.from('opvolging_taken').update({
        status         : 'gearchiveerd',
        archief_reden  : tekst,
        gearchiveerd_at: new Date().toISOString(),
        updated_at     : new Date().toISOString(),
      }).eq('id', k.id).eq('status', 'open');
      if (error) throw new Error(error.message);
      k.status        = 'gearchiveerd';
      k.archief_reden = tekst;
      geteld[sleutel] += 1;
    } catch (e) {
      console.warn('[cron-opvolging-annuleringen] kaart sluiten (soft):', e?.message || e);
    }
  }
  return geteld;
}

export { REDEN, HERBOEKT_STATUSSEN, ANNULERING_VANAF, REDEN_ZELF, momentVan };
