// api/_lib/opvolging-dagbeeld.js
//
// EEN DAG MOET ACHTERAF TE RECONSTRUEREN ZIJN.
//
// Maxims eis, en de reden erachter is scherper dan de wens zelf: verdwijnt een
// afspraak stilletjes uit een dag zodra iemand hem verzet, dan klopt het
// dagbeeld van gisteren morgen niet meer — en dan is het rapport over die dag
// ook niet meer waar. Wat er op een dag stond is een FEIT over die dag, en dat
// verandert niet meer door wat er daarna met de afspraak gebeurt.
//
// Dus: een zoomcall die voor een dag gepland stond blijft op die dag staan,
// ook als hij verzet, geannuleerd of niet nagekomen is. Actief in gewone
// opmaak, de rest grijs met een label erbij, en waar we het weten met de
// bestemming: 'verzet naar 15 september'.
//
// ── DE VALKUIL, EN WAAROM ER EEN KOLOM BIJ MOET ──────────────────────────
// Er zijn twee soorten verzetten, en ze zien er in de databank totaal anders
// uit:
//
//   1. NIEUWE RIJ. api/follow-up-verplaats-call.js zet de oude rij op
//      'verplaatst' en maakt een nieuwe met parent_appointment_id. De
//      oorspronkelijke dag staat dan nog gewoon in de oude rij.
//
//   2. DEZELFDE RIJ. De GHL-poll schrijft `scheduled_at` onvoorwaardelijk over
//      met wat GHL zegt. Wordt een afspraak daar verplaatst, dan verhuist de
//      rij zelf naar de nieuwe dag — zonder opvolger, zonder melding. Sander
//      De Groot ging zo van 7 naar 15 september.
//
// In geval 2 is de oorspronkelijke dag na de sync WEG. Je kunt hem dan niet
// grijs tonen, want je weet niet meer dát hij er stond. Geen enkele slimmigheid
// op de bestaande kolommen haalt dat terug: de waarde is overschreven.
//
// Vandaar `follow_up_appointments.eerst_gepland_op` — gezet bij het aanmaken en
// daarna NOOIT bijgewerkt. Zie de migratie: die onveranderlijkheid wordt door
// een database-trigger afgedwongen en niet door discipline in de code, want de
// poll schrijft elke vijf minuten een volledige rij weg en zou hem anders
// meenemen.
//
// Bijvangst die precies goed uitkomt: staat `eerst_gepland_op` op een andere
// dag dan `scheduled_at`, dan wéten we waarheen het verzet is — de rij draagt
// zelf allebei de dagen. Juist het moeilijke geval geeft de bestemming gratis.

const ZONE = 'Europe/Amsterdam';

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

/**
 * De dag waarop deze afspraak OORSPRONKELIJK stond.
 *
 * `eerst_gepland_op` wint, want die overleeft een verzetting in dezelfde rij.
 * Ontbreekt hij — de migratie is nog niet gedraaid, of de rij is ouder — dan is
 * `scheduled_at` het beste wat we hebben. Dat is dan geen leugen maar een
 * beperking, en de aanroeper hoort dat te melden in plaats van te doen alsof.
 */
export function oorspronkelijkeDag(a) {
  const eerst = a && a.eerst_gepland_op ? dagEnTijd(a.eerst_gepland_op) : null;
  if (eerst) return eerst.dag;
  const nu = a ? dagEnTijd(a.scheduled_at) : null;
  return nu ? nu.dag : null;
}

/** Het tijdstip zoals het op die oorspronkelijke dag stond. */
export function oorspronkelijkeTijd(a) {
  const eerst = a && a.eerst_gepland_op ? dagEnTijd(a.eerst_gepland_op) : null;
  if (eerst) return eerst.tijd;
  const nu = a ? dagEnTijd(a.scheduled_at) : null;
  return nu ? nu.tijd : null;
}

/**
 * Naar welke dag is deze afspraak verzet? Null als hij niet verzet is.
 *
 * Alleen het geval 'dezelfde rij': de rij draagt dan zelf de oude en de nieuwe
 * dag. Voor het geval met een opvolgerrij weet de aanroeper de bestemming uit
 * die andere rij; die koppeling hoort niet hier maar bij wie beide rijen heeft.
 */
