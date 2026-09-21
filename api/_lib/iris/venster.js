// api/_lib/iris/venster.js
//
// Hoeveel venster is er nog, en mag er nú iets vertrekken?
//
// Twee vragen die vaak door elkaar lopen en dat niet moeten:
//
//   1. Het SERVICEVENSTER van 24 uur. Een regel van Meta. Binnen 24 uur na het
//      laatste bericht van de klant mag je vrij schrijven; daarbuiten alleen
//      een goedgekeurde template. Overtreden betekent een geweigerd bericht en
//      op den duur een slechtere beoordeling van het nummer.
//   2. De STILLE UREN. Onze eigen afspraak. Geen automatische berichten
//      's avonds, 's nachts of op zondag.
//
// Het verschil is wezenlijk: het venster zegt WAT er mag (tekst of template),
// de stille uren zeggen WANNEER er iets mag. Een gesloten venster om drie uur
// 's middags betekent "gebruik een template". Open venster om drie uur
// 's nachts betekent "wacht tot acht uur". Ze blokkeren allebei, en om
// verschillende redenen — dus geven ze verschillende antwoorden terug.
//
// ── WAAROM DE AFTELLING ERBIJ HOORT ──────────────────────────────────────────
// Het bestaande scherm toont alleen de EINDtoestand: "24u-venster is verlopen".
// Dat zie je pas als het te laat is. Wie weet dat er nog veertig minuten zijn,
// kiest een andere zin dan wie er per ongeluk tegenaan loopt. De gegevens zijn
// er al — last_inbound_at staat in elk antwoord. Er werd alleen niet mee
// gerekend. Zie gat G3 in docs/iris/02-gesprekken-audit.md.
//
// ── DE ZOMERTIJD ─────────────────────────────────────────────────────────────
// Voor de stille uren gebruiken we Intl.DateTimeFormat met een tijdzone, net
// als dunning-office-hours.js. Zelf uren optellen bij een UTC-tijd gaat twee
// keer per jaar mis, en allebei de keren precies in het weekend waarin niemand
// kijkt.

const UUR = 3600 * 1000;
export const VENSTER_MS = 24 * UUR;

/** Onder hoeveel minuten we "bijna dicht" zeggen. */
export const BIJNA_DICHT_MINUTEN = 120;

/**
 * Hoe staat het venster ervoor?
 *
 * @param {string|Date|null} laatsteInbound
 * @param {Date} nu
 * @returns {{open: boolean, resterend_ms: number, resterend_tekst: string,
 *            bijna_dicht: boolean, ooit_contact: boolean}}
 */
export function vensterStand(laatsteInbound, nu = new Date()) {
  const dicht = {
    open: false,
    resterend_ms: 0,
    resterend_tekst: 'venster dicht — enkel template',
    bijna_dicht: false,
    ooit_contact: false,
  };

  if (!laatsteInbound) return dicht;
  const ms = (laatsteInbound instanceof Date) ? laatsteInbound.getTime() : Date.parse(laatsteInbound);
  if (!Number.isFinite(ms)) return dicht;

  const verstreken = nu.getTime() - ms;

  // Een tijdstempel in de toekomst is onzin. Dat gebeurt bij een klok die
  // verloopt of een handmatig gezette rij. We behandelen het als "net binnen":
  // het venster staat open, maar we doen niet alsof er 24 uur is.
  const resterend = verstreken < 0 ? VENSTER_MS : VENSTER_MS - verstreken;

  if (resterend <= 0) return { ...dicht, ooit_contact: true };

  const minuten = Math.floor(resterend / 60000);
  return {
    open: true,
    resterend_ms: resterend,
    resterend_tekst: `venster open nog ${duurTekst(resterend)}`,
    bijna_dicht: minuten <= BIJNA_DICHT_MINUTEN,
    ooit_contact: true,
  };
}

/**
 * Een duur als '6u12' of '43m'.
 *
 * Geen '0u43' — dat leest als iets anders dan drieënveertig minuten, en bij
 * een aftelling is juist het laatste uur de tijd dat je precies wilt weten
 * waar je aan toe bent.
 */
export function duurTekst(ms) {
  const totaalMin = Math.max(0, Math.floor(ms / 60000));
  const uren = Math.floor(totaalMin / 60);
  const min = totaalMin % 60;
  if (uren <= 0) return `${min}m`;
  return `${uren}u${String(min).padStart(2, '0')}`;
}

