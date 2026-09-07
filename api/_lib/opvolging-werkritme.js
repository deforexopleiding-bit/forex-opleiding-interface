// api/_lib/opvolging-werkritme.js
//
// WERKRITME — is het werk over de dag verdeeld of geklonterd?
//
// Maxims eis, in zijn woorden: Dave moet dagelijks alles afwerken en op een
// goede manier; niet één keer snel snel alles en dan de hele dag niets. Dat is
// een andere vraag dan 'hoeveel is er gedaan', en hij is met een tijdstempel te
// beantwoorden — geen reactietijd, geen trechter, geen vergelijking met vorige
// weken.
//
// Het voorbeeld waar dit blok om gebouwd is, 7 september: 36 uitgaande acties
// over slechts 6 verschillende uren, met een gat van 5,5 uur tussen 11:27 en
// 16:55. Per uur: 10u acht · 11u twee · 16u één · 17u twaalf · 19u één ·
// 20u twaalf. Drie pieken, daartussen vrijwel niets.
//
// ── DE VALKUIL VAN DIT HELE BLOK: DE TIJDZONE ──────────────────────────────
// Alles staat in UTC in de databank. In september is Amsterdam UTC+2, in
// december UTC+1, en op 25 oktober 2026 verspringt dat middenin. Wie
// `ts.slice(11,13)` doet of `getHours()` op een server in UTC, toont elk uur
// twee uur verkeerd — en dan gaat Dave terecht in beroep tegen zijn eigen
// rapport.
//
// Daarom uitsluitend Intl met een expliciete timeZone. Gecontroleerd tegen de
// zes gemeten uren hierboven én tegen de zomertijdgrens; zie
// tests/opvolging-werkritme.test.js.
//
// ── DE DREMPELS STAAN HIER, EN GAAN MEE HET RAPPORT IN ─────────────────────
// Een bevinding is een rekensom met een zichtbare drempel, geen indruk. Wat
// als werkuur telt bepaalt de hele beoordeling en mag dus geen verborgen
// aanname zijn: het staat in `drempels` en het rapport toont het.

const ZONE = 'Europe/Amsterdam';

/**
 * De werkdag: 09:00 tot en met 20:59, twaalf uren.
 *
 * Niet zomaar gekozen. De module heeft zelf al twee harde momenten: het
 * spraakbericht moet vóór 09:00 (SPRAAK_DEADLINE_UUR) en het nabellen valt
 * tussen 12 en 13. Aan de andere kant staan Daves zoomcalls om 19:00 en 20:30,
 * dus de dag eindigt niet om vijf uur. De gemeten activiteit van 7 september
 * (10u tot en met 20u) valt hier volledig binnen.
 *
 * Verander je dit, dan verandert elk oordeel eronder mee — vandaar dat het
 * getal het rapport in gaat en niet in een functie verstopt zit.
 */
export const WERKUUR_VAN = 9;
export const WERKUUR_TOT = 21;          // exclusief: het laatste werkuur is 20

/** Een stilte binnen werkuren is pas een bevinding vanaf twee uur. */
export const GAT_DREMPEL_MIN = 120;

/**
 * Onder deze bezetting heet de dag geklonterd: in minder dan 60% van de
 * werkuren is er iets gedaan. Op 7 september: 6 van 12 = 50%, dus gemeld.
 */
export const BEZETTING_DREMPEL = 0.6;

/** Het uur in Amsterdamse tijd. Nooit uit de ISO-tekst snijden. */
export function uurInZone(ts) {
  const ms = ts == null ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hourCycle: 'h23', hour: '2-digit',
  }).format(new Date(ms)));
}

/** uu:mm in Amsterdamse tijd. */
export function klokInZone(ts) {
  const ms = ts == null ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
}

const isWerkuur = (u) => u !== null && u >= WERKUUR_VAN && u < WERKUUR_TOT;

/**
 * @param {object[]} pogingen  uitgaande pogingen van ÉÉN dag, elk met `tijdstip`
 * @param {string}   dag       de dag waarover dit gaat (YYYY-MM-DD, lokaal)
 */