export function verzetNaar(a) {
  if (!a || !a.eerst_gepland_op) return null;
  const eerst = dagEnTijd(a.eerst_gepland_op);
  const nu    = dagEnTijd(a.scheduled_at);
  if (!eerst || !nu || eerst.dag === nu.dag) return null;
  return { dag: nu.dag, tijd: nu.tijd };
}

/** De statussen waarbij de afspraak nog gewoon staat. */
const ACTIEF = new Set(['scheduled', 'in_progress']);

export const ACTIEF_STAAT   = 'actief';
export const VERZET         = 'verzet';
export const GEANNULEERD    = 'geannuleerd';
export const NIET_GEKOMEN   = 'niet_gekomen';
export const GEWEEST        = 'geweest';
export const ONBEKEND       = 'onbekend';

/**
 * Hoe deze afspraak op zijn oorspronkelijke dag getoond hoort te worden.
 *
 * Geeft de staat, een label in Daves taal, en of de regel doorgehaald hoort te
 * zijn. De tekst staat HIER en niet in de views: het callsblok, het rapport en
 * de printweergave tonen alle drie hetzelfde, en drie kopieën van dezelfde
 * formulering lopen vroeg of laat uiteen.
 *
 * ONBEKEND IS EEN EIGEN GEVAL. follow_up_appointments.status draagt meer
 * waarden dan de CHECK-constraint noemt; een toekomstige waarde stilzwijgend
 * als 'geweest' boeken zou een dagbeeld opleveren dat niet klopt. Zelfde regel
 * als callStaat in het rapport.
 */
export function toonStaat(a, nuMs = Date.now(), { negeerVerplaatsing = false } = {}) {
  const status = String((a && a.status) || 'scheduled').toLowerCase();
  // Op de NIEUWE dag is de verplaatsing geen bijzonderheid meer: daar staat hij
  // gewoon. Alleen zijn eigen status telt dan nog.
  const naar   = negeerVerplaatsing ? null : verzetNaar(a);

  if (status === 'verplaatst' || status === 'wacht_op_reschedule' || naar) {
    return {
      staat: VERZET, doorgehaald: true,
      label: naar ? 'verzet naar ' + nlDatum(naar.dag) + (naar.tijd ? ' om ' + naar.tijd : '') : 'verzet',
    };
  }
  if (status === 'cancelled' || status === 'canceled' || status === 'verwijderd') {
    return { staat: GEANNULEERD, doorgehaald: true, label: 'geannuleerd' };
  }
  if (status === 'no_show' || status === 'noshow') {
    return { staat: NIET_GEKOMEN, doorgehaald: true, label: 'niet gekomen' };
  }
  if (status === 'completed') {
    // Niet doorgehaald: deze call heeft gewoon plaatsgevonden. Grijs zou hier
    // lezen als 'ging niet door', en dat is het tegenovergestelde.
    return { staat: GEWEEST, doorgehaald: false, label: 'geweest' };
  }
  if (ACTIEF.has(status)) {
    return { staat: ACTIEF_STAAT, doorgehaald: false, label: null };
  }
  return { staat: ONBEKEND, doorgehaald: true, label: 'status onbekend (' + status + ')' };
}

/**
 * De statussen waarbij de rij op zijn NIEUWE dag nog iets voorstelt.
 *
 * Een afspraak die van 1 naar 8 september is verplaatst vindt op de 8e echt
 * plaats, en hoort daar dus ook te staan — anders verdwijnt hij van de dag
 * waarop hij gebeurt, en dat is precies het gat dat dit bestand moet dichten,
 * alleen de andere kant op.
 *
 * `verplaatst`, `wacht_op_reschedule`, `cancelled` en `verwijderd` niet: die
 * rij gaat nergens meer door, dus die hoort ook op geen tweede dag te staan.
 */
const LEEFT_OP_NIEUWE_DAG = new Set(['scheduled', 'in_progress', 'completed', 'no_show', 'noshow']);

/**
 * Op welke dag of dagen hoort deze afspraak te staan?
 *
 * Meestal één. Twee als de rij zelf naar een andere dag is verplaatst: op de
 * oude dag als 'verzet naar …', op de nieuwe dag als de afspraak zelf. Dat is
 * geen dubbeling maar twee verschillende feiten — wat er die dag stond, en wat
 * er die dag staat.
 */
