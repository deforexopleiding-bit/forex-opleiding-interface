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
// wat er daarna ook mee gebeurt.
//
// ── WAT DEZE MODULE WEL EN NIET ZEGT ────────────────────────────────────
// Maxims grens, en die bepaalt alles hieronder: de module praat GHL-statussen
// niet na als waren het haar eigen oordeel. `no_show`, `completed`,
// `cancelled` en `in_progress` komen van buiten, kunnen door iedereen gezet
// worden en zeggen niets over wat Dave heeft vastgelegd. Een regel met
// 'niet gekomen' erop suggereert een uitkomst die niemand hier heeft
// opgeschreven.
//
// Wat dit bestand daarom nog wél zegt is één ding: het AGENDAFEIT. Deze
// afspraak stond op deze dag, hij is verzet, en waarheen als we dat weten.
// Meer niet. Een uitkomst tonen doet uitsluitend de afrondchip uit
// _lib/opvolging-call-afgerond.js, en die leest alleen `uitkomst` — de kolom
// die enkel door Daves eigen afrondknop wordt geschreven.
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
 * IS DEZE RIJ VERZET, EN WAARHEEN? — dag én uur.
 *
 * ── GEMETEN OP 11 SEPTEMBER, ±13:50 ──────────────────────────────────────
 * Redouane Jerroudi (appointment ac93ae66…) was in dezelfde rij verzet van
 * 15:00 naar 19:00, op dezelfde dag. De weekagenda toonde 19:00 (die leest
 * `scheduled_at`), maar 'Calls van vandaag' toonde 15:00, zonder label en met
 * alle knoppen aan. Voor Dave stond de call dus op het verkeerde uur, en niets
 * op het scherm zei dat er iets verschoven was.
 *
 * De oorzaak stond hier: de vergelijking ging alleen over de DAG. Bleef die
 * gelijk, dan was het antwoord 'niet verzet' — terwijl er vier uur tussen zat.
 * Corne Heeren (zelfde rij, andere dag) werkte wél, en dat is precies waarom
 * het zo lang onzichtbaar bleef: het gat zat alleen binnen één dag.
 *
 * @returns {?{dag:string,tijd:string,van:{dag:string,tijd:string},zelfdeDag:boolean}}
 */
export function verzetMoment(a) {
  if (!a || !a.eerst_gepland_op) return null;
  const eerst = dagEnTijd(a.eerst_gepland_op);
  const nu    = dagEnTijd(a.scheduled_at);
  if (!eerst || !nu) return null;
  if (eerst.dag === nu.dag && eerst.tijd === nu.tijd) return null;
  return {
    dag: nu.dag, tijd: nu.tijd,
    van: { dag: eerst.dag, tijd: eerst.tijd },
    zelfdeDag: eerst.dag === nu.dag,
  };
}

/**
 * Naar welke DAG is deze afspraak verzet? Null als hij niet naar een andere dag
 * is verzet.
 *
 * Bewust alleen de andere dag, want daar hangt meer aan dan een label: een
 * verzetting naar een andere dag haalt de regel door en neemt de knoppen weg
 * (de uitkomst hoort bij de nieuwe datum). Binnen dezelfde dag geldt dat juist
 * NIET — die call gebeurt vandaag, alleen later, en Dave moet hem gewoon kunnen
 * afronden. Zie binnenDagVerzet hieronder.
 *
 * Alleen het geval 'dezelfde rij': de rij draagt dan zelf de oude en de nieuwe
 * dag. Voor het geval met een opvolgerrij weet de aanroeper de bestemming uit
 * die andere rij; die koppeling hoort niet hier maar bij wie beide rijen heeft.
 */
export function verzetNaar(a) {
  const m = verzetMoment(a);
  return (m && !m.zelfdeDag) ? { dag: m.dag, tijd: m.tijd } : null;
}

/**
 * Verzet BINNEN dezelfde dag — een ander uur, dezelfde dag.
 *
 * Dit is geen doorhaling en geen reden om knoppen weg te nemen. Het is één
 * mededeling: de call staat nu op een ander uur dan waarop hij geboekt was.
 *
 * @returns {?{van:string,naar:string}} de twee uren, of null.
 */
export function binnenDagVerzet(a) {
  const m = verzetMoment(a);
  if (!m || !m.zelfdeDag) return null;
  return { van: m.van.tijd, naar: m.tijd };
}

// De twee statussen die een AGENDA-uitspraak doen in plaats van een oordeel
// over het gesprek: deze afspraak gaat hier niet meer door, hij wordt verzet.
// Dat is dezelfde soort mededeling als een verplaatste datum, en het is de
// enige status die dit bestand nog laat meespreken.
//
// De andere kant is bewust dicht: `cancelled`, `no_show`, `completed` en
// `in_progress` leveren GEEN label meer op. Wat daarvan waar is voor Dave
// staat in `uitkomst`, en dat toont de afrondchip.
const VERZET_STATUSSEN = new Set(['verplaatst', 'wacht_op_reschedule']);

