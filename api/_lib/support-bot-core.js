// api/_lib/support-bot-core.js
//
// De supportbot (persona "Sam"). Spiegel van api/_lib/joost-suggest-core.js,
// met drie bewuste verschillen:
//
//   1. Joost stelt een antwoord vóór dat een mens verstuurt. Sam praat
//      rechtstreeks met de bezoeker. Daarom zit de rem hier niet in een
//      medewerker die op "plak" klikt, maar in het mandaat hieronder.
//   2. Sam gebruikt anthropicMessages() in plaats van een rauwe fetch, zodat
//      we `usage` kunnen vastleggen. Joost doet dat niet en daardoor weet
//      niemand wat Joost kost; dat herhalen we niet.
//   3. Context wordt server-side opgehaald en in de prompt gezet — geen
//      tools die het model zelf mag aanroepen. Een model dat zelf mag
//      opzoeken kan om gegevens vragen die de bezoeker niet geverifieerd
//      heeft, en dat is precies het lek dat we niet willen.
//
// ── HET MANDAAT ─────────────────────────────────────────────────────────────
// Na het modelantwoord beslist beslisAntwoord() — een pure functie — of het
// antwoord naar de bezoeker mag of dat het gesprek naar een mens gaat. Die
// beslissing hangt niet aan de tekst van het model maar aan intent,
// vertrouwen en de configuratie in joost_config.autonomy_config. Zelfde
// opzet als evaluateAutonomy() in api/joost-autonomy-evaluate.js: eerste
// treffer wint, elke stap loggen, `nu` injecteerbaar.

import { supabaseAdmin } from '../supabase.js';
import { anthropicMessages, AnthropicClientError } from './anthropic-client.js';
import { bouwContext } from './support-lookups.js';

export const INTENTS = [
  'lms_toegang',
  'discord',
  'traject',
  'financieel',
  'informatie',
  'event',
  'escalatie',
  'overig',
];

// Welke onderwerpen persoonlijke gegevens raken en dus een geverifieerde
// sessie eisen. `discord` staat er bewust NIET bij: daar valt niets
// persoonlijks over te zeggen.
export const VERIFICATIE_ONDERWERPEN = ['lms', 'traject', 'financieel'];

const SUPPORT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    antwoord: {
      type: 'string',
      description: 'Het antwoord aan de bezoeker. Nederlands, per je, maximaal 5 zinnen. Geen begroeting als het gesprek al loopt.',
    },
    intent: {
      type: 'string',
      enum: INTENTS,
      description: 'Waar gaat de vraag over? escalatie = de bezoeker is boos, wil een mens, of het gaat over geld dat al betaald zou zijn.',
    },
    vertrouwen: {
      type: 'number',
      description: '0.0 = ik gok, 1.0 = dit staat letterlijk in de context of de kennisbank.',
    },
    naar_mens: {
      type: 'boolean',
      description: 'True als je vindt dat een collega hiernaar moet kijken, ongeacht je vertrouwen.',
    },
    reden: {
      type: 'string',
      description: 'Eén zin: waarom dit antwoord, of waarom het naar een collega moet. Voor de audit, niet voor de bezoeker.',
    },
    verificatie_nodig: {
      type: 'boolean',
      description: 'True als je de vraag alleen kunt beantwoorden met persoonlijke gegevens en de bezoeker nog niet geverifieerd is.',
    },
    voorgestelde_actie: {
      type: ['object', 'null'],
      description: 'Een concrete herstelactie die een collega zou moeten goedkeuren, of null.',
      properties: {
        soort: {
          type: 'string',
          enum: ['LMS_UITNODIGING_OPNIEUW', 'LMS_PROVISIONING_OPNIEUW', 'BETALINGSAFSPRAAK', 'MENTOR_CONTACT'],
        },
        omschrijving: { type: 'string' },
      },
      required: ['soort', 'omschrijving'],
    },
  },
  required: ['antwoord', 'intent', 'vertrouwen', 'naar_mens', 'reden', 'verificatie_nodig'],
};

function klem01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Haal de bot-configuratie. Eén rij, module='support'. */
export async function haalConfig() {
  try {
    const { data, error } = await supabaseAdmin
      .from('joost_config')
      .select('*')
      .eq('module', 'support')
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  } catch (e) {
    console.warn('[support-bot] config lezen mislukt:', e?.message || e);
    return null;
  }
}

/**
 * Kennisbankartikelen voor de supportbot. Simpele ILIKE-zoek over onderwerp
 * en inhoud, net als executeQueryKnowledgeBase() in api/agent-tools.js — er
 * is in dit project geen vector-search, en die er nu bij verzinnen betekent
 * een tweede, afwijkende manier van kennis ophalen.
 *
 * @param {string} vraag
 * @param {number} limiet
 */
