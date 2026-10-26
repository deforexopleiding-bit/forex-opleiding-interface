// api/_lib/lab-opvolging.js
//
// De warme opvolgmotor van ELKE trial-lead (26 okt 2026: minicursus,
// 7-daagse, webinar, site-formulier en The Lab — allemaal lab-leads in het
// echte LMS). De beslissing staat hier als PURE functie (volgendeStap), de
// standaardteksten ernaast; de cron (api/cron-lab-opvolging.js) haalt alleen
// de stand op en verstuurt.
//
// Waarom niet in de bestaande leadsonderhoud-motor: die draait op de views
// onderhoud_wachtrij/trial_warmte, die op lms_gebruikers (het OUDE trial-LMS)
// gebouwd zijn. Een lab-lead staat daar nooit in. De SJABLONEN delen we wél:
// een rij in onderhoud_sjablonen met traject_slug 'the-lab' en soort = de
// stapnaam hieronder overschrijft de standaardtekst (per warmte via
// score_min/score_max), en levert het WhatsApp-template (meta_template).
// Bewerkbaar in Leadsonderhoud › Templates › Trial-opvolging.
//
// Toon: Vlaams, persoonlijk, motiverend, commercieel, met autoriteit maar
// empathisch. Rode draad: trading is een business, consistentie maakt het
// verschil, en daarom werken wij met 1-op-1 begeleiding. Elke stap één actie.
//
// DE REGELS, die nooit gebroken worden:
//   - alleen met toestemming; nooit na een afmelding (lead_mail_voorkeuren);
//   - nooit nog iets na een boeking, of als de lead klant is;
//   - nooit "je bent nog niet ingelogd" aan wie al inlogde;
//   - hoogstens één bericht per lead per 20 uur, en niet tussen 21u en 8u;
//   - elke stap één keer (unique (aanmelding_id, stap, kanaal) in lab_opvolging);
//   - WhatsApp enkel via een goedgekeurd Meta-template — anders overgeslagen
//     en gelogd, de mail gaat wel.

import { SESSIE_WAARDE_EUR } from './lab-config.js';

export const STAPPEN = Object.freeze([
  'niet-ingelogd-24u', 'niet-ingelogd-48u', 'dag3-lab', 'uitnodiging-sessie',
  'dag5', 'laatste-dag', 'verlopen', 'verlopen-3', 'verlopen-7',
]);

/** Leesbaar, voor Leadsonderhoud › Templates. */
export const STAP_INFO = Object.freeze({
  'niet-ingelogd-24u': { label: '+24u niet ingelogd', wanneer: '24 uur na de start, nog niet ingelogd' },
  'niet-ingelogd-48u': { label: '+48u niet ingelogd', wanneer: '48 uur na de start, nog altijd niet ingelogd (ook WhatsApp)' },
  'dag3-lab': { label: 'Dag 3 · nu de praktijk', wanneer: 'Dag 3: wel ingelogd, The Lab nog niet gestart' },
  'uitnodiging-sessie': { label: 'Uitnodiging strategiesessie', wanneer: 'Lab afgewerkt of ≥ 2 video\'s gezien, geen sessie (ook WhatsApp)' },
  dag5: { label: 'Dag 5 · verloopt binnenkort', wanneer: '2 dagen voor het einde van de toegang' },
  'laatste-dag': { label: 'Laatste dag', wanneer: 'De laatste 24 uur van de toegang (ook WhatsApp)' },
  verlopen: { label: 'Verlopen', wanneer: 'De dag dat de toegang afloopt (ook WhatsApp)' },
  'verlopen-3': { label: 'Verlopen +3 · consistentie', wanneer: '3 dagen na het einde, er is niets mee gedaan' },
  'verlopen-7': { label: 'Verlopen +7 · laatste bericht', wanneer: '7 dagen na het einde' },
});

