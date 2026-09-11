// api/_lib/opvolging-agenda-merge.js
//
// Fase 2 DEEL B — vrij en bezet samenvoegen tot één weekweergave.
//
// Twee bronnen die niets van elkaar weten:
//   · GHL free-slots  → wat Dave's kalender aanbiedt, in { date, times[] }.
//   · follow_up_appointments → wat wij zelf geboekt hebben, als timestamps.
//
// Ze overlappen niet vanzelf. GHL kent onze afspraken meestal wél (ze zijn
// daar geboekt), maar niet altijd: een afspraak die buiten GHL om in onze
// tabel staat, of een GHL-antwoord dat net vóór een boeking is opgehaald,
// levert een slot op dat vrij lijkt en het niet is. Daarom trekken we bezet
// altijd van vrij af. Dubbel boeken is een afspraak die iemand misloopt;
// een slot te weinig tonen kost hooguit een kwartier.
//
// Pure functie, geen netwerk, geen database — zie tests/opvolging-agenda-merge.test.js.

import { afrondActie } from './opvolging-call-afgerond.js';
import { dagenVoorAfspraak, knoppenVoor } from './opvolging-dagbeeld.js';

/** Statussen die een moment daadwerkelijk bezet houden. */
const BEZET_STATUSSEN = new Set(['scheduled', 'in_progress']);

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dag + tijd van een timestamp, uitgedrukt in de agenda-tijdzone.
 *
 * Nooit toISOString().slice() gebruiken: dat is UTC, en een afspraak van 00:30
 * in Amsterdam valt daarmee op de vorige dag. Zie de lessons in CLAUDE.md —
 * dit is precies de off-by-one die niemand opmerkt tot iemand op de verkeerde
 * dag zit te wachten.
 */
export function delenInZone(ms, timeZone = 'Europe/Amsterdam') {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(ms))) map[p.type] = p.value;
  return { dag: `${map.year}-${map.month}-${map.day}`, tijd: `${map.hour}:${map.minute}` };
}

/**
 * Het omgekeerde van delenInZone: 'YYYY-MM-DD' + 'HH:mm' in de agenda-tijdzone
 * → de ISO-instant die daarbij hoort.
 *
 * Hiermee draagt elk vrij moment in het antwoord al zijn eigen ISO-tijdstip. De
 * browser hoeft dan niets meer om te rekenen bij het boeken — hij stuurt terug
 * wat hij kreeg. Tijdzone-rekenwerk in de browser is precies waar een klik op
 * 10:00 een afspraak om 11:00 wordt, en dat merk je pas als er iemand voor
 * niets zit te wachten.
 *
 * Werkt door te gissen (UTC) en daarna de fout te corrigeren met de offset op
 * dat moment. Twee rondes, want de eerste correctie kan zelf over een
 * DST-grens springen.
 */
export function zoneMomentNaarIso(dag, tijd, timeZone = 'Europe/Amsterdam') {
  if (!DATUM_RE.test(String(dag || '')) || !/^\d{2}:\d{2}$/.test(String(tijd || ''))) return null;
  const [y, m, d] = dag.split('-').map(Number);
  const [uu, mi]  = tijd.split(':').map(Number);
  // '25:00' past wel in het patroon maar bestaat niet. Date.UTC rolt zoiets
  // stilletjes door naar de volgende dag; dan zou een onmogelijke tijd een
  // geldig ogende afspraak opleveren.
  if (uu > 23 || mi > 59) return null;
  const doel = Date.UTC(y, m - 1, d, uu, mi, 0);
  let gok = doel;
  for (let i = 0; i < 2; i++) {
    const p = delenInZone(gok, timeZone);
    const [gy, gm, gd] = p.dag.split('-').map(Number);
    const [gu, gmi]    = p.tijd.split(':').map(Number);
    const alsUtc = Date.UTC(gy, gm - 1, gd, gu, gmi, 0);
    const fout = alsUtc - doel;
    if (fout === 0) break;
    gok -= fout;
  }
  return new Date(gok).toISOString();
}

