// api/_lib/brug-waakhond.js
//
// HET OORDEEL OVER DE HARTSLAG VAN DE BRUG, ALS PURE FUNCTIE.
//
// ── WAAROM DE DREMPEL ZO RUIM IS ───────────────────────────────────────────
// Een waakhond die blaft omdat het CRM even traag was, is binnen een week een
// waakhond waar niemand meer op reageert. Dat is een duurdere storing dan de
// storing die hij moet vangen, want dan mist hij óók de echte.
//
// Vandaar drie lagen tussen 'één hartslag gemist' en 'er gaat een mail uit':
//
//   1. De brug slaat elke 2 minuten.
//   2. De drempel ligt op 12 minuten stilte — zes gemiste slagen. Eén trage
//      levering, één herstart, één netwerkhikje: allemaal ruim binnen de marge.
//   3. En zelfs dan pas een mail na TWEE observaties achter elkaar. De cron
//      draait elke 5 minuten, dus er zit minstens 12 en in de praktijk 15-17
//      minuten tussen het laatste levensteken en de eerste mail.
//
// Die 12 minuten zijn geen meetfout maar een keuze: de brug mag een minuut of
// tien wegvallen zonder dat er iemand wakker wordt. Wat hij niet mag, is een
// uur wegvallen zonder dat iemand het weet — laat staan eenentwintig.
//
// ── EN NIET_GEMETEN IS HIER OOK SMAL ───────────────────────────────────────
// Zelfde regel als in opvolging-gezondheid.js: nooit een hartslag ontvangen is
// iets anders dan een hartslag die wegblijft. De eerste betekent dat de brug
// deze versie nog niet draait (of dat CRM_BASE_URL niet klopt); de tweede is
// een storing. Ze door elkaar halen laat een echte storing verdwijnen in de
// bak voor 'nog niet ingesteld' — dat is precies de fout van 7 september.

export const HARTSLAG_VERWACHT_MS = 120000;    // wat de brug doet
export const STIL_DREMPEL_MS      = 12 * 60 * 1000;
export const MIN_WAARNEMINGEN     = 2;         // niet mailen op één observatie

export const LEEFT        = 'leeft';
export const STIL         = 'stil';
export const NOOIT_GEZIEN = 'nooit_gezien';

/**
 * @param {object} p
 * @param {number} p.nuMs
 * @param {string|null} p.laatsteIso   laatste ontvangen hartslag
 * @param {number} p.stilWaarnemingen  hoe vaak op rij al stil bevonden
 * @param {boolean|null} p.verbonden   stand uit de laatste hartslag
 */
export function beoordeelHartslag({ nuMs, laatsteIso, stilWaarnemingen = 0,
                                    verbonden = null, drempelMs = STIL_DREMPEL_MS }) {
  if (!laatsteIso) {
    return { staat: NOOIT_GEZIEN, alarm: false, stil_ms: null, waarnemingen: 0,
      uitleg: 'Er is nog nooit een hartslag ontvangen. De brug draait deze versie waarschijnlijk nog niet.' };
  }
  const laatsteMs = Date.parse(laatsteIso);
  if (!Number.isFinite(laatsteMs)) {
    return { staat: NOOIT_GEZIEN, alarm: false, stil_ms: null, waarnemingen: 0,
      uitleg: 'De opgeslagen hartslag is onleesbaar: ' + String(laatsteIso) };
  }
  const stil = nuMs - laatsteMs;

  if (stil <= drempelMs) {
    // Leeft. De verbonden-vlag is een APARTE vraag: een brug die ademt maar
    // niet verbonden is, is nog steeds stuk — alleen op een andere manier.
    return verbonden === false
      ? { staat: LEEFT, alarm: true, stil_ms: stil, waarnemingen: 0, losgekoppeld: true,
          uitleg: 'De brug leeft maar is niet verbonden met WhatsApp. Er komt geen bericht binnen.' }
      : { staat: LEEFT, alarm: false, stil_ms: stil, waarnemingen: 0,
          uitleg: 'Laatste hartslag ' + Math.round(stil / 1000) + ' s geleden.' };
  }

  const n = Number(stilWaarnemingen || 0) + 1;
  return {
    staat: STIL, alarm: n >= MIN_WAARNEMINGEN, stil_ms: stil, waarnemingen: n,
    uitleg: n >= MIN_WAARNEMINGEN
      ? `Geen hartslag in ${Math.round(stil / 60000)} minuten, ${n} keer op rij vastgesteld. De brug ligt stil.`
      : `Geen hartslag in ${Math.round(stil / 60000)} minuten. Eén waarneming — nog geen alarm.`,
  };
}

/** De mailtekst. Draagt de getallen waarop het oordeel rust, net als de dagmail. */
export function bouwAlarmMail({ oordeel, nuIso, laatsteIso }) {
  const onderwerp = oordeel.losgekoppeld
    ? '[Brug] niet verbonden met WhatsApp'
    : '[Brug] geen hartslag — de brug ligt stil';
  const tekst =
    'WhatsApp-brug — ' + nuIso + '\n\n' +
    oordeel.uitleg + '\n\n' +
    'laatste hartslag = ' + (laatsteIso || 'nooit') + '\n' +
    'stil = ' + (oordeel.stil_ms === null ? 'onbekend' : Math.round(oordeel.stil_ms / 1000) + ' s') + '\n' +
    'waarnemingen op rij = ' + oordeel.waarnemingen + '\n' +
    'drempel = ' + Math.round(STIL_DREMPEL_MS / 60000) + ' min, hartslag elke ' +
      Math.round(HARTSLAG_VERWACHT_MS / 1000) + ' s\n\n' +
    '---\n' +
    'De brug probeert zichzelf te herstellen: opnieuw verbinden met oplopende\n' +
    'wachttijd, en na zes mislukte pogingen sluit het proces af zodat systemd\n' +
    'een verse start doet. Komt deze mail toch, dan is dat allemaal niet gelukt.\n';
  return { subject: onderwerp, text: tekst };
}
