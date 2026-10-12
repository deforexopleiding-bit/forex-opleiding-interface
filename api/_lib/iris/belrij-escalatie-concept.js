// api/_lib/iris/belrij-escalatie-concept.js
//
// Taak 6, deel 3 (schrijfkant) — van "drie keer niet opgenomen" naar een
// concept in de Post.
//
// `beslisEscalatie()` in belrij-escalatie.js zegt of er iets mag gebeuren en
// wat. Dit bestand doet het: het zoekt het gesprek, kiest het kanaal en zet de
// rij in `iris_concepten` met status 'klaar'. Eén klik van Maxim of Dave en het
// gaat weg langs het bestaande verzendpad — er is geen tweede verzendweg
// bijgebouwd, en dus ook geen tweede plek waar het ongedaan-venster van G2
// vergeten kan worden.
//
// ── VASTE TEKST, GEEN LLM-AANROEP ────────────────────────────────────────────
// Een "we proberen je te bereiken"-bericht is elke keer hetzelfde bericht. Een
// model erop zetten kost tokens, geeft drift tussen twee klanten die hetzelfde
// meemaken, en voegt een kans toe dat er een bedrag of een datum in belandt die
// niemand heeft nagekeken. Zelfde afweging als bij de intake-teksten van Joost
// (les 26): vaste tekst waar er geen context is om iets zinnigs mee te doen.
//
// Daarom staat er in deze teksten GEEN bedrag, GEEN factuurnummer en GEEN
// datum. Niet omdat het niet kan, maar omdat het niet hoeft: de vraag is
// "wanneer kunnen we je bereiken", en daar is geen cijfer voor nodig. Zo is er
// ook niets om te verzinnen.
//
// ── HET ENE GESPREK ──────────────────────────────────────────────────────────
// `iris_concepten.gesprek_id` is NOT NULL. Heeft een contact nul of meerdere
// gesprekken, dan is er geen enkele juiste keuze en komt er GEEN concept — dan
// staat de rij gewoon op de belrij met de reden erbij. Dezelfde regel als bij
// de doelbepaling van een opdracht (H1): nooit gokken op wie iemand is.
//
// ── NOOIT BIJ EEN KLACHT OF OPZEGGING ────────────────────────────────────────
// Is het gesprek ingedeeld als `opzeg_klacht_juridisch`, dan schrijft Iris
// niets. Dat is dezelfde regel als in instellingen.js (NOOIT_ZELF) en in
// templates.js (lege voorkeurslijst), en hij staat hier voor de derde keer
// omdat dit een derde weg naar de klant is.

import { CATEGORIEEN, NOOIT_ZELF, leesOngedaanSeconden } from './instellingen.js';
import { ESCALATIE_TEMPLATE, bruikbaar as bruikbareTemplates } from './templates.js';

/** Hoe lang het servicevenster van WhatsApp open staat. */
export const VENSTER_MS = 24 * 3600 * 1000;

/**
 * De teksten. Vast, en met opzet zonder bedrag, factuurnummer of datum.
 *
 * `{naam}` is het enige dat ingevuld wordt, en alleen als we een naam hebben;
 * anders valt de aanhef weg in plaats van "Hoi undefined" of "Hoi [invullen]".
 */
export const TEKST = Object.freeze({
  whatsapp_in_venster: (naam) =>
    `${naam ? `Hoi ${naam}, ` : 'Hoi, '}we hebben je de afgelopen dagen een paar keer geprobeerd te bellen ` +
    `maar kregen je niet te pakken. Wanneer schikt het jou? Een bericht hier terug is ook prima.`,
  mail_onderwerp: 'We proberen je te bereiken',
  mail_tekst: (naam) =>
    `${naam ? `Hoi ${naam},` : 'Hoi,'}\n\n` +
    `We hebben je de afgelopen dagen een paar keer geprobeerd te bellen, maar kregen je niet te pakken.\n\n` +
    `Laat even weten wanneer het jou schikt, dan bellen we je op dat moment. ` +
    `Antwoorden op deze mail kan ook.\n\n` +
    `Met vriendelijke groet,\nDe Forex Opleiding`,
});

/** De categorie waaronder deze concepten vallen, voor de autonomie-standen. */
export const CATEGORIE = 'overig';

/* ── het gesprek vinden ───────────────────────────────────────────────────── */

/**
 * Het ENE gesprek van dit contact, of een reden waarom er geen keuze is.
 *
 * Voorkeur voor WhatsApp als er precies één van elk is: daar is het venster van
 * 24 uur het argument om het nú te doen, en een mail kan altijd nog.
 *
 * @returns {{gesprek: object|null, reden: string|null}}
 */
