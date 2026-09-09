// api/_lib/opvolging-no-show.js
//
// EEN NO-SHOW WORDT EEN KAART, ONGEACHT WIE HEM ZO GEZET HEEFT.
//
// ── DE KETEN DIE DIT NODIG MAAKT ─────────────────────────────────────────
// De zoomcalls van 8 september die no-show werden, zijn nooit door Dave in de
// opvolgmodule als no-show gemarkeerd. Dus is er nooit een kaart ontstaan. Dus
// zijn ze ook nooit meegekomen naar vandaag. Mehran Jahani en Sebastian
// Kolodziejski verdwenen daarmee volledig uit beeld.
//
// De bestaande weg werkt wél: drukt Dave in de opvolgmodule op 'Afronden →
// no-show', dan post de view naar api/opvolging-taak-create met
// reden 'no_show_call', en er staat een kaart. Vier daarvan bestaan en doen
// het. Het probleem is niet die weg maar dat het de ENIGE aanleiding is.
//
// Deze module is de tweede aanleiding. Geen nieuwe machinerie: dezelfde
// kaartvorm, dezelfde reden, dezelfde idempotentie-sleutel.
//
// ── WAAROM EEN WACHTER OP DE UITKOMST EN GEEN HAAK IN DE SYNC ────────────
// Dit is gemeten en het verandert de vorm van de oplossing.
//
// De GHL-poll KAN geen no_show schrijven. mapGhlStatus() mapt `confirmed` naar
// scheduled, `showed` naar completed en `cancelled`/`invalid` naar cancelled;
// `noshow` staat er expliciet niet in, met een comment erbij dat de poll dat
// niet mag. Elke andere no_show-verwijzing in dat bestand is een LEESACTIE
// (statussen bewaren, rijen selecteren). Een haak in de sync zou dus nooit
// vuren — en dat is een derde stil pad erbij in plaats van een oplossing.
//
// Waar Mehran en Sebastian hun status vandaan hebben is met de code alleen niet
// vast te stellen. Precies daarom kijkt deze module naar de UITKOMST in de
// databank in plaats van naar de weg ernaartoe: wie de status ook zette, de
// kaart komt er.
//
// ── DE DRIE RANDVOORWAARDEN ──────────────────────────────────────────────
// 1. GEEN DUBBELE KAARTEN. De sleutel is `bron_ref.appointment_id` en niets
//    anders. Naam en telefoonnummer zijn te zwak — er zijn mensen met dezelfde
//    naam, en een nummer kan hergebruikt worden. Drukt Dave zelf op no-show en
//    zet de sync daarna ook no_show, dan wijst beide naar hetzelfde
//    appointment_id en blijft er één kaart.
// 2. ALLEEN VANAF DE GRENS. Zie NO_SHOW_VANAF.
// 3. Dit verandert niets aan het dagbeeld. De sync zorgt dat er een kaart komt,
//    het dagbeeld zorgt dat je ziet waarom. Twee dingen die elkaar versterken.

/**
 * ⚠ DE HARDE GRENS. Alleen zoomcalls op of ná deze dag leveren een kaart op.
 *
 * GEMETEN, en dat maakt de keuze simpel. Er staan 110 no-show-afspraken in de
 * databank, verdeeld over 101 personen — sommigen zijn meer dan één keer niet
 * komen opdagen. Daarvan liggen er 108 vóór 7 september, en die zitten al in de
 * warme-leadslijst die Maxim zelf dripfeedt. Precies TWEE zijn er nieuw sinds
 * die lijst gemaakt is: Mehran Jahani en Sebastian Kolodziejski, allebei van
 * 8 september.
 *
 * De grens ligt daarom op 9 september: de hele achterstand blijft buiten schot
 * en gaat via de dripfeed. Ook Mehran en Sebastian komen hier NIET in — die
 * worden zichtbaar in het dagbeeld en kan Dave zelf afronden. Dat is de nettere
 * weg: een mens die een uitkomst vastlegt, in plaats van dat wij met
 * terugwerkende kracht kaarten verzinnen.
 *
 * Zet hem NIET terug in de tijd zonder te tellen. `?droog=1` op de cron rekent
 * uit wie erin zou komen zonder iets weg te schrijven.
 */
export const NO_SHOW_VANAF = '2026-09-09';

/** De reden op de kaart. Bestaat al in de CHECK-constraint en in de UI. */
export const REDEN = 'no_show_call';
/** De bron. Dezelfde die de knop gebruikt, zodat de kaarten niet uiteenlopen. */
export const BRON = 'call';

