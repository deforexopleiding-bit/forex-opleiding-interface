// api/_lib/cadeau-mail.js
//
// Mail bij een cadeaupagina van de website (2026-11-25, Maxim): /checklist nu,
// straks reken, scan, funded, plan, regels. Bij het afronden van de oefening
// stuurt de website (server-to-server) een verzoek; het CRM bouwt de mail ZELF
// op uit deze vaste inhoud en verstuurt hem vanaf welkom@ in de opmaak van de
// bevestiging van de strategie-scan (mail-shell-afspraak.js).
//
// Pure kern (geen IO): inhoud per cadeau, mail bouwen, invoer controleren en de
// beslissing "mag er nog een mail weg" (één verstuurde mail per lead per
// cadeau). De route (api/public-cadeau-mail.js) doet de IO.
//
// Veiligheid: het verzoek draagt alleen cadeau + e-mail + score. Voornaam en
// adres komen uit de LEAD (bestaand, campagne = het cadeau), nooit vrije tekst
// uit het verzoek: zo kan de route niet misbruikt worden om andere inhoud of
// naar willekeurige adressen te mailen.

import { renderAfspraakMail, platteTekstAfspraak } from './mail-shell-afspraak.js';

export const MAIL_VAN = 'welkom@deforexopleiding.nl'; // zelfde afzender als de bevestiging van de strategie-scan
export const SITE = (process.env.SUPPORT_SITE_URL || 'https://www.deforexopleiding.nl').replace(/\/+$/, '');
export const DISCLAIMER = 'Geen garantie op resultaat; traden brengt risico op verlies mee.';

/** Inhoud per cadeau. Nieuw cadeau = een sleutel erbij (zelfde vorm). */
export const CADEAU_MAILS = Object.freeze({
  checklist: Object.freeze({
    onderwerp: 'Je checklist: de entry-check',
    titel: 'Je checklist: de entry-check',
    maxScore: 5,
    // Zelfde tekst als het eindscherm op /checklist (dfo-website lib/checklist-oefening.ts).
    regels: Object.freeze([
      ['Doorbraak', 'Een kaars sluit met haar lichaam door de vorige high of low. Een wiek telt niet.'],
      ['Sweep', 'De stops net onder een low of boven een high zijn opgehaald. Dat punt is je beschermde low of high.'],
      ['Volume', 'De doorbraak liet een gat achter in de kaarsen.'],
      ['Order block', 'De kaars net voor het gat is gemarkeerd.'],
      ['Meetlat', 'Van wiek tot wiek gemeten. De instap ligt op 0,71.'],
      ['Risico', 'Maximaal 1% per idee. De stop ligt onder het 1-niveau. Raakt prijs het nulniveau, dan gaat de stop naar de instap. Het doel ligt op −0,27.'],
    ]),
    inleiding: (voornaam, score, max) =>
      `Hoi ${voornaam}, hier is de checklist die wij bij elke trade openhouden. Je had er ${score} van de ${max} in één keer juist.<br><br>Eén leeg vakje betekent: geen trade.`,
    knop: 'Bespreek je resultaat met Dave',
    knopPad: '/agenda/strategiescan?cadeau=checklist',
    naKnop: 'Twintig minuten via Zoom. Je loopt samen je grafiek door en je weet wat je eerst moet oefenen.',
  }),
});

export function isCadeauMail(c) { return typeof c === 'string' && Object.prototype.hasOwnProperty.call(CADEAU_MAILS, c); }

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Controleer het verzoek van de website. PURE. */
export function valideerCadeauMailVerzoek(body) {
  const b = body && typeof body === 'object' ? body : {};
  const cadeau = String(b.cadeau || '').trim().toLowerCase();
  if (!isCadeauMail(cadeau)) return { ok: false, fout: 'onbekend cadeau' };
  const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) return { ok: false, fout: 'geldig e-mailadres vereist' };
  const max = CADEAU_MAILS[cadeau].maxScore;
  const score = Number(b.score);
  if (!Number.isInteger(score) || score < 0 || score > max) return { ok: false, fout: `score moet 0..${max} zijn` };
  return { ok: true, cadeau, email, score };
}

/** De voornaam uit de lead, veilig voor een aanhef (letters, spatie, - en '). PURE. */
export function veiligeVoornaam(v) {
  const s = String(v || '').normalize('NFC').replace(/[^\p{L}\s'’-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'daar';
}

/** De mail (onderwerp, html, tekst) voor een cadeau. PURE. */
export function bouwCadeauMail(cadeau, { voornaam, score }) {
  const m = CADEAU_MAILS[cadeau];
  if (!m) throw new Error('onbekend cadeau: ' + cadeau);
  const args = {
    subject: m.onderwerp,
    titel: m.titel,
    inleiding: m.inleiding(esc(veiligeVoornaam(voornaam)), score, m.maxScore),
    details: m.regels.map(([label, tekst]) => ({ label, waarde: esc(tekst) })),
    cta: { label: m.knop, url: SITE + m.knopPad },
    voetnoot: `${esc(m.naKnop)}<br><br>${esc(DISCLAIMER)}`,
  };
  return { subject: m.onderwerp, html: renderAfspraakMail(args), text: platteTekstAfspraak(args) };
}

export const LOG_SOORT = (cadeau) => `cadeau-${cadeau}`;

/**
 * Mag er een mail weg? Eén VERSTUURDE mail per lead per cadeau; na een mislukte
 * poging mag het opnieuw, maar niet vaker dan 5 pogingen per uur. PURE.
 * @param {Array<{status:string, verstuurd_op:string}>} log  berichten_log-rijen van die lead + soort
 */
export function magCadeauMailWeg(log = [], nu = Date.now()) {
  if (log.some((r) => r.status === 'verstuurd')) return { mag: false, reden: 'al_verstuurd' };
  const uur = nu - 3600 * 1000;
  const recent = log.filter((r) => r.status === 'mislukt' && new Date(r.verstuurd_op).getTime() > uur).length;
  if (recent >= 5) return { mag: false, reden: 'te_veel_pogingen' };
  return { mag: true, reden: null };
}
