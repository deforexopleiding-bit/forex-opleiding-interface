// api/_lib/iris/doel.js
//
// Op wie slaat deze stap? — de zuivere kant.
//
// ── HET PROBLEEM ─────────────────────────────────────────────────────────────
// Een plan van Iris noemt mensen zoals een mens dat doet: "Andy De Landtsheer
// (andy@dl-interieur.be)". Geen sleutel, want een taalmodel kent er geen. Maar
// een opvolging, een belofte en een plek op de belrij hangen allemaal aan een
// contact of een gesprek. Dus moet die tekst omgezet worden naar een rij.
//
// ── DE VOLGORDE IS DE HELE VEILIGHEID ────────────────────────────────────────
// Eerst op e-mailadres of telefoonnummer, want die zijn uniek genoeg om zeker
// van te zijn. Pas als die er niet in staan, op naam — en een naam is NOOIT
// genoeg om op te handelen: twee studenten kunnen Jan Jansen heten. Vandaar dat
// de uitkomst altijd via het GESPREK loopt en er precies één mag zijn. Zijn het
// nul of meer, dan is het een vraag aan een mens, geen gok.
//
// (In productie bestaan er dubbele contacten: Andy heeft er twee met hetzelfde
// adres, en die zitten in hetzelfde gesprek. Twee contacten, één gesprek — dus
// tellen op gesprekken en niet op contacten is óók wat het in de praktijk doet
// werken.)
//
// ── WAAROM ZONDER DATABANK ───────────────────────────────────────────────────
// Dit bestand importeert niets. Het uitpluizen van een stuk tekst is precies
// wat je zonder Supabase-omgevingsvariabelen wilt kunnen nakijken; de
// opvraging zelf staat in iris-actie.js.

/** Een adres is uniek genoeg om op te handelen. Een naam niet. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Reeksen van negen cijfers of meer; korter is geen telefoonnummer. */
const CIJFERREEKS_RE = /\+?[\d][\d\s().-]{7,}\d/g;

/**
 * Welke herkenningspunten staan er in deze tekst?
 *
 * @param {...(string|null|undefined)} stukken  wie, de oorspronkelijke vraag, de omschrijving
 * @returns {{emails: string[], telefoons: string[]}} genormaliseerd en ontdubbeld
 */
export function haalHerkenningspunten(...stukken) {
  const tekst = stukken.filter((s) => typeof s === 'string' && s.trim()).join(' \n ');
  if (!tekst) return { emails: [], telefoons: [] };

  const emails = [...new Set((tekst.match(EMAIL_RE) || []).map((e) => e.trim().toLowerCase()))];

  // Een adres bevat cijfers (andy2@…) en zou anders als telefoonnummer
  // meegeteld worden. Dus eerst de adressen eruit halen.
  const zonderMail = tekst.replace(EMAIL_RE, ' ');
  const telefoons = [...new Set(
    (zonderMail.match(CIJFERREEKS_RE) || [])
      .map((t) => t.replace(/[^\d+]/g, ''))
      .filter((t) => t.replace(/\D/g, '').length >= 9),
  )];

  return { emails, telefoons };
}

/**
 * De vormen waarin één telefoonnummer in de databank kan staan.
 *
 * `iris_contacten.telefoons` is E.164 met een plus, maar wat er in een plan
 * staat is wat een mens typte: 0644562426, +31 6 44 56 24 26, 0032 475…
 * Zonder deze omzetting mist de opvraging precies de normale gevallen.
 *
 * Alleen NL en BE: dat is waar de school klanten heeft, en een lijst die alle
 * landcodes raadt levert vooral valse treffers.
 *
 * @returns {string[]} kandidaten, met plus, ontdubbeld
 */
export function telefoonVormen(ruw, landcodes = ['31', '32']) {
  const cijfers = String(ruw || '').replace(/\D/g, '');
  if (cijfers.length < 9) return [];
  const uit = new Set();

  if (String(ruw).trim().startsWith('+')) uit.add('+' + cijfers);
  // 0031… / 0032…
  if (cijfers.startsWith('00')) uit.add('+' + cijfers.slice(2));
  // Begint met een landcode zonder plus.
  for (const lc of landcodes) if (cijfers.startsWith(lc)) uit.add('+' + cijfers);
  // Nationale vorm met een voorloopnul: 06… -> +316…
  if (cijfers.startsWith('0') && !cijfers.startsWith('00')) {
    for (const lc of landcodes) uit.add('+' + lc + cijfers.slice(1));
  }
  // En de kale reeks zoals hij er staat.
  uit.add('+' + cijfers);

  // '+0644…' is geen nummer: dat is de nationale vorm met een plus ervoor
  // geplakt. Die zou nooit treffen en kost alleen een langere opvraging.
  return [...uit].filter((t) => !t.startsWith('+0'));
}

/**
 * De naam uit een `wie`-regel, zonder het adres erachter.
 *
 * "Andy De Landtsheer (andy@dl-interieur.be)" -> "Andy De Landtsheer"
 *
 * Geeft null bij iets wat geen naam kan zijn. Een lege of eenletterige naam
 * zou met een ilike-opvraging de halve tabel teruggeven, en dan is "precies
 * één gesprek" nooit waar en vraagt Iris altijd — wat niet erg is, maar wel
 * een nutteloze opvraging.
 */
export function naamUit(wie) {
  const kaal = String(wie || '')
    .replace(EMAIL_RE, ' ')
    .replace(/[()<>,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (kaal.length < 3) return null;
  return kaal;
}
