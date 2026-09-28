// api/_lib/iris/opvolging.js
//
// "Verwittig me als er geen reactie komt."
//
// ── WAT ER MIS WAS (O-2) ─────────────────────────────────────────────────────
// Dit is het belangrijkste dat de audit vond, want hier deed Iris iets ANDERS
// dan waar om gevraagd werd. `taak_aanmaken` deed dit, en niets meer:
//
//     .from('pending_actions').insert({ action_type: 'MANUAL_FOLLOWUP', ... })
//
// Eén regel met een omschrijving. Geen datum, geen bewaking, geen bericht.
// Er werd om drie dingen gevraagd -- hou bij of er gereageerd wordt, verwittig
// me, als het binnen een paar dagen uitblijft -- en daarvan gebeurde er nul.
// Er kwam een to-do-regel in een module waar de vrager niet werkt.
//
// ── DE DRIE DINGEN ───────────────────────────────────────────────────────────
//   WAAROP  wordt gewacht  → een gesprek, of een contact over al zijn kanalen
//   TOT     wanneer        → `tot`
//   WIE     krijgt bericht → bij het MAKEN vastgelegd, niet bij het melden
//                            opgezocht: wie het vroeg, krijgt het bericht
//
// Dit bestand importeert niets. Elke regel hieronder is de regel die bepaalt
// of iemand wel of geen bericht krijgt, en die wil je kunnen narekenen zonder
// databank en zonder klok.

/** Hoeveel dagen een opvolging standaard kijkt als er niets gezegd wordt. */
export const STANDAARD_DAGEN = 3;

/** De grenzen. Een dag is de kortste zinnige termijn, een kwartaal de langste. */
export const MIN_DAGEN = 1;
export const MAX_DAGEN = 90;

/**
 * Hoe vaak we een melding proberen voor we het opgeven.
 *
 * Gecapt, en met opzet laag. De afspraak-reminders stuurden ooit 95 mails op
 * een dag omdat elke mislukte poging opnieuw alarm sloeg (zie CLAUDE.md). Een
 * melding die drie keer niet aankomt, komt de vierde keer ook niet aan; die
 * blijft op `verlopen` staan met de fout erbij, zichtbaar in de module.
 */
export const MAX_MELD_POGINGEN = 3;

/** Statussen waarin een opvolging nog iets van de cron moet. */
export const OPEN_STATUSSEN = Object.freeze(['kijkt', 'verlopen']);

/**
 * Het aantal dagen uit een opdracht, binnen de grenzen.
 *
 * Fail-zacht naar de STANDAARD, niet naar nul: "0 dagen" zou betekenen dat de
 * opvolging bij de eerstvolgende cron-ronde al afgaat, en een melding die
 * meteen komt is geen opvolging maar ruis.
 */
export function leesDagen(ruw, standaard = STANDAARD_DAGEN) {
  // null, undefined en '' zijn "niet opgegeven" en géén nul. Number(null) is 0,
  // en dat is eindig -- zonder deze regel wordt "geen termijn meegegeven"
  // stilletjes de KORTST mogelijke termijn in plaats van de standaard.
  if (ruw === null || ruw === undefined || String(ruw).trim() === '') return standaard;
  const n = Number(ruw);
  if (!Number.isFinite(n)) return standaard;
  const heel = Math.trunc(n);
  if (heel < MIN_DAGEN) return MIN_DAGEN;
  if (heel > MAX_DAGEN) return MAX_DAGEN;
  return heel;
}

/** Wanneer een opvolging afloopt. */
export function termijn(dagen, nu = new Date()) {
  return new Date(nu.getTime() + leesDagen(dagen) * 24 * 3600 * 1000);
}

/**
 * De rij die de databank in gaat.
 *
 * @returns {{ok: false, fout: string} | {ok: true, rij: object}}
 */
export function bouwOpvolging({
  opdrachtId = null,
  actieId = null,
  gesprekId = null,
  contactId = null,
  omschrijving = '',
  dagen = STANDAARD_DAGEN,
  verwittigEmail = null,
  verwittigWie = null,
  aangemaaktDoor = null,
  nu = new Date(),
} = {}) {
  const tekst = String(omschrijving || '').trim().slice(0, 500);
  if (!tekst) return { ok: false, fout: 'een opvolging zonder omschrijving zegt later niets' };

  // Waarop gewacht wordt, moet vaststaan. Een opvolging zonder spoor kan nooit
  // zien dat er iets binnenkwam en zou dus ALTIJD afgaan -- een wekker die
  // gegarandeerd vals alarm geeft.
  const waarop = gesprekId ? 'gesprek' : (contactId ? 'contact' : null);
  if (!waarop) return { ok: false, fout: 'een opvolging heeft een gesprek of een contact nodig' };

  // En er moet iemand zijn om te verwittigen. Anders is het een wekker die
  // afgaat in een lege kamer.
  const email = String(verwittigEmail || '').trim();
  if (!email || !email.includes('@')) {
    return { ok: false, fout: 'er is geen adres om de melding heen te sturen' };
  }

  return {
    ok: true,
    rij: {
      opdracht_id: opdrachtId || null,
      actie_id: actieId || null,
      gesprek_id: gesprekId || null,
      contact_id: contactId || null,
      waarop,
      omschrijving: tekst,
      sinds: nu.toISOString(),
      tot: termijn(dagen, nu).toISOString(),
      verwittig_email: email,
      verwittig_wie: verwittigWie || null,
      status: 'kijkt',
      aangemaakt_door: aangemaaktDoor || null,
    },
  };
}