/** De stappen die ook een WhatsApp proberen (enkel met een goedgekeurd template). */
export const WA_STAPPEN = Object.freeze(new Set(['niet-ingelogd-48u', 'uitnodiging-sessie', 'laatste-dag', 'verlopen']));

/** Het voorgestelde Meta-template per WhatsApp-stap (zie docs/trial-opvolging-whatsapp.md). */
export const WA_TEMPLATE_NAMEN = Object.freeze({
  welkom: 'trial_welkom',
  'niet-ingelogd-48u': 'trial_niet_ingelogd_48u',
  'uitnodiging-sessie': 'trial_uitnodiging_sessie',
  'laatste-dag': 'trial_laatste_dag',
  verlopen: 'trial_verlopen',
});

const UUR = 3600 * 1000;
const DAG = 24 * UUR;

/**
 * Welke stap is nu aan de beurt voor deze lead? null = niets.
 *
 * @param {object} s
 * @param {number}  s.aangemeldOp       ms — start van de trial (toegang_van, anders de aanmelding)
 * @param {boolean} s.toestemming
 * @param {string|null} s.toegangTot    ISO
 * @param {boolean} s.geboekt
 * @param {boolean} [s.afgemeld]        lead_mail_voorkeuren.afgemeld
 * @param {boolean} [s.klant]           lead werd klant
 * @param {boolean} [s.ingelogd]        hlms_lab_lead.eerste_login_op gezet
 * @param {boolean} s.gestart           The Lab: verder dan stap 1
 * @param {boolean} s.afgerond          The Lab afgewerkt
 * @param {number}  [s.videos]          aantal uitgekeken video's
 * @param {Set<string>} s.gehad         stappen die al verstuurd zijn (of overgeslagen)
 * @param {number|null} s.laatsteBericht ms — laatste opvolgbericht (elk kanaal)
 * @param {number} nu
 */
export function volgendeStap(s, nu) {
  if (!s.toestemming || s.geboekt || s.afgemeld || s.klant) return null;
  if (s.laatsteBericht && nu - s.laatsteBericht < 20 * UUR) return null;
  const tot = s.toegangTot ? Date.parse(s.toegangTot) : null;
  const gehad = s.gehad || new Set();
  const nog = (stap) => !gehad.has(stap);
  const videos = Number(s.videos || 0);
  const ingelogd = !!s.ingelogd;
  const sinds = nu - s.aangemeldOp;

  // Na het einde van de toegang.
  if (tot != null && nu >= tot) {
    const na = nu - tot;
    const nietsGedaan = !ingelogd || (videos === 0 && !s.gestart && !s.afgerond);
    if (na >= 7 * DAG) return nog('verlopen-7') ? 'verlopen-7' : null;
    if (na >= 3 * DAG) return nietsGedaan && nog('verlopen-3') ? 'verlopen-3' : null;
    return nog('verlopen') ? 'verlopen' : null;
  }

  // Het einde nadert: dat weegt zwaarder dan de rest.
  if (tot != null && tot - nu <= DAG) return nog('laatste-dag') ? 'laatste-dag' : null;
  if (tot != null && tot - nu <= 2 * DAG && nog('dag5')) return 'dag5';

  // Warm: Lab afgewerkt of minstens 2 video's → de uitnodiging.
  if ((s.afgerond || videos >= 2) && nog('uitnodiging-sessie')) return 'uitnodiging-sessie';

  if (!ingelogd) {
    if (sinds >= 2 * DAG) return nog('niet-ingelogd-48u') ? 'niet-ingelogd-48u' : null;
    if (sinds >= DAG && nog('niet-ingelogd-24u')) return 'niet-ingelogd-24u';
    return null;
  }

  // Ingelogd, maar The Lab nog niet gestart: dag 3 = nu de praktijk.
  if (!s.gestart && !s.afgerond && sinds >= 3 * DAG && nog('dag3-lab')) return 'dag3-lab';
  return null;
}