/** Alle dagen van van t/m tot, inclusief. Kalenderrekenwerk in UTC-noon zodat DST niet meetelt. */
export function dagenTussen(van, tot) {
  if (!DATUM_RE.test(String(van || '')) || !DATUM_RE.test(String(tot || ''))) return [];
  const start = Date.parse(`${van}T12:00:00Z`);
  const eind  = Date.parse(`${tot}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(eind) || eind < start) return [];
  const uit = [];
  for (let ms = start; ms <= eind; ms += 86400000) uit.push(new Date(ms).toISOString().slice(0, 10));
  return uit;
}

/**
 * Voegt vrij en bezet samen tot één rij dagen.
 *
 *   slots        — [{ date:'YYYY-MM-DD', times:['09:00', ...] }] uit free-slots.
 *   afspraken    — [{ scheduled_at, lead_name, status, id }] uit follow_up_appointments.
 *   van / tot    — YYYY-MM-DD, inclusief. Bepaalt welke dagen er in de uitvoer staan,
 *                  ook als er voor die dag niets is (een lege kolom is informatie:
 *                  'hier is niets vrij' leest anders dan 'deze dag bestaat niet').
 *   timeZone     — komt uit het GHL-antwoord; wij verzinnen 'm niet.
 *
 * Uitvoer per dag: { dag, vrij: [{tijd}], bezet: [{tijd, naam, status}] }.
 * Een tijd die in allebei voorkomt telt als bezet en verdwijnt uit vrij.
 */
export function voegAgendaSamen({ slots, afspraken, van, tot, timeZone = 'Europe/Amsterdam', nuMs = Date.now() }) {
  const dagen = dagenTussen(van, tot);
  const inVenster = new Set(dagen);

  // ── PROEFRIJEN HOREN NIET IN HET DAGBEELD ────────────────────────────────
  // Eén filter, helemaal bovenaan, zodat een testrij nergens half doorlekt —
  // niet in `bezet`, niet in `gepland`, niet in `afgerond`.
  //
  // OP DE KOLOM, NOOIT OP DE NAAM. Filteren op 'test' in lead_name zou de
  // eerste echte klant die Tessa of Testerink heet uit Daves dag laten
  // verdwijnen, en dat merkt niemand tot de call gemist is. De kolom is
  // expliciet gezet en na te kijken; een naampatroon is een gok die zich
  // voordoet als een regel.
  //
  // Bestaat de kolom nog niet, dan is `is_test` overal undefined en filtert
  // dit niets weg — het dagbeeld gedraagt zich dan als voorheen.
  //
  // ALLEEN HIER, NIET IN HET RAPPORT. Deze functie wordt uitsluitend door
  // api/opvolging-agenda.js gebruikt; het rapport telt zijn eigen rijen en
  // blijft ongemoeid.
  const echt = (Array.isArray(afspraken) ? afspraken : []).filter((a) => a && a.is_test !== true);

  // ── WAT ER OP DIE DAG STOND, ONGEACHT WAT ERVAN GEWORDEN IS ─────────────
  // Maxims eis: een zoomcall die verzet is blijft hard op zijn oorspronkelijke
  // dag staan, in het grijs, met de bestemming erbij. Hij mag niet meer stil
  // uit de dag verdwijnen, want dan klopt het dagbeeld van gisteren morgen niet
  // meer.
  //
  // DRIE LIJSTEN, MET OPZET, want ze beantwoorden drie vragen:
  //   bezet    — welke vrije momenten vallen weg? Een geannuleerde afspraak
  //              hoort daar NIET in, anders blokkeert een afzegging voorgoed
  //              een slot dat vrij is.
  //   afgerond — wat heeft Dave zelf afgerond? Leest alleen `uitkomst`.
  //   gepland  — wat stond er die dag? Het dagbeeld.
  // Ze bij elkaar trekken is precies de fout die je pas merkt als iemand niet
  // meer kan boeken.
  //
  // De dag komt uit oorspronkelijkeDag(), niet uit scheduled_at: een afspraak
  // die in dezelfde rij naar een andere dag is verplaatst hoort te blijven
  // staan op de dag waarop hij stónd. Zie _lib/opvolging-dagbeeld.js.
  const geplandPerDag = new Map();
  for (const a of echt) {
    if (!a || !a.scheduled_at) continue;
    // Kan er twee opleveren: de oude dag ('verzet naar …') en de nieuwe dag,
    // waar de afspraak echt plaatsvindt. Zie dagenVoorAfspraak.
    for (const plek of dagenVoorAfspraak(a)) {
      if (!plek.dag || !inVenster.has(plek.dag)) continue;
      if (!geplandPerDag.has(plek.dag)) geplandPerDag.set(plek.dag, []);
      geplandPerDag.get(plek.dag).push({
        tijd          : plek.tijd,
        naam          : (a.lead_name && String(a.lead_name).trim()) || 'Bezet',
        status        : String(a.status || 'scheduled').toLowerCase(),
        // Het agendafeit, en niets anders. Geen label uit een status: wat er
        // voor Dave waar is staat in `afrond` hieronder.
        label         : plek.feit.label,
        doorgehaald   : plek.feit.doorgehaald,
        verzet_naar   : plek.verzet_van ? null : plek.feit.naar,
        verzet_van    : plek.verzet_van || null,
        // Verzet binnen dezelfde dag: geen doorhaling, wel een ander uur. Los
        // veld zodat het na te meten is zonder het label te moeten uitparsen.
        verzet_binnen_dag: plek.feit.binnen_dag || null,
        // Heeft Dave deze al afgerond, en waarmee? Dezelfde chip als in het
        // callsblok — de ENIGE plek waar een uitkomst getoond wordt.
        afrond        : afrondActie(a),
        // Welke knoppen hier horen. Server-side, zodat de regel op één plek
        // staat — en zodat 'grijs' niet stilzwijgend 'onaanraakbaar' gaat
        // betekenen. Zie knoppenVoor.
        knoppen       : knoppenVoor(a, nuMs, { opNieuweDag: !!plek.verzet_van }),
        appointment_id: a.id || null,
        telefoon      : a.lead_phone || null,
        email         : a.lead_email || null,
        zoom_url      : a.zoom_join_url || null,
        start         : a.scheduled_at || null,
      });
    }
  }

  // ── Bezet eerst: dat bepaalt wat er van vrij overblijft. ──────────────────
  const bezetPerDag = new Map();
  for (const a of echt) {
    if (!a || !a.scheduled_at) continue;
    const status = String(a.status || '').toLowerCase();
    // Geannuleerd of verplaatst houdt niets bezet — anders blijft een slot
    // voorgoed grijs omdat er ooit een afgezegde afspraak stond.
    if (status && !BEZET_STATUSSEN.has(status)) continue;
    const ms = Date.parse(a.scheduled_at);
    if (!Number.isFinite(ms)) continue;
    const { dag, tijd } = delenInZone(ms, timeZone);
    if (!inVenster.has(dag)) continue;
    if (!bezetPerDag.has(dag)) bezetPerDag.set(dag, new Map());
    // Twee afspraken op hetzelfde tijdstip: de eerste houdt de naam. Een
    // dubbele boeking is één bezet moment, geen twee blokjes over elkaar.
    const perTijd = bezetPerDag.get(dag);
    if (!perTijd.has(tijd)) {
      perTijd.set(tijd, {
        tijd,
        naam  : (a.lead_name && String(a.lead_name).trim()) || 'Bezet',
        status: status || 'scheduled',
        // Fase 3a — het blok 'Calls van vandaag' leest dezelfde bezette
        // momenten als Daves callrij, en heeft daarvoor meer nodig dan een
        // naam: de Zoom-link om de call te openen, en telefoon/e-mail om te
        // bellen, te appen en de bijbehorende taak te vinden. Ontbreken ze,
        // dan blijven ze null en verbergt de UI die knoppen.
        appointment_id: a.id || null,
        telefoon      : a.lead_phone || null,
        email         : a.lead_email || null,
        zoom_url      : a.zoom_join_url || null,
        start         : a.scheduled_at || null,
        // Heeft Dave deze al afgerond, en waarmee? Server-side bepaald, zodat
        // de regel op één plek staat. Zie _lib/opvolging-call-afgerond.js.
        afrond        : afrondActie(a),
      });
    }
  }

  // ── WAT DAVE ZELF AL AFGEROND HEEFT ──────────────────────────────────────
  // Zodra hij een uitkomst vastlegt gaat de afspraak naar `completed`,
  // `no_show` of `cancelled` — en die vallen geen van drieën in
  // BEZET_STATUSSEN. De regel verdween daarmee uit het callsblok op het moment
  // dat hij hem afrondde, en dan kan 'Afgerond' per definitie nooit zichtbaar
  // zijn. Precies wat Dave 's middags moet kunnen terugzien.
  //
  // Vandaar een APARTE lijst en geen verbreding van `bezet`. Dat is met opzet:
  // `bezet` bepaalt welke vrije momenten wegvallen, en daar hoort een
  // afgezegde call niet in — anders blokkeert een annulering voorgoed een slot
  // dat vrij is. Twee vragen, twee antwoorden.
  //
  // De grens is onze EIGEN uitkomst en niets anders. Een status die van elders
  // komt telt hier niet mee; de module praat geen externe waarheid na.
  const afgerondPerDag = new Map();
  for (const a of echt) {
    if (!a || !a.scheduled_at) continue;
    const oordeel = afrondActie(a);
    if (oordeel.toon !== 'uitkomst') continue;
    const ms = Date.parse(a.scheduled_at);
    if (!Number.isFinite(ms)) continue;
    const { dag, tijd } = delenInZone(ms, timeZone);
    if (!inVenster.has(dag)) continue;
    // Staat hij al bij bezet, dan hoort hij daar en niet twee keer.
    if ((bezetPerDag.get(dag) || new Map()).has(tijd)) continue;
    if (!afgerondPerDag.has(dag)) afgerondPerDag.set(dag, []);
    afgerondPerDag.get(dag).push({
      tijd,
      naam          : (a.lead_name && String(a.lead_name).trim()) || 'Bezet',
      status        : String(a.status || '').toLowerCase(),
      appointment_id: a.id || null,
      telefoon      : a.lead_phone || null,
      email         : a.lead_email || null,
      zoom_url      : a.zoom_join_url || null,
      start         : a.scheduled_at || null,
      afrond        : oordeel,
    });
  }

  // ── Vrij, minus wat bezet is. ─────────────────────────────────────────────
  const vrijPerDag = new Map();
  for (const rij of (Array.isArray(slots) ? slots : [])) {
    const dag = String(rij?.date || '');
    if (!inVenster.has(dag)) continue;
    const bezetteTijden = bezetPerDag.get(dag) || new Map();
    const uniek = new Set();
    for (const t of (Array.isArray(rij?.times) ? rij.times : [])) {
      const tijd = String(t || '').trim();
      if (!/^\d{2}:\d{2}$/.test(tijd)) continue;
      if (bezetteTijden.has(tijd)) continue;
      uniek.add(tijd);
    }
    const bestaand = vrijPerDag.get(dag) || new Set();
    for (const t of uniek) bestaand.add(t);
    vrijPerDag.set(dag, bestaand);
  }

  return dagen.map((dag) => ({
    dag,
    vrij : [...(vrijPerDag.get(dag) || new Set())].sort()
      .map((tijd) => ({ tijd, iso: zoneMomentNaarIso(dag, tijd, timeZone) })),
    bezet: [...(bezetPerDag.get(dag) || new Map()).values()].sort((a, b) => a.tijd.localeCompare(b.tijd)),
    // Wat Dave die dag zelf heeft afgerond. Apart van `bezet`, zie het blok
    // hierboven; het callsblok toont ze samen.
    afgerond: (afgerondPerDag.get(dag) || []).sort((a, b) => a.tijd.localeCompare(b.tijd)),
    // Het dagbeeld: alles wat voor deze dag gepland stond, verzet inbegrepen.
    // Zie de kop van het blok hierboven voor waarom dit naast `bezet` staat en
    // niet in plaats daarvan.
    gepland: (geplandPerDag.get(dag) || [])
      .sort((a, b) => String(a.tijd || '').localeCompare(String(b.tijd || ''))),
  }));
}