/**
 * Het agendafeit van deze afspraak op de dag waarop hij stond.
 *
 * Twee bronnen, en ze vullen elkaar aan:
 *   · `eerst_gepland_op` verschilt van `scheduled_at` — dan is hij verzet ÉN
 *     weten we waarheen. Dat is onze eigen onveranderlijke kolom.
 *   · status 'verplaatst' / 'wacht_op_reschedule' — dan is hij verzet en weten
 *     we de bestemming (nog) niet.
 *
 * @returns {{verzet:boolean,label:?string,doorgehaald:boolean,naar:?object}}
 */
export function agendaFeit(a, { negeerVerplaatsing = false } = {}) {
  // Op de NIEUWE dag is de verplaatsing geen bijzonderheid meer: daar staat hij
  // gewoon, en dan is er niets te melden.
  if (negeerVerplaatsing) return { verzet: false, label: null, doorgehaald: false, naar: null };

  const naar   = verzetNaar(a);
  const status = String((a && a.status) || '').toLowerCase();
  if (!naar && !VERZET_STATUSSEN.has(status)) {
    // BINNEN DEZELFDE DAG IS GEEN DOORHALING. De call gebeurt gewoon vandaag,
    // alleen later (of eerder). `verzet: false` is hier dus geen vergissing
    // maar het hele punt: knoppenVoor() haalt de knoppen weg bij `verzet`, en
    // Dave moet deze call juist kunnen bellen en afronden. Alleen het LABEL
    // vertelt dat het uur verschoven is.
    const binnen = binnenDagVerzet(a);
    if (binnen) {
      return {
        verzet: false, doorgehaald: false, naar: null,
        label : 'verzet van ' + binnen.van,
        binnen_dag: binnen,
      };
    }
    return { verzet: false, label: null, doorgehaald: false, naar: null };
  }
  return {
    verzet: true, doorgehaald: true, naar,
    label : naar
      ? 'verzet naar ' + nlDatum(naar.dag) + (naar.tijd ? ' om ' + naar.tijd : '')
      : 'verzet',
  };
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
 *
 * DIT IS EEN PLAATSINGSREGEL, GEEN LABEL. Hij bepaalt of een regel ergens
 * getekend wordt en zegt niets over wat er dan staat — dat is het verschil met
 * de statuslabels die hier uit zijn gehaald. Een status weerhouden van een
 * tweede plek doet geen uitspraak; er 'geannuleerd' bij zetten wel.
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
export function dagenVoorAfspraak(a) {
  const oud   = oorspronkelijkeDag(a);
  const nuMom = a ? (dagEnTijd(a.scheduled_at) || {}) : {};
  const nu    = nuMom.dag || null;
  const uit = [];
  if (oud) {
    // HET UUR OP DE KAART IS HET ECHTE UUR.
    //
    // Voor een verzetting naar een ANDERE dag klopt het oorspronkelijke uur:
    // die regel staat op de oude dag en zegt wat daar stónd. Maar bij een
    // verzetting BINNEN dezelfde dag is er maar één regel, en die hoort te
    // zeggen wanneer de call is — niet wanneer hij ooit geboekt werd.
    // Redouane stond daardoor op 15:00 terwijl hij om 19:00 gebeld moest
    // worden. Het uur bepaalt ook de volgorde in de lijst, dus met het oude
    // uur staat hij bovendien op de verkeerde plek.
    const binnenDag = (oud === nu) && !!binnenDagVerzet(a);
    uit.push({
      dag : oud,
      tijd: binnenDag ? nuMom.tijd : oorspronkelijkeTijd(a),
      feit: agendaFeit(a),
    });
  }
  if (nu && nu !== oud && LEEFT_OP_NIEUWE_DAG.has(String((a && a.status) || '').toLowerCase())) {
    uit.push({
      dag : nu,
      tijd: (dagEnTijd(a.scheduled_at) || {}).tijd,
      feit: agendaFeit(a, { negeerVerplaatsing: true }),
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
 * status no_show en waren uit beeld voordat iemand er iets mee kon. Ze zijn
 * niet vergeten door nalatigheid; het scherm toonde ze niet meer.
 *
 * ── ÉÉN REDEN OM EEN KNOP WEG TE HALEN, EN DAT IS EEN AGENDAFEIT ─────────
 * Alleen op de OUDE dag van een verzette afspraak vervallen de knoppen: de
 * uitkomst hoort bij de nieuwe datum, niet hier, anders legt Dave een uitkomst
 * vast op een call die gewoon verzet is.
 *
 * Een status doet dat NIET meer. Een afspraak die elders op `cancelled` of
 * `no_show` is gezet houdt gewoon zijn knoppen: die status is niet ons oordeel,
 * en hem gebruiken om Dave een handeling te ontnemen is dezelfde fout als hem
 * als label tonen — alleen stiller, want een knop die er niet is valt niemand
 * op. Grijs betekent niet onaanraakbaar, en van buiten gezet betekent niet
 * afgehandeld.
 *
 * api/follow-up-appointment-outcome.js weigert een afspraak met een andere
 * status niet — hij haalt de rij op, controleert de rol en gaat door. De knop
 * werkt dus ook op een afspraak van gisteren die al op no_show staat.
 */
export function knoppenVoor(a, nuMs = Date.now(), { opNieuweDag = false } = {}) {
  const heeftNummer = !!(a && a.lead_phone);
  const start = a ? Date.parse(a.scheduled_at) : NaN;
  const geweest = Number.isFinite(start) && start < nuMs;

  // Het enige geval: de regel op zijn oude dag van een afspraak die verzet is.
  const weg = !opNieuweDag && agendaFeit(a).verzet;

  return {
    afronden: !weg,
    bellen  : !weg && heeftNummer,
    whatsapp: !weg && heeftNummer,
    // De Zoom-link bij een call die al geweest is nodigt uit tot een gesprek
    // dat niemand verwacht. Dat is de klok, geen status.
    zoom    : !weg && !geweest && !!(a && a.zoom_join_url),
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

// ═══════════════════════════════════════════════════════════════════════════
// DE BESTEMMING VAN EEN VERZETTE AFSPRAAK — UIT DE OPVOLGER
// ═══════════════════════════════════════════════════════════════════════════
//
// agendaFeit() leest de bestemming uit `eerst_gepland_op`, en dat werkt voor de
// ENE vorm van verzetten: dezelfde rij, scheduled_at overgezet (sander De
// groot). Bij de ANDERE vorm — de goede, die verzetAfspraak() maakt — blijft de
// oude rij op zijn eigen moment staan met status 'verplaatst', en woont het
// nieuwe moment in een tweede rij met parent_appointment_id.
//
// Op de oude dag leverde dat 'verzet' op, zonder waarheen. Dave ziet dan wel
// dat de call weg is, maar niet of hij morgen of over drie weken terugkomt —
// en dat is precies het stukje dat hij nodig heeft om te weten of er nog iets
// moet gebeuren.
//
// Pure functie, met de opvolgers als gewone lijst erbij. Het ophalen doet de
// aanroeper; zo staat de regel in een test in plaats van in een query.

/**
 * Een tabel van parent-id → het moment van de opvolger.
 *
 * Meerdere opvolgers op dezelfde parent horen niet te bestaan, maar als het
 * gebeurt wint de LAATSTE: dat is het moment waarop de afspraak nu staat.
 *
 * @param {Array} kinderen rijen met parent_appointment_id + scheduled_at
 * @returns {Map<string,{dag:string,tijd:string}>}
 */
export function bestemmingPerParent(kinderen) {
  const uit = new Map();
  for (const k of (Array.isArray(kinderen) ? kinderen : [])) {
    const ouder = k && k.parent_appointment_id;
    if (!ouder) continue;
    const m = dagEnTijd(k.scheduled_at);
    if (!m) continue;
    const vorige = uit.get(String(ouder));
    if (vorige && Date.parse(k.scheduled_at) <= (vorige.ms || 0)) continue;
    uit.set(String(ouder), { dag: m.dag, tijd: m.tijd, ms: Date.parse(k.scheduled_at) });
  }
  return uit;
}

/**
 * Vult 'verzet naar …' aan op de regels waarvan de bestemming in een opvolger
 * staat. Verandert alleen regels die AL als verzet gemarkeerd zijn — dit voegt
 * de bestemming toe, het spreekt geen nieuw oordeel uit.
 *
 * @param {Array} dagen      de dagen zoals voegAgendaSamen ze oplevert
 * @param {Map}   bestemming uit bestemmingPerParent()
 * @returns {number} aantal aangevulde regels
 */
export function vulVerzetBestemming(dagen, bestemming) {
  if (!bestemming || bestemming.size === 0) return 0;
  let n = 0;
  for (const d of (Array.isArray(dagen) ? dagen : [])) {
    for (const c of ((d && d.gepland) || [])) {
      if (!c || !c.appointment_id) continue;
      // Alleen waar de bestemming nog ontbreekt: staat er al 'verzet naar 15
      // september', dan komt die uit eerst_gepland_op en is hij even waar.
      if (c.label && /verzet naar /.test(String(c.label))) continue;
      if (String(c.label || '') !== 'verzet') continue;
      const naar = bestemming.get(String(c.appointment_id));
      if (!naar) continue;
      c.label = 'verzet naar ' + nlDatum(naar.dag) + (naar.tijd ? ' om ' + naar.tijd : '');
      c.verzet_naar = { dag: naar.dag, tijd: naar.tijd };
      n += 1;
    }
  }
  return n;
}
