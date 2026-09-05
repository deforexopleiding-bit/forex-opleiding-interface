// api/_lib/opvolging-aanmelding.js
//
// Wanneer wordt een aanmelding voor een event een taak in Daves lijst, en
// wanneer sluit die taak zichzelf weer? Pure functies, geen database, geen
// klok uit het niets — alles komt binnen als argument.
//
// DE INSTROOM HANGT AAN DE DEELNEMERRIJ, NIET AAN HET INSCHRIJFMOMENT.
// Er zijn drie manieren waarop een rij met status 'aangemeld' ontstaat: het
// GHL-formulier, de Webflow-vragenlijst, en een verplaatsing naar een ander
// event. Die laatste is de reden dat we niet aan één endpoint mogen hangen:
// api/events-attendee-move.js maakt een NIEUWE rij op het doel-event, en wie
// aan het inschrijfmoment hangt mist die persoon volledig.
//
// TWEE MOMENTEN, ÉÉN KAART.
//   A — de aanmelding zelf: bellen binnen 24 uur, vraag of alles goed ging.
//   B — vier dagen voor het event: dezelfde kaart wordt weer wakker.
// Daartussen slaapt de kaart doordat `due` in de toekomst staat; de dagweergave
// toont alleen wat op of vóór vandaag staat. Wie zich twee maanden vooraf
// aanmeldt hangt dus niet twee maanden in de lijst. Meldt iemand zich binnen
// die vier dagen aan, dan vallen A en B vanzelf samen: de due van A is dan al
// vandaag.

const ZONE = 'Europe/Amsterdam';

/** Vast, niet instelbaar. Vier dagen voor het event wordt de kaart wakker. */
export const WAKKER_DAGEN_VOOR_EVENT = 4;

/** Statussen waarin een deelnemer nog verwacht wordt op het event. */
export const ACTIEF = new Set(['aangemeld']);

