// api/opvolging-aanmelding-actie.js
//
// De uitgangen van een aanmeldkaart, plus de knop die de deelnemer meteen in de
// eventmodule op geannuleerd zet.
//
// POST { taak_id, actie, notitie? }
//   'bevestigd'           — de lead komt. Notitie mag leeg. Slaapt tot vier
//                           dagen voor het event, of gaat dicht als die dag al
//                           geweest is — zie hieronder.
//   'gesprek_gehad'       — notitie verplicht. Er is echt contact geweest, dus
//                           de kaart is klaar.
//   'geen_interesse'      — archiveren. Antwoord bevat vraag_annuleren=true.
//   'verplaatst'          — naar 'wacht_verplaatsing'; de 48-uurcontrole zoekt
//                           daarna het bewijs op. Ook hier vraag_annuleren.
//   'annuleer_in_event'   — zet event_attendees.status op 'geannuleerd'.
//
// 'bevestigd' zet daarnaast de belstatus van de deelnemer in de eventmodule op
// 'bevestigd'. Zonder dat blijft daar '— nog niet gebeld —' staan terwijl Dave
// die persoon net aan de lijn had; op 10 september stonden 12 van de 18
// bevestigingen daar zo. Zie zetBelstatusBevestigd() onderaan.
//
// 'bevestigd' is de meest voorkomende uitkomst en tegelijk de enige die geen
// eindpunt is. Wie ruim voor het event bevestigt moet vandaag uit de lijst maar
// vier dagen voor het event terugkomen voor de reminder-call: niet meer met de
// vraag óf hij komt, maar of het nog klopt. Daarom zet die actie de kaart niet
// dicht maar vooruit — precies op de dag waarop cron-opvolging-aanmeldingen hem
// anders zelf wakker zou maken. Bevestigt iemand binnen die vier dagen, dan is
// er geen ronde meer en gaat de kaart wél dicht.
//
// Waarom dat laatste hier zit en niet in de eventmodule: Dave moet er niet
// voor naar een ander scherm. Het bevestigingsvenster in de opvolgmodule zegt
// dat het nodig is én doet het meteen. Het venster blijft de melding tonen,
// want een popup wordt weggeklikt en dan is de knop niet ingedrukt — daarom
// staat de 48-uurcontrole er als vangnet naast.
//
// Schrijft in opvolging_taken en opvolging_pogingen, en bij die ene actie in
// event_attendees.status. Geen bestaand endpoint gewijzigd.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { dagPlus, WAKKER_DAGEN_VOOR_EVENT, badgeVoorEvent } from './_lib/opvolging-aanmelding.js';
import { onConfirmedAttendeeMutation } from './_lib/event-attendee-mutations.js';
import { verplaatsDeelnemer } from './_lib/event-attendee-move-core.js';