export function dagenVoorAfspraak(a, nuMs = Date.now()) {
  const oud = oorspronkelijkeDag(a);
  const nu  = a ? (dagEnTijd(a.scheduled_at) || {}).dag : null;
  const uit = [];
  if (oud) uit.push({ dag: oud, tijd: oorspronkelijkeTijd(a), toon: toonStaat(a, nuMs) });
  if (nu && nu !== oud && LEEFT_OP_NIEUWE_DAG.has(String((a && a.status) || '').toLowerCase())) {
    uit.push({
      dag : nu,
      tijd: (dagEnTijd(a.scheduled_at) || {}).tijd,
      toon: toonStaat(a, nuMs, { negeerVerplaatsing: true }),
      verzet_van: oud,
    });
  }
  return uit;
}

/**
 * Welke knoppen horen er bij deze regel?
 *
 * ── WAAROM DIT MEER IS DAN OPMAAK ────────────────────────────────────────
 * Dave kan alleen afronden bij een call die hij ZIET. Zolang de dagweergave op
 * `scheduled` filterde, verdween een afspraak uit de lijst zodra hij een andere
 * status kreeg — en daarmee verdween ook de kans om er een uitkomst aan te
 * hangen. Mehran Jahani en Sebastian Kolodziejski kregen op 9 september de
 * status no_show en waren uit beeld voordat iemand er iets mee kon. Ze zijn niet
 * vergeten door nalatigheid; het scherm toonde ze niet meer.
 *
 * Het dagbeeld is dus niet alleen een weergavefix: het is wat die uitkomst
 * alsnog vastlegbaar maakt. Een regel die je wél ziet maar niets mee kunt, maakt
 * het probleem zichtbaar zonder het op te lossen.
 *
 * Vandaar dat 'doorgehaald' NIET bepaalt of er knoppen zijn. Een no-show is
 * grijs én afrondbaar; dat is precies de regel waar het om gaat.
 *
 * api/follow-up-appointment-outcome.js weigert een afspraak met een andere
 * status niet — hij haalt de rij op, controleert de rol en gaat door. De knop
 * werkt dus ook op een afspraak van gisteren die al op no_show staat.
 */
export function knoppenVoor(a, nuMs = Date.now(), { opNieuweDag = false } = {}) {
  const status = String((a && a.status) || 'scheduled').toLowerCase();
  const heeftNummer = !!(a && a.lead_phone);
  const start = a ? Date.parse(a.scheduled_at) : NaN;
  const geweest = Number.isFinite(start) && start < nuMs;

  // De regel op zijn OUDE dag, van een afspraak die inmiddels verplaatst is:
  // de uitkomst hoort bij de nieuwe datum, niet hier. Anders legt Dave een
  // no-show vast op een call die gewoon verzet is.
  const verplaatstWeg = !opNieuweDag && !!verzetNaar(a);

  // Nergens meer iets aan te doen.
  const dood = verplaatstWeg
    || status === 'cancelled' || status === 'canceled'
    || status === 'verwijderd' || status === 'verplaatst'
    || status === 'wacht_op_reschedule';

  return {
    // Afronden mag bij alles wat echt heeft plaatsgevonden of nog moet
    // plaatsvinden — inclusief een no-show, want DAT is de hele reden.
    afronden: !dood,
    bellen  : !dood && heeftNummer,
    whatsapp: !dood && heeftNummer,
    // De Zoom-link bij een call die al geweest is nodigt uit tot een gesprek
    // dat niemand verwacht.
    zoom    : !dood && !geweest && !!(a && a.zoom_join_url),
  };
}

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

/** '2026-09-15' → '15 september'. Het jaar erbij als het een ander jaar is. */
export function nlDatum(dag, nuMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dag || ''))) return String(dag || '');
  const [j, m, d] = dag.split('-').map(Number);
  const ditJaar = dagEnTijd(nuMs);
  const zelfdeJaar = ditJaar && Number(ditJaar.dag.slice(0, 4)) === j;
  return `${d} ${MAANDEN[m - 1]}${zelfdeJaar ? '' : ' ' + j}`;
}