/**
 * Wat moet er met deze opvolging gebeuren?
 *
 * Zuiver: de aanroeper zoekt op of er iets binnenkwam en geeft dat mee. Zo is
 * elke tak te testen zonder databank en zonder te wachten tot morgen.
 *
 * ── DE VOLGORDE IS NIET WILLEKEURIG ─────────────────────────────────────────
 * Een reactie wint ALTIJD van een verstreken termijn, ook als allebei waar
 * zijn. Iemand die op de valreep antwoordde en dan toch een "er is niet
 * gereageerd"-mail krijgt, gelooft de volgende melding niet meer.
 *
 * @returns {{doe: 'reactie'|'melden'|'wacht'|'opgeven', reden: string}}
 */
export function beoordeel(opvolging, { reactie = null, nu = new Date() } = {}) {
  if (!opvolging) return { doe: 'wacht', reden: 'geen opvolging' };
  const status = String(opvolging.status || '');

  if (!OPEN_STATUSSEN.includes(status)) {
    return { doe: 'wacht', reden: `status ${status || '(leeg)'} vraagt niets` };
  }

  // Een reactie sluit de opvolging, ook als de termijn net om is.
  if (reactie && reactie.id) {
    const op = reactie.ontvangen_op ? Date.parse(reactie.ontvangen_op) : NaN;
    const sinds = opvolging.sinds ? Date.parse(opvolging.sinds) : NaN;
    // Alleen wat NA het ijkpunt binnenkwam telt. Zonder deze vergelijking sluit
    // een bericht van vorige week de opvolging meteen -- en dan heeft de
    // opvolging nooit iets gedaan.
    if (Number.isFinite(op) && Number.isFinite(sinds) && op > sinds) {
      return { doe: 'reactie', reden: 'er kwam iets binnen' };
    }
  }

  const tot = opvolging.tot ? Date.parse(opvolging.tot) : NaN;
  if (!Number.isFinite(tot)) {
    // Een onleesbare termijn is geen reden om te melden. Melden bij twijfel is
    // hier de dure kant: dat is een mail naar een mens over niets.
    return { doe: 'wacht', reden: 'termijn onleesbaar' };
  }
  if (nu.getTime() < tot) return { doe: 'wacht', reden: 'de termijn loopt nog' };

  const pogingen = Number(opvolging.meld_pogingen) || 0;
  if (pogingen >= MAX_MELD_POGINGEN) {
    return { doe: 'opgeven', reden: `${pogingen} mislukte pogingen; de melding komt niet aan` };
  }
  return { doe: 'melden', reden: 'de termijn is om en er kwam niets' };
}

/**
 * Het bericht dat een mens krijgt.
 *
 * Geen verzonnen feiten: alleen wat er in de opvolging staat plus de link.
 * Staat er geen link, dan staat er geen link -- geen url die we hopen dat
 * klopt.
 */
export function meldTekst(opvolging, { basisUrl = '' } = {}) {
  const regels = [
    'Je vroeg Iris om je te verwittigen als er geen reactie kwam.',
    '',
    String(opvolging?.omschrijving || '').trim(),
    '',
  ];

  const dagen = dagenTussen(opvolging?.sinds, opvolging?.tot);
  regels.push(dagen !== null
    ? `Er is ${dagen === 1 ? 'één dag' : `${dagen} dagen`} gewacht en er kwam niets binnen.`
    : 'De afgesproken termijn is verstreken en er kwam niets binnen.');

  const link = gesprekLink(opvolging, basisUrl);
  if (link) {
    regels.push('');
    regels.push(`Het gesprek: ${link}`);
  }

  regels.push('');
  regels.push('Deze opvolging is hiermee afgerond. Wil je opnieuw wachten, zet er dan een nieuwe op.');
  return regels.join('\n');
}

/** Het onderwerp. Kort, met de omschrijving erin zodat de inbox al genoeg zegt. */
export function meldOnderwerp(opvolging) {
  const kort = String(opvolging?.omschrijving || 'opvolging').trim().slice(0, 80);
  return `Geen reactie: ${kort}`;
}

/** Hele dagen tussen twee tijdstempels. Null als er iets onleesbaars bij zit. */
export function dagenTussen(van, tot) {
  const a = van ? Date.parse(van) : NaN;
  const b = tot ? Date.parse(tot) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.max(1, Math.round((b - a) / (24 * 3600 * 1000)));
}

/**
 * De link naar het gesprek, of null.
 *
 * Alleen voor een opvolging op een GESPREK. Bij een contact is er geen enkele
 * draad om heen te wijzen, en een link naar "ergens in de module" is erger dan
 * geen link: die kost een klik en levert niets op.
 */
export function gesprekLink(opvolging, basisUrl = '') {
  if (!opvolging?.gesprek_id || opvolging.waarop !== 'gesprek') return null;
  const basis = String(basisUrl || '').replace(/\/+$/, '');
  if (!basis) return null;
  return `${basis}/modules/klanten-v2/index.html?v2preview=iris&gesprek=${encodeURIComponent(opvolging.gesprek_id)}`;
}
