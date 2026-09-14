// api/opvolging-zoom-actie.js
//
// DE VIER UITGANGEN VAN EEN OPWARMKAART.
//
// De kaart komt uit cron-opvolging-zoom-opwarm: 'deze zoomcall is geboekt, bel
// om te bevestigen'. Dat gesprek kent vier afloopen, en tot nu toe had de
// werklijst er geen enkele van — de bestaande 'Wat nu?' gaat over een lead die
// je niet te pakken krijgt, niet over een afspraak die al staat.
//
// POST { taak_id, actie, notitie?, start? }
//   'bevestigd'     — hij komt. Kaart dicht, en komt NIET terug. Eén ronde,
//                     bewust: de calldag zelf is al gedekt door het
//                     spraakbericht van 09:00 en de nabelronde van 12:00.
//   'gesprek_gehad' — notitie verplicht. Er is contact geweest, kaart klaar.
//   'verplaatsen'   — start verplicht. De call verhuist via dezelfde motor als
//                     de cockpit (_lib/verzet-afspraak.js): GHL blokkerend
//                     eerst, oude rij op 'verplaatst', nieuwe rij met
//                     parent_appointment_id. Onze kaart gaat dicht; de cron
//                     maakt vanzelf een nieuwe op de nieuwe afspraakrij.
//   'annuleren'     — de call gaat niet door en er komt niets voor in de
//                     plaats. Loopt via api/follow-up-annuleer.js, dus GHL
//                     eerst en dan pas de databank.
//
// ── WAAROM 'annuleren' NIET ZIJN EIGEN ANNULEERCODE KRIJGT ───────────────
// Annuleren is GHL-cancel + statuswissel + auditregel + het bericht naar de
// lead. Dat staat compleet in api/follow-up-annuleer.js, en een tweede kopie
// hier zou bij elke wijziging aan de GHL-vorm uit elkaar lopen — precies
// lesson 17 (lib + endpoint splitsing). Dat bestand exporteert alleen zijn
// handler, en dat bestand mag in deze PR niet gewijzigd worden.
//
// Dus roepen we die handler IN HETZELFDE PROCES aan, met de echte headers van
// deze aanvraag en een minimale res die het antwoord opvangt. Uitdrukkelijk
// GEEN self-call over HTTP: een fetch van de ene Vercel-functie naar de andere
// binnen dezelfde deployment is in deze repo een gedocumenteerd anti-pattern
// (zie de kop van api/_lib/joost-suggest-core.js) en faalde structureel met
// `TypeError: fetch failed`.
//
// ── HET MERKTEKEN BIJ ANNULEREN ─────────────────────────────────────────
// Iemand die zelf via de link afzegt hoort terug in de lijst met 'plan hem
// opnieuw in' — dat doet cron-opvolging-annuleringen. Maar Dave heeft deze
// persoon net aan de lijn gehad; die kaart zou hem laten bellen over iets wat
// hij zojuist zelf besproken heeft. Onze kaart blijft daarom staan met
// `bron_ref.appointment_id` van precies die afspraak, en die cron slaat een
// afspraak over zodra er een kaart uit die afspraak bestaat — in élke status.
// `geannuleerd_na_gesprek: true` zegt in de data waaróm dat hier de bedoeling
// is; tests/opvolging-zoom-actie.test.js legt het mechanisme vast.
//
// Schrijft in opvolging_taken en opvolging_pogingen, en via de twee motoren in
// follow_up_appointments + follow_up_events_log. Geen bestaand endpoint
// gewijzigd.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { REDEN } from './_lib/opvolging-zoom-opwarm.js';
import {
  verzetAfspraak, verzetBlokkade, mapGhlError as mapVerzetGhlError, VERZET_DUUR_MIN,
} from './_lib/verzet-afspraak.js';
import annuleerHandler from './follow-up-annuleer.js';

export const ACTIES = new Set(['bevestigd', 'gesprek_gehad', 'verplaatsen', 'annuleren']);

/** De archiefredenen. Kort genoeg voor de kolom, leesbaar in het archief. */
export const ARCHIEF = {
  bevestigd    : 'bevestigd',
  gesprek_gehad: 'gesprek gehad',
  verplaatsen  : 'call verzet na bevestigingsgesprek',
  annuleren    : 'afspraak geannuleerd na gesprek',
};