export async function haalKennis(vraag, limiet = 6) {
  const woorden = String(vraag || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(0, 6);

  try {
    let q = supabaseAdmin
      .from('kennisbank_artikelen')
      .select('onderwerp, categorie, content')
      .contains('agents', ['support'])
      .limit(limiet);

    if (woorden.length) {
      const or = woorden
        .flatMap((w) => [`onderwerp.ilike.%${w}%`, `content.ilike.%${w}%`])
        .join(',');
      q = q.or(or);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data || [];
  } catch (e) {
    console.warn('[support-bot] kennisbank lezen mislukt:', e?.message || e);
    return [];
  }
}

/**
 * Leg een onbeantwoorde vraag vast. kennisbank_unmatched is precies de bak
 * die hiervoor bestaat: wat de bot niet wist, is wat er in de kennisbank
 * ontbreekt. Fail-soft — dit mag een gesprek nooit ophouden.
 */
async function noteerOnbeantwoord(vraag) {
  try {
    const { data } = await supabaseAdmin
      .from('kennisbank_unmatched')
      .select('id, count')
      .eq('agent_key', 'support')
      .ilike('question', String(vraag).slice(0, 200))
      .maybeSingle();
    if (data?.id) {
      await supabaseAdmin
        .from('kennisbank_unmatched')
        .update({ count: (data.count || 1) + 1, last_seen: new Date().toISOString() })
        .eq('id', data.id);
    } else {
      await supabaseAdmin
        .from('kennisbank_unmatched')
        .insert({ agent_key: 'support', question: String(vraag).slice(0, 500) });
    }
  } catch (_) { /* fail-soft */ }
}

/**
 * Het mandaat. PURE functie — geen database, geen netwerk, `nu` injecteerbaar.
 *
 * Eerste treffer wint, en elke overweging komt in `log` zodat achteraf te
 * zien is waaróm een gesprek is doorgezet. Die log is het verschil tussen
 * "de bot deed raar" en "de bot deed precies wat we hadden ingesteld".
 *
 * @param {object} opts
 * @param {object} opts.model      — de ruwe tool-output
 * @param {object} opts.config     — joost_config-rij voor module 'support'
 * @param {object} opts.gesprek    — support_gesprekken-rij
 * @param {object} opts.beschikbaarheid — uit support-beschikbaarheid.js
 * @returns {{versturen:boolean, escaleren:boolean, reden:string, log:string[]}}
 */
export function beslisAntwoord({ model, config, gesprek, beschikbaarheid }) {
  const log = [];
  const intents = config?.autonomy_config?.intents || {};
  const flags = config?.feature_flags || {};

  if (!model || typeof model.antwoord !== 'string' || !model.antwoord.trim()) {
    log.push('geen bruikbaar antwoord van het model');
    return { versturen: false, escaleren: true, reden: 'geen_antwoord', log };
  }

  const intent = INTENTS.includes(model.intent) ? model.intent : 'overig';
  const vertrouwen = klem01(model.vertrouwen);
  log.push(`intent=${intent} vertrouwen=${vertrouwen.toFixed(2)}`);

  // a) Het model geeft het zelf uit handen. Dat oordeel overrulen we niet.
  if (model.naar_mens === true) {
    log.push('model vraagt zelf om een mens');
    return { versturen: true, escaleren: true, reden: 'model_escaleert', log };
  }

  // b) Escalatie-intent is altijd een mens. Hard, zoals de veiligheidsklep
  //    voor cancel_or_reschedule in api/simone-autonomy-evaluate.js.
  if (intent === 'escalatie') {
    log.push('intent escalatie — altijd naar een mens');
    return { versturen: true, escaleren: true, reden: 'intent_escalatie', log };
  }

  // c) Staat dit onderwerp aan?
  const cfg = intents[intent];
  if (!cfg || cfg.enabled !== true) {
    log.push(`intent ${intent} staat uit in autonomy_config`);
    return { versturen: false, escaleren: true, reden: 'intent_uit', log };
  }

  // d) Vertrouwensdrempel.
  const drempel = Number.isFinite(cfg.min_confidence) ? cfg.min_confidence : 0.8;
  if (vertrouwen < drempel) {
    log.push(`vertrouwen ${vertrouwen.toFixed(2)} onder drempel ${drempel}`);
    return { versturen: false, escaleren: true, reden: 'laag_vertrouwen', log };
  }

  // e) Buiten kantooruren mag de bot alleen door als dat expliciet aanstaat.
  //    Default uit: liever een eerlijke wachtrijmelding dan een bot die
  //    's nachts alleen in de kamer staat.
  if (!beschikbaarheid?.binnen_kantooruren && flags.s3_buiten_kantooruren !== true) {
    log.push('buiten kantooruren en s3_buiten_kantooruren staat uit');
    return { versturen: true, escaleren: true, reden: 'buiten_kantooruren', log };
  }

  // f) Persoonlijk onderwerp zonder geverifieerde sessie: nooit een inhoudelijk
  //    antwoord. Het model zou hier sowieso niets persoonlijks hebben, maar
  //    deze regel voorkomt dat het gaat gissen.
  if (VERIFICATIE_ONDERWERPEN.includes(gesprek?.onderwerp) && !gesprek?.geverifieerd) {
    log.push('persoonlijk onderwerp zonder verificatie');
    return { versturen: true, escaleren: false, reden: 'verificatie_nodig', log };
  }

  log.push('binnen mandaat');
  return { versturen: true, escaleren: false, reden: 'ok', log };
}

/** Het contextblok dat onder de system prompt komt. */
function bouwContextBlok({ gesprek, context, kennis, beschikbaarheid }) {
  const r = [];
  const nu = new Date();
  r.push('CONTEXT (server-side opgehaald — verzin hier niets bij)');
  r.push(`Vandaag: ${nu.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' })}`);
  r.push(`Bereikbaarheid: ${beschikbaarheid?.live ? 'er zit nu iemand aan de chat' : 'er zit nu niemand aan de chat'} (${beschikbaarheid?.label || 'onbekend'})`);
  r.push(`Soort bezoeker: ${gesprek.soort === 'klant' ? 'bestaande student' : 'nog geen klant'}`);
  r.push(`Gekozen onderwerp: ${gesprek.onderwerp}`);
  r.push(`Geverifieerd: ${gesprek.geverifieerd ? 'ja' : 'nee'}`);

  if (!gesprek.geverifieerd && VERIFICATIE_ONDERWERPEN.includes(gesprek.onderwerp)) {
    r.push('LET OP: deze bezoeker is niet geverifieerd. Je hebt GEEN persoonlijke gegevens en mag er ook niet naar raden. Leg uit dat je eerst even moet vaststellen dat hij het zelf is.');
  }

  if (context?.klant_gevonden) {
    r.push('');
    r.push('GEGEVENS VAN DEZE STUDENT');
    if (context.voornaam) r.push(`Voornaam: ${context.voornaam}`);
    if (context.onboarding_status) r.push(`Onboarding-status: ${context.onboarding_status}`);
    if (context.lms) {
      if (context.lms.onbereikbaar) r.push('LMS-status: nu niet op te vragen.');
      else r.push(`LMS-status: ${context.lms.reden}${context.lms.toelichting ? ' — ' + context.lms.toelichting : ''}`);
    }
    if (context.facturen && !context.facturen.onbereikbaar) {
      r.push(`Facturen: ${context.facturen.open_aantal} open, waarvan ${context.facturen.vervallen_aantal} vervallen. Noem GEEN bedragen.`);
    }
    if (context.stilte) {
      r.push(`Er loopt al een afspraak tot en met ${context.stilte.stil_tot}${context.stilte.door_naam ? ' (gemaakt met ' + context.stilte.door_naam + ')' : ''}. Laat de student dat niet opnieuw uitleggen.`);
    }
    if (context.mentor?.naam) r.push(`Mentor: ${context.mentor.naam}`);
    if (context.volgende_sessie?.start_tijd) {
      r.push(`Volgende sessie: ${new Date(context.volgende_sessie.start_tijd).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })}`);
    }
    if (context.lopende_betalingsafspraak) {
      r.push(`Er loopt al een betalingsafspraak (${context.lopende_betalingsafspraak.type}, status ${context.lopende_betalingsafspraak.status}). Zeg dat en stel er geen tweede voor.`);
    }
  } else if (gesprek.geverifieerd && context && context.klant_gevonden === false) {
    r.push('Deze bezoeker is geverifieerd op zijn mailadres, maar er staat geen klant met dat adres in het systeem. Beloof niets en laat een collega meekijken.');
  }

  if (Array.isArray(kennis) && kennis.length) {
    r.push('');
    r.push('KENNISBANK');
    for (const k of kennis) {
      r.push(`- ${k.onderwerp}${k.categorie ? ` (${k.categorie})` : ''}: ${String(k.content || '').slice(0, 600)}`);
    }
  }

  return r.join('\n');
}

/**
 * Laat de bot antwoorden op de laatste vraag in een gesprek.
 *
 * Gooit nooit: elke fout wordt een `{ok:false, code}` zodat het endpoint kan
 * kiezen wat de bezoeker te zien krijgt. Een chat die "er ging iets mis" zegt
 * is bruikbaar; een chat die een stacktrace toont is dat niet.
 *
 * @returns {Promise<{ok:boolean, code?:string, antwoord?:string, escaleren?:boolean, meta?:object, actie?:object}>}
 */
export async function botAntwoord({ gesprek, berichten, beschikbaarheid }) {
  const config = await haalConfig();
  if (!config || config.is_enabled !== true) {
    return { ok: false, code: 'BOT_UIT' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, code: 'GEEN_API_KEY' };
  }

  const laatsteVraag = [...(berichten || [])].reverse().find((b) => b.afzender === 'klant')?.tekst || '';

  const flags = config.feature_flags || {};
  const [context, kennis] = await Promise.all([
    flags.s1_live_lookups === true ? bouwContext(gesprek) : Promise.resolve({ geverifieerd: !!gesprek.geverifieerd }),
    flags.s1_kennisbank === true ? haalKennis(laatsteVraag) : Promise.resolve([]),
  ]);

  const systeem = [
    String(config.system_prompt_template || '').replace('{klant_naam}', context?.voornaam ? `De bezoeker heet ${context.voornaam}.` : ''),
    '',
    bouwContextBlok({ gesprek, context, kennis, beschikbaarheid }),
  ].join('\n');

  // Laatste N berichten, oudste eerst. 'bot' en 'medewerker' zijn allebei
  // assistant — voor het model is dat één stem, en dat is ook hoe de
  // bezoeker het leest.
  const limiet = Number.isFinite(config.context_message_count) ? config.context_message_count : 20;
  const messages = (berichten || [])
    .filter((b) => b.afzender !== 'systeem')
    .slice(-limiet)
    .map((b) => ({
      role: b.afzender === 'klant' ? 'user' : 'assistant',
      content: b.tekst,
    }));

  // Het model moet met een user-bericht kunnen beginnen.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length) return { ok: false, code: 'GEEN_VRAAG' };

  let data;
  try {
    data = await anthropicMessages({
      model: config.model || 'claude-sonnet-4-6',
      max_tokens: 1024,
      temperature: klem01(config.temperature ?? 0.3),
      system: systeem,
      messages,
      tools: [{
        name: 'support_antwoord',
        description: 'Lever het supportantwoord voor deze bezoeker.',
        input_schema: SUPPORT_TOOL_SCHEMA,
      }],
      tool_choice: { type: 'tool', name: 'support_antwoord' },
    });
  } catch (e) {
    const code = e instanceof AnthropicClientError ? e.code : 'ANTHROPIC_ONBEKEND';
    console.warn('[support-bot] Anthropic-call mislukt:', code, e?.message || e);
    return { ok: false, code };
  }

  const blok = (data?.content || []).find((b) => b?.type === 'tool_use' && b.name === 'support_antwoord');
  if (!blok?.input) return { ok: false, code: 'GEEN_TOOL_USE' };

  const uit = blok.input;
  const besluit = beslisAntwoord({ model: uit, config, gesprek, beschikbaarheid });

  if (!besluit.versturen || besluit.reden === 'laag_vertrouwen' || besluit.reden === 'intent_uit') {
    await noteerOnbeantwoord(laatsteVraag);
  }

  // Alleen een actie voorstellen als dat aanstaat én de lookup 'm ook
  // ondersteunt. Een bot die een uitnodiging voorstelt terwijl het account
  // gewoon actief is, kost een collega een klik en een vraagteken.
  let actie = null;
  if (flags.s1_acties_voorstellen === true && uit.voorgestelde_actie?.soort) {
    const ondersteund = context?.lms?.voorstel;
    const isLmsActie = String(uit.voorgestelde_actie.soort).startsWith('LMS_');
    if (!isLmsActie || ondersteund === uit.voorgestelde_actie.soort) {
      actie = {
        soort: uit.voorgestelde_actie.soort,
        omschrijving: String(uit.voorgestelde_actie.omschrijving || '').slice(0, 500),
        payload: {
          onboarding_id: context?.onboarding_id || null,
          customer_id: context?.customer_id || null,
          lms_reden: context?.lms?.reden || null,
        },
      };
    }
  }

  return {
    ok: true,
    antwoord: String(uit.antwoord).trim(),
    escaleren: besluit.escaleren,
    besluit_reden: besluit.reden,
    actie,
    meta: {
      intent: INTENTS.includes(uit.intent) ? uit.intent : 'overig',
      vertrouwen: klem01(uit.vertrouwen),
      reden: String(uit.reden || '').slice(0, 300),
      model: config.model || 'claude-sonnet-4-6',
      // Tokenverbruik vastleggen vanaf dag één. Joost doet dit niet en
      // daardoor weet niemand wat Joost per maand kost.
      tokens_in: data?.usage?.input_tokens ?? null,
      tokens_uit: data?.usage?.output_tokens ?? null,
      besluit_log: besluit.log,
      kennis_gebruikt: (kennis || []).map((k) => k.onderwerp).slice(0, 6),
    },
  };
}