const ACTIES = new Set([
  'bevestigd', 'gesprek_gehad', 'geen_interesse', 'verplaatst',
  'annuleer_in_event', 'verplaats_naar_event',
]);
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
  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  // Dit endpoint IS het afronden van een aanmeldkaart: bevestigd, gesprek
  // gehad, geen interesse, verplaatst. Vandaar dezelfde sleutel als bij de
  // gewone taak-mutaties.
  if (!(await requirePermission(req, 'opvolging.taak.afronden'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.taak.afronden)' });
  }

  const b = req.body || {};
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });
  const actie = String(b.actie || '');
  if (!ACTIES.has(actie)) return res.status(400).json({ error: 'onbekende actie' });

  const notitie = b.notitie != null ? String(b.notitie).trim().slice(0, 2000) : '';
  // Zonder die zin is 'gesprek gehad' een vinkje zonder inhoud, en dan weet de
  // volgende die deze lead oppakt nog steeds niets.
  if (actie === 'gesprek_gehad' && !notitie) {
    return res.status(400).json({ error: 'notitie is verplicht bij een gesprek' });
  }

  try {
    const { data: taak, error: leesErr } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).maybeSingle();
    if (leesErr) throw new Error(leesErr.message);
    if (!taak) return res.status(404).json({ error: 'Taak niet gevonden' });

    const nu = new Date().toISOString();
    const vandaag = dagInZone(Date.now());
    const attendeeId = taak.bron_ref && taak.bron_ref.attendee_id;

    // ── De losse knop, voor oude tabbladen ──────────────────────────────────
    // Sinds de aanmeldkaart zelf afmeldt is deze actie geen aparte stap meer.
    // Hij blijft bestaan omdat een oud tabblad hem nog kan sturen, en doet nu
    // hetzelfde als 'geen_interesse': KOMT NIET, niet alleen 'geannuleerd'.
    if (actie === 'annuleer_in_event') {
      if (!attendeeId) return res.status(400).json({ error: 'Deze taak hangt niet aan een deelnemer.' });
      const eventmodule = await zetKomtNiet(attendeeId, nu);
      if (eventmodule === 'mislukt') return res.status(500).json({ error: 'Afmelden in de eventmodule lukte niet.' });
      await schrijfNotitie(taak, `${vandaag} · In de eventmodule op 'komt niet' gezet vanuit de opvolgmodule.`);
      return res.status(200).json({ success: true, geannuleerd: true, eventmodule });
    }

    // ── Verplaatsen naar een ander event, vanuit de aanmeldkaart ────────────
    if (actie === 'verplaats_naar_event') return await verplaatsNaarEvent({ res, taak, attendeeId, nu, vandaag, b });

    // ── Bevestigd: de lead komt ──────────────────────────────────────────────
    // Twee uitkomsten, en welke het wordt hangt aan één ding: is er na vandaag
    // nog een ronde? De wakker-dag is dezelfde die de cron gebruikt, zodat de
    // kaart precies op dat moment terugkomt en de cron hem daarna met rust
    // laat (bepaalTaakActie maakt alleen wakker wat verder wég staat).
    if (actie === 'bevestigd') {
      const eventDag = (taak.bron_ref && taak.bron_ref.event_dag) || null;
      const wakker = eventDag ? dagPlus(eventDag, -WAKKER_DAGEN_VOOR_EVENT) : null;
      const nogEenRonde = !!wakker && wakker > vandaag;

      // De poging eerst: dit ís contact geweest, en daar hangt 'klaar voor
      // vandaag' aan. Resultaat begint met 'gesproken' zodat isEchtContact()
      // 'm herkent — zelfde afspraak als bij 'gesprek gehad'.
      await schrijfPoging(taak.id, 'call',
        `gesproken: bevestigd${notitie ? ' — ' + notitie : ''}`.slice(0, 200));

      const regel = `${vandaag} · Bevestigd dat hij komt.` +
        (notitie ? ` ${notitie}` : '') +
        (nogEenRonde ? ` Komt op ${wakker} terug voor de reminder.` : '');

      const patch = {
        bevestigd_op     : nu,
        bevestigd_notitie: notitie || null,
        notitie          : voegRegelToe(taak.notitie, regel),
        updated_at       : nu,
      };
      if (nogEenRonde) {
        // Blijft open, maar verdwijnt uit de lijst van vandaag doordat `due`
        // vooruit staat. `later` terug op false: die vlag hoort bij de tweede
        // ronde van vandaag en zegt over een dag in de toekomst niets.
        patch.status = 'open';
        patch.due    = wakker;
        patch.later  = false;
      } else {
        patch.status          = 'gearchiveerd';
        patch.archief_reden   = 'bevestigd';
        patch.gearchiveerd_at = nu;
      }

      const { error } = await supabaseAdmin.from('opvolging_taken').update(patch).eq('id', taak.id);
      if (error) throw new Error(error.message);

      // Pas nadat de kaart vaststaat: de eventmodule mag nooit 'bevestigd'
      // tonen voor een kaart die zelf niet is weggeschreven. Andersom is wel
      // te overzien — de view vertelt het dan aan Dave.
      const belstatus = await zetBelstatusBevestigd(attendeeId, nu);

      return res.status(200).json({
        success: true,
        slaapt_tot: nogEenRonde ? wakker : null,
        gearchiveerd: !nogEenRonde,
        belstatus,
      });
    }

    // ── Gesprek gehad ────────────────────────────────────────────────────────
    if (actie === 'gesprek_gehad') {
      // De poging eerst: die is het bewijs dat er contact was, en daar hangt
      // 'klaar voor vandaag' aan. Resultaat begint met 'gesproken' zodat
      // isEchtContact() 'm herkent.
      await schrijfPoging(taak.id, 'call', `gesproken: ${notitie}`.slice(0, 200));
      const { error } = await supabaseAdmin.from('opvolging_taken').update({
        status         : 'gearchiveerd',
        archief_reden  : 'gesprek gehad',
        gearchiveerd_at: nu,
        notitie        : voegRegelToe(taak.notitie, `${vandaag} · ${notitie}`),
        updated_at     : nu,
      }).eq('id', taak.id);
      if (error) throw new Error(error.message);
      return res.status(200).json({ success: true });
    }

    // ── Archiveren: geen interesse ───────────────────────────────────────────
    // Dave hoeft hierna niet meer naar de eventmodule: die wordt hier meteen
    // goed gezet. Het bevestigingsvenster met de losse annuleerknop is daarmee
    // verdwenen — een popup wordt weggeklikt, en dan bleef de aanwezigenlijst
    // achter met iemand die net heeft afgezegd.
    if (actie === 'geen_interesse') {
      const { error } = await supabaseAdmin.from('opvolging_taken').update({
        status         : 'gearchiveerd',
        archief_reden  : 'geen interesse of per ongeluk aangemeld',
        gearchiveerd_at: nu,
        notitie        : notitie ? voegRegelToe(taak.notitie, `${vandaag} · ${notitie}`) : taak.notitie,
        updated_at     : nu,
      }).eq('id', taak.id);
      if (error) throw new Error(error.message);

      // Pas nadat de kaart dicht is. Fail-soft, maar niet stil: de view meldt
      // het aan Dave zodra dit 'mislukt' is.
      const eventmodule = await zetKomtNiet(attendeeId, nu);
      return res.status(200).json({ success: true, eventmodule });
    }

    // ── Archiveren: verplaatst naar een ander event ──────────────────────────
    // Niet meteen dicht: eerst wachten op bewijs. Staat deze persoon binnen 48
    // uur nergens als aanmelding op een ander event, dan komt de kaart terug.
    // Het moment van melden staat in bron_ref, niet in agenda_doorgestuurd_at —
    // die kolom betekent iets anders en zou de 48-uurcontrole in de war sturen.
    const { error } = await supabaseAdmin.from('opvolging_taken').update({
      status    : 'wacht_verplaatsing',
      bron_ref  : { ...(taak.bron_ref || {}), verplaatst_gemeld_at: nu },
      notitie   : voegRegelToe(taak.notitie,
        `${vandaag} · Aangeduid als verplaatst naar een ander event.` +
        (notitie ? ` ${notitie}` : '')),
      updated_at: nu,
    }).eq('id', taak.id);
    if (error) throw new Error(error.message);
    return res.status(200).json({ success: true, vraag_annuleren: !!attendeeId });
  } catch (e) {
    console.error('[opvolging-aanmelding-actie]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

/**
 * VERPLAATSEN NAAR EEN ANDER EVENT, VANUIT DE AANMELDKAART.
 *
 * ── WAAROM DIT HIER ZIT EN NIET ACHTER events.attendee.create ───────────
 * De verplaatsing zelf staat in _lib/event-attendee-move-core.js en is
 * letterlijk dezelfde als die van de eventmodule — geen tweede kopie, geen
 * eigen capaciteitscheck. Alleen de POORT verschilt: dit endpoint zit achter
 * `opvolging.taak.afronden`, en dat is de sleutel die Dave (rol sales) heeft.
 *
 * `events.attendee.create` heeft in deze repo geen enkele grant-migratie —
 * hij staat wel in de RBAC-registry en wordt in
 * 2026-06-12-event-signup-inbox.sql als 'admin' omschreven. Zou de
 * aanmeldkaart die sleutel eisen, dan zou de knop voor Dave 403 geven en
 * moest hij alsnog naar de eventmodule. Precies wat deze wijziging opheft.
 *
 * ── DE VOLGORDE, EN WAAROM DIE ZO IS ────────────────────────────────────
 * 1. Eerst de verplaatsing. Mislukt die (vol event, e-mail bestaat al), dan
 *    blijft de kaart ONGEMOEID open en krijgt Dave de letterlijke melding.
 *    Een kaart sluiten bij een mislukte verplaatsing zou de lead laten
 *    verdwijnen zonder dat er iets gebeurd is.
 * 2. Dan de oude kaart dicht, met de bestemming in de notitie.
 * 3. Dan de nieuwe kaart, meteen als BEVESTIGD.
 * 4. Dan de belstatus op de nieuwe rij.
 *
 * ── WAAROM DE NIEUWE KAART METEEN BEVESTIGD IS ──────────────────────────
 * Maxims keuze, en ze volgt uit het moment: Dave had deze persoon net aan de
 * lijn en die zei 'ik kom naar dat andere event'. Hem morgen opnieuw laten
 * bellen met de vraag óf hij komt is dubbel werk en leest voor de lead als
 * slordigheid. De kaart krijgt dus dezelfde behandeling als de bevestigd-tak
 * hierboven: is er nog een reminder-ronde, dan slaapt hij tot vier dagen voor
 * het event; anders gaat hij meteen dicht.
 *
 * Die kaart maken we ZELF, met de nieuwe attendee-id in bron_ref. Zou we dat
 * aan cron-opvolging-aanmeldingen overlaten, dan zet die er een verse
 * ronde-A-kaart neer ('bellen binnen 24 uur') voor iemand die net bevestigd
 * heeft. Met onze kaart erbij ziet bepaalTaakActie een bestaande kaart en
 * doet hij niets.
 */
async function verplaatsNaarEvent({ res, taak, attendeeId, nu, vandaag, b }) {
  if (!attendeeId) return res.status(400).json({ error: 'Deze taak hangt niet aan een deelnemer.' });
  const targetEventId = b.target_event_id ? String(b.target_event_id) : null;
  if (!targetEventId) return res.status(400).json({ error: 'target_event_id ontbreekt' });

  // ── 1 · De verplaatsing, via dezelfde kern als de eventmodule ──────────
  let uitkomst;
  try {
    uitkomst = await verplaatsDeelnemer({ attendeeId, targetEventId, userId: null });
  } catch (e) {
    console.error('[opvolging-aanmelding-actie] verplaatsen:', e?.message || e);
    return res.status(500).json({ error: 'De verplaatsing is niet gelukt: ' + (e?.message || 'onbekende fout') });
  }
  // LETTERLIJK DOORGEVEN. 'Doel-event is vol (12/12 met ingevulde
  // vragenlijst)' zegt precies wat Dave moet weten; er een eigen zin naast
  // zetten levert twee formuleringen op voor dezelfde grens.
  if (!uitkomst.ok) return res.status(uitkomst.status).json(uitkomst.body);

  const nieuweAttendeeId = uitkomst.body.new_attendee && uitkomst.body.new_attendee.id;
  // De proefvlag reist mee. De kern zet 'm op de nieuwe deelnemer; zonder deze
  // regel zou de opvolgkaart ernaast alsnog als echt werk in Daves lijst staan.
  const isTest = !!(uitkomst.body.new_attendee && uitkomst.body.new_attendee.is_test === true);

  // Het doel-event, voor de notitie en voor de reminder-dag.
  let doelEvent = null;
  try {
    const { data } = await supabaseAdmin
      .from('events').select('id, title, location, starts_at').eq('id', targetEventId).maybeSingle();
    doelEvent = data || null;
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] doel-event lezen (soft):', e?.message || e);
  }
  const eventDag = doelEvent && doelEvent.starts_at ? dagInZone(Date.parse(doelEvent.starts_at)) : null;
  const eventNaam = (doelEvent && doelEvent.title) || 'een ander event';

  // ── 2 · De oude kaart dicht ────────────────────────────────────────────
  // Eerst de poging: dit ís contact geweest. Resultaat begint met 'gesproken'
  // zodat isEchtContact() 'm herkent — zelfde afspraak als bij 'bevestigd'.
  await schrijfPoging(taak.id, 'call', 'gesproken: bevestigd (verplaatst)');
  try {
    const { error } = await supabaseAdmin.from('opvolging_taken').update({
      status         : 'gearchiveerd',
      archief_reden  : 'verplaatst naar ander event',
      gearchiveerd_at: nu,
      notitie        : voegRegelToe(taak.notitie,
        `${vandaag} · Verplaatst naar ${eventNaam}${eventDag ? ' van ' + eventDag : ''}.`),
      updated_at     : nu,
    }).eq('id', taak.id);
    if (error) throw new Error(error.message);
  } catch (e) {
    // De verplaatsing staat al. Dit melden en niet stil doorgaan: blijft de
    // oude kaart open, dan staat dezelfde persoon twee keer op de lijst.
    console.error('[opvolging-aanmelding-actie] oude kaart sluiten:', e?.message || e);
    return res.status(500).json({
      error: 'De deelnemer is verplaatst, maar de oude kaart kon niet gesloten worden. Archiveer hem even met de hand.',
      nieuwe_attendee_id: nieuweAttendeeId, target_event_id: targetEventId,
    });
  }

  // ── 3 · De nieuwe kaart, meteen bevestigd ──────────────────────────────
  const wakker = eventDag ? dagPlus(eventDag, -WAKKER_DAGEN_VOOR_EVENT) : null;
  const nogEenRonde = !!wakker && wakker > vandaag;
  const nieuweTaakId = await maakBevestigdeKaart({
    taak, nieuweAttendeeId, doelEvent, eventDag, nu, vandaag, wakker, nogEenRonde, isTest,
  });

  // ── 4 · De belstatus op de nieuwe rij ──────────────────────────────────
  const belstatus = await zetBelstatusBevestigd(nieuweAttendeeId, nu);

  return res.status(200).json({
    success: true,
    nieuwe_attendee_id: nieuweAttendeeId,
    target_event_id   : targetEventId,
    nieuwe_taak_id    : nieuweTaakId,
    event_titel       : eventNaam,
    slaapt_tot        : nogEenRonde ? wakker : null,
    belstatus,
  });
}

/**
 * De kaart voor de nieuwe deelnemer, met dezelfde uitkomst als 'bevestigd'.
 *
 * Fail-soft: de verplaatsing en de belstatus zijn de harde feiten. Lukt de
 * kaart niet, dan maakt cron-opvolging-aanmeldingen er alsnog een — een
 * ronde-A-kaart weliswaar, wat een belletje te veel is maar geen verlies.
 *
 * @returns {Promise<?string>} de id van de nieuwe kaart, of null.
 */
async function maakBevestigdeKaart({ taak, nieuweAttendeeId, doelEvent, eventDag, nu, vandaag, wakker, nogEenRonde, isTest }) {
  if (!nieuweAttendeeId) return null;
  try {
    const regel = `${vandaag} · Bevestigd bij het verplaatsen: hij komt naar dit event.` +
      (nogEenRonde ? ` Komt op ${wakker} terug voor de reminder.` : '');
    const velden = {
      naam       : taak.naam,
      email      : taak.email || null,
      telefoon   : taak.telefoon || null,
      reden      : 'aanmelding',
      bron       : 'event',
      // ZELFDE VORM ALS cron-opvolging-aanmeldingen SCHRIJFT. De view leest
      // bron_ref rechtstreeks (evVan) voor de eventkop op de kaart; een eigen
      // vorm hier zou een kaart opleveren die er anders uitziet dan alle
      // andere aanmeldkaarten.
      bron_ref   : {
        event_id     : doelEvent ? doelEvent.id : null,
        // De NIEUWE deelnemer, zodat cron-opvolging-aanmeldingen deze kaart
        // bij die rij vindt en er geen tweede naast zet.
        attendee_id  : nieuweAttendeeId,
        soort        : 'aanmelding',
        event_dag    : eventDag,
        event_titel  : doelEvent ? (doelEvent.title || null) : null,
        event_plaats : doelEvent ? (doelEvent.location || null) : null,
        event_start  : doelEvent ? (doelEvent.starts_at || null) : null,
        verplaatst_van_taak_id: taak.id,
        verplaatst_van_event_id: (taak.bron_ref && taak.bron_ref.event_id) || null,
        verplaatst_van_titel   : (taak.bron_ref && taak.bron_ref.event_titel) || null,
      },
      badge_label     : badgeVoorEvent(doelEvent),
      later           : false,
      bevestigd_op    : nu,
      bevestigd_notitie: 'Bevestigd bij het verplaatsen naar dit event.',
      notitie         : regel,
      eigenaar_id     : null,
      // Een proefdeelnemer levert een proefkaart op, geen echt werk in de
      // dagelijkse lijst van Dave.
      is_test         : isTest === true,
    };
    if (nogEenRonde) {
      velden.status = 'open';
      velden.due    = wakker;
    } else {
      velden.status          = 'gearchiveerd';
      velden.archief_reden   = 'bevestigd';
      velden.gearchiveerd_at = nu;
      // Een gearchiveerde kaart heeft nog steeds een due nodig: de kolom is
      // NOT NULL, en vandaag is het moment waarop dit gebeurde.
      velden.due             = vandaag;
    }
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken').insert(velden).select('id').single();
    if (error) throw new Error(error.message);
    return data ? data.id : null;
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] nieuwe kaart (soft):', e?.message || e);
    return null;
  }
}

