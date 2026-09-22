// api/_lib/iris/schrijf.js
//
// Het antwoord schrijven.
//
// ── DE VOLGORDE ──────────────────────────────────────────────────────────────
// Dossier → instructie → model → poort. In die volgorde, en de poort komt
// altijd laatst. Wat het model produceert is een voorstel, geen uitkomst; pas
// nadat keurTekst() er naar gekeken heeft mag het ergens heen.
//
// ── WAT ER IN DE PROMPT GAAT, EN WAT NIET ────────────────────────────────────
// Het dossier gaat mee als PLATTE FEITEN, niet als vrije tekst. Bedragen met
// hun factuurnummer, dagen te laat, de LMS-stand, een lopende belofte. Dat is
// wat het model nodig heeft om niet te hoeven gokken.
//
// Wat er niet in gaat: de interne toestand van de aanmaanmotor voorbij de
// fasenaam, de belpogingen van collega's, het e-mailadres van andere klanten.
// Een model kan alleen lekken wat het gekregen heeft.
//
// ── DE BELANGRIJKSTE ZIN IN DE HELE PROMPT ───────────────────────────────────
// "Staat het gegeven niet in het dossier hieronder, schrijf dan letterlijk
// [invullen]." Dat is de enige manier om een taalmodel te laten zwijgen over
// iets wat het niet weet: geef het een uitweg die geen verzinsel is. Zonder
// die uitweg vult het de gaten, want dat is wat het doet.

import { anthropicStructuredOutput, AnthropicClientError } from '../anthropic-client.js';
import { TOON_INSTRUCTIE, keurTekst, zetOndertekening, ONTBREEKT } from './toon.js';

/** Categorieën waarvoor Iris geen antwoord schrijft maar het doorgeeft. */
export const ALTIJD_EEN_MENS = Object.freeze(['opzeg_klacht_juridisch']);

export const GEREEDSCHAP_SCHEMA = {
  type: 'object',
  properties: {
    tekst: {
      type: 'string',
      description: 'Het antwoord aan de klant. Nederlands. Geen ondertekening.',
    },
    onderwerp: {
      type: 'string',
      description: 'Alleen bij mail: het onderwerp. Bij WhatsApp een lege tekst.',
    },
    ontbrekende_gegevens: {
      type: 'array',
      items: { type: 'string' },
      description: 'Welke gegevens je miste en waarvoor je [invullen] hebt geschreven. Leeg als je niets miste.',
    },
    toelichting: {
      type: 'string',
      description: 'Eén zin voor de medewerker: waarom dit antwoord. Niet voor de klant.',
    },
  },
  required: ['tekst', 'ontbrekende_gegevens', 'toelichting'],
};

/**
 * Zet de dossierkaart om in feiten die een model kan lezen.
 *
 * Exporteerbaar en zuiver, zodat te testen is wat er wél en niet in de prompt
 * belandt. Dat is niet alleen netjes: wat hier per ongeluk in komt, kan het
 * model naar een klant schrijven.
 */
