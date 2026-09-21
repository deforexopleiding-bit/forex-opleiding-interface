// api/_lib/iris/opdracht.js
//
// "Iris, regel dit."
//
// ── WAT EEN OPDRACHT IS ──────────────────────────────────────────────────────
// Eén zin van Maxim — ingesproken of getypt — die Iris omzet in een zichtbaar
// plan met stappen. "Stuur Kevin dat hij tot vrijdag heeft." "Verleng de
// toegang van Sarah met twee weken, ze was ziek." "Vraag bij iedereen die meer
// dan dertig dagen te laat staat een betaaldatum."
//
// ── DE ZEVEN TOESTANDEN, EN WAAROM ER GEEN ACHTSTE IS ────────────────────────
//   gevraagd → uitzoeken → wacht_op_ok → uitgevoerd → wacht_op_antwoord →
//   geregeld, met afgebroken als uitweg.
//
// Wat hier NIET bij zit is een toestand als "klaar" of "gesloten" die los van
// de uitvoering bestaat. Dat is met opzet: "Geregeld" drukken terwijl er nog
// iets onverstuurd klaarstaat is precies waar dingen stil verdwijnen, en
// daarom vraagt dat scherm uitdrukkelijk wat er met dat onverstuurde moet
// gebeuren. Een aparte "afgesloten"-toestand zou een sluiproute zijn.
//
// ── ÉÉN VRAAG, NIET DRIE ─────────────────────────────────────────────────────
// Ontbreekt er iets, dan stelt Iris één vraag met opties. Niet een formulier
// met vier velden. Een formulier is iets wat je invult als je tijd hebt; een
// vraag met twee knoppen beantwoord je terwijl je loopt. Het schema dwingt dat
// af: één veld voor de vraag, één lijst met opties.
//
// ── BULK ─────────────────────────────────────────────────────────────────────
// Raakt een opdracht meerdere mensen, dan toont Iris eerst de lijst en het
// aantal, en vraagt ze altijd bevestiging — ook als de autonomie aan staat.
// Een verkeerd bericht naar één persoon is een excuus waard; hetzelfde bericht
// naar veertig mensen is een incident.

import { anthropicStructuredOutput, AnthropicClientError } from '../anthropic-client.js';

/** Boven hoeveel ontvangers een opdracht als bulk telt. */
export const BULK_VANAF = 2;

/** Hoeveel ontvangers een opdracht hoogstens mag raken zonder apart gesprek. */
export const BULK_MAX = 200;

export const TOESTANDEN = Object.freeze([
  'gevraagd', 'uitzoeken', 'wacht_op_ok', 'uitgevoerd',
  'wacht_op_antwoord', 'geregeld', 'afgebroken',
]);

/** De stappen die Iris in een plan mag zetten. Gelijk aan iris_acties.type. */
export const STAPTYPES = Object.freeze([
  'wa_versturen', 'mail_versturen',
  'lms_toegang_verlengen', 'lms_uitnodiging', 'lms_on_hold',
  'belofte_vastleggen', 'afbetalingsplan',
  'taak_aanmaken', 'belrij_toevoegen', 'factuur_nakijken',
]);

export const GEREEDSCHAP_SCHEMA = {
  type: 'object',
  properties: {
    titel: {
      type: 'string',
      description: 'Korte titel, maximaal acht woorden. Wat er gaat gebeuren, niet wat er gevraagd is.',
    },
    begrepen: {
      type: 'string',
      description: 'Eén zin: wat je denkt dat er moet gebeuren. In gewone taal, voor een mens.',
    },
    stappen: {
      type: 'array',
      description: 'De stappen in volgorde. Leeg als je eerst iets moet vragen.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...STAPTYPES] },
          omschrijving: { type: 'string', description: 'Eén regel in gewone taal: wat deze stap doet.' },
          wie: { type: 'string', description: 'Naam of omschrijving van wie dit raakt. Leeg als het over een groep gaat.' },
          parameters: { type: 'object', description: 'De gegevens die de stap nodig heeft. Laat leeg wat je niet weet.' },
        },
        required: ['type', 'omschrijving'],
      },
    },
    vraag: {
      type: 'string',
      description: 'ÉÉN vraag als er iets ontbreekt dat je niet kunt opzoeken. Leeg als je genoeg weet.',
    },
    opties: {
      type: 'array',
      items: { type: 'string' },
      description: 'Twee tot vier antwoorden op die vraag, zodat er geklikt kan worden in plaats van getypt.',
    },
    raakt_groep: {
      type: 'boolean',
      description: 'True als deze opdracht over meer dan één persoon gaat.',
    },
    groep_omschrijving: {
      type: 'string',
      description: 'Bij een groep: welke mensen precies, in woorden. Bijvoorbeeld "iedereen met een factuur meer dan 30 dagen te laat".',
    },
  },
  required: ['titel', 'begrepen', 'stappen', 'raakt_groep'],
};

