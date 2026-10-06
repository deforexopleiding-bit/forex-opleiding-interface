// api/_lib/wa-nummers.js
//
// WhatsApp-NUMMERS en ROUTERING — één plek, config-gedreven, multi-nummer.
//
// Achtergrond (2026-10-05): de oude Meta-WABA is geblokkeerd. We verzenden en
// ontvangen nu via 360dialog (Cloud-API, https://waba-v2.360dialog.io). Er is
// nu één actief nummer; meer nummers = een entry in WA_NUMMERS + de env-keys
// ervan, geen codewijziging elders.
//
// Wat een entry vastlegt:
//   sleutel              interne naam (ook in de webhook-URL: ?nummer=<sleutel>)
//   e164                 het nummer zelf
//   provider             '360dialog' (de enige die nu verstuurt)
//   channel_id           360dialog channel-ID (ter referentie / support)
//   api_key_env          Vercel-env met de D360-API-KEY van dit nummer (NOOIT hardcoden)
//   phone_number_id_env  Vercel-env met Meta's phone_number_id van dit nummer.
//                        Optioneel: ontbreekt hij, dan vraagt de transport hem één
//                        keer op bij 360dialog (GET /health_status?fields=id) en
//                        onthoudt hem per serverinstantie.
//   webhook_token_env    Vercel-env met het gedeelde geheim voor de inkomende webhook
//   modules              welke CRM-modules (whatsapp_module_config.module) via dit
//                        nummer versturen; '*' = alle niet-uitgesloten modules
//   uitgesloten_modules  modules die hier NOOIT over mogen (klantgericht)
//   standaard            true = ook voor verzendingen zonder lijn én zonder module.
//                        Bewust UIT op het hoofdnummer: klant-flows (gedeelde inbox,
//                        Joost, Iris, mark-read, test-cockpit) vallen zonder lijn terug
//                        op de standaard; die mogen niet stil op het leadnummer landen.
//   inkomend_module      welke module eigenaar is van inkomende gesprekken
//   templates            CRM-templatenaam → naam bij 360dialog (alleen als ze verschillen)
//
// ROUTERING NU: het hoofdnummer bedient de LEAD-/niet-klant-modules
// (leadsonderhoud = welkom/afspraken/toegang/onderhoud/gesprekken, welkom,
// events, opvolging). KLANT-modules staan er bewust buiten:
//   - onboarding  → krijgt later een eigen nummer; tot dan e-mail (zie
//                   api/_lib/onboarding-template-send.js / onboarding-invite.js);
//   - finance / dunning (wanbetalers, Joost, Iris) → klanten; beslissing Jeffrey.
//     Aanzetten = 'finance' en 'dunning' van uitgesloten_modules naar modules.

export const WA_NUMMERS = Object.freeze([
  Object.freeze({
    sleutel: 'hoofdnummer',
    label: 'Hoofdnummer (leads)',
    // 2026-10-06: nieuwe 360dialog-account + WABA + nummer (was +31657210825,
    // channel n4BsS9CH — dat account liep vast op 131042-betaalproblemen).
    // Meta's phone_number_id van dit nummer: 1273723375834177 (Vercel-env).
    e164: '+31644562426',
    provider: '360dialog',
    channel_id: null,   // TODO: channel-ID uit de 360dialog-hub invullen (alleen referentie, functioneel niet gebruikt)
    api_key_env: 'D360_API_KEY_HOOFDNUMMER',
    phone_number_id_env: 'D360_PHONE_NUMBER_ID_HOOFDNUMMER',
    webhook_token_env: 'D360_WEBHOOK_TOKEN_HOOFDNUMMER',
    modules: Object.freeze(['leadsonderhoud', 'welkom', 'events', 'opvolging']),
    uitgesloten_modules: Object.freeze(['onboarding', 'finance', 'dunning']),
    standaard: false,
    inkomend_module: 'leadsonderhoud',
    templates: Object.freeze({}),
    actief: true,
  }),
]);

