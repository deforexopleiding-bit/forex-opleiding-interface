// api/joost-config-get.js
// GET -> haal de Joost-config voor een module op (1 rij per module).
// Permission: admin.joost_config OF finance.joost.view (fallback voor read-only
// finance-gebruikers die het Joost-paneel in de inbox mogen zien zonder de
// config te kunnen bewerken).
//
// Query-params:
//   module (text, default 'finance')  -> exact-match op joost_config.module
//
// Response 200: { config: row }
//   - row: volledige joost_config rij (persona_name, persona_tone,
//     system_prompt_template, knowledge_base, model, temperature,
//     context_message_count, is_enabled, updated_by_user_id, updated_at).
//   - Als geen rij bestaat voor de opgegeven module geeft het endpoint een
//     spec-conforme default-shape terug met is_default: true zodat UI / admin
//     altijd een werkbare baseline laadt (geen leeg form, geen 0.4 / 10 / false
//     legacy defaults). Eerste save (upsert) materialiseert deze defaults dan
//     in de DB-rij.
//
// Auth: Bearer-token verplicht (401 bij ontbreken / ongeldig).
// RBAC: 403 als noch admin.joost_config noch finance.joost.view granted is.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const MODULE_RX = /^[a-z0-9_-]{1,50}$/;

// Spec-conforme defaults voor E1.0 finance-module. Wordt 1-op-1 gespiegeld in
// docs/sql-migrations/2026-06-09-joost-e10-seed-completion.sql zodat get-defaults
// en seed nooit divergeren. Bij wijzigen: beide locaties bijwerken.
const DEFAULT_SYSTEM_PROMPT_TEMPLATE = [
  'Je bent Joost, een vriendelijke en oplossingsgerichte incasso-medewerker van {{company_name}}.',
  '',
  'Je doel: klanten helpen met openstaande facturen via vriendelijke, korte WhatsApp berichten.',
  '',
  'Regels:',
  '- Schrijf in het Nederlands, tutoyeer',
  '- Max 3-4 zinnen',
  '- Vriendelijk maar zakelijk',
  '- Bij betalingsbeloften: bevestig + bedank',
  '- Bij financiele problemen: vraag door zonder oplossing aan te bieden, escaleer naar mens',
  '- Bij verzoek om regeling: niet zelf onderhandelen, escaleer',
  '- Geen specifieke betaalmogelijkheden of bankgegevens noemen tenzij gevraagd',
  '',
  'Klant-context: {{customer_name}}, openstaand: EUR {{open_amount}} over {{open_invoice_count}} factuur of facturen.',
].join('\n');

function buildDefaultConfig(moduleKey) {
  return {
    module: moduleKey,
    persona_name: 'Joost',
    persona_tone: 'professioneel, vriendelijk, oplossingsgericht - Nederlands',
    system_prompt_template: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
    knowledge_base: { betaaltermijn_dagen: 14, max_termijnen: 6 },
    model: 'claude-sonnet-4-6',
    temperature: 0.3,
    context_message_count: 20,
    is_enabled: true,
    feature_flags: {},
    autonomy_config: {},
    updated_by_user_id: null,
    updated_at: null,
    is_default: true,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // ---- Auth ----
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Module-param valideren (BEFORE permission zodat we per module kunnen
  //      checken; default 'finance' houdt bestaande callers byte-identiek). ----
  const moduleRaw = (req.query?.module ?? 'finance').toString().trim();
  const moduleKey = moduleRaw || 'finance';
  if (!MODULE_RX.test(moduleKey)) {
    return res.status(400).json({ error: 'module: alleen lowercase a-z, 0-9, _ en - (max 50 chars)' });
  }

  // ---- Permission (module-conditioned, OR-fallback met short-circuit) ----
  // Voor module='events' (Simone): admin.simone_config (volledige toegang) of
  // events.simone.use (read-only paneel-gate). Voor andere modules: bestaande
  // finance/joost-gate, byte-identiek met pre-stap-2c.
  let adminPermKey, viewPermKey;
  if (moduleKey === 'events') {
    adminPermKey = 'admin.simone_config';
    viewPermKey  = 'events.simone.use';
  } else {
    adminPermKey = 'admin.joost_config';
    viewPermKey  = 'finance.joost.view';
  }
  const hasAdmin = await requirePermission(req, adminPermKey);
  const hasView  = hasAdmin ? true : await requirePermission(req, viewPermKey);
  if (!hasAdmin && !hasView) {
    return res.status(403).json({ error: 'Geen rechten (' + adminPermKey + ' of ' + viewPermKey + ')' });
  }

  // ---- Query ----
  try {
    const { data: row, error } = await supabaseAdmin
      .from('joost_config')
      .select(`
        module, persona_name, persona_tone, system_prompt_template,
        knowledge_base, model, temperature, context_message_count,
        is_enabled, feature_flags, autonomy_config,
        updated_by_user_id, updated_at
      `)
      .eq('module', moduleKey)
      .maybeSingle();

    if (error) {
      console.error('[joost-config-get] select error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    if (row) {
      // Bestaande rij: geef terug zoals opgeslagen. is_default expliciet false
      // zodat UI weet dat dit een gematerialiseerde rij is (en geen baseline).
      return res.status(200).json({ config: { ...row, is_default: false } });
    }
    // Geen rij: spec-defaults teruggeven zodat UI direct een werkbaar form
    // toont; eerste save (upsert INSERT-pad) materialiseert deze in DB.
    return res.status(200).json({ config: buildDefaultConfig(moduleKey) });
  } catch (e) {
    console.error('[joost-config-get] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