/** De dag in Amsterdamse tijd, zoals cron-opvolging-doorrol dat doet. */
export function dagInZone(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** Kalenderrekenwerk op UTC-noon, zodat de zomertijdgrens geen dag verschuift. */
export function dagPlus(dag, n) {
  const ms = Date.parse(`${dag}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + n * 86400000).toISOString().slice(0, 10);
}

/** Hoeveel hele dagen liggen er tussen twee dagen? Negatief = in het verleden. */
export function dagenTussen(vanaf, tot) {
  const a = Date.parse(`${vanaf}T12:00:00Z`);
  const b = Date.parse(`${tot}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Op welke dag hoort deze kaart te staan?
 *
 * Vandaag als het event binnen vier dagen is (dan vallen A en B samen), anders
 * de dag waarop hij wakker moet worden. Nooit in het verleden: een kaart met
 * een due van gisteren zou meteen als 'bleef liggen' binnenkomen terwijl er
 * niets bleef liggen.
 */
export function dueVoorAanmelding({ eventDag, vandaag }) {
  if (!eventDag || !vandaag) return vandaag || null;
  const wakker = dagPlus(eventDag, -WAKKER_DAGEN_VOOR_EVENT);
  if (!wakker) return vandaag;
  return wakker <= vandaag ? vandaag : wakker;
}

/**
 * Wat moet er met deze deelnemer gebeuren?
 *
 *   attendee — { id, status, registered_at, switched_from_event_id }
 *   event    — { id, title, location, starts_at }
 *   taak     — de bestaande opvolgtaak voor deze attendee, of null
 *   nu       — referentiemoment in ms
 *
 * Vijf uitkomsten. 'niets' is de meest voorkomende en dat hoort zo: deze
 * functie draait elk kwartier over alle aanmeldingen.
 */
export function bepaalTaakActie({ attendee, event, taak = null, nu = Date.now() }) {
  if (!attendee || !event || !event.starts_at) return { actie: 'niets' };

  const vandaag = dagInZone(nu);
  const eventMs = Date.parse(event.starts_at);
  if (!Number.isFinite(eventMs)) return { actie: 'niets' };
  const eventDag = dagInZone(eventMs);

  const status = String(attendee.status || '');

  // ── De kaart sluit zichzelf ───────────────────────────────────────────────
  // Beter dan een popup die weggeklikt wordt: dit is een meting van wat er in
  // de eventmodule écht gebeurd is. Een al gearchiveerde kaart laten we staan.
  const taakLoopt = taak && taak.status !== 'gearchiveerd';
  if (taakLoopt && status === 'switched_to_other_event') {
    return { actie: 'sluiten_verplaatst', taak_id: taak.id };
  }
  if (taakLoopt && status === 'geannuleerd') {
    return { actie: 'sluiten_geannuleerd', taak_id: taak.id };
  }

  // Vanaf hier alleen nog wie daadwerkelijk verwacht wordt.
  if (!ACTIEF.has(status)) return { actie: 'niets' };

  // Een event dat al geweest is hoort niet meer bij deze flow: vanaf dat moment
  // neemt 'Event afronden' het over (Punt B in events-complete-core).
  if (eventDag < vandaag) return { actie: 'niets' };

  const due = dueVoorAanmelding({ eventDag, vandaag });

  if (!taak) {
    return {
      actie      : 'aanmaken',
      due,
      reden      : 'aanmelding',
      event_dag  : eventDag,
      badge_label: badgeVoorEvent(event),
      verplaatst : !!attendee.switched_from_event_id,
    };
  }

  // Bestaat al. Alleen een lopende kaart mag wakker worden; gearchiveerd blijft
  // gearchiveerd (Dave heeft 'm bewust weggezet), en wacht_verplaatsing en
  // ingepland hebben hun eigen weg.
  if (taak.status !== 'open') return { actie: 'niets' };

  // Moment B: het event komt eraan en de kaart staat nog verder weg.
  if (String(taak.due || '') > due) {
    return { actie: 'wakker_maken', taak_id: taak.id, due };
  }
  return { actie: 'niets' };
}

/**
 * Het etiket op de kaart: 'Masterclass Gent · 12 sep 19:00'.
 *
 * Titel, plaats en het moment, want Dave belt met een concrete afspraak in zijn
 * hoofd. Ontbreekt er iets, dan valt dat deel gewoon weg.
 */
export function badgeVoorEvent(event) {
  if (!event) return null;
  const naam = [event.title, event.location].filter((s) => s && String(s).trim()).map((s) => String(s).trim()).join(' ');
  let moment = '';
  const ms = event.starts_at ? Date.parse(event.starts_at) : NaN;
  if (Number.isFinite(ms)) {
    try {
      // nl-NL zet er een komma tussen ('20 sep, 19:00'); op een badge leest
      // dat rommelig, dus die haalt hij eruit.
      moment = new Intl.DateTimeFormat('nl-NL', {
        timeZone: ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      }).format(new Date(ms)).replace(',', '');
    } catch (_) { moment = ''; }
  }
  const label = [naam, moment].filter(Boolean).join(' · ');
  return label ? label.slice(0, 200) : null;
}

/**
 * Is er ECHT contact geweest?
 *
 * Dit bepaalt of de kaart morgen terugkomt, dus de definitie moet streng zijn.
 * Een telefoon die overgaat is geen gesprek: die poging bestaat wel (soort
 * 'call') maar met resultaat 'niet opgenomen'. Zou dat meetellen, dan verdwijnt
 * iemand uit de lijst zonder dat er iemand mee gesproken heeft.
 *
 * Telt wel: een gesprek dat tot stand kwam, of een bericht dat de lead ons
 * stuurde.
 */
export function isEchtContact(poging) {
  if (!poging) return false;
  const resultaat = String(poging.resultaat || '').toLowerCase();
  if (poging.soort === 'call') return /gesproken/.test(resultaat);
  if (poging.soort === 'whatsapp' || poging.soort === 'spraakbericht') {
    return /ontvangen/.test(resultaat);
  }
  return false;
}

/** Heeft deze taak al echt contact gehad? Dan is hij klaar. */
export function heeftEchtContact(pogingen) {
  return (Array.isArray(pogingen) ? pogingen : []).some(isEchtContact);
}

/**
 * Mag de gewone archiveerdrempel gelden — drie belpogingen op drie dagen plus
 * een WhatsApp?
 *
 * Zolang het event nog moet komen: nee. Die mensen komen misschien gewoon
 * opdagen, en dan is 'genoeg moeite gedaan om te archiveren' de verkeerde
 * vraag. Na het event neemt Event afronden het over en geldt de drempel weer.
 */
export function drempelGeldt({ eventDag, vandaag }) {
  if (!eventDag || !vandaag) return true;
  return eventDag < vandaag;
}
