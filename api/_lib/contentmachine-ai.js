// api/_lib/contentmachine-ai.js
//
// Contentmachine — Anthropic-aanroepen (zelfde client en ANTHROPIC_API_KEY als
// de rest van het CRM: api/_lib/anthropic-client.js).
//
//   - modelKeten():     probeert het nieuwste model eerst en valt terug als de
//                        sleutel dat model (nog) niet kent (404 / "model").
//                        Overschrijfbaar met env CONTENTMACHINE_MODEL.
//   - beschrijfBeeld(): vision op één beeld (publieke Storage-URL) → korte
//                        beschrijving + wat er concreet op staat (bedrag,
//                        firma, paar, setup …). Verzint niets: onleesbaar = null.

import { anthropicStructuredOutput } from './anthropic-client.js';

export const MODELLEN = ['claude-sonnet-5-5', 'claude-sonnet-4-6'];

export function modellen() {
  const eigen = String(process.env.CONTENTMACHINE_MODEL || '').trim();
  return eigen ? [eigen, ...MODELLEN.filter((m) => m !== eigen)] : MODELLEN.slice();
}

/** Model onbekend voor deze sleutel? Dan het volgende proberen. */
export function isModelFout(e) {
  if (!e || e.code !== 'ANTHROPIC_API_ERROR') return false;
  const msg = String(e?.parsed_error?.error?.message || e.message || '');
  return e.status === 404 || (e.status === 400 && /model/i.test(msg));
}

// Modellen die deze sleutel niet kent, onthouden we per (warm) serverproces:
// geen dubbele mislukte aanroep bij de herstelronde of het volgende onderdeel.
const ONBEKEND = new Set();

/** Roep fn(model) aan met het eerste model dat de sleutel kent. */
export async function modelKeten(fn, lijst = modellen()) {
  let laatste = null;
  const kandidaten = lijst.filter((m) => !ONBEKEND.has(m));
  for (const model of (kandidaten.length ? kandidaten : lijst)) {
    try {
      return { resultaat: await fn(model), model };
    } catch (e) {
      if (!isModelFout(e)) throw e;
      console.error('[contentmachine-ai] model niet beschikbaar, volgende:', model, e.status);
      ONBEKEND.add(model);
      laatste = e;
    }
  }
  throw laatste || new Error('Geen model beschikbaar');
}

export const BESCHRIJF_SCHEMA = {
  type: 'object',
  properties: {
    beschrijving: { type: 'string', description: 'Eén tot drie zinnen in het Nederlands: wat staat er feitelijk op het beeld.' },
    soort: { type: 'string', enum: ['payout', 'trade', 'chart', 'masterclass', 'team', 'community', 'overig'] },
    bedrag: { type: ['number', 'null'], description: 'Uitbetaald of getoond bedrag als het leesbaar is, anders null.' },
    valuta: { type: ['string', 'null'], description: 'USD, EUR, GBP … of null.' },
    firma: { type: ['string', 'null'], description: 'Prop firm of broker (FTMO, FundedNext …) als leesbaar.' },
    paar: { type: ['string', 'null'], description: 'Valutapaar/instrument (EURUSD, XAUUSD, DXY …) als zichtbaar.' },
    timeframe: { type: ['string', 'null'], description: 'Bv. H4, 15M, als zichtbaar.' },
    richting: { type: ['string', 'null'], enum: ['long', 'short', null] },
    setup: { type: ['string', 'null'], description: 'Wat er op de chart getekend is (fibonacci, range, zone …), kort.' },
    datum_zichtbaar: { type: ['string', 'null'] },
    namen_zichtbaar: { type: 'array', items: { type: 'string' }, description: 'Namen die letterlijk leesbaar zijn op het beeld.' },
    bijschrift_voorstel: { type: 'string', description: 'Kort bijschrift (max 12 woorden), feitelijk, zonder hype.' },
    tags: { type: 'array', items: { type: 'string' }, description: '3 tot 6 korte trefwoorden in kleine letters.' },
  },
  required: ['beschrijving', 'soort', 'bijschrift_voorstel', 'tags'],
};

const BESCHRIJF_SYSTEEM = `Je beschrijft beelden voor de contentbibliotheek van De Forex Opleiding (forex-trading opleiding).
Beschrijf alleen wat je feitelijk ziet. Lees bedragen, firma's, paren en timeframes enkel als ze duidelijk leesbaar zijn; anders null.
Verzin niets, schat geen bedragen, en trek geen conclusies over winst die niet op het beeld staan. Schrijf in het Nederlands.`;

/** Vision op één beeld. → { details, model } */
export async function beschrijfBeeld({ url, bijschrift, persoon }) {
  const context = [bijschrift ? `Bestaand bijschrift: ${bijschrift}` : null, persoon ? `Persoon volgens de uploader: ${persoon}` : null]
    .filter(Boolean).join('\n');
  const { resultaat, model } = await modelKeten((m) => anthropicStructuredOutput({
    model: m,
    system: BESCHRIJF_SYSTEEM,
    max_tokens: 1024,
    temperature: 0,
    tool_name: 'beschrijf_beeld',
    tool_input_schema: BESCHRIJF_SCHEMA,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url } },
        { type: 'text', text: `Beschrijf dit beeld voor de bibliotheek.${context ? '\n' + context : ''}` },
      ],
    }],
  }));
  return { details: resultaat, model };
}
