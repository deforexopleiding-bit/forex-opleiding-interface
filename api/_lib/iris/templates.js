// api/_lib/iris/templates.js
//
// Welke goedgekeurde template past bij dit bericht?
//
// ── HET PROBLEEM ─────────────────────────────────────────────────────────────
// Buiten het venster van 24 uur mag er alleen een door Meta goedgekeurde
// template weg. De bestaande gesprekken-module lost dat op met een keuzelijst
// vol kale namen: `aanmaning_dag7`, `opvolging_geen_reactie2`. Wie die lijst
// niet uit zijn hoofd kent, kiest de verkeerde of geeft het op.
//
// Iris weet waar het gesprek over gaat — ze heeft het net ingedeeld. Die
// wetenschap gebruiken om een template voor te stellen is precies het soort
// werk dat een mens niet hoort te doen.
//
// ── OP STATUS FILTEREN, NIET OP NAAM ─────────────────────────────────────────
// Namen veranderen, `APPROVED` niet. Een template die bij Meta op PAUSED of
// REJECTED staat en die we toch sturen, levert een geweigerd bericht op en op
// den duur een slechtere beoordeling van het nummer. De filtering staat dus op
// status en niet op een lijst namen die iemand ooit heeft opgeschreven.
//
// ── EN ALS ER GEEN PAST? ─────────────────────────────────────────────────────
// Dan gaat het bericht via mail, en komt de gewenste template in
// docs/iris/template-wensen.md te staan. Een bericht forceren in een template
// die er niet over gaat, is erger dan een dag wachten: de klant leest dan iets
// wat niet bij zijn vraag past en concludeert dat er niemand meekijkt.

import { CATEGORIEEN } from './instellingen.js';

/**
 * Welke template hoort bij welke categorie, en in welke volgorde van voorkeur.
 *
 * De namen hieronder zijn wat we in de code terugvinden. Ze staan hier als
 * VOORKEUR, niet als voorwaarde: bestaat de template niet of is hij niet
 * goedgekeurd, dan valt de keuze door naar de volgende. Zo breekt deze lijst
 * niet zodra iemand bij Meta een template hernoemt.
 */
export const VOORKEUR = Object.freeze({
  facturatie: ['factuur_vraag', 'aanmaning_dag7'],
  betaalafspraak: ['betaalafspraak_bevestiging', 'aanmaning_dag7'],
  wanbetaling_reactie: ['aanmaning_dag7'],
  lms_toegang: ['lms_toegang_hulp', 'opvolging_geen_reactie2'],
  lms_support: ['lms_support', 'opvolging_geen_reactie2'],
  planning_mentor: ['mentor_planning', 'opvolging_geen_reactie2'],
  bounce_systeem: [],
  overig: ['opvolging_geen_reactie2'],
  spam: [],
  // Met opzet leeg: een opzegging of klacht krijgt nooit een automatische
  // template. Dat is dezelfde regel als in instellingen.js, en hij staat hier
  // nog een keer omdat een lege lijst hier hetzelfde betekent.
  opzeg_klacht_juridisch: [],
});

/** De template voor "we proberen je te bereiken" na een reeks belpogingen. */
export const ESCALATIE_TEMPLATE = 'opvolging_geen_reactie2';

/** Alleen deze status mag weg. */
export const BRUIKBARE_STATUS = 'APPROVED';

/**
 * Filter een lijst templates op wat er daadwerkelijk verstuurd mag worden.
 *
 * MARKETING-templates vallen af, ook als ze goedgekeurd zijn. Een
 * betalingsherinnering onder een marketing-categorie versturen is een
 * overtreding van Meta's eigen indeling, en het is bovendien een categorie
 * waar klanten zich voor kunnen afmelden — dan mist een aanmaning zijn doel.
 */
export function bruikbaar(templates) {
  return (Array.isArray(templates) ? templates : []).filter((t) => {
    if (!t || !t.name) return false;
    if (String(t.status || '').toUpperCase() !== BRUIKBARE_STATUS) return false;
    if (String(t.category || '').toUpperCase() === 'MARKETING') return false;
    return true;
  });
}