export function kiesGesprek(gesprekken) {
  const lijst = (gesprekken || []).filter((g) => g && g.id);
  if (!lijst.length) return { gesprek: null, reden: 'geen gesprek om het aan te hangen' };

  const wa = lijst.filter((g) => g.kanaal === 'whatsapp');
  const mail = lijst.filter((g) => g.kanaal === 'email');

  if (wa.length === 1) return { gesprek: wa[0], reden: null };
  if (wa.length === 0 && mail.length === 1) return { gesprek: mail[0], reden: null };
  if (wa.length > 1) return { gesprek: null, reden: `${wa.length} WhatsApp-gesprekken — kies er zelf een` };
  return { gesprek: null, reden: `${mail.length} mailgesprekken — kies er zelf een` };
}

/** Staat het servicevenster nog open? Zonder inkomend bericht: nee. */
export function vensterOpen(gesprek, nu = new Date()) {
  const laatste = gesprek?.laatste_inbound;
  if (!laatste) return false;
  const ms = new Date(nu).getTime() - new Date(laatste).getTime();
  if (!Number.isFinite(ms)) return false;
  return ms >= 0 && ms < VENSTER_MS;
}

/**
 * Welke rijen moeten er in iris_concepten komen?
 *
 * Puur: geen databank, geen netwerk. Geeft nul, één of twee rijen terug — een
 * WhatsApp en/of een mail — plus wat er niet kon en waarom.
 *
 * Buiten het venster is een goedgekeurde template nodig. Is die er niet, dan
 * komt er GEEN WhatsApp-concept: een bericht forceren in een template die er
 * niet over gaat is erger dan een dag wachten (zelfde regel als templates.js).
 * De mail blijft dan over, en als die er ook niet is, komt er niets.
 */
export function bouwConcepten({
  gesprek,
  naam = null,
  email = null,
  templates = [],
  nu = new Date(),
}) {
  const uit = { rijen: [], overgeslagen: [] };
  if (!gesprek?.id) {
    uit.overgeslagen.push('geen gesprek');
    return uit;
  }
  if (NOOIT_ZELF.includes(gesprek.categorie)) {
    uit.overgeslagen.push('een opzegging of klacht schrijft Iris nooit zelf');
    return uit;
  }

  if (gesprek.kanaal === 'whatsapp') {
    if (vensterOpen(gesprek, nu)) {
      uit.rijen.push({
        gesprek_id: gesprek.id,
        kanaal: 'whatsapp',
        onderwerp: null,
        tekst: TEKST.whatsapp_in_venster(naam),
        template_naam: null,
        template_vars: null,
      });
    } else {
      const bruikbaar = bruikbareTemplates(templates);
      const template = bruikbaar.find((t) => t.name === ESCALATIE_TEMPLATE) || null;
      if (template) {
        uit.rijen.push({
          gesprek_id: gesprek.id,
          kanaal: 'whatsapp',
          onderwerp: null,
          tekst: null,
          template_naam: template.name,
          template_vars: naam ? { 1: naam } : {},
        });
      } else {
        uit.overgeslagen.push(
          `het venster is dicht en de template "${ESCALATIE_TEMPLATE}" is niet goedgekeurd`
        );
      }
    }
  }

  // De mail gaat er altijd bij als er een adres is: buiten het venster is hij
  // de enige weg, en binnen het venster is hij het vangnet voor iemand die zijn
  // WhatsApp niet leest. Twee concepten betekent niet twee berichten — een mens
  // kiest er één en annuleert de ander.
  if (email) {
    uit.rijen.push({
      gesprek_id: gesprek.id,
      kanaal: 'email',
      onderwerp: TEKST.mail_onderwerp,
      tekst: TEKST.mail_tekst(naam),
      template_naam: null,
      template_vars: null,
    });
  } else if (gesprek.kanaal === 'email') {
    uit.overgeslagen.push('mailgesprek zonder adres');
  }

  if (!uit.rijen.length && !uit.overgeslagen.length) {
    uit.overgeslagen.push('geen kanaal om het over te doen');
  }
  return uit;
}

/**
 * Wat er van een concept-rij gemaakt wordt voordat hij de databank in gaat.
 *
 * Bij stand 'concept' blijft hij op 'klaar' staan en wacht hij op een mens.
 * Bij stand 'zelf' wordt hij meteen 'goedgekeurd' met een `verstuur_na` —
 * waarna de BESTAANDE cron hem verstuurt, binnen het ongedaan-venster van G2.
 * Dat is met opzet: geen tweede verzendweg betekent geen tweede plek waar de
 * claim-voor-versturen vergeten kan worden.
 */
export function metStand(rij, { doen, ongedaanSeconden = 30, nu = new Date() }) {
  if (doen === 'zelf') {
    return {
      ...rij,
      status: 'goedgekeurd',
      verstuur_na: new Date(new Date(nu).getTime() + Math.max(5, Number(ongedaanSeconden) || 30) * 1000).toISOString(),
    };
  }
  return { ...rij, status: 'klaar', verstuur_na: null };
}

export { leesOngedaanSeconden, CATEGORIEEN };