/**
 * Zet de deelnemer in de eventmodule op KOMT NIET.
 *
 * ── WAAROM DIT MEER IS DAN 'GEANNULEERD' ────────────────────────────────
 * De oude actie zette alleen `status = 'geannuleerd'`. Twee dingen gingen
 * daardoor mis, en allebei zijn ze onzichtbaar tot iemand het merkt:
 *
 *  1. De belstatus bleef leeg. In de aanwezigenlijst stond '— nog niet
 *     gebeld —' bij iemand die net had afgezegd, dus belde de volgende hem
 *     nog eens.
 *  2. Er draaide geen capaciteitshook. Een plaats die vrijkwam heropende het
 *     event dus nooit; een vol event bleef dicht terwijl er ruimte was.
 *
 * Dit is dezelfde betekenis als outcome 'komt_niet' in
 * api/follow-up-lead-outcome.js: dezelfde drie velden, dezelfde
 * statusregel, dezelfde cascade. Die motor zelf blijft ongemoeid — zie het
 * waarschuwingsblok daar, productie-incident 20 mei.
 *
 * ── WELKE STATUS WEL EN NIET ────────────────────────────────────────────
 * Alleen 'aangemeld' en 'wachtlijst' gaan naar 'geannuleerd'. `sale` en
 * `aanwezig` zijn eindstanden die iets zeggen over wat er écht gebeurd is —
 * die overschrijven met een afmelding zou geschiedenis wissen.
 * `switched_to_other_event` blijft ook staan: die persoon is niet weg, hij
 * staat ergens anders.
 *
 * De belstatus gaat wél altijd mee. Dat gaat over de belronde, en die heeft
 * plaatsgevonden, ongeacht wat de inschrijving verder doet.
 *
 * Fail-soft: de kaart is op dit moment al dicht en mag hier niet op
 * stuklopen. De uitkomst gaat als tekst mee in het antwoord zodat de view
 * het aan Dave kan melden.
 *
 * @returns {Promise<'geen_deelnemer'|'bijgewerkt'|'mislukt'>}
 */