/** Modules die nooit via een nummer met modules:['*'] mogen (klantgericht, eigen nummer later). */
export const NOOIT_VIA_WILDCARD = Object.freeze(['onboarding']);

export const D360_BASE_URL = 'https://waba-v2.360dialog.io';

const cijfers = (s) => String(s || '').replace(/\D/g, '');

export function actieveNummers() {
  return WA_NUMMERS.filter((n) => n.actief);
}

export function nummerOpSleutel(sleutel) {
  return actieveNummers().find((n) => n.sleutel === sleutel) || null;
}

/** Nummer bij een e164 / display_phone_number (cijfers vergeleken). */
export function nummerOpTelefoon(tel) {
  const c = cijfers(tel);
  if (!c) return null;
  return actieveNummers().find((n) => cijfers(n.e164) === c) || null;
}

/** API-key van een nummer, of null als de env ontbreekt. */
export function apiKeyVan(nummer) {
  const k = nummer && process.env[nummer.api_key_env];
  return k && String(k).trim() ? String(k).trim() : null;
}

/** phone_number_id uit env (synchroon). De transport kan hem ook opvragen — zie meta-whatsapp.js. */
export function phoneNumberIdUitEnv(nummer) {
  const v = nummer && process.env[nummer.phone_number_id_env];
  return v && String(v).trim() ? String(v).trim() : null;
}

/** Nummer bij een phone_number_id — alleen via env (synchroon). */
export function nummerOpPhoneNumberId(pnId) {
  if (!pnId) return null;
  const p = String(pnId).trim();
  return actieveNummers().find((n) => phoneNumberIdUitEnv(n) === p) || null;
}

/**
 * Welk nummer verstuurt voor deze module? null = geen WhatsApp voor deze module
 * (bv. onboarding nu). Expliciete module-lijst gaat vóór de wildcard.
 */
export function nummerVoorModule(module) {
  const m = module ? String(module).toLowerCase() : null;
  const kandidaten = actieveNummers();
  if (m) {
    const expliciet = kandidaten.find((n) => n.modules.includes(m) && !n.uitgesloten_modules.includes(m));
    if (expliciet) return expliciet;
    if (NOOIT_VIA_WILDCARD.includes(m)) return null;
  }
  return kandidaten.find((n) => n.modules.includes('*') && !(m && n.uitgesloten_modules.includes(m))) || null;
}

/** Het standaardnummer voor verzendingen zonder module én zonder lijn (alleen met standaard:true). */
export function standaardNummer() {
  return actieveNummers().find((n) => n.standaard === true) || null;
}

/** Mag deze module WhatsApp sturen via dit nummer? */
export function moduleMagViaNummer(module, nummer) {
  if (!nummer) return false;
  const m = module ? String(module).toLowerCase() : null;
  if (m && nummer.uitgesloten_modules.includes(m)) return false;
  if (m && nummer.modules.includes(m)) return true;
  if (m && NOOIT_VIA_WILDCARD.includes(m)) return false;
  return nummer.modules.includes('*');
}

/** CRM-templatenaam → naam bij de provider (identiek tenzij gemapt). */
export function templateNaamVoor(nummer, crmNaam) {
  if (!nummer || !crmNaam) return crmNaam;
  return (nummer.templates && nummer.templates[crmNaam]) || crmNaam;
}

/** Webhook-geheim van een nummer (of null). */
export function webhookTokenVan(nummer) {
  const v = nummer && process.env[nummer.webhook_token_env];
  return v && String(v).trim() ? String(v).trim() : null;
}

/** Status per nummer voor diagnose — zonder geheimen. */
export function nummerStatus() {
  return actieveNummers().map((n) => ({
    sleutel: n.sleutel, e164: n.e164, provider: n.provider, channel_id: n.channel_id,
    api_key: !!apiKeyVan(n), phone_number_id: phoneNumberIdUitEnv(n), webhook_token: !!webhookTokenVan(n),
    modules: [...n.modules], uitgesloten_modules: [...n.uitgesloten_modules], inkomend_module: n.inkomend_module,
  }));
}