const ZONE = 'Europe/Amsterdam';
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/** Dag ('JJJJ-MM-DD') en tijd ('HH:MM') in Amsterdamse tijd. Nooit via toISOString(). */
export function dagEnTijd(ts) {
  const ms = ts == null ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(new Date(ms))) m[p.type] = p.value;
  return { dag: `${m.year}-${m.month}-${m.day}`, tijd: `${m.hour}:${m.minute}` };
}

/** '2026-09-08' → '8 september'. */
export function nlDatum(dag) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dag || ''))) return String(dag || '');
  const [, m, d] = dag.split('-').map(Number);
  return `${d} ${MAANDEN[m - 1]}`;
}

/** De zin op de kaart, in Daves taal. */
export function kaartNotitie(afspraak) {
  const z = dagEnTijd(afspraak && afspraak.scheduled_at);
  if (!z) return 'Kwam niet opdagen bij een zoomcall.';
  return `Kwam niet opdagen bij de zoomcall van ${nlDatum(z.dag)} om ${z.tijd}.`;
}

/**
 * De bestaande kaarten op hun appointment_id zetten.
 *
 * Apart en puur, want dit IS de ontdubbeling. Zat hij alleen in de cron, dan is
 * hij pas in productie te zien — en de ontdubbeling is precies het ding dat
 * niet stil mag falen.
 *
 * Bij twee kaarten voor dezelfde afspraak wint de eerste; welke dat is maakt
 * niet uit, want beide betekenen 'er is er al een'.
 */
export function kaartenPerAfspraak(rijen) {
  const uit = new Map();
  for (const t of (Array.isArray(rijen) ? rijen : [])) {
    const aid = t && t.bron_ref && t.bron_ref.appointment_id;
    if (aid && !uit.has(String(aid))) uit.set(String(aid), t);
  }
  return uit;
}

// ── De uitkomsten ─────────────────────────────────────────────────────────
export const AANMAKEN = 'aanmaken';
export const NIETS    = 'niets';

export const GEEN_NO_SHOW  = 'geen_no_show';
export const VOOR_DE_GRENS = 'voor_de_grens';
export const AL_EEN_KAART  = 'al_een_kaart';
export const GEEN_ID       = 'geen_appointment_id';

/**
 * Moet er voor deze no-show een kaart komen?
 *
 * Pure functie: geen database, geen klok uit het niets.
 *
 * @param {object}  afspraak         rij uit follow_up_appointments
 * @param {object?} kaartVanAfspraak bestaande niet-gearchiveerde kaart met
 *   dezelfde bron_ref.appointment_id, of null
 * @param {string}  vanaf            de harde grens (JJJJ-MM-DD)
 */
export function bepaalNoShowKaart({ afspraak, kaartVanAfspraak = null, vanaf = NO_SHOW_VANAF }) {
  const a = afspraak || {};
  const z = dagEnTijd(a.scheduled_at);
  const basis = { appointment_id: a.id || null, naam: a.lead_name || 'Naamloos',
    dag: z ? z.dag : null, tijd: z ? z.tijd : null };

  if (String(a.status || '').toLowerCase() !== 'no_show') {
    return { ...basis, actie: NIETS, code: GEEN_NO_SHOW };
  }
  // Zonder id is er geen sleutel om op te ontdubbelen, en dan levert elke run
  // een nieuwe kaart op. Liever niets dan een lijst die zichzelf vult.
  if (!a.id) return { ...basis, actie: NIETS, code: GEEN_ID };

  if (!z || !/^\d{4}-\d{2}-\d{2}$/.test(vanaf) || z.dag < vanaf) {
    return { ...basis, actie: NIETS, code: VOOR_DE_GRENS };
  }
  // DE ENIGE ONTDUBBELING. Op het appointment_id, niet op naam of nummer.
  if (kaartVanAfspraak) {
    return { ...basis, actie: NIETS, code: AL_EEN_KAART, taak_id: kaartVanAfspraak.id };
  }

  return {
    ...basis, actie: AANMAKEN,
    kaart: {
      naam    : a.lead_name || 'Naamloos',
      email   : a.lead_email || null,
      telefoon: a.lead_phone || null,
      reden   : REDEN,
      bron    : BRON,
      // Dezelfde sleutel die de knop zet, plus waar deze kaart vandaan komt.
      bron_ref: {
        appointment_id: a.id,
        start         : a.scheduled_at || null,
        source        : 'opvolging-no-show-sync',
        zoom_url      : a.zoom_join_url || null,
      },
      badge_label: 'Niet gekomen',
      notitie    : kaartNotitie(a),
      status     : 'open',
      later      : false,
    },
  };
}