export async function zetKomtNiet(attendeeId, nuIso, db = supabaseAdmin, opties = {}) {
  if (!attendeeId) return 'geen_deelnemer';
  try {
    const { data: rij, error: leesErr } = await db
      .from('event_attendees')
      .select('id, event_id, status, notes')
      .eq('id', attendeeId)
      .maybeSingle();
    if (leesErr) throw new Error(leesErr.message);
    if (!rij) throw new Error('deelnemer niet gevonden');

    const huidige = String(rij.status || '').toLowerCase();
    const patch = { call_status: 'komt_niet', call_status_at: nuIso, called: true };
    const statusWijzigt = huidige === 'aangemeld' || huidige === 'wachtlijst';
    if (statusWijzigt) patch.status = 'geannuleerd';

    // ── EEN AFMELDING MET EEN REDEN ──────────────────────────────────────
    // 'Liever via zoom' is geen afhaker. Zonder eigen reden staat hij in de
    // aanwezigenlijst naast de mensen die geen interesse hadden, en dat is een
    // ander gesprek — ook voor de 'je inschrijving is geannuleerd'-berichten
    // die later nog komen: die horen hier NIET af te gaan.
    //
    // `notes` is vrije tekst en accepteert dus zeker wat we schrijven; het
    // gemarkeerde voorvoegsel is meteen de haak waar die automatisering later
    // op kan filteren. `call_status` is een eigen stap hieronder, want dat is
    // een waarde die de badge-tabellen kennen en een onbekende zou de hele
    // update kunnen laten falen.
    if (opties.notitieRegel) {
      const oud = String(rij.notes || '').trim();
      patch.notes = oud ? `${opties.notitieRegel}\n${oud}` : opties.notitieRegel;
    }

    const { error } = await db.from('event_attendees').update(patch).eq('id', attendeeId);
    if (error) throw new Error(error.message);

    // APART, EN FAIL-SOFT. De afmelding zelf staat nu; een call_status die de
    // databank om welke reden ook weigert mag die niet meeslepen. Dan blijft
    // 'komt_niet' staan — minder precies, maar niet fout.
    if (opties.callStatus && opties.callStatus !== 'komt_niet') {
      const { error: csErr } = await db.from('event_attendees')
        .update({ call_status: opties.callStatus, call_status_at: nuIso })
        .eq('id', attendeeId);
      if (csErr) {
        console.warn('[opvolging-aanmelding-actie] call_status ' + opties.callStatus
          + ' (soft):', csErr.message);
      }
    }

    // Alleen bij een echte statuswijziging: er komt dan een plaats vrij, en
    // een vol event hoort weer open te gaan. Zonder wijziging is er niets
    // veranderd aan de bezetting en zou de cascade werk voor niets zijn.
    if (statusWijzigt && rij.event_id) {
      try {
        await onConfirmedAttendeeMutation(rij.event_id, { reason: 'opvolging-aanmelding-actie' });
      } catch (e) {
        // De afmelding staat; de cascade is de opruiming erna.
        console.warn('[opvolging-aanmelding-actie] capaciteitshook (soft):', e?.message || e);
      }
    }
    return 'bijgewerkt';
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] komt-niet (soft):', e?.message || e);
    return 'mislukt';
  }
}

