// api/_lib/support-mailbrug.js
//
// De brug tussen de supportmodule en de mailbox.
//
// Aanleiding: in de antwoordmail staat "Je kunt op deze mail antwoorden."
// Dat was tot nu toe een loze belofte. Het antwoord kwam wél binnen op
// info@, maar belandde in de e-mailmodule als een losse mail — niet terug in
// het gesprek. De collega die de wachtrij bewaakt zag dus niets, het gesprek
// bleef op 'wacht_op_klant' staan, en de klant wachtte op een reactie die
// niemand aan het schrijven was.
//
// Hier staat de pure kant van die brug: het kenmerk uit een onderwerpregel
// vissen en de citaatgeschiedenis van een mailantwoord afknippen. Beide zijn
// bewust zonder database en zonder netwerk, zodat ze te testen zijn met de
// echte rommel die mailprogramma's produceren.

// Hetzelfde alfabet als maakKenmerk() in support-sessie.js — zonder 0/O/1/I/L.
// Die beperking is hier winst: een `Re: [SUP-…]`-achtige string uit een
// andere afzender matcht niet zomaar per ongeluk.
const KENMERK_RE = /SUP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}/i;

/**
 * Het kenmerk uit een onderwerpregel halen.
 *
 * Onze eigen onderwerpen zijn "Antwoord op je vraag (SUP-7K2M9Q)" en
 * "We hebben je vraag binnen (SUP-7K2M9Q)"; een antwoord daarop komt terug
 * als "Re:", "RE:", "Antw:", "Fwd:" of een van de tientallen lokale
 * varianten. Daarom zoeken we het kenmerk ergens in de regel in plaats van
 * een prefix af te pellen.
 *
 * @param {*} onderwerp
 * @returns {string|null} het kenmerk in hoofdletters, of null
 */
export function kenmerkUitOnderwerp(onderwerp) {
  if (typeof onderwerp !== 'string') return null;
  const m = onderwerp.match(KENMERK_RE);
  return m ? m[0].toUpperCase() : null;
}

// Regels waarmee mailprogramma's het citaat inluiden. Alles vanaf de eerste
// treffer valt weg. Bewust breed: een citaat dat blijft staan is erger dan
// een zin te weinig — de volledige mail blijft sowieso in de e-mailmodule
// staan, dus er gaat niets verloren.
const CITAAT_START = [
  /^\s*>/,                                             // > geciteerde regel
  /^\s*Op .{0,120}\bschreef\b.{0,80}:\s*$/i,           // Op <datum> schreef X:
  /^\s*Op .{0,120}\bheeft\b.{0,120}\bgeschreven\b/i,
  /^\s*On .{0,120}\bwrote\b.{0,40}:\s*$/i,             // On <date> X wrote:
  /^\s*-{2,}\s*(Oorspronkelijk bericht|Original Message|Origineel bericht)\s*-{2,}/i,
  /^\s*_{5,}\s*$/,                                     // Outlook-scheidingslijn
  /^\s*(Van|From|Verzonden|Sent)\s*:\s*.+$/i,          // Outlook-headerblok
  /^\s*(Verstuurd vanaf|Sent from) mijn /i,
  /^\s*(Verstuurd vanaf|Sent from) my /i,
];

/**
 * De citaatgeschiedenis van een mailantwoord afknippen.
 *
 * Zonder dit staat onze eigen vorige mail integraal in de chat, en dan leest
 * de thread in het CRM als een echoput. We knippen bij de eerste regel die
 * een citaat inluidt en houden wat de klant zelf getypt heeft.
 *
 * @param {*} tekst  — body_text van de mail
 * @param {number} [max=4000]
 * @returns {string} de eigen tekst, getrimd; lege string als er niets overblijft
 */
export function strookCitaat(tekst, max = 4000) {
  if (typeof tekst !== 'string' || !tekst.trim()) return '';

  const regels = tekst.replace(/\r\n/g, '\n').split('\n');
  const eigen = [];
  for (const regel of regels) {
    if (CITAAT_START.some((re) => re.test(regel))) break;
    eigen.push(regel);
  }

  // Niets over? Dan begon de mail meteen met een citaat. Val terug op de hele
  // tekst: een echoput in de thread is nog altijd beter dan een leeg bericht
  // waar de collega niets aan heeft.
  const uit = eigen.join('\n').trim();
  return (uit || tekst.trim()).replace(/\n{3,}/g, '\n\n').slice(0, max);
}

/**
 * Hoort dit mailadres bij dit gesprek?
 *
 * Dit is de enige toegangscontrole op deze route, en daarom hard: alleen het
 * adres waar wij de mail naartoe stuurden mag terugschrijven in het gesprek.
 * Een kenmerk is kort genoeg om te raden, en zonder deze check zou iemand met
 * een gegokt kenmerk een bericht in andermans gesprek kunnen zetten — en daar
 * dan ook nog het antwoord van een collega op krijgen.
 *
 * Afzender-adressen zijn niet cryptografisch te vertrouwen (een From is te
 * vervalsen), dus dit verhoogt níets: `geverifieerd` blijft staan zoals het
 * stond. Een mailantwoord is genoeg om een vraag te stellen, niet om
 * persoonlijke gegevens los te krijgen.
 *
 * @param {*} afzender
 * @param {*} gesprekEmail
 * @returns {boolean}
 */
export function afzenderHoortBij(afzender, gesprekEmail) {
  const a = String(afzender || '').trim().toLowerCase();
  const b = String(gesprekEmail || '').trim().toLowerCase();
  if (!a || !b || !a.includes('@') || !b.includes('@')) return false;
  return a === b;
}