export const SYSTEEM_TEKST = [
  'Je bent de assistent van De Forex Opleiding. Maxim of Dave geeft je een opdracht',
  'in één zin, ingesproken of getypt. Jij maakt er een zichtbaar plan van.',
  '',
  'Regels:',
  '',
  '1. Zet alleen stappen in het plan die je met de beschikbare stappen KUNT doen.',
  '   Kan iets niet, zeg dat dan in "begrepen" in plaats van een stap te verzinnen',
  '   die niet bestaat.',
  '',
  '2. Ontbreekt er iets wat je niet kunt opzoeken, stel dan ÉÉN vraag met twee tot',
  '   vier opties. Niet drie vragen, niet een formulier. Eén vraag met knoppen',
  '   beantwoord je terwijl je loopt; een formulier vul je in als je tijd hebt,',
  '   en dat moment komt niet.',
  '',
  '3. Verzin nooit een naam, een bedrag of een datum. Weet je niet wie "Kevin" is,',
  '   vraag dat dan. Er zijn misschien drie Kevins.',
  '',
  '4. Raakt de opdracht meer dan één persoon, zet raakt_groep op true en',
  '   beschrijf in groep_omschrijving precies welke mensen. Iemand moet die',
  '   omschrijving kunnen nalezen en zien of hij klopt voordat er iets vertrekt.',
  '',
  '5. Een stap die iets naar een klant stuurt, is nooit de eerste stap. Zoek eerst',
  '   op, stel dan voor.',
  '',
  'Beschikbare stappen:',
  '  wa_versturen           een WhatsApp-bericht',
  '  mail_versturen         een mail',
  '  lms_toegang_verlengen  de einddatum van iemands toegang vooruit zetten',
  '  lms_uitnodiging        de uitnodiging of inloglink opnieuw sturen',
  '  lms_on_hold            iemand op pauze zetten of die pauze opheffen, met reden',
  '  belofte_vastleggen     een betaaltoezegging met datum en bedrag',
  '  afbetalingsplan        een voorstel in termijnen',
  '  taak_aanmaken          een taak voor een mens',
  '  belrij_toevoegen       iemand op de belrij zetten',
  '  factuur_nakijken       laten nakijken of een factuur al betaald is',
  '',
  'Wat je NIET kunt, en ook niet moet voorstellen: iemand blokkeren, iemands',
  'toegang intrekken, een factuur op betaald zetten. Dat doet een mens.',
].join('\n');

/**
 * Kijk na wat het model van een opdracht maakte.
 *
 * @returns {{ok: true, plan: object} | {ok: false, fout: string}}
 */
export function keurPlan(ruw) {
  if (!ruw || typeof ruw !== 'object') return { ok: false, fout: 'geen plan terug' };

  const titel = String(ruw.titel || '').trim().slice(0, 120);
  const begrepen = String(ruw.begrepen || '').trim().slice(0, 500);
  if (!begrepen) return { ok: false, fout: 'het model zei niet wat het begreep' };

  // Stappen met een type dat wij niet kennen, gooien we weg in plaats van door
  // te laten. Een stap die nergens heen gaat, ziet er in het scherm uit als
  // iets wat zal gebeuren — en dat gebeurt dan niet.
  const stappen = [];
  const geweigerd = [];
  for (const s of (Array.isArray(ruw.stappen) ? ruw.stappen : [])) {
    const type = String(s?.type || '').trim();
    if (!STAPTYPES.includes(type)) { geweigerd.push(type || '(leeg)'); continue; }
    stappen.push({
      type,
      omschrijving: String(s.omschrijving || '').trim().slice(0, 300) || type,
      wie: String(s.wie || '').trim().slice(0, 120) || null,
      parameters: (s.parameters && typeof s.parameters === 'object' && !Array.isArray(s.parameters)) ? s.parameters : {},
    });
  }

  const vraag = String(ruw.vraag || '').trim().slice(0, 300);
  let opties = Array.isArray(ruw.opties)
    ? ruw.opties.map((o) => String(o).trim().slice(0, 120)).filter(Boolean).slice(0, 4)
    : [];
  // Een vraag zonder opties is gewoon een vraag, en dat mag. Opties zonder
  // vraag is een menu zonder titel, en dat is verwarrend.
  if (!vraag) opties = [];

  return {
    ok: true,
    plan: {
      titel: titel || begrepen.slice(0, 60),
      begrepen,
      stappen,
      vraag: vraag || null,
      opties,
      raakt_groep: ruw.raakt_groep === true,
      groep_omschrijving: String(ruw.groep_omschrijving || '').trim().slice(0, 300) || null,
      geweigerde_stappen: geweigerd,
    },
  };
}

