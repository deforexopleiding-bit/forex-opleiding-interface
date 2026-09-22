// api/_lib/iris/classificeer.js
//
// Waar gaat dit bericht over, en wat wil deze persoon?
//
// ── WAAROM AFGEDWONGEN GEREEDSCHAP EN GEEN JSON-PROMPT ───────────────────────
// Lesson learned 22 in CLAUDE.md, en die is duur betaald: vragen om "antwoord
// alleen in JSON" en daarna JSON.parse doen is broos. Modellen wikkelen hun
// antwoord in ```json, zetten er "Hier is de JSON:" voor, of ontsnappen
// aanhalingstekens net anders. Met één gereedschap plus een afgedwongen
// tool_choice ligt het schema contractueel vast bij de API en hoeft er niets
// ontleed te worden.
//
// ── WAAROM DE UITKOMST DAARNA TÓCH NOG NAGEKEKEN WORDT ───────────────────────
// Omdat "het schema ligt vast" niet hetzelfde is als "de waarde klopt". Een
// enum kan gerespecteerd worden en toch een categorie opleveren die wij niet
// kennen omdat het schema en onze lijst uit elkaar gelopen zijn. En een
// zekerheid van 1.4 is geldig JSON. keurUitkomst() is de tweede deur.
//
// ── WAT DEZE MODULE NIET DOET ────────────────────────────────────────────────
// Ze schrijft geen antwoord. Ze beslist niet of er iets verstuurd wordt. Ze
// leest een bericht en zegt waar het over gaat, met een reden en een zekerheid.
// Meer niet. Het gescheiden houden van "begrijpen" en "beslissen" is wat
// maakt dat de schaduwmodus iets waard is: je kunt dagenlang meekijken of Iris
// het goed begrijpt zonder dat er één bericht de deur uit kan.

import { anthropicStructuredOutput, AnthropicClientError } from '../anthropic-client.js';
import { CATEGORIEEN } from './instellingen.js';

/** Hoeveel tekens van een bericht we meesturen. Langer helpt niet en kost. */
export const MAX_TEKST = 4000;

/** Hoeveel eerdere berichten als context meegaan. */
export const CONTEXT_BERICHTEN = 6;

export const SYSTEEM_TEKST = [
  'Je bent de leeshulp van De Forex Opleiding, een Nederlandstalige opleider in Vlaanderen en Nederland.',
  '',
  'Je krijgt een binnengekomen bericht van een klant of student, via WhatsApp of mail.',
  'Je enige taak is begrijpen waar het over gaat. Je schrijft GEEN antwoord.',
  '',
  'Kies één categorie:',
  '  facturatie             — vraag over een factuur, een betaalbewijs, "ik heb al betaald"',
  '  betaalafspraak         — vraag om uitstel, afbetaling, of een belofte op een datum',
  '  wanbetaling_reactie    — reactie op een aanmaning of herinnering',
  '  lms_toegang            — kan niet inloggen, toegang verlopen, uitnodiging niet gekregen, wachtwoord',
  '  lms_support            — technische of inhoudelijke vraag over de cursus zelf',
  '  planning_mentor        — sessie inplannen of verzetten, iets over een mentor, een gemiste afspraak',
  '  opzeg_klacht_juridisch — opzegging, klacht, dreiging met een advocaat of een instantie',
  '  bounce_systeem         — automatisch bericht: bounce, out-of-office, afleveringsfout',
  '  overig                 — iets anders dat wel een antwoord verdient',
  '  spam                   — reclame, phishing, onzin',
  '',
  'Bij twijfel tussen twee categorieën kies je de categorie met het grootste gevolg.',
  'Gaat het over zowel een factuur als een opzegging, dan is het opzeg_klacht_juridisch.',
  'Dat is met opzet: die categorie gaat altijd langs een mens, en te voorzichtig',
  'indelen kost een minuut aandacht terwijl te laks indelen een klant kost.',
  '',
  'Geef ook:',
  '  reden        — één korte zin: waar zie je dat aan',
  '  zekerheid    — 0 tot 1. Onder 0.5 betekent: ik weet het echt niet.',
  '  samenvatting — één zin in het Nederlands: wat wil deze persoon.',
  '  urgentie     — laag, midden of hoog. Hoog alleen als er vandaag iets moet gebeuren.',
  '',
  'Verzin nooit feiten. Staat er geen bedrag in het bericht, noem dan geen bedrag.',
].join('\n');

export const GEREEDSCHAP_SCHEMA = {
  type: 'object',
  properties: {
    categorie: {
      type: 'string',
      enum: [...CATEGORIEEN],
      description: 'De categorie waar dit bericht over gaat.',
    },
    reden: {
      type: 'string',
      description: 'Eén korte zin: waar zie je dat aan.',
    },
    zekerheid: {
      type: 'number',
      description: 'Tussen 0 en 1. Onder 0.5 betekent: ik weet het echt niet.',
    },
    samenvatting: {
      type: 'string',
      description: 'Eén zin in het Nederlands: wat wil deze persoon.',
    },
    urgentie: {
      type: 'string',
      enum: ['laag', 'midden', 'hoog'],
      description: 'Hoog alleen als er vandaag iets moet gebeuren.',
    },
  },
  required: ['categorie', 'reden', 'zekerheid', 'samenvatting', 'urgentie'],
};