export function bouwWerkritme({ pogingen, dag }) {
  const rijen = (pogingen || [])
    .filter((p) => p && p.tijdstip && (!p.richting || String(p.richting) === 'uit'))
    .map((p) => ({ ms: Date.parse(p.tijdstip), uur: uurInZone(p.tijdstip), soort: p.soort || null }))
    .filter((p) => Number.isFinite(p.ms) && p.uur !== null)
    .sort((a, b) => a.ms - b.ms);

  // Het balkje per uur: ALLE werkuren staan erin, ook de lege. Een uur dat
  // ontbreekt leest als 'niet gemeten'; een uur met nul leest als 'niets
  // gedaan', en dat is hier het hele punt.
  const perUur = [];
  for (let u = WERKUUR_VAN; u < WERKUUR_TOT; u++) {
    perUur.push({ uur: u, aantal: rijen.filter((r) => r.uur === u).length });
  }
  // Acties buiten werkuren gaan niet verloren: ze worden apart geteld zodat de
  // som van het blok altijd klopt met het volume elders in het rapport.
  const buitenWerkuren = rijen.filter((r) => !isWerkuur(r.uur)).length;

  const binnen = rijen.filter((r) => isWerkuur(r.uur));
  const actieveUren = perUur.filter((u) => u.aantal > 0).length;
  const werkuren = WERKUUR_TOT - WERKUUR_VAN;

  // ── Het langste gat binnen werkuren ──────────────────────────────────────
  // Van poging tot poging, met de randen van de werkdag als begin en eind: een
  // dag die pas om vier uur begint heeft een gat van zeven uur, en dat hoort
  // net zo goed te tellen als een gat in het midden.
  let gat = null;
  if (binnen.length) {
    const dagMs = (uur) => {
      // De werkdaggrens in lokale tijd, via de eerste poging als anker: die
      // draagt de juiste offset voor déze dag, ook rond de zomertijdgrens.
      const eerste = binnen[0];
      const uurVerschil = uur - eerste.uur;
      const naarHeelUur = new Date(eerste.ms);
      naarHeelUur.setUTCMinutes(0, 0, 0);
      return naarHeelUur.getTime() + uurVerschil * 3600000;
    };
    const punten = [dagMs(WERKUUR_VAN), ...binnen.map((r) => r.ms), dagMs(WERKUUR_TOT)];
    for (let i = 1; i < punten.length; i++) {
      const minuten = Math.round((punten[i] - punten[i - 1]) / 60000);
      if (minuten <= 0) continue;
      if (!gat || minuten > gat.minuten) {
        gat = { minuten, van: klokInZone(punten[i - 1]), tot: klokInZone(punten[i]) };
      }
    }
  }

  const bevindingen = [];
  if (gat && gat.minuten >= GAT_DREMPEL_MIN) {
    const u = Math.floor(gat.minuten / 60);
    const m = gat.minuten % 60;
    bevindingen.push({
      soort : 'lang_gat',
      tekst : `Tussen ${gat.van} en ${gat.tot} is er ${u} uur${m ? ' en ' + m + ' minuten' : ''} lang niets gedaan.`,
      getallen: { van: gat.van, tot: gat.tot, minuten: gat.minuten, drempel_min: GAT_DREMPEL_MIN },
    });
  }
  if (binnen.length && actieveUren < Math.ceil(werkuren * BEZETTING_DREMPEL)) {
    bevindingen.push({
      soort : 'geklonterd',
      tekst : `Er is in ${actieveUren} van de ${werkuren} werkuren iets gedaan. Het werk zit in pieken in plaats van verdeeld over de dag.`,
      getallen: { actieve_uren: actieveUren, werkuren, drempel: BEZETTING_DREMPEL },
    });
  }

  return {
    dag,
    per_uur: perUur,
    totaal : rijen.length,
    binnen_werkuren: binnen.length,
    buiten_werkuren: buitenWerkuren,
    actieve_uren: actieveUren,
    werkuren,
    langste_gat: gat,
    bevindingen,
  };
}