/** Dag, uur en minuut in een tijdzone, zomertijd-proof. Null bij een fout. */
export function lokaleTijd(nu = new Date(), tz = 'Europe/Brussels') {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    const map = {};
    for (const p of fmt.formatToParts(nu)) if (p.type !== 'literal') map[p.type] = p.value;
    const dagen = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dag = dagen[map.weekday];
    const uur = parseInt(map.hour, 10);
    const minuut = parseInt(map.minute, 10);
    if (!Number.isInteger(dag) || !Number.isFinite(uur) || !Number.isFinite(minuut)) return null;
    return { dag, uur, minuut };
  } catch (_) {
    return null;
  }
}

/** 'uu:mm' naar minuten sinds middernacht. Null bij onzin. */
export function naarMinuten(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Is het nú stil?
 *
 * Het venster loopt over middernacht heen (21:00 tot 08:00), dus de
 * vergelijking is een OF in plaats van een EN. Dat is de klassieke val bij
 * dit soort controles: met een EN is er nooit een stil uur.
 *
 * Fail-zacht naar de STILLE kant: kunnen we de lokale tijd niet bepalen of is
 * de instelling onleesbaar, dan zwijgen we. Een bericht dat een uur later komt
 * is een ongemak; een bericht om drie uur 's nachts is een klacht.
 *
 * @returns {{stil: boolean, reden: string|null}}
 */
export function stilleUren(instelling, nu = new Date()) {
  const tz = String(instelling?.tijdzone || 'Europe/Brussels');
  const t = lokaleTijd(nu, tz);
  if (!t) return { stil: true, reden: 'lokale tijd niet te bepalen — bij twijfel zwijgen we' };

  if (instelling?.zondag_stil !== false && t.dag === 0) {
    return { stil: true, reden: 'zondag' };
  }

  const van = naarMinuten(instelling?.van);
  const tot = naarMinuten(instelling?.tot);
  if (van === null || tot === null) {
    return { stil: true, reden: 'stille uren onleesbaar — bij twijfel zwijgen we' };
  }
  if (van === tot) {
    // Van 21:00 tot 21:00 is óf nooit stil óf altijd. Dat is geen instelling
    // maar een typefout, en we nemen de stille kant.
    return { stil: true, reden: 'stille uren beslaan een heel etmaal — waarschijnlijk een vergissing' };
  }

  const nuMin = t.uur * 60 + t.minuut;
  const stil = (van > tot)
    ? (nuMin >= van || nuMin < tot)   // over middernacht heen
    : (nuMin >= van && nuMin < tot);  // binnen één dag

  return stil ? { stil: true, reden: `stille uren (${instelling.van}–${instelling.tot})` } : { stil: false, reden: null };
}

/**
 * De samengestelde vraag: mag er nu iets vertrekken, en in welke vorm?
 *
 * @param {object} opties
 * @param {string|Date|null} opties.laatsteInbound
 * @param {object} opties.stilleUrenInstelling
 * @param {boolean} opties.automatisch  false voor een mens die op Verstuur drukt
 * @param {Date} opties.nu
 * @returns {{mag: boolean, vorm: 'tekst'|'template'|null, reden: string,
 *            venster: object, stil: object}}
 */
export function magVersturen({ laatsteInbound, stilleUrenInstelling, automatisch = true, nu = new Date() } = {}) {
  const venster = vensterStand(laatsteInbound, nu);
  const stil = stilleUren(stilleUrenInstelling, nu);

  // Stille uren gelden alleen voor wat Iris uit zichzelf doet. Een mens die om
  // half elf 's avonds bewust op Verstuur drukt, weet wat hij doet — daar hoort
  // de software niet tussen te gaan staan. De afspraak gaat over automatische
  // berichten, niet over mensen.
  if (automatisch && stil.stil) {
    return { mag: false, vorm: null, reden: stil.reden, venster, stil };
  }

  if (venster.open) {
    return { mag: true, vorm: 'tekst', reden: venster.resterend_tekst, venster, stil };
  }
  return {
    mag: true,
    vorm: 'template',
    reden: venster.ooit_contact
      ? 'venster dicht — alleen een goedgekeurde template'
      : 'nog nooit een bericht van deze persoon — alleen een goedgekeurde template',
    venster,
    stil,
  };
}