/**
 * Kort een tekst in zonder midden in een woord af te breken.
 * Een bericht dat halverwege een zin stopt leest als iets anders dan het is.
 */
export function kortIn(tekst, max = MAX_TEKST) {
  const s = String(tekst ?? '').trim();
  if (s.length <= max) return s;
  const afgekapt = s.slice(0, max);
  const spatie = afgekapt.lastIndexOf(' ');
  return (spatie > max * 0.8 ? afgekapt.slice(0, spatie) : afgekapt) + ' […]';
}

/**
 * Bouw de berichtenreeks voor het model.
 *
 * De voorgeschiedenis gaat mee als platte tekst in één bericht, niet als losse
 * beurten. Reden: het model hoeft geen gesprek voort te zetten, het moet één
 * bericht begrijpen. De geschiedenis is context, geen dialoog — en als
 * dialoog aangeboden zou het model geneigd zijn te antwoorden in plaats van
 * in te delen.
 */
export function bouwBerichten({ tekst, kanaal, onderwerp, voorgeschiedenis } = {}) {
  const delen = [];

  const eerder = Array.isArray(voorgeschiedenis) ? voorgeschiedenis.slice(-CONTEXT_BERICHTEN) : [];
  if (eerder.length) {
    delen.push('Eerder in dit gesprek (oudste eerst):');
    for (const b of eerder) {
      const wie = b?.richting === 'uit' ? 'wij' : 'klant';
      delen.push(`  [${wie}] ${kortIn(b?.tekst_kort || b?.tekst || '', 300)}`);
    }
    delen.push('');
  }

  delen.push(`Nieuw bericht, via ${kanaal === 'email' ? 'mail' : 'WhatsApp'}:`);
  if (onderwerp) delen.push(`Onderwerp: ${kortIn(onderwerp, 200)}`);
  delen.push('---');
  delen.push(kortIn(tekst));
  delen.push('---');

  return [{ role: 'user', content: delen.join('\n') }];
}

/**
 * Kijk na wat het model teruggaf.
 *
 * @returns {{ok: true, uitkomst: object} | {ok: false, fout: string}}
 */
export function keurUitkomst(ruw) {
  if (!ruw || typeof ruw !== 'object') return { ok: false, fout: 'geen object terug' };

  const cat = String(ruw.categorie || '').trim();
  if (!CATEGORIEEN.includes(cat)) {
    return { ok: false, fout: `onbekende categorie: ${cat || '(leeg)'}` };
  }

  let zekerheid = Number(ruw.zekerheid);
  if (!Number.isFinite(zekerheid)) zekerheid = 0;
  // Klemmen in plaats van weigeren: een zekerheid van 1.4 is een rekenfout van
  // het model, geen reden om de hele indeling weg te gooien.
  zekerheid = Math.min(Math.max(zekerheid, 0), 1);

  const urgentie = ['laag', 'midden', 'hoog'].includes(String(ruw.urgentie || '').trim())
    ? String(ruw.urgentie).trim()
    : 'midden';

  const reden = String(ruw.reden || '').trim().slice(0, 500);
  const samenvatting = String(ruw.samenvatting || '').trim().slice(0, 500);
  if (!samenvatting) return { ok: false, fout: 'geen samenvatting' };

  return {
    ok: true,
    uitkomst: {
      categorie: cat,
      reden: reden || 'geen reden gegeven',
      zekerheid: Math.round(zekerheid * 100) / 100,
      samenvatting,
      urgentie,
    },
  };
}

/**
 * Deel één bericht in.
 *
 * Gooit niet. Bij een fout komt er `{ok: false, fout}` terug en blijft het
 * bericht onverwerkt staan, zodat de volgende ronde het opnieuw probeert. Dat
 * is beter dan het als 'overig' wegschrijven: een verkeerde indeling die er
 * definitief uitziet is erger dan een bericht dat nog even wacht.
 */
export async function deelIn({ tekst, kanaal, onderwerp, voorgeschiedenis, model, temperatuur } = {}) {
  const schoon = String(tekst ?? '').trim();
  if (!schoon) return { ok: false, fout: 'leeg bericht' };

  try {
    const blok = await anthropicStructuredOutput({
      system: SYSTEEM_TEKST,
      messages: bouwBerichten({ tekst: schoon, kanaal, onderwerp, voorgeschiedenis }),
      tool_name: 'deel_bericht_in',
      tool_input_schema: GEREEDSCHAP_SCHEMA,
      model: model || undefined,
      temperature: Number.isFinite(temperatuur) ? temperatuur : 0,
      max_tokens: 700,
    });
    return keurUitkomst(blok);
  } catch (e) {
    const code = (e instanceof AnthropicClientError && e.code) ? e.code : 'ONBEKEND';
    console.error('[iris/classificeer] mislukt:', code, e?.message || e);
    return { ok: false, fout: `${code}: ${e?.message || e}` };
  }
}
