// api/_lib/lab-opvolging.js
//
// Traject "the-lab" — de opvolging van een Lab-lead. De beslissing staat hier
// als PURE functie (volgendeStap), de teksten ernaast; de cron
// (api/cron-lab-opvolging.js) haalt alleen de stand op en verstuurt.
//
// Waarom niet in de bestaande leadsonderhoud-motor: die draait op de views
// onderhoud_wachtrij/trial_warmte, die op lms_gebruikers (de trial-site van
// de 7-daagse) gebouwd zijn. Een Lab-lead staat daar nooit in, en die views
// staan niet in de repo — wijzigen zonder ze te kunnen lezen is blind werken.
// De SJABLONEN delen we wél: een rij in onderhoud_sjablonen met
// traject_slug 'the-lab' en soort = de stapnaam hieronder overschrijft de
// standaardtekst (per warmte via score_min/score_max), en levert het
// WhatsApp-template (meta_template).
//
// DE REGELS, die nooit gebroken worden:
//   - alleen met toestemming;
//   - nooit nog iets na een boeking;
//   - nooit "je bent nog niet gestart" aan wie al gestart of klaar is;
//   - hoogstens één bericht per lead per 20 uur, en niet tussen 21u en 8u;
//   - elke stap één keer (unique in lab_opvolging).

export const STAPPEN = Object.freeze([
  'niet-gestart-24u', 'bezig-24u', 'afgewerkt-d1', 'afgewerkt-d3', 'dag6', 'dag8',
]);

const UUR = 3600 * 1000;
const DAG = 24 * UUR;

/**
 * Welke stap is nu aan de beurt voor deze lead? null = niets.
 *
 * @param {object} s
 * @param {number}  s.aangemeldOp       ms — eerste aanmelding
 * @param {boolean} s.toestemming
 * @param {string|null} s.toegangTot    ISO
 * @param {boolean} s.geboekt
 * @param {boolean} s.gestart           verder dan stap 1
 * @param {boolean} s.afgerond
 * @param {number|null} s.laatsteActiviteit ms — bijgewerkt_op van de sessie
 * @param {Set<string>} s.gehad          stappen die al verstuurd zijn (of overgeslagen)
 * @param {number|null} s.laatsteBericht ms — laatste opvolgbericht (elk kanaal)
 * @param {number} nu
 */
export function volgendeStap(s, nu) {
  if (!s.toestemming || s.geboekt) return null;
  if (s.laatsteBericht && nu - s.laatsteBericht < 20 * UUR) return null;
  const tot = s.toegangTot ? Date.parse(s.toegangTot) : null;
  const gehad = s.gehad || new Set();
  const nog = (stap) => !gehad.has(stap);

  // Einde van de toegang: die twee wegen zwaarder dan de rest.
  if (tot != null && nu >= tot + DAG && nog('dag8')) return 'dag8';
  if (tot != null && nu < tot && tot - nu <= DAG && nog('dag6')) return 'dag6';
  if (tot != null && nu >= tot) return null; // verlopen, dag8 nog niet aan de beurt

  if (s.afgerond) {
    const sinds = s.laatsteActiviteit ?? s.aangemeldOp;
    if (nu - sinds >= 3 * DAG && nog('afgewerkt-d3') && !nog('afgewerkt-d1')) return 'afgewerkt-d3';
    if (nu - sinds >= DAG && nog('afgewerkt-d1')) return 'afgewerkt-d1';
    return null;
  }
  if (s.gestart) {
    if (s.laatsteActiviteit && nu - s.laatsteActiviteit >= DAG && nog('bezig-24u')) return 'bezig-24u';
    return null;
  }
  if (nu - s.aangemeldOp >= DAG && nog('niet-gestart-24u')) return 'niet-gestart-24u';
  return null;
}

/** Stille uren (Amsterdam): niets tussen 21:00 en 08:00. PURE. */
export function isStilUur(nu) {
  const uur = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(new Date(nu)));
  return uur >= 21 || uur < 8;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * De standaardtekst per stap. `link` is de persoonlijke loginlink (naar The Lab
 * of naar de boeking — zie linkDoel). Toon: professioneel, direct, warm,
 * Vlaams-Nederlands, geen verkooppraat, geen trucjes.
 */