/**
 * In welke toestand hoort een opdracht na het maken van het plan?
 *
 * Zuiver, zodat de overgangen te testen zijn zonder model en zonder databank.
 * Dit is het soort logica waar een gemiste tak betekent dat een opdracht stil
 * blijft hangen.
 */
export function volgendeToestand(plan) {
  if (!plan) return 'afgebroken';
  if (plan.vraag) return 'wacht_op_ok';          // er is iets te beantwoorden
  if (!plan.stappen?.length) return 'wacht_op_ok'; // niets te doen: laat een mens kijken
  return 'wacht_op_ok';                           // er is altijd een ok nodig vóór uitvoeren
}

/**
 * Mag deze opdracht zonder verdere vragen uitgevoerd worden?
 *
 * Nee bij een groep — die vraagt altijd bevestiging, ook met autonomie aan.
 * Een verkeerd bericht naar één persoon is een excuus waard; hetzelfde bericht
 * naar veertig mensen is een incident.
 */
export function magDirectUitvoeren(plan) {
  if (!plan) return { mag: false, reden: 'geen plan' };
  if (plan.vraag) return { mag: false, reden: 'Iris heeft eerst een vraag.' };
  if (!plan.stappen?.length) return { mag: false, reden: 'Er zijn geen stappen om uit te voeren.' };
  if (plan.raakt_groep) {
    return { mag: false, reden: 'Deze opdracht raakt meerdere mensen. Die vraagt altijd om bevestiging.' };
  }
  return { mag: true, reden: null };
}

/**
 * Hoeveel er tegelijk mag vertrekken, en met hoeveel tussenruimte.
 *
 * Strato knijpt af bij bulk (421 en 450), en Meta straft herhaalde templates
 * naar mensen die niet reageren. De dosering is dus niet alleen hoffelijkheid
 * maar ook de enige manier om het kanaal te houden.
 */
export function doseerPlan(aantal, dosering = {}) {
  const perMinuut = Math.max(1, Number(dosering.max_per_minuut) || 6);
  const tussenMs = Math.ceil(60000 / perMinuut);
  return {
    aantal,
    per_minuut: perMinuut,
    tussen_ms: tussenMs,
    duur_minuten: Math.ceil(aantal / perMinuut),
    te_groot: aantal > BULK_MAX,
  };
}

/**
 * Maak een plan uit een opdracht.
 *
 * Gooit niet.
 */
export async function maakPlan({ vraag, context = null, model = null, temperatuur = 0.2 } = {}) {
  const schoon = String(vraag ?? '').trim();
  if (!schoon) return { ok: false, fout: 'lege opdracht' };

  const delen = [];
  if (context) {
    delen.push('Wat je al weet:');
    delen.push(typeof context === 'string' ? context : JSON.stringify(context, null, 2));
    delen.push('');
  }
  delen.push('De opdracht:');
  delen.push(schoon.slice(0, 2000));

  try {
    const ruw = await anthropicStructuredOutput({
      system: SYSTEEM_TEKST,
      messages: [{ role: 'user', content: delen.join('\n') }],
      tool_name: 'maak_plan',
      tool_input_schema: GEREEDSCHAP_SCHEMA,
      model: model || undefined,
      temperature: Number.isFinite(temperatuur) ? temperatuur : 0.2,
      max_tokens: 1500,
    });
    return keurPlan(ruw);
  } catch (e) {
    const code = (e instanceof AnthropicClientError && e.code) ? e.code : 'ONBEKEND';
    console.error('[iris/opdracht] plan maken mislukt:', code, e?.message || e);
    return { ok: false, fout: `${code}: ${e?.message || e}` };
  }
}

/**
 * Voeg een regel toe aan het verloop van een opdracht.
 *
 * Het verloop is wat maakt dat er nooit iets stil verdwijnt. Elke regel zegt
 * wanneer, wie en wat — en 'wie' is null als Iris het zelf deed.
 */
export function verloopRegel(wat, { wie = null, details = null, op = new Date() } = {}) {
  return {
    op: op.toISOString(),
    wie,
    wat: String(wat).slice(0, 300),
    ...(details ? { details } : {}),
  };
}
