// api/_lib/opvolging-doorrol.js
//
// Fase 3a — de twee besluiten die 's nachts en ieder uur automatisch genomen
// worden, als pure functies. Geen database, geen klok uit het niets: alles komt
// binnen als argument zodat het te testen is.
//
//   1. bepaalDoorrol()       — wat blijft liggen rolt door naar morgen.
//   2. beslisWachtInplanning() — heeft de lead zelf iets ingepland, of niet?
//
// Waarom apart: dit zijn precies de plekken waar werk stil kan verdwijnen. Een
// taak die niet doorrolt staat morgen op geen enkele lijst; een taak die na 48
// uur niet terugkomt is een lead waar niemand meer achteraan gaat. Allebei merk
// je pas weken later, als je het al kwijt bent.

/** Zoveel uur mag een lead zelf een moment kiezen voor we hem terughalen. */
export const WACHT_UREN = 48;

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Wat er met de achterstallige openstaande taken gebeurt.
 *
 * DE REGEL IS 'NAAR VANDAAG', NIET 'NAAR MORGEN', EN DAT IS EEN GEMETEN LES.
 *
 * De oude regel zette alles op morgen. Dat werkt alleen als de cron ook echt
 * vóór middernacht draait, en dat deed hij niet: in vercel.json staat hij op
 * `59 23 * * *`, Vercel draait crons in UTC, en 23:59 UTC is 01:59 in
 * Amsterdam. Het was dan dus al de volgende dag, 'morgen' werd overmorgen, en
 * elke openstaande kaart sloeg precies een dag over. Op 8 september stonden de
 * vijf leads van de dag ervoor daardoor op 9 september — niet blijven liggen,
 * maar een dag onzichtbaar.
 *
 * Een tijdzonecorrectie op het schema lost dat niet op: `59 21 * * *` klopt in
 * de zomer en is in de winter weer mis, want Nederland schuift twee keer per
 * jaar. Redeneren in VANDAAG haalt de klok uit de vergelijking. Het gevolg:
 *
 *   · idempotent — twee keer draaien verandert de tweede keer niets;
 *   · tijdstip-onafhankelijk — het maakt niet uit hoe laat de cron valt;
 *   · zelfhelend — slaat een nacht over of faalt een run, dan haalt de
 *     volgende run alles alsnog naar voren, in plaats van kaarten voorgoed in
 *     het verleden te laten hangen.
 *
 * Dat laatste is het verschil tussen 'werkt' en 'blijft werken'.
 *
 * `later` gaat expliciet terug naar false. Dat is het punt van deze cron:
 * zonder die reset blijft een taak die vandaag naar de tweede ronde is gezet
 * daar voor altijd staan, en zakt hij elke ochtend meteen onderaan in plaats
 * van bovenaan de eerste ronde te beginnen. Dan lijkt hij afgehandeld terwijl
 * er nooit meer iemand naar kijkt.
 *
 *   taken   — [{ id, status, due, later }]
 *   vandaag — 'YYYY-MM-DD', de huidige Amsterdamse datum
 *
 * Geeft alleen de taken terug die echt veranderen, met de patch erbij. Wat al
 * goed staat blijft ongemoeid — geen zinloze updates, en geen updated_at die
 * verschuift zonder reden.
 */
const ZONE = 'Europe/Amsterdam';

/**
 * De dag waarop de doorrol moet richten: VANDAAG in Amsterdam.
 *
 * Staat hier als pure functie en niet als regel in de cron, omdat juist dit
 * rekensommetje de fout bevatte. `dagInZone(nu + 24 uur)` leest als 'morgen' en
 * was dat ook — maar de cron draait om 01:59 Amsterdamse tijd, dus 'morgen' was
 * al overmorgen. Zo'n som hoort in een test te staan waar je hem kunt naslaan,
 * niet in een handler waar je hem alleen in productie ziet werken.
 */
export function doorrolDag(nuMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nuMs));
}

/** Zoveel ids bewaart het merkteken als steekproef voor de ochtendcontrole. */
export const VOORBEELDEN_MAX = 25;