/** Stille uren (Amsterdam): niets tussen 21:00 en 08:00. PURE. */
export function isStilUur(nu) {
  const uur = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(new Date(nu)));
  return uur >= 21 || uur < 8;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** De belofte in een zin: "je minicursus", "je 7 dagen meekijken", … PURE. */
export function belofteKort(product) {
  return ({
    minicursus: 'je minicursus',
    '7-daagse': 'je 7 dagen meekijken',
    webinar: 'je leeromgeving',
    website: 'je leeromgeving',
    'the-lab': 'The Lab',
  })[product] || 'je leeromgeving';
}

const p = (t) => `<p>${t}</p>`;

/**
 * De standaardtekst per stap. `link` is de persoonlijke loginlink (naar het
 * actieplan, The Lab of de boeking — zie linkDoel). `knop(href, tekst)` maakt
 * de ene knop.
 */
export function standaardMail(stap, { voornaam, link, knop, product = 'the-lab', eersteVideoMin = null }) {
  const v = esc(voornaam || 'daar');
  const b = esc(belofteKort(product));
  const waarde = `€${SESSIE_WAARDE_EUR}`;
  const min = eersteVideoMin ? `${esc(eersteVideoMin)} minuten` : 'maar een paar minuten';
  switch (stap) {
    case 'niet-ingelogd-24u':
      return { onderwerp: `Je toegang staat klaar, ${voornaam || 'het is zover'}`, html:
        p(`Hey ${v},`)
        + p(`Gisteren vroeg je ${b} aan. Je account staat klaar en wacht op je. Je eerste video duurt ${min} — meer heb je vandaag niet nodig om te zien hoe wij naar de markt kijken.`)
        + p('Trading is geen gok. Het is een business, en elke business begint met één eerste stap.')
        + knop(link, 'Log in en kijk de eerste video') };
    case 'niet-ingelogd-48u':
      return { onderwerp: 'Je toegang loopt maar 7 dagen', html:
        p(`Hey ${v},`)
        + p('Ik zie dat je nog niet bent ingelogd. Geen verwijt — iedereen heeft het druk. Maar je toegang loopt maar 7 dagen, en wie blijft wachten, begint meestal nooit.')
        + p('Zet er vanavond tien minuten voor opzij. Eén klik en je zit erin, inloggen of een wachtwoord kiezen hoeft niet.')
        + knop(link, 'Log in') };
    case 'dag3-lab':
      return { onderwerp: 'Nu de praktijk: je eerste trade', html:
        p(`Hey ${v},`)
        + p('Je hebt al rondgekeken — sterk. Maar kijken is één ding, doen is iets anders.')
        + p('In The Lab plaats je je eerste (simulatie)trade met onze strategie, stap voor stap in een echte chart. Twintig minuten, en je voelt meteen hoe een trade aanvoelt als je een plan hebt in plaats van een gevoel.')
        + knop(link, 'Plaats mijn eerste trade') };
    case 'uitnodiging-sessie':
      return { onderwerp: 'Je bent er klaar voor: je strategiesessie', html:
        p(`Hey ${v},`)
        + p('Je hebt meer gedaan dan de meeste mensen die zich aanmelden. Dan is dit het moment om het concreet te maken.')
        + p(`In een strategiesessie van 30 minuten bekijken we samen jouw doelen, je tijd en de aanpak die bij jou past. Normaal ${waarde} — voor jou nu gratis.`)
        + p('Waarom we dat doen? Omdat trading een business is, en een business bouw je niet alleen. Daarom werken wij met 1-op-1 begeleiding.')
        + knop(link, 'Plan mijn strategiesessie') };
    case 'dag5':
      return { onderwerp: 'Je toegang verloopt binnenkort', html:
        p(`Hey ${v},`)
        + p(`Nog twee dagen toegang tot ${b}. Haal er het maximum uit — en plan je gratis strategiesessie zolang het kan. Daar kijken we samen hoe je hier een vaste gewoonte van maakt, want consistentie maakt het verschil.`)
        + knop(link, 'Plan mijn strategiesessie') };
    case 'laatste-dag':
      return { onderwerp: 'Vandaag je laatste dag', html:
        p(`Hey ${v},`)
        + p('Morgen sluit je toegang. Twijfel je nog? Dat is normaal — en net daarom bestaat de strategiesessie: 30 minuten, gratis, zonder verplichtingen. Je gaat buiten met een plan, wat je ook beslist.')
        + knop(link, 'Plan mijn strategiesessie') };
    case 'verlopen':
      return { onderwerp: 'Je toegang is verlopen', html:
        p(`Hey ${v},`)
        + p('Je 7 dagen zitten erop. Wil je verder? Plan een sessie met ons team, dan bekijken we samen wat er voor jou mogelijk is.')
        + knop(link, 'Plan een sessie met ons team') };
    case 'verlopen-3':
      return { onderwerp: `Eerlijk is eerlijk, ${voornaam || 'even dit'}`, html:
        p(`Hey ${v},`)
        + p('Je vroeg toegang aan, en daarna is het er niet van gekomen. Dat is geen verwijt — het is precies wat we bij de meeste mensen zien. Niet omdat ze het niet kunnen, maar omdat de structuur ontbreekt.')
        + p('Trading is een business. En als ondernemer weet je: niet talent, maar consistentie maakt het verschil. Dat leer je niet uit een video alleen, dat leer je met iemand naast je. Net daarom werken wij 1-op-1.')
        + p('Plan een gratis strategiesessie, dan kijken we samen of dat bij je past.')
        + knop(link, 'Plan mijn strategiesessie') };
    case 'verlopen-7':
      return { onderwerp: 'Een laatste bericht van ons', html:
        p(`Hey ${v},`)
        + p('Dit is ons laatste bericht hierover. Wil je ooit trading aanpakken zoals een business — met een vast plan en iemand die je opvolgt — dan blijft je strategiesessie voor je klaarstaan.')
        + p('Daarna laten we je met rust. Veel succes, wat je ook kiest.')
        + knop(link, 'Plan mijn strategiesessie') };
    default:
      return null;
  }
}