export function dossierAlsFeiten(dossier) {
  if (!dossier) return 'Er is geen dossier beschikbaar. Ga van niets uit.';
  const r = [];

  const c = dossier.contact;
  r.push(`Persoon: ${c?.naam || 'naam onbekend'}`);
  if (c?.koppelstatus && c.koppelstatus !== 'gekoppeld') {
    r.push('LET OP: deze persoon is nog niet zeker aan een klant gekoppeld. Noem geen factuurgegevens.');
  }

  // Facturen. De gelezen-vlag is hier geen formaliteit: "geen open facturen"
  // en "we konden niet kijken" leiden tot een totaal ander antwoord.
  const f = dossier.facturen;
  if (!f || f.gelezen === false) {
    r.push('Facturen: NIET GELEZEN. Zeg niets over facturen, bedragen of vervaldata.');
  } else if (!f.items.length) {
    r.push('Facturen: geen openstaande facturen.');
  } else {
    r.push('Openstaande facturen:');
    for (const inv of f.items) {
      const nr = inv.nummer || inv.id.slice(0, 8);
      const laat = inv.te_laat ? `, ${inv.dagen_te_laat} dagen over de vervaldatum` : ', nog niet vervallen';
      r.push(`  - ${nr}: € ${inv.bedrag_open.toFixed(2)}, vervaldatum ${inv.vervaldatum || 'onbekend'}${laat}`);
    }
    const t = dossier.totalen || {};
    r.push(`  Totaal open: € ${Number(t.open_bedrag || 0).toFixed(2)}`);

    // De harde regel uit de opdracht, hier als zin in de prompt én als controle
    // in de poort. Twee keer, want dit is er een die geld kost als hij misgaat.
    const mag = dossier.mag_over_facturen_praten;
    if (mag && mag.mag === false) {
      r.push('  LET OP: geen enkele factuur is over de vervaldatum. Vraag NIET om betaling en maan NIET aan.');
    }
  }

  const m = dossier.aanmaanmotor;
  if (m?.gelezen && m.fase) r.push(`Aanmaanmotor: fase "${m.fase}".`);

  const l = dossier.lms;
  if (l?.gelezen && l.student) {
    r.push(`LMS: toegang tot ${l.student.toegang_tot || 'onbekend'}${l.student.toegang_geldig === false ? ' (VERLOPEN)' : ''}.`);
    if (l.student.product) r.push(`  Traject: ${l.student.product}`);
    if (l.student.no_shows) r.push(`  Niet op komen dagen: ${l.student.no_shows}×`);
  } else if (l?.gelezen === false) {
    r.push('LMS: NIET GELEZEN. Zeg niets over toegang of einddatum.');
  }

  const b = dossier.beloftes?.actief;
  if (b) r.push(`Lopende betaalafspraak: € ${Number(b.bedrag || 0).toFixed(2)} op ${b.datum}. Houd je daaraan; vraag niet eerder om betaling.`);

  const s = dossier.signalen;
  if (s?.gelezen && s.items?.length) {
    r.push('Mentorsignalen:');
    for (const sig of s.items.slice(0, 3)) {
      r.push(`  - ${sig.type}${sig.toelichting ? `: ${sig.toelichting}` : ''}`);
    }
  }

  return r.join('\n');
}

/** Bouw de instructie aan het model. */
export function bouwSysteem({ kanaal, categorie, dossier, kennis }) {
  const delen = [
    'Je schrijft namens De Forex Opleiding, een Nederlandstalige opleider in Vlaanderen en Nederland.',
    `Je schrijft een antwoord via ${kanaal === 'email' ? 'e-mail' : 'WhatsApp'}.`,
    '',
    TOON_INSTRUCTIE,
    '',
    'Het dossier van deze persoon:',
    dossierAlsFeiten(dossier),
  ];
  if (categorie) {
    delen.push('', `De vraag is ingedeeld als: ${categorie}.`);
  }
  if (kennis && typeof kennis === 'object' && Object.keys(kennis).length) {
    delen.push('', 'Vaste bedrijfsgegevens die je mag gebruiken:', JSON.stringify(kennis, null, 2));
  }
  return delen.join('\n');
}

/** Bouw de beurt met de voorgeschiedenis en de instructie van de medewerker. */
export function bouwBerichten({ voorgeschiedenis, instructie, laatsteBericht }) {
  const delen = [];
  const eerder = Array.isArray(voorgeschiedenis) ? voorgeschiedenis.slice(-8) : [];
  if (eerder.length) {
    delen.push('Het gesprek tot nu toe (oudste eerst):');
    for (const b of eerder) {
      delen.push(`  [${b?.richting === 'uit' ? 'wij' : 'klant'}] ${String(b?.tekst_kort || '').slice(0, 400)}`);
    }
    delen.push('');
  }
  if (laatsteBericht) {
    delen.push('Waar je op antwoordt:');
    delen.push(String(laatsteBericht).slice(0, 2000));
    delen.push('');
  }
  delen.push(instructie
    ? `Wat de medewerker wil dat je schrijft:\n${String(instructie).slice(0, 2000)}`
    : 'Schrijf een passend antwoord op het laatste bericht.');
  return [{ role: 'user', content: delen.join('\n') }];
}

