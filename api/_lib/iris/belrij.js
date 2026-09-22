// api/_lib/iris/belrij.js
//
// Wie moet er gebeld worden, hoe vaak is het geprobeerd, en wanneer is het
// genoeg geweest?
//
// ── DRIE REGELS, OVERGENOMEN VAN DE OPVOLGING ────────────────────────────────
// Dave's opvolging heeft deze regels uitgevochten. We nemen ze over, maar met
// een eigen telling in iris_belpogingen — opvolging_pogingen blijft van hem en
// wordt hier niet aangeraakt.
//
//   1. Hoogstens twee pogingen per persoon per dag.
//   2. Een call die wordt afgebroken vóór er opgenomen is, telt NOOIT als
//      poging.
//   3. Contact is: een gesprek, of een inkomend bericht.
//
// Regel 2 is de belangrijkste en de makkelijkste om te verliezen. Wie per
// ongeluk op bellen drukt en meteen ophangt, heeft niet geprobeerd te bereiken.
// Die poging meetellen betekent dat iemand na drie mispieken "onbereikbaar"
// heet en een escalatiebericht krijgt dat nergens op slaat. De softphone levert
// dat onderscheid al: call_log.outcome_hint = 'local_cancel'.
//
// ── DE ESCALATIE ─────────────────────────────────────────────────────────────
// Na N niet-opgenomen pogingen op M VERSCHILLENDE dagen stuurt Iris zelf een
// WhatsApp en een mail. Standaard drie op drie.
//
// Het onderscheid tussen pogingen en dagen is geen muggenzifterij. Drie keer
// bellen op één ochtend is geen drie dagen proberen — dat is één ochtend waarop
// iemand in een vergadering zat. Pas als het op drie verschillende dagen niet
// lukt, is "we krijgen je niet te pakken" een eerlijke mededeling.

/** De uitkomsten die de softphone kan opleveren. */
export const UITKOMSTEN = Object.freeze(['gesproken', 'niet_opgenomen', 'voicemail', 'bezet', 'mislukt']);

/** Hoeveel pogingen er per persoon per dag mogen. */
export const MAX_PER_DAG = 2;

/**
 * Zet een uitkomst van de softphone om naar wat wij noteren.
 *
 * `local_cancel` is het geval uit regel 2: de beller hing op vóór er iets
 * gebeurde. Dat is geen poging.
 */
export function uitCallLog(outcomeHint) {
  const h = String(outcomeHint || '').trim().toLowerCase();
  switch (h) {
    case 'answered': return { uitkomst: 'gesproken', afgebroken: false };
    case 'no_answer': return { uitkomst: 'niet_opgenomen', afgebroken: false };
    case 'busy': return { uitkomst: 'bezet', afgebroken: false };
    case 'local_cancel': return { uitkomst: 'mislukt', afgebroken: true };
    case 'failed': return { uitkomst: 'mislukt', afgebroken: false };
    default:
      // Onbekend is 'mislukt' en NIET afgebroken. Een onbekende uitkomst als
      // afgebroken behandelen zou betekenen dat een nieuwe soort fout stil uit
      // de telling verdwijnt.
      return { uitkomst: 'mislukt', afgebroken: false };
  }
}

/** Telt deze poging mee? */
export function teltMee(poging) {
  if (!poging) return false;
  if (poging.afgebroken_voor_opname === true) return false;
  return UITKOMSTEN.includes(poging.uitkomst);
}

/** De dag van een tijdstempel, in de lokale tijdzone. */
export function dagVan(iso, tz = 'Europe/Brussels') {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    // Niet toISOString().slice(0,10): dat rekent in UTC, en dan telt een
    // telefoontje van kwart over één 's nachts bij de vorige dag. Lesson
    // learned over datum-vergelijking in de UI, hier net zo goed van
    // toepassing.
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    return f.format(d);
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}

/**
 * Vat een reeks pogingen samen.
 *
 * @returns {{meetellend: number, niet_opgenomen: number, dagen_met_poging: number,
 *            vandaag: number, laatste_contact: string|null, mag_vandaag_nog: boolean}}
 */
