// api/_lib/gesprekken-verzondenkopie.js
//
// Je eigen antwoord terugzien in je mailbox.
//
// ── HET GAT ──────────────────────────────────────────────────────────────────
// api/send-email.js verstuurt via Strato's SMTP en schrijft een regel in
// email_replies. Meer niet. Strato zet uitgaande mail nergens in de mailbox
// zelf neer, dus wie in Thunderbird kijkt of op zijn telefoon, ziet zijn eigen
// antwoord niet staan.
//
// Dat is niet alleen onhandig — het is de directe aanleiding voor een tweede
// antwoord op dezelfde mail, door dezelfde persoon of door een collega, omdat
// niets laat zien dat er al geantwoord is. Gat G7 uit
// docs/iris/02-gesprekken-audit.md.
//
// Iris deed dit al voor haar eigen verzendingen (api/_lib/iris/verzend.js).
// Dit is dezelfde beweging voor de knop waar een mens op drukt.
//
// ── WAAROM WE DE MAIL NIET OPNIEUW OPBOUWEN ──────────────────────────────────
// De verleiding is om een eenvoudig platte-tekstbericht in elkaar te zetten,
// zoals Iris doet. Dat kan hier niet: deze mail kan opmaak hebben,
// kopieontvangers, en bijlagen. Een kopie die de bijlage kwijt is, is erger
// dan geen kopie — dan zie je in Verzonden staan dat je geantwoord hebt en
// neem je aan dat het contract meeging.
//
// Daarom bouwen we de kopie met dezelfde opsteller die de verzending gebruikt
// (nodemailer), uit exact dezelfde opdracht. Wat de klant kreeg en wat er in
// Verzonden komt te staan, is dan hetzelfde bericht — tot en met het
// Message-ID, zodat een mailprogramma de kopie aan de draad hangt in plaats
// van als los bericht te tonen.
//
// Bcc: de echte verzending haalt die kopregel eruit (anders zien de
// ontvangers wie er stiekem meelas). In onze eigen kopie blijft hij staan, en
// dat is de bedoeling: je wilt later kunnen terugzien wie je hebt meegestuurd.
// Deze bytes gaan nooit naar een ontvanger — ze gaan alleen naar onze eigen
// map Verzonden.

import nodemailer from 'nodemailer';
import { zetRauwInVerzonden } from './iris/verzonden-map.js';
import { gesprekkenV2Aan } from './gesprekken-vlag.js';

/**
 * Mag er een kopie gemaakt worden?
 *
 * Achter dezelfde vlag als de rest van de gesprekken-verbeteringen. Let op:
 * dit endpoint bedient ook de e-mailmodule en de events-module, dus met de
 * vlag aan krijgen die er net zo goed een kopie bij. Dat is gewenst, maar het
 * is wel meer dan alleen "de gesprekken".
 */
export function magKopieMaken(env) {
  return gesprekkenV2Aan(env);
}

/**
 * De opdracht voor de kopie, afgeleid van de opdracht die verstuurd is.
 *
 * Zuiver, want hier zit het ene ding dat stil kan breken: het Message-ID. Komt
 * dat niet mee, dan krijgt de kopie een nieuw id en staat hij in Thunderbird
 * als een tweede, losstaand bericht naast het origineel — precies de
 * verwarring die deze kopie moet wegnemen.
 */
export function kopieOpdracht(verzendOpdracht, { messageId = null, datum = null } = {}) {
  const opdracht = { ...(verzendOpdracht || {}) };
  if (messageId) opdracht.messageId = messageId;
  if (datum) opdracht.date = datum;
  return opdracht;
}

/**
 * Maak er overal CRLF-regeleindes van.
 *
 * Dit is geen overbodige netheid. nodemailer zet de kopregels en de
 * scheidingen netjes op CRLF, maar de TEKST van het bericht laat het staan
 * zoals hij binnenkwam — en die komt hier uit een webformulier, dus met kale
 * LF's. Bij het versturen is dat onzichtbaar, want de SMTP-laag trekt het
 * alsnog recht. Bij een IMAP APPEND is er geen laag die dat doet: daar gaan de
 * bytes er precies zo in als wij ze aanleveren. Een strenge server weigert het
 * bericht dan, en een minder strenge bewaart een kopie die in je mailprogramma
 * als één lange regel oogt.
 *
 * Veilig over de hele buffer: alles wat geen platte tekst is (een bijlage,
 * een afbeelding) zit al in base64, en daar staat geen losse CR of LF in.
 */
export function normaliseerRegeleindes(bytes) {
  if (!bytes) return bytes;
  const s = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  return Buffer.from(s.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8');
}

/**
 * Bouw de rauwe bytes van het bericht.
 *
 * nodemailer heeft hier een vervoerder voor die niets verstuurt maar het
 * bericht teruggeeft. Zo gebruiken we de opsteller die de verzending ook
 * gebruikt, zonder een tweede, eigen opbouw die uit de pas kan gaan lopen.
 *
 * @returns {Promise<Buffer|null>}
 */
export async function bouwRauweKopie(opdracht) {
  const opsteller = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows', // IMAP wil regels die op CRLF eindigen
  });
  const gebouwd = await opsteller.sendMail(opdracht);
  if (!Buffer.isBuffer(gebouwd?.message)) return null;
  return normaliseerRegeleindes(gebouwd.message);
}

/**
 * Zet een kopie van een zojuist verstuurde mail in de map Verzonden.
 *
 * Gooit nooit, en geeft nooit een afwijzing terug die een aanroeper moet
 * afhandelen. Op het moment dat dit draait is de mail al weg; of de kopie
 * lukt verandert niets aan wat de ontvanger kreeg. De aanroeper hoeft hier
 * dus niet op te wachten en al helemaal niet op te struikelen.
 *
 * @returns {Promise<{ok: boolean, map?: string, reden?: string}>}
 */
export async function plaatsKopieInVerzonden({ mailbox, verzendOpdracht, messageId = null }) {
  try {
    const rauw = await bouwRauweKopie(kopieOpdracht(verzendOpdracht, { messageId }));
    if (!rauw) return { ok: false, reden: 'bericht niet op te bouwen' };
    return await zetRauwInVerzonden({ mailbox, rauw });
  } catch (e) {
    console.warn('[verzonden-kopie] kopie niet neergezet:', e?.message || e);
    return { ok: false, reden: e?.message || 'onbekende fout' };
  }
}