/**
 * Zet de belstatus van de deelnemer in de eventmodule op 'bevestigd'.
 *
 * Dave belt vanuit de opvolgmodule, maar de aanwezigenlijst van het event leest
 * `event_attendees.call_status`. Werd die niet meegeschreven, dan staat daar
 * '— nog niet gebeld —' bij iemand die net heeft bevestigd, en belt de volgende
 * hem nog eens. Dezelfde drie velden als api/follow-up-lead-outcome.js bij
 * outcome 'bevestigd' schrijft, zodat beide wegen dezelfde badge opleveren.
 *
 * De inschrijvings-`status` blijft met opzet ongemoeid: bevestigen zegt iets
 * over de belronde, niet over aangemeld/wachtlijst/geannuleerd. Wie dat wil
 * wijzigen gebruikt de knop 'annuleer_in_event' hierboven.
 *
 * Fail-soft: een fout hier mag de bevestiging niet terugdraaien. De uitkomst
 * gaat als tekst mee in het antwoord zodat de view het aan Dave kan melden.
 *
 * @returns {Promise<'geen_deelnemer'|'bijgewerkt'|'mislukt'>}
 */
export async function zetBelstatusBevestigd(attendeeId, nuIso, db = supabaseAdmin) {
  if (!attendeeId) return 'geen_deelnemer';
  try {
    const { error } = await db
      .from('event_attendees')
      .update({ call_status: 'bevestigd', call_status_at: nuIso, called: true })
      .eq('id', attendeeId);
    if (error) throw new Error(error.message);
    return 'bijgewerkt';
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] belstatus (soft):', e?.message || e);
    return 'mislukt';
  }
}

