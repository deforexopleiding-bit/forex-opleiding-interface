// api/_lib/template-variables.js
//
// Variable registry + parser + resolver voor WhatsApp template-variabelen
// (Module C4). Twee placeholder-stijlen ondersteund:
//
//   1) Named (nieuw, dot-notation):    {{klant.naam}}, {{factuur.bedrag_open}}
//   2) Positional (legacy, Meta-native): {{1}}, {{2}}
//
// Meta's WhatsApp Cloud API accepteert ALLEEN positionele placeholders in
// de uiteindelijke template body. Onze named-style is intern: we vertalen
// named -> positioneel bij submit, en bij send-time gebruiken we
// whatsapp_meta_templates.meta_param_mapping om positie -> variable-key te
// mappen en de waarde te resolven.
//
// Backward-compat: legacy templates (mapping = NULL) blijven werken via
// caller-supplied variables in inbox-send-template.js.
//
// Geen DB-import op module-niveau. SQL queries gebeuren in resolveVariables
// via een meegegeven supabaseAdmin client (callers reuse hun eigen).

// ── Helpers: formatters (lokaal, geen import uit dunning-template-render
//    om namespace-collision te vermijden — zie recon.data anti-pattern) ─────
const EUR_FORMATTER = new Intl.NumberFormat('nl-NL', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NL_MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

function formatEur(amount) {
  const n = Number(amount) || 0;
  return `EUR ${EUR_FORMATTER.format(n)}`;
}

function formatDateNl(isoDate) {
  if (!isoDate) return '';
  const ymd = String(isoDate).slice(0, 10);
  const parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  return parts.reverse().join('-');
}

function openAmount(inv) {
  if (!inv) return 0;
  const total = Number(inv.amount_total) || 0;
  const paid = Number(inv.amount_paid) || 0;
  const credited = Number(inv.credited_amount) || 0;
  return Math.max(0, total - paid - credited);
}

function customerDisplayName(c) {
  if (!c) return '';
  if (c.company_name && String(c.company_name).trim()) {
    return String(c.company_name).trim();
  }
  const first = (c.first_name || '').trim();
  const last = (c.last_name || '').trim();
  const full = `${first} ${last}`.trim();
  return full;
}

// ── Variable Registry ────────────────────────────────────────────────────
// Alle ondersteunde named variabelen voor WhatsApp templates.
// Categorieën:
//   - customer: klant-velden (uit public.customers)
//   - invoice:  factuur-velden (oudste open invoice tenzij anders gemarkeerd)
//   - klant:    aggregaties over alle open invoices van de klant
//   - bedrijf:  bedrijfsgegevens van De Forex Opleiding (env vars / constants)
//   - datum:    datum-helpers (vandaag, deze maand, dit jaar)
//
// requires_context: welke onderdelen van de resolve-context nodig zijn.
//   'customer' -> resolver moet customer-rij opzoeken
//   'invoice'  -> resolver moet oudste open invoice opzoeken
//   'invoices' -> resolver moet alle open invoices opzoeken (aggregaties)
//   null       -> server-side (env / clock), geen DB nodig
//
// requires_module_context (boolean): true wanneer de variabele waarde uit
// de whatsapp_module_config rij van de zendende lijn komt (afdeling.*).
// Caller moet context.moduleContext meeleveren ({ afdeling_telefoon, ... }).

export const AVAILABLE_VARIABLES = [
  // ── customer ───────────────────────────────────────────────────────────
  { key: 'klant.naam',       label: 'Volledige naam',     category: 'customer', example: 'Jeffrey Biemold',    requires_context: 'customer' },
  { key: 'klant.voornaam',   label: 'Voornaam',           category: 'customer', example: 'Jeffrey',            requires_context: 'customer' },
  { key: 'klant.email',      label: 'E-mailadres',        category: 'customer', example: 'klant@example.com',  requires_context: 'customer' },
  { key: 'klant.telefoon',   label: 'Telefoonnummer',     category: 'customer', example: '+31612345678',       requires_context: 'customer' },
  { key: 'klant.bedrijf',    label: 'Bedrijfsnaam',       category: 'customer', example: 'Voorbeeld B.V.',     requires_context: 'customer' },

  // ── invoice (oudste open factuur) ──────────────────────────────────────
  { key: 'factuur.nummer',       label: 'Factuurnummer',         category: 'invoice', example: '2026-0001',         requires_context: 'invoice' },
  { key: 'factuur.bedrag',       label: 'Factuurbedrag (totaal)', category: 'invoice', example: 'EUR 1.234,56',     requires_context: 'invoice' },
  { key: 'factuur.bedrag_open',  label: 'Openstaand bedrag',     category: 'invoice', example: 'EUR 80,00',         requires_context: 'invoice' },
  { key: 'factuur.vervaldatum',  label: 'Vervaldatum',           category: 'invoice', example: '15-06-2026',        requires_context: 'invoice' },
  { key: 'factuur.dagen_overdue', label: 'Dagen te laat',        category: 'invoice', example: '12',                requires_context: 'invoice' },
  { key: 'factuur.factuur_datum', label: 'Factuurdatum',         category: 'invoice', example: '01-06-2026',        requires_context: 'invoice' },
  { key: 'factuur.betaal_link',  label: 'Betaal-link',           category: 'invoice', example: 'https://focus.teamleader.eu/...', requires_context: 'invoice' },

  // ── klant (aggregaties over alle open invoices) ────────────────────────
  { key: 'klant.factuur_lijst', label: 'Lijst openstaande facturen', category: 'klant', example: '- 2026-0001 (EUR 80,00)\n- 2026-0002 (EUR 120,00)', requires_context: 'invoices' },
  { key: 'klant.totaal_open',   label: 'Totaal openstaand',          category: 'klant', example: 'EUR 200,00',  requires_context: 'invoices' },
  { key: 'klant.aantal_open',   label: 'Aantal open facturen',       category: 'klant', example: '2',           requires_context: 'invoices' },

  // ── afdeling (per-module contactgegevens uit whatsapp_module_config) ───
  { key: 'afdeling.telefoon',      label: 'Telefoon afdeling',  category: 'afdeling', example: '+31 85 130 83 62',              requires_context: null, requires_module_context: true },
  { key: 'afdeling.whatsapp',      label: 'WhatsApp afdeling',  category: 'afdeling', example: '+31 6 51031673',                requires_context: null, requires_module_context: true },
  { key: 'afdeling.email',         label: 'Email afdeling',     category: 'afdeling', example: 'administratie@deforexopleiding.nl', requires_context: null, requires_module_context: true },
  { key: 'afdeling.ondertekenaar', label: 'Ondertekenaar',      category: 'afdeling', example: 'De Forex Opleiding',            requires_context: null, requires_module_context: true },

  // ── bedrijf (env / constants) ──────────────────────────────────────────
  { key: 'bedrijf.naam',     label: 'Bedrijfsnaam',  category: 'bedrijf', example: 'De Forex Opleiding NL B.V.', requires_context: null },
  { key: 'bedrijf.adres',    label: 'Bedrijfsadres', category: 'bedrijf', example: 'Voorbeeldstraat 1, 1234 AB Plaats', requires_context: null },
  { key: 'bedrijf.kvk',      label: 'KvK-nummer',    category: 'bedrijf', example: '12345678',                   requires_context: null },
  { key: 'bedrijf.btw',      label: 'BTW-nummer',    category: 'bedrijf', example: 'NL123456789B01',             requires_context: null },
  { key: 'bedrijf.telefoon', label: 'Bedrijfstelefoon', category: 'bedrijf', example: '+31201234567',            requires_context: null },
  { key: 'bedrijf.email',    label: 'Bedrijfse-mail',   category: 'bedrijf', example: 'info@deforexopleiding.nl', requires_context: null },

  // ── event (Fase 4) — vereist context.event (events-row met starts_at /
  //   ends_at / location / niveau / title). Caller die geen event meegeeft
  //   (bv. finance-flows) krijgt lege strings — geen crash, geen regressie.
  { key: 'event.titel',      label: 'Event-titel', category: 'event', example: 'Forex Masterclass',         requires_context: 'event' },
  { key: 'event.datum',      label: 'Datum',       category: 'event', example: 'zaterdag 20 juni 2026',     requires_context: 'event' },
  { key: 'event.starttijd',  label: 'Starttijd',   category: 'event', example: '10:00',                     requires_context: 'event' },
  { key: 'event.eindtijd',   label: 'Eindtijd',    category: 'event', example: '13:00',                     requires_context: 'event' },
  { key: 'event.locatie',    label: 'Locatie',     category: 'event', example: 'Van der Valk, Gent',        requires_context: 'event' },
  { key: 'event.niveau',     label: 'Niveau',      category: 'event', example: 'Basis',                     requires_context: 'event' },

  // ── attendee (Fase 3a) — vereist context.attendee (event_attendees-row).
  //   Caller die geen attendee meegeeft krijgt lege strings — geen crash,
  //   geen regressie voor finance-flows. Eigen domein (NIET klant) omdat
  //   een keuze-link-ontvanger een event-inschrijving / prospect is.
  { key: 'attendee.voornaam',   label: 'Voornaam',        category: 'attendee', example: 'Jeffrey',                                                                                                        requires_context: 'attendee' },
  { key: 'attendee.achternaam', label: 'Achternaam',      category: 'attendee', example: 'Biemold',                                                                                                        requires_context: 'attendee' },
  { key: 'attendee.naam',       label: 'Volledige naam',  category: 'attendee', example: 'Jeffrey Biemold',                                                                                                requires_context: 'attendee' },
  { key: 'attendee.email',      label: 'E-mail',          category: 'attendee', example: 'naam@voorbeeld.nl',                                                                                              requires_context: 'attendee' },
  { key: 'attendee.telefoon',   label: 'Telefoon',        category: 'attendee', example: '+31 6 12345678',                                                                                                 requires_context: 'attendee' },
  { key: 'attendee.keuze_link',      label: 'Keuze-link',      category: 'attendee', example: 'https://forex-opleiding-interface.vercel.app/modules/event-keuze.html?t=00000000-0000-0000-0000-000000000000',   requires_context: 'attendee' },
  { key: 'attendee.vragenlijst_link', label: 'Vragenlijst-link', category: 'attendee', example: 'https://forex-opleiding-interface.vercel.app/modules/assessment.html?t=00000000-0000-0000-0000-000000000000', requires_context: 'attendee' },

  // ── onboarding (Comms C1) — vereist context.onboarding (onboardings-row).
  //   Onboarding-invite-flow geeft een onboarding-context mee zodat we de
  //   persoonlijke wizard-link + traject-naam + status kunnen renderen.
  //   Callers die alleen een customer hebben kunnen vóór resolveVariables
  //   loadOnboardingForCustomer(supabaseClient, customer.id) aanroepen om
  //   context.onboarding op te halen (meest recente onboardings-rij).
  { key: 'onboarding.persoonlijke_link', label: 'Persoonlijke onboarding-link', category: 'onboarding', example: 'https://forex-opleiding-interface.vercel.app/modules/onboarding.html?t=00000000-0000-0000-0000-000000000000', requires_context: 'onboarding' },
  { key: 'onboarding.startdatum',   label: 'Startdatum',          category: 'onboarding', example: '20-06-2026', requires_context: 'onboarding' },
  { key: 'onboarding.traject',      label: 'Traject',             category: 'onboarding', example: 'Forex Masterclass 1-op-1', requires_context: 'onboarding' },
  { key: 'onboarding.mentor',       label: 'Toegewezen mentor',   category: 'onboarding', example: 'Dave de Jong', requires_context: 'onboarding' },
  { key: 'onboarding.wizard_link',  label: 'Wizard-link',     category: 'onboarding', example: 'https://forex-opleiding-interface.vercel.app/modules/onboarding.html?t=00000000-0000-0000-0000-000000000000', requires_context: 'onboarding' },
  { key: 'onboarding.traject_label', label: 'Traject-label',  category: 'onboarding', example: 'Forex Masterclass 1-op-1', requires_context: 'onboarding' },
  { key: 'onboarding.status',       label: 'Onboarding-status', category: 'onboarding', example: 'aangemeld', requires_context: 'onboarding' },
  { key: 'onboarding.login_url',    label: 'Login-URL Bubble', category: 'onboarding', example: 'https://dashboard.deforexopleiding.nl', requires_context: 'onboarding' },
  { key: 'onboarding.temp_password', label: 'Tijdelijk wachtwoord (alleen credentials-flow)', category: 'onboarding', example: 'Aw9!Xq2p', requires_context: 'onboarding' },
  // Credentials-flow voor 'Stuur inloggegevens via WhatsApp' — bubble_gebruikersnaam
  // mag uit customer.email of (fallback) onboarding.bubble_username komen;
  // bubble_wachtwoord is een alias van onboarding.temp_password die door de
  // credentials-knop met een vers wachtwoord wordt gevuld.
  { key: 'onboarding.bubble_gebruikersnaam', label: 'Bubble gebruikersnaam (klant-email)', category: 'onboarding', example: 'klant@example.com', requires_context: 'customer' },
  { key: 'onboarding.bubble_wachtwoord',     label: 'Bubble wachtwoord (tijdelijk)',       category: 'onboarding', example: 'Aw9!Xq2p',           requires_context: 'onboarding' },

  // ── datum ──────────────────────────────────────────────────────────────
  { key: 'datum.vandaag',     label: 'Datum vandaag', category: 'datum', example: '09-06-2026',  requires_context: null },
  { key: 'datum.deze_maand',  label: 'Deze maand',    category: 'datum', example: 'juni 2026',   requires_context: null },
  { key: 'datum.dit_jaar',    label: 'Dit jaar',      category: 'datum', example: '2026',         requires_context: null },
];

// Snelle key-lookup map (one-shot bij module-load).
const VAR_BY_KEY = new Map(AVAILABLE_VARIABLES.map((v) => [v.key, v]));

// ── Regex patterns ───────────────────────────────────────────────────────
// Named: {{categorie.veld}} — alleen lowercase letters, underscore, dot.
export const VARIABLE_REGEX = /\{\{([a-z_]+\.[a-z_]+)\}\}/g;
// Positional: {{N}} — legacy Meta-native.
export const POSITIONAL_REGEX = /\{\{(\d+)\}\}/g;

// ── Parsers ──────────────────────────────────────────────────────────────

/**
 * Vind alle named placeholders ({{klant.naam}}) in tekst.
 * Returnt unieke keys in volgorde van eerste verschijning.
 */
export function parseNamedPlaceholders(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  const result = [];
  const re = new RegExp(VARIABLE_REGEX.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1];
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

/**
 * Vind alle positionele placeholders ({{1}}, {{2}}, ...) in tekst.
 * Returnt unieke indices (als integers) gesorteerd numeriek.
 */
export function parsePositionalPlaceholders(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Set();
  const re = new RegExp(POSITIONAL_REGEX.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    seen.add(parseInt(m[1], 10));
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * True als de tekst named placeholders bevat en GEEN positionele.
 * Mixed templates (beide stijlen) zijn niet ondersteund; submit-endpoint
 * dient die te weigeren.
 */
export function isNamedTemplate(text) {
  const named = parseNamedPlaceholders(text);
  const positional = parsePositionalPlaceholders(text);
  return named.length > 0 && positional.length === 0;
}

// ── Registry lookup helpers ──────────────────────────────────────────────

export function getVariableByKey(key) {
  return VAR_BY_KEY.get(key) || null;
}

export function getExampleForKey(key) {
  const v = VAR_BY_KEY.get(key);
  return v ? v.example : '';
}

// ── Submit-time conversion ───────────────────────────────────────────────

/**
 * Converteert een named-style body naar Meta-positioneel + bouwt mapping.
 *
 * Input:  "Hoi {{klant.naam}}, je factuur {{factuur.nummer}} staat open."
 * Output: {
 *   converted_text: "Hoi {{1}}, je factuur {{2}} staat open.",
 *   mapping:        { "1": "klant.naam", "2": "factuur.nummer" }
 * }
 *
 * Onbekende keys (niet in AVAILABLE_VARIABLES) worden 1-op-1 mee gemapt
 * met een warning in het result-object (caller kan dan blokkeren).
 */
export function buildPositionalMapping(text) {
  const keys = parseNamedPlaceholders(text);
  const mapping = {};
  const unknown = [];

  let converted_text = text || '';
  keys.forEach((key, idx) => {
    const position = String(idx + 1);
    mapping[position] = key;
    if (!VAR_BY_KEY.has(key)) unknown.push(key);
    // Vervang alle voorkomens van deze key door {{position}}.
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const placeholderRe = new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g');
    converted_text = converted_text.replace(placeholderRe, `{{${position}}}`);
  });

  return { converted_text, mapping, unknown };
}

// ── Send-time value resolvers ────────────────────────────────────────────

function getCompanyValue(key) {
  // Server-side bedrijfsgegevens uit env-vars. Fallback = lege string (caller
  // moet beslissen wat te doen — sturen mag, leeg veld in template-body is OK).
  // Documentatie van verwachte env-vars:
  //   COMPANY_NAME      -> bedrijf.naam     (fallback: 'De Forex Opleiding NL B.V.')
  //   COMPANY_ADDRESS   -> bedrijf.adres
  //   COMPANY_KVK       -> bedrijf.kvk
  //   COMPANY_BTW       -> bedrijf.btw
  //   COMPANY_PHONE     -> bedrijf.telefoon
  //   COMPANY_EMAIL     -> bedrijf.email
  const env = process.env || {};
  switch (key) {
    case 'bedrijf.naam':     return env.COMPANY_NAME || 'De Forex Opleiding NL B.V.';
    case 'bedrijf.adres':    return env.COMPANY_ADDRESS || '';
    case 'bedrijf.kvk':      return env.COMPANY_KVK || '';
    case 'bedrijf.btw':      return env.COMPANY_BTW || '';
    case 'bedrijf.telefoon': return env.COMPANY_PHONE || '';
    case 'bedrijf.email':    return env.COMPANY_EMAIL || '';
    default: return '';
  }
}

function getAfdelingValue(key, moduleContext) {
  // moduleContext = whatsapp_module_config rij van de zendende lijn:
  //   { afdeling_telefoon, afdeling_whatsapp, afdeling_email,
  //     afdeling_ondertekenaar, ... }.
  // Bij ontbrekende context (legacy callers): empty string + console.warn
  // zodat het opvalt in Vercel logs maar de send niet faalt.
  if (!moduleContext) {
    // eslint-disable-next-line no-console
    console.warn(`[template-variables] ${key} requested zonder moduleContext`);
    return '';
  }
  switch (key) {
    case 'afdeling.telefoon':      return moduleContext.afdeling_telefoon || '';
    case 'afdeling.whatsapp':      return moduleContext.afdeling_whatsapp || '';
    case 'afdeling.email':         return moduleContext.afdeling_email || '';
    case 'afdeling.ondertekenaar': return moduleContext.afdeling_ondertekenaar || '';
    default: return '';
  }
}

function getDateValue(key) {
  const now = new Date();
  switch (key) {
    case 'datum.vandaag': {
      const dd = String(now.getDate()).padStart(2, '0');
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      return `${dd}-${mm}-${yyyy}`;
    }
    case 'datum.deze_maand':
      return `${NL_MONTHS[now.getMonth()]} ${now.getFullYear()}`;
    case 'datum.dit_jaar':
      return String(now.getFullYear());
    default: return '';
  }
}

function getCustomerValue(customer, key) {
  if (!customer) return '';
  switch (key) {
    case 'klant.naam':     return customerDisplayName(customer);
    case 'klant.voornaam': return (customer.first_name || '').trim();
    case 'klant.email':    return customer.email || '';
    case 'klant.telefoon': return customer.phone || '';
    case 'klant.bedrijf':  return customer.company_name || '';
    default: return '';
  }
}

function getInvoiceValue(invoice, key) {
  if (!invoice) return '';
  switch (key) {
    case 'factuur.nummer':         return invoice.invoice_number || '';
    case 'factuur.bedrag':         return formatEur(invoice.amount_total);
    case 'factuur.bedrag_open':    return formatEur(openAmount(invoice));
    case 'factuur.vervaldatum':    return formatDateNl(invoice.due_date);
    case 'factuur.factuur_datum':  return formatDateNl(invoice.issue_date);
    case 'factuur.dagen_overdue': {
      if (!invoice.due_date) return '0';
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const due = new Date(`${String(invoice.due_date).slice(0, 10)}T00:00:00`);
      const diff = Math.floor((today.getTime() - due.getTime()) / 86400000);
      return String(Math.max(0, diff));
    }
    case 'factuur.betaal_link':
      // payment_url wordt lazy gevuld door /api/finance-invoice-payment-link.
      // Tot dan: leeg. Caller (resolveVariables) kan optioneel het endpoint
      // pre-call'en alvorens te resolven.
      return invoice.payment_url || '';
    default: return '';
  }
}

function getKlantAggregateValue(openInvoices, key) {
  const invs = Array.isArray(openInvoices) ? openInvoices : [];
  switch (key) {
    case 'klant.factuur_lijst':
      return invs
        .map((inv) => `- ${inv.invoice_number || inv.id || ''} (${formatEur(openAmount(inv))})`)
        .join('\n');
    case 'klant.totaal_open':
      return formatEur(invs.reduce((sum, inv) => sum + openAmount(inv), 0));
    case 'klant.aantal_open':
      return String(invs.length);
    default: return '';
  }
}

// ── event (Fase 4) ─────────────────────────────────────────────────────────
//
// NL-locale + timezone Europe/Amsterdam zodat een event op zaterdagochtend
// niet als vrijdagavond UTC verschijnt. Bij ontbrekend/ongeldig timestamp
// returnt elke formatter '' — consistent met andere requires_context helpers.

function fmtEventDateNl(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    if (!Number.isFinite(dt.getTime())) return '';
    return new Intl.DateTimeFormat('nl-NL', {
      weekday : 'long',
      day     : 'numeric',
      month   : 'long',
      year    : 'numeric',
      timeZone: 'Europe/Amsterdam',
    }).format(dt);
  } catch (_e) { return ''; }
}

function fmtEventTimeNl(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    if (!Number.isFinite(dt.getTime())) return '';
    return new Intl.DateTimeFormat('nl-NL', {
      hour    : '2-digit',
      minute  : '2-digit',
      hour12  : false,
      timeZone: 'Europe/Amsterdam',
    }).format(dt);
  } catch (_e) { return ''; }
}

function capitalizeFirst(s) {
  if (!s || typeof s !== 'string') return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getEventValue(event, key) {
  if (!event) return '';
  switch (key) {
    case 'event.titel':     return String(event.title    || '');
    case 'event.datum':     return fmtEventDateNl(event.starts_at);
    case 'event.starttijd': return fmtEventTimeNl(event.starts_at);
    case 'event.eindtijd':  return fmtEventTimeNl(event.ends_at);
    case 'event.locatie':   return String(event.location || '');
    case 'event.niveau':    return capitalizeFirst(String(event.niveau || ''));
    default: return '';
  }
}

// ── attendee (Fase 3a) ──────────────────────────────────────────────────────
//
// Persoonlijke keuze-link per deelnemer: base-URL via PUBLIC_BASE_URL
// (zelfde env-var-patroon als sales-onboarding-send / teamleader-webhook-
// register). Productie-fallback op de Vercel-alias zodat de link altijd naar
// productie wijst, niet naar de deployment-specifieke VERCEL_URL.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app';

// Onboarding-vars (Comms C1) — vereist context.onboarding met minstens
// `token` voor de wizard-link. traject_label en status zijn optioneel.
// Geen context.onboarding → lege string (no-crash).
function getOnboardingValue(onboarding, key) {
  if (!onboarding) return '';
  switch (key) {
    case 'onboarding.wizard_link':
    case 'onboarding.persoonlijke_link': {
      // Beide keys produceren exact dezelfde persoonlijke link
      // (base-URL + /modules/onboarding.html?t=<token>), identiek aan
      // de URL die onboarding-hub bouwt.
      const token = onboarding.token;
      if (!token) return '';
      return `${PUBLIC_BASE_URL}/modules/onboarding.html?t=${encodeURIComponent(String(token))}`;
    }
    case 'onboarding.startdatum':    return onboarding.start_date ? formatDateNl(onboarding.start_date) : '';
    case 'onboarding.traject':       return String(onboarding.traject_label || '');
    case 'onboarding.mentor':        return String(onboarding.mentor_name || '');
    case 'onboarding.traject_label': return String(onboarding.traject_label || '');
    case 'onboarding.status':        return String(onboarding.status || '');
    case 'onboarding.login_url':     return String(onboarding.login_url || '');
    case 'onboarding.temp_password': return String(onboarding.temp_password || '');
    default: return '';
  }
}

/**
 * Laadt de meest recente onboardings-rij voor een klant. Bedoeld als
 * pre-resolve helper voor callers die alleen een customer hebben maar
 * onboarding.*-variabelen willen renderen.
 *
 *   const onboarding = await loadOnboardingForCustomer(supabaseAdmin, customer.id);
 *   const ctx = { customer, invoice, openInvoices, onboarding };
 *   const out = resolveVariables(text, mapping, ctx);
 *
 * Selecteert alle kolommen die onboarding.*-resolvers gebruiken
 * (token, start_date, traject_label, mentor_name, status). Sorteert op
 * created_at desc + limit 1. Fail-soft: bij geen klant, DB-fout of geen
 * rij returnt null — callers hoeven niet te try/catchen, resolveVariables
 * geeft dan zelf '' voor onboarding.*-keys.
 */
export async function loadOnboardingForCustomer(supabaseClient, customerId) {
  if (!supabaseClient || !customerId) return null;
  try {
    const { data, error } = await supabaseClient
      .from('onboardings')
      .select('id, token, start_date, traject_label, mentor_name, status, created_at')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn('[template-variables] loadOnboardingForCustomer:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.warn('[template-variables] loadOnboardingForCustomer fout:', e?.message || e);
    return null;
  }
}

function getAttendeeValue(attendee, key) {
  if (!attendee) return '';
  switch (key) {
    case 'attendee.voornaam':   return String(attendee.first_name || '');
    case 'attendee.achternaam': return String(attendee.last_name  || '');
    case 'attendee.naam': {
      // Trim + filter zodat ontbrekende achternaam geen losse spatie geeft.
      const parts = [attendee.first_name, attendee.last_name]
        .map((s) => (s == null ? '' : String(s).trim()))
        .filter((s) => s.length > 0);
      return parts.join(' ');
    }
    case 'attendee.email':      return String(attendee.email || '');
    case 'attendee.telefoon':   return String(attendee.phone || '');
    case 'attendee.keuze_link': {
      const token = attendee.choice_token;
      if (!token) return '';
      return `${PUBLIC_BASE_URL}/modules/event-keuze.html?t=${encodeURIComponent(String(token))}`;
    }
    case 'attendee.vragenlijst_link': {
      const token = attendee.choice_token;
      if (!token) return '';
      return `${PUBLIC_BASE_URL}/modules/assessment.html?t=${encodeURIComponent(String(token))}`;
    }
    default: return '';
  }
}

/**
 * Resolve een enkele variabele-key naar zijn waarde, gegeven de context.
 * context = {
 *   customer,                // customers rij
 *   invoice,                 // oudste open invoice
 *   openInvoices,            // alle open invoices
 *   moduleContext,           // whatsapp_module_config rij voor afdeling.*
 *   event,                   // events rij voor event.* (Fase 4 — optioneel;
 *                            //   callers zonder event krijgen lege strings,
 *                            //   geen crash, geen regressie voor finance-flow)
 *   attendee,                // event_attendees rij voor attendee.* (Fase 3a —
 *                            //   optioneel; minimaal choice_token nodig voor
 *                            //   attendee.keuze_link. Callers zonder attendee
 *                            //   krijgen lege string, geen crash.)
 * }.
 */
export function resolveVariableValue(key, context) {
  const v = VAR_BY_KEY.get(key);
  if (!v) return '';

  // Special-cases voor de credentials-flow: deze 2 keys hangen tussen
  // onboarding (wachtwoord) en customer (gebruikersnaam = klant-email) in.
  // Pure fail-soft: lege string bij ontbrekende context, nooit throwen.
  // Raken expliciet alleen deze 2 keys; alle andere onboarding.*-resolutie
  // valt door naar getOnboardingValue ongewijzigd.
  if (key === 'onboarding.bubble_gebruikersnaam') {
    const email = (context && context.customer && context.customer.email) || null;
    const fallback = (context && context.onboarding && context.onboarding.bubble_username) || null;
    return String(email || fallback || '');
  }
  if (key === 'onboarding.bubble_wachtwoord') {
    return String((context && context.onboarding && context.onboarding.temp_password) || '');
  }

  switch (v.category) {
    case 'bedrijf':  return getCompanyValue(key);
    case 'datum':    return getDateValue(key);
    case 'customer': return getCustomerValue(context && context.customer, key);
    case 'invoice':  return getInvoiceValue(context && context.invoice, key);
    case 'klant':    return getKlantAggregateValue(context && context.openInvoices, key);
    case 'afdeling': return getAfdelingValue(key, context && context.moduleContext);
    case 'event':      return getEventValue(context && context.event, key);
    case 'attendee':   return getAttendeeValue(context && context.attendee, key);
    case 'onboarding': return getOnboardingValue(context && context.onboarding, key);
    default: return '';
  }
}

/**
 * Hoofdresolver: tekst + mapping + context -> ingevulde tekst.
 *
 * Twee modi:
 *   1) Named-style tekst ({{klant.naam}}): ignore mapping, resolve direct.
 *   2) Positioneel-style ({{1}}, {{2}}) MET mapping: lookup mapping[N] = key,
 *      resolve key tegen context.
 *
 * Context-shape: { customer, invoice, openInvoices, moduleContext, event }.
 * moduleContext is optioneel — alleen vereist voor afdeling.* keys; caller
 * (bv. inbox-send-template) bepaalt de juiste whatsapp_module_config rij op
 * basis van het zendende phone_number_id.
 * event is optioneel — alleen vereist voor event.* keys; caller (bv. een
 * toekomstige events-template-send) geeft de events-row mee. Finance-flows
 * sturen geen event mee — event.* keys vallen dan terug op '' (geen crash).
 * attendee is optioneel — alleen vereist voor attendee.* keys; caller (bv. een
 * outbound naar een specifieke deelnemer) geeft de event_attendees-row mee
 * (minimaal choice_token voor attendee.keuze_link). Geen attendee → ''.
 *
 * Onbekende keys: laat placeholder staan + log warning.
 *
 * Returnt { text, values: { '<key>': '<value>' }, warnings: [] }.
 */
export function resolveVariables(text, mapping, context) {
  let result = text == null ? '' : String(text);
  const values = {};
  const warnings = [];

  // ── Mode 1: named placeholders direct vervangen ────────────────────────
  const namedKeys = parseNamedPlaceholders(result);
  for (const key of namedKeys) {
    if (!VAR_BY_KEY.has(key)) {
      warnings.push(`Onbekende variabele-key: ${key}`);
      continue;
    }
    const value = resolveVariableValue(key, context);
    values[key] = value;
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\{\\{${escapedKey}\\}\\}`, 'g');
    result = result.replace(re, value);
  }

  // ── Mode 2: positional + mapping ──────────────────────────────────────
  const positionalIdx = parsePositionalPlaceholders(result);
  if (positionalIdx.length > 0 && mapping && typeof mapping === 'object') {
    for (const idx of positionalIdx) {
      const key = mapping[String(idx)];
      if (!key) {
        warnings.push(`Geen mapping voor positie ${idx}`);
        continue;
      }
      if (!VAR_BY_KEY.has(key)) {
        warnings.push(`Onbekende variabele-key in mapping[${idx}]: ${key}`);
        continue;
      }
      const value = resolveVariableValue(key, context);
      values[key] = value;
      const re = new RegExp(`\\{\\{${idx}\\}\\}`, 'g');
      result = result.replace(re, value);
    }
  }

  return { text: result, values, warnings };
}

/**
 * Bouwt de Meta body-parameters array uit een mapping + context.
 * Output-shape past op inbox-send-template.js variables-param:
 *   { '1': '<resolved>', '2': '<resolved>', ... }
 */
export function buildMetaVariablesFromMapping(mapping, context) {
  const out = {};
  if (!mapping || typeof mapping !== 'object') return out;
  const keys = Object.keys(mapping).filter((k) => /^\d+$/.test(k));
  for (const k of keys) {
    const varKey = mapping[k];
    out[k] = resolveVariableValue(varKey, context);
  }
  return out;
}