/**
 * Kies een template bij een categorie.
 *
 * @param {Array} templates   alle bekende templates
 * @param {string} categorie
 * @param {object} opties
 * @param {string|null} opties.taal
 * @returns {{template: object|null, reden: string, alternatieven: Array}}
 */
export function kiesTemplate(templates, categorie, { taal = 'nl' } = {}) {
  if (categorie && !CATEGORIEEN.includes(categorie)) {
    return { template: null, reden: `onbekende categorie: ${categorie}`, alternatieven: [] };
  }

  const bruikbare = bruikbaar(templates).filter((t) => {
    if (!taal) return true;
    const tt = String(t.language || '').toLowerCase();
    // 'nl' matcht ook 'nl_BE' en 'nl_NL' — dat is dezelfde taal met een
    // regiocode erachter, en een template weigeren omdat er _BE achter staat
    // zou betekenen dat we naar Vlaanderen niets kunnen sturen.
    return tt === taal.toLowerCase() || tt.startsWith(taal.toLowerCase() + '_');
  });

  if (!bruikbare.length) {
    return {
      template: null,
      reden: 'er is geen enkele goedgekeurde template in deze taal',
      alternatieven: [],
    };
  }

  const voorkeur = VOORKEUR[categorie] || [];
  if (!voorkeur.length) {
    return {
      template: null,
      reden: categorie === 'opzeg_klacht_juridisch'
        ? 'voor een opzegging of klacht gaat er nooit automatisch een template weg'
        : `er is geen template afgesproken voor "${categorie}"`,
      alternatieven: bruikbare,
    };
  }

  for (const naam of voorkeur) {
    const gevonden = bruikbare.find((t) => t.name === naam);
    if (gevonden) {
      return {
        template: gevonden,
        reden: `past bij "${categorie}"`,
        alternatieven: bruikbare.filter((t) => t.name !== naam),
      };
    }
  }

  return {
    template: null,
    reden: `de templates voor "${categorie}" (${voorkeur.join(', ')}) bestaan niet of zijn niet goedgekeurd`,
    alternatieven: bruikbare,
  };
}

/**
 * Wat te doen als er geen template past.
 *
 * Drie uitwegen, in volgorde van voorkeur. De derde is uitdrukkelijk NIET
 * "stuur dan maar een andere template": een bericht forceren in een template
 * die er niet over gaat, is erger dan een dag wachten.
 */
export function terugvalpad({ heeftEmail, categorie }) {
  if (heeftEmail) {
    return {
      pad: 'mail',
      uitleg: 'Het venster is dicht en er past geen template. Dit gaat via mail.',
    };
  }
  return {
    pad: 'wachten',
    uitleg: `Het venster is dicht, er past geen template voor "${categorie}", en er is geen mailadres. ` +
      'Zet de gewenste template in docs/iris/template-wensen.md zodat Maxim hem bij Meta kan laten goedkeuren.',
  };
}

/**
 * Welke variabelen heeft deze template nodig, en hebben we ze?
 *
 * Meta weigert een template-send waarbij het aantal parameters niet klopt.
 * Dat is een 400 die er in de logs uitziet als een vaag probleem met de
 * componenten — dus kijken we het hier na, waar we er iets zinnigs over
 * kunnen zeggen.
 */
export function controleerVariabelen(template, waarden) {
  const body = String(template?.body_text || '');
  const genummerd = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const benoemd = [...body.matchAll(/\{\{([a-z_]+\.[a-z_]+)\}\}/gi)].map((m) => m[1]);

  const nodig = genummerd.length ? Math.max(...genummerd) : benoemd.length;
  const gegeven = Array.isArray(waarden) ? waarden.length : Object.keys(waarden || {}).length;

  if (nodig === 0) return { ok: true, nodig: 0, gegeven, ontbreekt: [] };
  if (gegeven < nodig) {
    return {
      ok: false,
      nodig,
      gegeven,
      ontbreekt: benoemd.length ? benoemd.slice(gegeven) : [],
      reden: `deze template heeft ${nodig} waarde(n) nodig en er ${gegeven === 1 ? 'is er 1' : `zijn er ${gegeven}`} gegeven`,
    };
  }
  return { ok: true, nodig, gegeven, ontbreekt: [] };
}