export function telPogingen(pogingen, { nu = new Date(), tz = 'Europe/Brussels', maxPerDag = MAX_PER_DAG } = {}) {
  const lijst = (Array.isArray(pogingen) ? pogingen : []).filter(teltMee);
  const vandaag = dagVan(nu, tz);

  const dagen = new Set();
  const dagenNietOpgenomen = new Set();
  let nietOpgenomen = 0;
  let vandaagAantal = 0;
  let laatsteContact = null;

  for (const p of lijst) {
    const dag = dagVan(p.gebeld_op, tz);
    if (dag) dagen.add(dag);
    if (dag === vandaag) vandaagAantal++;
    if (p.uitkomst === 'gesproken') {
      if (!laatsteContact || String(p.gebeld_op) > String(laatsteContact)) laatsteContact = p.gebeld_op;
    }
    // Voicemail en bezet tellen als "niet bereikt". Iemand die zijn voicemail
    // laat aanslaan, heeft je niet gesproken — en dat is waar de escalatie
    // over gaat.
    if (['niet_opgenomen', 'voicemail', 'bezet'].includes(p.uitkomst)) {
      nietOpgenomen++;
      if (dag) dagenNietOpgenomen.add(dag);
    }
  }

  return {
    meetellend: lijst.length,
    niet_opgenomen: nietOpgenomen,
    dagen_met_poging: dagen.size,
    dagen_niet_opgenomen: dagenNietOpgenomen.size,
    vandaag: vandaagAantal,
    laatste_contact: laatsteContact,
    mag_vandaag_nog: vandaagAantal < maxPerDag,
  };
}

/**
 * Moet er geëscaleerd worden?
 *
 * @param {object} telling  uit telPogingen()
 * @param {object} drempel  { pogingen, dagen }
 * @param {object} opties
 * @param {string|null} opties.laatsteInbound  een inkomend bericht is ook contact
 * @returns {{escaleren: boolean, reden: string}}
 */
export function moetEscaleren(telling, drempel = {}, { laatsteInbound = null, nu = new Date() } = {}) {
  const nodigPogingen = Number.isInteger(drempel.pogingen) ? drempel.pogingen : 3;
  const nodigDagen = Number.isInteger(drempel.dagen) ? drempel.dagen : 3;

  // Regel 3: contact is een gesprek OF een inkomend bericht. Wie gisteren nog
  // appte, is niet onbereikbaar — dan is een "we proberen je te bereiken"-
  // bericht een belediging.
  if (telling?.laatste_contact) {
    return { escaleren: false, reden: 'er is gesproken met deze persoon' };
  }
  if (laatsteInbound) {
    const uren = (nu.getTime() - new Date(laatsteInbound).getTime()) / 3600000;
    if (Number.isFinite(uren) && uren < 72) {
      return { escaleren: false, reden: 'deze persoon stuurde nog geen drie dagen geleden een bericht' };
    }
  }

  if ((telling?.niet_opgenomen || 0) < nodigPogingen) {
    return { escaleren: false, reden: `${telling?.niet_opgenomen || 0} van de ${nodigPogingen} pogingen` };
  }
  if ((telling?.dagen_niet_opgenomen || 0) < nodigDagen) {
    return {
      escaleren: false,
      reden: `${telling?.dagen_niet_opgenomen || 0} van de ${nodigDagen} verschillende dagen — ` +
        'drie keer bellen op één ochtend is geen drie dagen proberen',
    };
  }

  return {
    escaleren: true,
    reden: `${telling.niet_opgenomen} pogingen op ${telling.dagen_niet_opgenomen} verschillende dagen zonder contact`,
  };
}

/**
 * De volgorde van de belrij.
 *
 * Prioriteit eerst, dan wie het langst wacht. Niet op "meeste pogingen": dan
 * zou iemand die al vijf keer niet opnam bovenaan blijven staan terwijl er
 * iemand onderaan hangt die nog nooit gebeld is.
 */
export function sorteerBelrij(rijen, { nu = new Date() } = {}) {
  return [...(rijen || [])].sort((a, b) => {
    const pa = Number(a?.prioriteit) || 0;
    const pb = Number(b?.prioriteit) || 0;
    if (pa !== pb) return pb - pa;
    return String(a?.aangemaakt_op || '').localeCompare(String(b?.aangemaakt_op || ''));
  });
}

/**
 * De tekst bij een reden, voor in het scherm.
 *
 * Waarom iemand gebeld moet worden, is het enige wat de beller vóór het
 * opnemen te zien krijgt. Een code als 'geen_reactie' helpt dan niet.
 */
export const REDEN_TEKST = Object.freeze({
  wanbetaler: 'Openstaande factuur, telefoon nodig',
  onboarding: 'Zou moeten opstarten maar is nog niet begonnen',
  mentorsignaal: 'Signaal van de mentor',
  geen_reactie: 'Reageert niet op berichten',
  hand: 'Handmatig op de lijst gezet',
});

export function redenTekst(bron, detail) {
  const basis = REDEN_TEKST[bron] || 'Bellen';
  return detail ? `${basis} — ${detail}` : basis;
}