export function standaardMail(stap, { voornaam, link, stap: labStap, stappen, knop }) {
  const v = esc(voornaam || 'daar');
  const k = knop;
  switch (stap) {
    case 'niet-gestart-24u':
      return { onderwerp: 'Je eerste trade wacht op je', html:
        `<p>Hey ${v},</p><p>Je account voor The Lab staat klaar, maar je bent nog niet gestart. Het kost je twintig minuten: één echte chart, één trade, met onze strategie — stap voor stap uitgelegd.</p>${k(link, 'Start The Lab')}` };
    case 'bezig-24u':
      return { onderwerp: 'Je bent er bijna', html:
        `<p>Hey ${v},</p><p>Je zit in The Lab op stap ${esc(labStap)}${stappen ? ` van ${esc(stappen)}` : ''}. Je gaat verder waar je was. Het beste deel komt op het einde: daar zie je wat 20.244 echte trades van onze studenten laten zien.</p>${k(link, 'Verder met The Lab')}` };
    case 'afgewerkt-d1':
      return { onderwerp: '78,7% of 48,5%?', html:
        `<p>Hey ${v},</p><p>In de backtest wint onze strategie 78,7% van de trades. In de echte journals van onze studenten is dat 48,5%. De strategie werkt — het verschil zit in de mens die op de knop drukt.</p><p>In een strategiesessie van dertig minuten bekijken we samen hoe jij die kloof overbrugt. Voor wie The Lab afwerkte is ze eenmalig gratis (t.w.v. €100).</p>${k(link, 'Plan mijn strategiesessie')}` };
    case 'afgewerkt-d3':
      return { onderwerp: 'Je strategiesessie staat nog open', html:
        `<p>Hey ${v},</p><p>Je werkte The Lab af, en je gratis strategiesessie staat nog voor je klaar. Dertig minuten met iemand van ons team: je doelen, of trading bij je past, en of je in aanmerking komt voor een traject.</p>${k(link, 'Kies een moment')}` };
    case 'dag6':
      return { onderwerp: 'Je toegang tot The Lab loopt morgen af', html:
        `<p>Hey ${v},</p><p>Morgen sluit je toegang tot The Lab. Wil je nog verder, of je strategiesessie inplannen? Dan is vandaag het moment.</p>${k(link, 'Plan mijn strategiesessie')}` };
    case 'dag8':
      return { onderwerp: 'Een laatste bericht over The Lab', html:
        `<p>Hey ${v},</p><p>Je toegang tot The Lab is afgelopen. Wil je toch nog praten over je doelen en of trading bij je past? Je strategiesessie kan je nog altijd inplannen. Daarna laten we je met rust.</p>${k(link, 'Plan mijn strategiesessie')}` };
    default:
      return null;
  }
}

/** Waar de knop heen moet: verder in The Lab, of naar de boeking. PURE. */
export function linkDoel(stap) {
  return stap === 'niet-gestart-24u' || stap === 'bezig-24u' ? 'lab' : 'sessie';
}

/** Een sjabloon uit onderhoud_sjablonen invullen ({voornaam}, {loginlink}, {stap}, {stappen}). PURE. */
export function vulLabSjabloon(tekst, w) {
  return String(tekst || '').replace(/\{(voornaam|loginlink|stap|stappen)\}/g, (_, k) => String(w[k] ?? ''));
}

/** Kies de sjabloonvariant bij de leadscore (score_min <= score < score_max). PURE. */
export function kiesVariant(rijen, score) {
  const s = Number(score);
  const past = (rijen || []).filter((r) =>
    (r.score_min == null || (Number.isFinite(s) && s >= r.score_min)) &&
    (r.score_max == null || (Number.isFinite(s) && s < r.score_max)));
  return past[0] || (rijen || []).find((r) => r.score_min == null && r.score_max == null) || null;
}
