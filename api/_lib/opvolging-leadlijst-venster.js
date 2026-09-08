// api/_lib/opvolging-leadlijst-venster.js
//
// WELKE ZOOMCALL-LEADS HOREN OP DE LEADLIJST, EN VOOR HOE LANG.
//
// ── HET GAT DAT DIT DICHT ────────────────────────────────────────────────
// De brug filtert op de lijst uit api/opvolging-whatsapp-nummers.js, en die
// werd uitsluitend uit `opvolging_taken` gebouwd. Sectie 3 van het rapport
// vraagt daarentegen of er vóór 09:00 een spraakbericht ging naar leads met een
// ZOOMCALL die dag. Twee verschillende verzamelingen.
//
// Gevolg, gemeten op 8 september: acht zoomcalls, nul bijbehorende opvolgtaken.
// De brug had letterlijk nooit van die mensen gehoord, gooide elk bericht weg
// als 'niet_op_leadlijst' (20 op message_create, 21 op message), en het rapport
// meette structureel nul voor iedereen die alleen een zoomcall heeft. Dat is
// geen storing: het privacyfilter deed precies wat het moet doen.
//
// Het rapport meet dus een verzameling waar de brug nooit van gehoord heeft.
//
// ── WAAROM HET VENSTER KRAP IS ───────────────────────────────────────────
// Dit filter is een PRIVACYGRENS. Daves privécontacten lopen over dezelfde
// telefoon, en elk nummer dat we toevoegen is een gesprek dat het CRM in mag.
// De hele afsprakenhistorie toevoegen zou die grens permanent verbreden, en dat
// is precies wat dit filter moet voorkomen.
//
// Dus alleen rond het moment dat er contact te verwachten valt: vanaf gisteren
// tot enkele dagen vooruit. Iemand met een afspraak van drie maanden geleden
// hoort er niet in, en iemand met een afspraak over een maand ook niet — die
// komt vanzelf in beeld als de dag nadert.

/** Van gisteren (het spraakbericht kan de avond ervoor zijn gegaan)… */
export const VENSTER_TERUG_DAGEN = 1;
/** …tot een paar dagen vooruit, zodat een afspraak van morgen al meetelt. */
export const VENSTER_VOORUIT_DAGEN = 3;

/** De statussen waarbij de afspraak nog leeft. Geannuleerd hoort er niet bij. */
export const LEVENDE_STATUSSEN = ['scheduled', 'in_progress', 'no_show', 'completed'];

/**
 * De grenzen van het venster, als ISO-tijdstippen.
 *
 * @param {number} nuMs referentiemoment; injecteerbaar zodat de test niet van
 *   de klok afhangt.
 */
export function venster(nuMs = Date.now()) {
  const dag = 24 * 60 * 60 * 1000;
  return {
    vanIso: new Date(nuMs - VENSTER_TERUG_DAGEN * dag).toISOString(),
    totIso: new Date(nuMs + VENSTER_VOORUIT_DAGEN * dag).toISOString(),
  };
}

/**
 * Hoort deze afspraak in het venster?
 *
 * Pure functie zodat de grens vastligt in een test in plaats van in een query
 * die niemand naleest — anders schuift hij ooit stilletjes op en verbreedt de
 * privacygrens zonder dat iemand het merkt.
 */
export function valtInVenster(scheduledAt, nuMs = Date.now()) {
  const ms = scheduledAt ? new Date(scheduledAt).getTime() : NaN;
  if (!Number.isFinite(ms)) return false;
  const { vanIso, totIso } = venster(nuMs);
  return ms >= Date.parse(vanIso) && ms <= Date.parse(totIso);
}

// ── VANAF WELKE DAG DEKT DE LEADLIJST DE ZOOMCALL-LEADS? ─────────────────
// Een dag vóór deze datum is voor sectie 3 NIET MEETBAAR, en dat is iets
// anders dan 'er ging geen spraakbericht'. De brug gooide toen elk bericht
// naar een lead zonder opvolgtaak weg voordat het geregistreerd kon worden.
// Het rapport mag daar geen verwijt van maken; het hoort te zeggen dat het
// die dag niet kon meten.
//
// Waarom een datum en geen berekening: of een nummer op de lijst stond op het
// moment dat het bericht ging, is achteraf nergens uit af te leiden. De lijst
// wordt live opgebouwd en niet bewaard. Het enige harde feit is de dag waarop
// deze code live ging — dus dat is wat hier staat, en dan lapst de blinde vlek
// vanzelf in plaats van voor altijd te blijven hangen.
//
// ⚠ SCHUIFT DE DEPLOY OP, SCHUIF DEZE DATUM MEE. Staat hier een dag vóór de
// echte deploy, dan beweert het rapport iets gemeten te hebben wat het niet
// kon meten — precies de fout die dit hele blok moet voorkomen.
export const DEKKING_VANAF = '2026-09-09';

/**
 * Kon de brug op deze dag de zoomcall-leads überhaupt doorlaten?
 *
 * @param {string} dag 'JJJJ-MM-DD' in Amsterdamse tijd, zoals de rest van het
 *   rapport dagen benoemt. Stringvergelijking mag: ISO-datums sorteren
 *   lexicografisch gelijk aan chronologisch.
 */
export function leadlijstDektDag(dag) {
  const d = String(dag || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;   // onbekend = niet meetbaar
  return d >= DEKKING_VANAF;
}