/**
 * Het merkteken dat de doorrol achterlaat voor de controle van 07:00.
 *
 * Staat hier als pure functie om dezelfde reden als doorrolDag hierboven: de
 * inhoud ervan IS het bewijsmateriaal van de ochtendcontrole, en die inhoud
 * hoort in een test te staan in plaats van los in een handler. Een merkteken
 * zonder tijdstip of zonder ids ziet er in een log net zo goed uit als een
 * volledig merkteken, maar maakt controle 7 blind.
 *
 * Zie controleerDoorrol in api/_lib/opvolging-gezondheid.js voor wat er mee
 * gebeurt.
 */
export function bouwMerkteken({ vandaag, gedraaidMs, doorgerold, bekeken, aangeraakt }) {
  return {
    dag        : vandaag,
    gedraaid_op: new Date(gedraaidMs).toISOString(),
    doorgerold : Number(doorgerold) || 0,
    bekeken    : Number(bekeken) || 0,
    // De steekproef waar de controle de rijen zelf mee nakijkt. Leeg maken
    // haalt de rijcontrole stilletjes weg, dus dat mag hier niet zomaar.
    voorbeelden: (Array.isArray(aangeraakt) ? aangeraakt : []).slice(0, VOORBEELDEN_MAX),
  };
}

export function bepaalDoorrol({ taken, vandaag }) {
  if (!DATUM_RE.test(String(vandaag || ''))) return [];
  const uit = [];
  for (const t of (Array.isArray(taken) ? taken : [])) {
    if (!t || !t.id) continue;
    if (String(t.status || '') !== 'open') continue;
    const due = String(t.due || '');
    if (!DATUM_RE.test(due)) continue;
    // Alleen wat achterloopt. Een taak van vandaag is niet achterstallig, en
    // een taak die de gebruiker zelf vooruit heeft gezet mag deze cron nooit
    // naar voren trekken.
    if (due >= vandaag) continue;
    uit.push({ id: t.id, patch: { due: vandaag, later: false } });
  }
  return uit;
}

/**
 * Hoort deze naam bij de afspraak die intussen geboekt is?
 *
 * Drie ingangen, want we weten nooit welke de lead invulde: telefoon, e-mail of
 * naam. Telefoon en e-mail zijn hard; naam is de zwakste en daarom exact (op
 * hoofdletters en spaties na) — 'Jan' laten matchen op 'Jan Peeters' zou een
 * afspraak van de verkeerde persoon als bewijs gebruiken en de lead ten
 * onrechte uit de lijst halen.
 */
export function hoortBijLead(taak, afspraak) {
  if (!taak || !afspraak) return false;

  const tel = cijfers(taak.telefoon);
  const aTel = cijfers(afspraak.lead_phone);
  if (tel && aTel && (tel === aTel || staart(tel) === staart(aTel))) return true;

  const mail = String(taak.email || '').trim().toLowerCase();
  const aMail = String(afspraak.lead_email || '').trim().toLowerCase();
  if (mail && aMail && mail === aMail) return true;

  const naam = normaliseerNaam(taak.naam);
  const aNaam = normaliseerNaam(afspraak.lead_name);
  if (naam && aNaam && naam === aNaam) return true;

  return false;
}

function cijfers(s) {
  const c = String(s == null ? '' : s).replace(/\D/g, '');
  if (!c) return null;
  return c.startsWith('00') ? (c.slice(2) || null) : c;
}
function staart(c) { return c && c.length >= 9 ? c.slice(-9) : null; }
function normaliseerNaam(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ') || null;
}

/**
 * De 48-uurbeslissing voor één taak die op 'wacht_inplanning' staat.
 *
 *   taak      — { id, naam, email, telefoon, agenda_doorgestuurd_at }
 *   afspraken — kandidaten uit de agenda ({ id, lead_name, lead_email,
 *               lead_phone, scheduled_at, created_at, zoom_join_url, ... })
 *   nu        — referentiemoment in ms; injecteerbaar voor de test.
 *
 * Drie uitkomsten:
 *   { actie: 'ingepland', afspraak }  — hij heeft zelf geboekt.
 *   { actie: 'terug' }                — 48 uur voorbij, niets geboekt.
 *   { actie: 'wacht' }                — de termijn loopt nog.
 *
 * Alleen afspraken die ná het doorsturen zijn aangemaakt tellen mee. Een oude
 * afspraak van dezelfde persoon is geen bewijs dat hij nú iets heeft gekozen —
 * dan zou de taak meteen als ingepland wegvallen zonder dat er iets gebeurd is.
 */