/** Fail-soft: de poging is de historiek, niet de actie zelf. */
async function schrijfPoging(taakId, soort, resultaat) {
  try {
    const { error } = await supabaseAdmin.from('opvolging_pogingen')
      .insert({ taak_id: taakId, soort, resultaat, automatisch: false });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] poging (soft):', e?.message || e);
  }
}

async function schrijfNotitie(taak, regel) {
  try {
    await supabaseAdmin.from('opvolging_taken')
      .update({ notitie: voegRegelToe(taak.notitie, regel), updated_at: new Date().toISOString() })
      .eq('id', taak.id);
  } catch (e) {
    console.warn('[opvolging-aanmelding-actie] notitie (soft):', e?.message || e);
  }
}

/** Nieuwe regel bovenaan, bestaande notitie eronder. Nooit overschrijven. */
function voegRegelToe(bestaand, regel) {
  const oud = String(bestaand || '').trim();
  return oud ? `${regel}\n\n${oud}` : regel;
}

/**
 * LIEVER VIA ZOOM — afmelden voor het event, met de juiste reden.
 *
 * Dave belt iemand die zich voor een masterclass heeft aangemeld en die zegt:
 * eigenlijk heb ik liever een zoomcall. Tot nu toe moest hij dan buiten
 * Opvolging een zoom boeken én in de eventmodule de persoon zelf afmelden —
 * twee administraties, en precies waar het misloopt.
 *
 * Dit is dezelfde kern als zetKomtNiet: dezelfde statusregel (alleen
 * 'aangemeld' en 'wachtlijst' gaan naar 'geannuleerd'), dezelfde
 * capaciteitshook, dezelfde fail-soft. Alleen de REDEN verschilt, en dat is
 * het hele punt — in de aanwezigenlijst mag dit niet lezen als 'geen
 * interesse'.
 *
 * @param {string} attendeeId
 * @param {string} nuIso
 * @param {?string} momentTekst  het gekozen zoom-moment, voor de notitie
 * @returns {Promise<'geen_deelnemer'|'bijgewerkt'|'mislukt'>}
 */
export const LIEVER_ZOOM_CALL_STATUS = 'liever_zoom';
/** Het voorvoegsel waar latere automatiseringen op kunnen filteren. */
export const LIEVER_ZOOM_MARKER = '[liever-zoom]';

export async function zetLieverZoom(attendeeId, nuIso, momentTekst = null, db = supabaseAdmin) {
  const regel = `${LIEVER_ZOOM_MARKER} ${String(nuIso).slice(0, 10)} · omgezet naar een zoomcall`
    + (momentTekst ? ` op ${momentTekst}` : '') + ' vanuit Opvolging. Geen afhaker.';
  return await zetKomtNiet(attendeeId, nuIso, db, {
    callStatus   : LIEVER_ZOOM_CALL_STATUS,
    notitieRegel : regel,
  });
}