/**
 * Schrijf een concept.
 *
 * Gooit niet. Geeft altijd een object met `ok` terug.
 *
 * @returns {Promise<{ok: boolean, concept?: object, fout?: string, mensNodig?: boolean}>}
 */
export async function schrijfConcept({
  kanaal = 'whatsapp',
  categorie = null,
  dossier = null,
  kennis = null,
  voorgeschiedenis = [],
  laatsteBericht = null,
  instructie = null,
  model = null,
  temperatuur = 0.3,
  eigenNaam = null,
} = {}) {
  // Sommige dingen schrijft Iris niet. Dat is geen instelling en geen
  // zekerheidsdrempel — het is een eigenschap. Een opzegging of een klacht
  // beantwoorden met een gegenereerde zin is het soort fout waar je later
  // niet meer omheen praat.
  if (ALTIJD_EEN_MENS.includes(categorie)) {
    return {
      ok: true,
      mensNodig: true,
      concept: {
        tekst: '',
        onderwerp: '',
        ontbrekende_gegevens: [],
        toelichting: 'Dit gaat over een opzegging, een klacht of iets juridisch. Iris schrijft hier niets; een mens kijkt ernaar.',
        blokkades: ['Deze categorie gaat altijd langs een mens.'],
        waarschuwingen: [],
        mag_verstuurd_worden: false,
      },
    };
  }

  try {
    const ruw = await anthropicStructuredOutput({
      system: bouwSysteem({ kanaal, categorie, dossier, kennis }),
      messages: bouwBerichten({ voorgeschiedenis, instructie, laatsteBericht }),
      tool_name: 'schrijf_antwoord',
      tool_input_schema: GEREEDSCHAP_SCHEMA,
      model: model || undefined,
      temperature: Number.isFinite(temperatuur) ? temperatuur : 0.3,
      max_tokens: 1200,
    });

    let tekst = String(ruw?.tekst || '').trim();
    if (!tekst) return { ok: false, fout: 'Het model gaf geen tekst terug.' };

    tekst = zetOndertekening(tekst, { kanaal, eigenNaam });

    // De poort. Altijd hier, altijd na het model, altijd vóór het opslaan.
    const keuring = keurTekst(tekst, { kanaal, doorMens: false });

    // Het model zegt zelf welke gegevens het miste. Dat is nuttig voor de
    // medewerker, maar het is geen bewijs: de controle op [invullen] in de
    // tekst is wat telt. Een model dat iets verzint, meldt dat niet.
    const gemeld = Array.isArray(ruw.ontbrekende_gegevens) ? ruw.ontbrekende_gegevens.map(String) : [];
    const echtOntbrekend = tekst.includes(ONTBREEKT);

    return {
      ok: true,
      concept: {
        tekst,
        onderwerp: kanaal === 'email' ? String(ruw.onderwerp || '').trim() : '',
        ontbrekende_gegevens: gemeld,
        heeft_gaten: echtOntbrekend,
        toelichting: String(ruw.toelichting || '').trim(),
        blokkades: keuring.blokkades,
        waarschuwingen: keuring.waarschuwingen,
        mag_verstuurd_worden: keuring.mag,
      },
    };
  } catch (e) {
    const code = (e instanceof AnthropicClientError && e.code) ? e.code : 'ONBEKEND';
    console.error('[iris/schrijf] mislukt:', code, e?.message || e);
    return { ok: false, fout: `${code}: ${e?.message || e}` };
  }
}