export function beslisWachtInplanning({ taak, afspraken, nu = Date.now() }) {
  const gestuurd = taak?.agenda_doorgestuurd_at ? new Date(taak.agenda_doorgestuurd_at).getTime() : NaN;

  const kandidaten = (Array.isArray(afspraken) ? afspraken : [])
    .filter((a) => a && hoortBijLead(taak, a))
    .filter((a) => {
      // Zonder bruikbaar doorstuurmoment kunnen we 'na het doorsturen' niet
      // beoordelen. Dan is elke afspraak van deze persoon verdacht en laten we
      // 'm liever staan dan de taak op grond van oude data af te sluiten.
      if (!Number.isFinite(gestuurd)) return false;
      const gemaakt = a.created_at ? new Date(a.created_at).getTime() : NaN;
      return Number.isFinite(gemaakt) && gemaakt >= gestuurd;
    })
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  if (kandidaten.length > 0) return { actie: 'ingepland', afspraak: kandidaten[0] };

  if (!Number.isFinite(gestuurd)) {
    // Geen doorstuurmoment bekend: dan is er geen klok om af te lopen. Terug in
    // de lijst zetten zou hier willekeurig zijn; laat staan en laat het opvallen.
    return { actie: 'wacht' };
  }
  if (nu - gestuurd >= WACHT_UREN * 3600 * 1000) return { actie: 'terug' };
  return { actie: 'wacht' };
}

/**
 * De 48-uurbeslissing voor een taak die op 'wacht_verplaatsing' staat.
 *
 * Dave gaf aan dat hij deze persoon naar een ander event verplaatst. Dat is een
 * belofte, geen meting — vandaar dit vangnet, met dezelfde vorm als
 * beslisWachtInplanning() hierboven: zoek bewijs, en zonder bewijs komt de
 * kaart na 48 uur terug.
 *
 * Het bewijs is een ANDER bewijs dan bij wacht_inplanning, en dat is precies
 * waarom die twee statussen apart zijn gebleven: hier zoeken we een rij in
 * event_attendees met status 'aangemeld' op een ander event, daar een afspraak
 * in follow_up_appointments. Met één status zou een gevonden afspraak een
 * openstaande verplaatsing kunnen afsluiten, en dan gaat een kaart om de
 * verkeerde reden dicht.
 *
 *   taak       — { id, bron_ref: { attendee_id, event_id, verplaatst_gemeld_at } }
 *   aanmeldingen — kandidaat-rijen ({ id, event_id, email, phone, status })
 *   nu         — referentiemoment in ms
 */
export function beslisWachtVerplaatsing({ taak, aanmeldingen, nu = Date.now() }) {
  const ref = (taak && taak.bron_ref) || {};
  const gemeld = ref.verplaatst_gemeld_at ? new Date(ref.verplaatst_gemeld_at).getTime() : NaN;

  const gevonden = (Array.isArray(aanmeldingen) ? aanmeldingen : []).find((a) => {
    if (!a || String(a.status || '') !== 'aangemeld') return false;
    // Op een ANDER event: op hetzelfde event staan is geen verplaatsing.
    if (!a.event_id || a.event_id === ref.event_id) return false;
    // En niet de rij waar deze kaart zelf aan hangt.
    if (a.id && a.id === ref.attendee_id) return false;
    // hoortBijLead() is geschreven op de veldnamen van een afspraak; een
    // deelnemerrij heet anders. Vertalen is eerlijker dan die functie oprekken.
    return hoortBijLead(taak, {
      lead_name : [a.first_name, a.last_name].filter(Boolean).join(' ') || null,
      lead_email: a.email || null,
      lead_phone: a.phone || null,
    });
  });
  if (gevonden) return { actie: 'verplaatst', aanmelding: gevonden };

  if (!Number.isFinite(gemeld)) {
    // Geen meldmoment bekend: dan is er geen klok om af te lopen. Laat staan en
    // laat het opvallen in plaats van willekeurig terug te zetten.
    return { actie: 'wacht' };
  }
  if (nu - gemeld >= WACHT_UREN * 3600 * 1000) return { actie: 'terug' };
  return { actie: 'wacht' };
}