const ZONE = 'Europe/Amsterdam';
const dagInZone = (ms) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'opvolging.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });
  }
  // Dit endpoint IS het afronden van een opwarmkaart — dezelfde sleutel als
  // bij de andere taak-mutaties.
  if (!(await requirePermission(req, 'opvolging.taak.afronden'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.taak.afronden)' });
  }

  const b = req.body || {};
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });
  const actie = String(b.actie || '');
  if (!ACTIES.has(actie)) return res.status(400).json({ error: 'onbekende actie' });

  const notitie = b.notitie != null ? String(b.notitie).trim().slice(0, 2000) : '';
  // Zonder die zin is 'gesprek gehad' een vinkje zonder inhoud, en weet de
  // volgende die deze lead oppakt nog steeds niets.
  if (actie === 'gesprek_gehad' && !notitie) {
    return res.status(400).json({ error: 'notitie is verplicht bij een gesprek' });
  }

  // Verzetten boekt een moment in de agenda. Zelfde extra sleutel als de POST
  // op api/opvolging-agenda.js daarvoor vraagt.
  if (actie === 'verplaatsen' && !(await requirePermission(req, 'opvolging.agenda.boeken'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.agenda.boeken)' });
  }

  try {
    const { data: taak, error: leesErr } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).maybeSingle();
    if (leesErr) throw new Error(leesErr.message);
    if (!taak) return res.status(404).json({ error: 'Taak niet gevonden' });

    // De uitgangen hieronder gaan over een GEBOEKTE afspraak. Op een gewone
    // werklijstkaart hoort 'Wat nu?' en niet dit venster.
    if (String(taak.reden || '') !== REDEN) {
      return res.status(400).json({
        error: 'Deze uitgang hoort bij een opwarmkaart voor een geboekte zoomcall.',
      });
    }
    if (String(taak.status || '') === 'gearchiveerd') {
      return res.status(409).json({ error: 'Deze kaart is al afgerond.' });
    }

    const nu = new Date().toISOString();
    const vandaag = dagInZone(Date.now());
    const appointmentId = (taak.bron_ref && taak.bron_ref.appointment_id) || null;

    // ── Bevestigd ────────────────────────────────────────────────────────
    // Eén ronde, en dat is een keuze. Bij een aanmeldkaart schuift 'bevestigd'
    // de kaart door naar vier dagen voor het event; hier gaat hij dicht en
    // komt hij NIET terug. De calldag zelf is al gedekt.
    if (actie === 'bevestigd') {
      // De poging eerst: dit ís contact geweest, en daar hangt 'klaar voor
      // vandaag' aan. Resultaat begint met 'gesproken' zodat isContact() 'm
      // herkent — zelfde afspraak als bij de aanmeldkaart.
      await schrijfPoging(taak.id, `gesproken: bevestigd${notitie ? ' — ' + notitie : ''}`);
      await sluitKaart(taak, {
        archief_reden: ARCHIEF.bevestigd,
        regel: `${vandaag} · Bevestigd dat de zoomcall doorgaat.${notitie ? ' ' + notitie : ''}`,
        nu,
      });
      return res.status(200).json({ success: true, gearchiveerd: true });
    }

    // ── Gesprek gehad ────────────────────────────────────────────────────
    if (actie === 'gesprek_gehad') {
      await schrijfPoging(taak.id, `gesproken: ${notitie}`);
      await sluitKaart(taak, {
        archief_reden: ARCHIEF.gesprek_gehad,
        regel: `${vandaag} · ${notitie}`,
        nu,
      });
      return res.status(200).json({ success: true, gearchiveerd: true });
    }

    // Vanaf hier raken we de afspraak zelf aan, en dan moet die er zijn.
    if (!appointmentId) {
      return res.status(400).json({
        error: 'Deze kaart hangt niet aan een afspraak, dus er valt niets te verzetten of te annuleren.',
      });
    }

    if (actie === 'verplaatsen') {
      return await verplaats({ req, res, taak, appointmentId, b, nu, vandaag, notitie });
    }
    return await annuleer({ req, res, taak, appointmentId, nu, vandaag, notitie });
  } catch (e) {
    console.error('[opvolging-zoom-actie]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VERPLAATSEN — dezelfde motor als de cockpit
// ═══════════════════════════════════════════════════════════════════════════
//
// GEEN SPOOKAFSPRAAK. verzetAfspraak() verzet de BESTAANDE GHL-afspraak in
// plaats van hem te annuleren en opnieuw te boeken; anders blijft er een
// afspraak op het oude uur in Daves agenda staan. GHL is blokkerend-eerst:
// faalt die, dan verandert er hier niets en blijft de kaart gewoon staan.
async function verplaats({ req, res, taak, appointmentId, b, nu, vandaag, notitie }) {
  const start = new Date(String(b.start || ''));
  if (!Number.isFinite(start.getTime())) {
    return res.status(400).json({ error: 'start ontbreekt of is geen geldig moment' });
  }
  if (start.getTime() < Date.now() - 60 * 1000) {
    return res.status(400).json({ error: 'Dat moment ligt in het verleden.' });
  }

  const { data: afspraak, error } = await supabaseAdmin
    .from('follow_up_appointments').select('*').eq('id', appointmentId).maybeSingle();
  if (error) throw new Error('afspraak lezen: ' + error.message);
  if (!afspraak) return res.status(404).json({ error: 'Afspraak niet gevonden' });

  // Niet elke status is te verzetten, en de reden hoort leesbaar te zijn —
  // 'er ging iets mis' laat Dave gokken wat hij nu moet doen.
  const blokkade = verzetBlokkade(afspraak);
  if (blokkade) return res.status(409).json({ error: blokkade });

  let uit;
  try {
    uit = await verzetAfspraak({
      supabaseAdmin,
      afspraak,
      nieuwStartIso: start.toISOString(),
      duurMinuten  : afspraak.duration_minutes || VERZET_DUUR_MIN,
      doorUserId   : null,
      bron         : 'opvolging-opwarm',
    });
  } catch (e) {
    if (e?.code === 'GHL_UPDATE') {
      console.error('[opvolging-zoom-actie] verzet GHL:', e.ghlStatus, e.ghlBody);
      return res.status(422).json({ error: mapVerzetGhlError(e.ghlStatus, e.ghlBody), ghl_status: e.ghlStatus });
    }
    console.error('[opvolging-zoom-actie] verzet:', e?.code || '', e?.message || e);
    return res.status(500).json({
      error: 'Verzetten is niet gelukt. De afspraak staat nog op zijn oude moment; probeer het opnieuw.',
    });
  }

  // Pas NA een geslaagde verzetting. Andersom zou een mislukte GHL-call een
  // kaart sluiten waarvan de opdracht nog gewoon openstaat.
  await schrijfPoging(taak.id, `gesproken: call verzet${notitie ? ' — ' + notitie : ''}`);
  await sluitKaart(taak, {
    archief_reden: ARCHIEF.verplaatsen,
    regel: `${vandaag} · Call verzet naar ${uit.nieuweAfspraak.scheduled_at}. `
      + 'Voor de nieuwe afspraak komt er vanzelf een nieuwe opwarmkaart.'
      + (notitie ? ` ${notitie}` : ''),
    nu,
  });

  return res.status(200).json({
    success: true,
    gearchiveerd: true,
    verzet: {
      appointment_id      : afspraak.id,
      nieuw_appointment_id: uit.nieuweAfspraak.id,
      van                 : afspraak.scheduled_at,
      naar                : uit.nieuweAfspraak.scheduled_at,
      ghl_bijgewerkt      : uit.ghlBijgewerkt,
      zoom_bijgewerkt     : uit.zoomBijgewerkt,
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ANNULEREN — via api/follow-up-annuleer.js, in hetzelfde proces
// ═══════════════════════════════════════════════════════════════════════════
async function annuleer({ req, res, taak, appointmentId, nu, vandaag, notitie }) {
  const uit = await roepAnnuleerAan(req, { appointment_id: appointmentId, reden: notitie || undefined });

  if (uit.status !== 200 || !(uit.body && uit.body.success)) {
    // De letterlijke melding van het annuleer-endpoint doorgeven: die zegt
    // precies wat er aan de hand is ('Kan alleen scheduled annuleren',
    // 'GHL is tijdelijk niet beschikbaar'). Onze kaart blijft staan — de
    // opdracht is immers niet uitgevoerd.
    const melding = (uit.body && (uit.body.error || uit.body.message))
      || 'Annuleren is niet gelukt. De afspraak staat er nog; probeer het opnieuw.';
    console.error('[opvolging-zoom-actie] annuleren faalde:', uit.status, melding);
    return res.status(uit.status >= 400 && uit.status < 600 ? uit.status : 500).json({ error: melding });
  }

  await schrijfPoging(taak.id, `gesproken: afspraak geannuleerd${notitie ? ' — ' + notitie : ''}`);
  await sluitKaart(taak, {
    archief_reden: ARCHIEF.annuleren,
    regel: `${vandaag} · Zoomcall geannuleerd na het bevestigingsgesprek.`
      + (notitie ? ` Reden: ${notitie}` : '')
      + ' Er komt geen opnieuw-inplannen-kaart: dit is besproken, geen stille afzegging.',
    nu,
    // Het merkteken. Zie de kop van dit bestand.
    bron_ref: { ...(taak.bron_ref || {}), geannuleerd_na_gesprek: true },
  });

  return res.status(200).json({ success: true, gearchiveerd: true, ghl_cancelled: !!uit.body.ghl_cancelled });
}

/**
 * De handler van api/follow-up-annuleer.js aanroepen alsof er een POST
 * binnenkwam — met de echte headers van deze aanvraag, zodat zijn eigen
 * auth- en rechtencontrole gewoon draait.
 *
 * Minimale res: alleen wat die handler aanraakt (setHeader / status / json).
 * Zou hij ooit meer gaan gebruiken, dan valt dat hier op als een TypeError in
 * het log en niet als een stil verkeerd antwoord.
 */
async function roepAnnuleerAan(req, body) {
  const opgevangen = { status: 500, body: null };
  const nepRes = {
    statusCode: 200,
    setHeader() {},
    status(code) { opgevangen.status = code; this.statusCode = code; return this; },
    json(payload) { opgevangen.body = payload; return this; },
    end() { return this; },
  };
  try {
    await annuleerHandler({ method: 'POST', headers: req.headers || {}, body }, nepRes);
  } catch (e) {
    console.error('[opvolging-zoom-actie] annuleer-handler gooide:', e?.message || e);
    return { status: 500, body: { error: 'Annuleren is niet gelukt: ' + (e?.message || 'onbekende fout') } };
  }
  return opgevangen;
}

// ═══════════════════════════════════════════════════════════════════════════
// GEDEELD
// ═══════════════════════════════════════════════════════════════════════════

/** De kaart dicht. Nooit een bestaande notitie overschrijven. */
async function sluitKaart(taak, { archief_reden, regel, nu, bron_ref }) {
  const patch = {
    status         : 'gearchiveerd',
    archief_reden,
    gearchiveerd_at: nu,
    notitie        : voegRegelToe(taak.notitie, regel),
    updated_at     : nu,
  };
  if (bron_ref) patch.bron_ref = bron_ref;
  const { error } = await supabaseAdmin.from('opvolging_taken')
    .update(patch).eq('id', taak.id).neq('status', 'gearchiveerd');
  if (error) throw new Error('kaart sluiten: ' + error.message);
}

/**
 * De belpoging. Fail-soft: de actie is de actie, de poging is de historiek.
 *
 * Resultaat begint altijd met 'gesproken', zodat isContact() in
 * _lib/opvolging-poging-telling.js hem als echt contact telt. Alle vier de
 * uitgangen veronderstellen dat Dave deze persoon aan de lijn had — dat is
 * precies wat een opwarmkaart vraagt.
 */
async function schrijfPoging(taakId, resultaat) {
  try {
    const { error } = await supabaseAdmin.from('opvolging_pogingen')
      .insert({ taak_id: taakId, soort: 'call', resultaat: String(resultaat).slice(0, 200), automatisch: false });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[opvolging-zoom-actie] poging (soft):', e?.message || e);
  }
}

/** Nieuwe regel bovenaan, bestaande notitie eronder. Nooit overschrijven. */
function voegRegelToe(bestaand, regel) {
  const oud = String(bestaand || '').trim();
  return oud ? `${regel}\n\n${oud}` : regel;
}