/** Waar de knop heen moet: actieplan, The Lab of de boeking. PURE. */
export function linkDoel(stap) {
  if (stap === 'niet-ingelogd-24u' || stap === 'niet-ingelogd-48u') return 'start';
  return stap === 'dag3-lab' ? 'lab' : 'sessie';
}

/** De variabelen die een sjabloon mag gebruiken. */
export const SJABLOON_VARIABELEN = Object.freeze(['voornaam', 'loginlink', 'belofte', 'eerste_video_min', 'dagen_over', 'stap', 'stappen']);

/** Een sjabloon uit onderhoud_sjablonen invullen ({voornaam}, {loginlink}, …). PURE. */
export function vulLabSjabloon(tekst, w) {
  const re = new RegExp(`\\{(${SJABLOON_VARIABELEN.join('|')})\\}`, 'g');
  return String(tekst || '').replace(re, (_, k) => String(w[k] ?? ''));
}

/** Kies de sjabloonvariant bij de leadscore (score_min <= score < score_max). PURE. */
export function kiesVariant(rijen, score) {
  const s = Number(score);
  const past = (rijen || []).filter((r) =>
    (r.score_min == null || (Number.isFinite(s) && s >= r.score_min)) &&
    (r.score_max == null || (Number.isFinite(s) && s < r.score_max)));
  return past[0] || (rijen || []).find((r) => r.score_min == null && r.score_max == null) || null;
}

/** Dagen toegang die nog over zijn (afgerond naar boven, min 0). PURE. */
export function dagenOver(toegangTot, nu) {
  const t = toegangTot ? Date.parse(toegangTot) : NaN;
  if (!Number.isFinite(t)) return '';
  return String(Math.max(0, Math.ceil((t - nu) / DAG)));
}
