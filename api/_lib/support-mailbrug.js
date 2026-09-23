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

// Namen van de unieke indexen uit
// docs/sql-migrations/2026-09-23-support-mail-ontdubbelen.sql. Een schending
// daarvan betekent: een andere run (of een andere kopie van dezelfde mail) was
// ons voor. Dat is geen storing.
export const UNIEKE_BRON_INDEXEN = [
  'uniq_support_bericht_bron_email',
  'uniq_support_bericht_bron_message',
];

/**
 * Een Message-ID normaliseren tot iets waarop we kunnen ontdubbelen.
 *
 * Dezelfde mail die naar info@ én events@ gaat, landt als twee rijen in
 * email_messages (één per mailbox), met twee verschillende id's maar
 * dezelfde Message-ID. Die header is dus de sleutel voor "dezelfde mail".
 *
 * We halen de punthaken en witruimte eraf en laten de rest ongemoeid —
 * Message-ID's zijn hoofdlettergevoelig. Wat geen bruikbare ID is (leeg,
 * spaties erin, te lang, of met " of \ die in een PostgREST-filter niet
 * veilig te citeren zijn) wordt null: dan ontdubbelen we alleen op
 * bron_email_id, zoals voorheen.
 *
 * @param {*} raw
 * @returns {string|null}
 */
export function normaliseerMessageId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().replace(/^<+/, '').replace(/>+$/, '').trim();
  if (!id || id.length > 500) return null;
  if (/[\s"\\]/.test(id)) return null;
  return id;
}

/**
 * Is deze databasefout een botsing op een van onze bron-indexen?
 *
 * Postgres meldt een unieke-sleutelschending als SQLSTATE 23505; PostgREST
 * geeft die door als `error.code` met de indexnaam in `message`. We kijken
 * naar allebei: een 23505 op een andere index (die er nu niet is, maar
 * later kan komen) moet gewoon als fout blijven tellen.
 *
 * @param {*} error — het error-object uit supabase-js
 * @returns {boolean}
 */
export function isAlVerwerktFout(error) {
  if (!error || String(error.code || '') !== '23505') return false;
  const tekst = `${error.message || ''} ${error.details || ''}`;
  return UNIEKE_BRON_INDEXEN.some((naam) => tekst.includes(naam));
}

/**
 * Uit een batch mails kiezen wat nog verwerkt moet worden.
 *
 * Valt af: een mail waarvan het id al als bron_email_id in een bericht staat,
 * een mail waarvan de Message-ID al bekend is, en een tweede kopie van
 * dezelfde Message-ID binnen deze batch (info@ en events@ in één run). De
 * eerste kopie in de aangeleverde volgorde wint.
 *
 * @param {Array<{id:string, message_id?:string}>} mails
 * @param {{ bekendeEmailIds?: Iterable<string>, bekendeMessageIds?: Iterable<string> }} bekend
 * @returns {Array<{ mail: object, messageId: string|null }>}
 */
export function kiesNieuweMails(mails, { bekendeEmailIds = [], bekendeMessageIds = [] } = {}) {
  const emailIds = new Set(bekendeEmailIds);
  const messageIds = new Set(bekendeMessageIds);
  const uit = [];
  for (const mail of mails || []) {
    if (!mail?.id || emailIds.has(mail.id)) continue;
    const messageId = normaliseerMessageId(mail.message_id);
    if (messageId) {
      if (messageIds.has(messageId)) continue;
      messageIds.add(messageId);
    }
    emailIds.add(mail.id);
    uit.push({ mail, messageId });
  }
  return uit;
}
