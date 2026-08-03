// api/_lib/conv-reminder-template.js
//
// Pure helper voor de reminder-cron: gegeven een template-naam + render-context,
// bouw het juiste Meta-payload (components + preview_body + used_variables) door
// de whatsapp_meta_templates-registratie te lezen en de bijbehorende
// meta_param_mapping.body toe te passen.
//
// WAAROM (Bug 2 uit GAT 5 — 3 aug 2026):
//   De cron stuurde tot deze fix ALTIJD 5 hardcoded positional params
//   [NAAM, FACTUUR_NR, TOTAAL_BEDRAG, DAGEN_OVERDUE, VERVAL_DATUM] naar
//   sendTemplate, ongeacht welke template op no_reply.reminder_2_template_name
//   staat ingesteld. Als de template in Meta minder placeholders heeft (bv.
//   joost_reminder_2_nl heeft er 4), returnt Meta 132000/132001 en faalt de
//   send stil. Bovendien: `TOTAAL_BEDRAG` bevat de EUR-prefix ("EUR 320,00"),
//   dus als de template "EUR {{3}}" gebruikt met bedoeling `factuur.bedrag`
//   (kaal), krijg je "EUR EUR 320,00" — zelfde dubbele-EUR-drift als de
//   dag7-ellende.
//
// FIX:
//   Hergebruik het patroon dat cron-dunning-bulk-send en inbox-send-template
//   al toepassen: fetch de template-row + mapping, bouw variables via
//   buildMetaVariablesFromMapping, bouw components via buildSendComponents.
//   Zo matcht het aantal params automatisch met het aantal placeholders én
//   worden de juiste variabele-waarden opgehaald (factuur.bedrag = kaal,
//   klant.voornaam = alleen voornaam, etc).
//
// FALLBACK (backward-compat):
//   Als de template niet gevonden wordt in whatsapp_meta_templates (bv. Meta-
//   only registratie die nooit in onze DB terechtkwam), OF als er geen
//   meta_param_mapping.body bestaat, terugvallen op het oude gedrag: 5
//   hardcoded positional params. Dat houdt bestaande templates werkend en
//   voorkomt regressie op deployments waar de mapping nog niet aanwezig is.

// NB: deze module importeert bewust GEEN supabase-client op module-load —
// dat zou tests forceren om SUPABASE_URL env-vars te zetten. In plaats
// daarvan levert de caller (cron) z'n eigen supabase-client via de
// `supabase` parameter. Tests injecteren een fake client.
import { buildMetaVariablesFromMapping } from './template-variables.js';
import { buildSendComponents } from './meta-template-components-builder.js';

const LEGACY_ORDERED_KEYS = ['NAAM', 'FACTUUR_NR', 'TOTAAL_BEDRAG', 'DAGEN_OVERDUE', 'VERVAL_DATUM'];

// Kleine in-memory cache per invocation zodat een tick met N gepauzeerde runs
// niet N × DB-fetch doet voor dezelfde template. Wordt bij elke fresh cron-
// invocation opnieuw opgebouwd (module-scope leeft zolang de Lambda leeft,
// maar is safe: template-mutations gaan via admin-flow + zetten status).
const _tplCache = new Map();

/**
 * Reset de cache. Gebruikt door tests + optioneel door de cron-handler bij
 * fresh boot als je paranoid wilt zijn. Niet strikt nodig — cache is per-warm-
 * lambda en templates wisselen zelden.
 */
export function resetReminderTemplateCache() {
  _tplCache.clear();
}

/**
 * Fetch template-registratie voor Meta-send. Returnt {template, warnings}.
 * template=null → geen mapping-pad mogelijk, caller moet fallback doen.
 *
 * @param {string} templateName
 * @param {object} opts
 * @param {object} opts.supabase   supabase-client (verplicht — cron levert
 *   supabaseAdmin, tests leveren een fake client).
 */
export async function fetchReminderTemplate(templateName, opts = {}) {
  if (!templateName || typeof templateName !== 'string') {
    return { template: null, warnings: ['no-template-name'] };
  }
  if (_tplCache.has(templateName)) {
    return { template: _tplCache.get(templateName), warnings: [] };
  }
  const supabase = opts.supabase;
  if (!supabase) {
    return { template: null, warnings: ['no-supabase-client'] };
  }
  const warnings = [];
  let template = null;
  try {
    // Zelfde select-shape als cron-dunning-bulk-send r206-211 voor consistency.
    const { data: tRows, error } = await supabase
      .from('whatsapp_meta_templates')
      .select('name, language, status, body_text, header_type, meta_param_mapping, buttons')
      .eq('name', templateName)
      .limit(5);
    if (error) {
      warnings.push('template-lookup: ' + error.message);
    } else {
      // Meta approval-status is text; case-insensitief matchen.
      template = (Array.isArray(tRows) ? tRows : [])
        .find((r) => String(r.status || '').toLowerCase() === 'approved') || null;
      if (!template && Array.isArray(tRows) && tRows.length > 0) {
        warnings.push(`template '${templateName}' gevonden maar niet approved`);
      }
    }
  } catch (e) {
    warnings.push('template-lookup exception: ' + (e?.message || String(e)));
  }
  _tplCache.set(templateName, template);
  return { template, warnings };
}

/**
 * Bouw een legacy 5-positional variables-array (backward-compat pad). Wordt
 * gebruikt als de template niet in whatsapp_meta_templates gevonden wordt.
 *
 * @param {object} variables  { NAAM, FACTUUR_NR, TOTAAL_BEDRAG, DAGEN_OVERDUE, VERVAL_DATUM }
 * @returns {string[]}         geordende array voor sendTemplate({variables})
 */
export function buildLegacyPositionalVariables(variables) {
  return LEGACY_ORDERED_KEYS.map((k) => String((variables && variables[k]) || ''));
}

/**
 * Bouw sendTemplate-payload voor een reminder. Twee paden:
 *   A) MAPPING (nieuw, preferred): template gevonden + meta_param_mapping.body
 *      aanwezig → bouw components via buildSendComponents. Aantal params matcht
 *      automatisch. Waarden komen uit resolveVariableValue op basis van de
 *      NAMED variabele-keys in de mapping (bv. 'klant.voornaam', 'factuur.bedrag').
 *   B) LEGACY (fallback): geen template-row of geen mapping → 5 hardcoded
 *      positional params zoals de cron altijd deed. Voor backward-compat.
 *
 * @param {object} args
 * @param {string} args.templateName
 * @param {object} args.ctx         { customer, openInvoices, invoice }
 *   context voor resolveVariableValue (invoice = oudste openstaande).
 * @param {object} args.legacyVars  { NAAM, FACTUUR_NR, TOTAAL_BEDRAG,
 *   DAGEN_OVERDUE, VERVAL_DATUM } — pre-berekende waarden uit
 *   computeVariables, gebruikt als fallback.
 * @param {object} [args.supabase]  injectie voor tests
 *
 * @returns {Promise<{
 *   mode: 'mapping'|'legacy',
 *   components: object[]|null,      // voor sendTemplate({components}) — mapping-mode
 *   variables:  string[]|null,      // voor sendTemplate({variables})  — legacy-mode
 *   templateLanguage: string,       // 'nl' default
 *   usedVariables: object,          // { '1': 'Ingrid', '2': '2024-0512', ... } voor persist
 *   warnings: string[],
 * }>}
 */
export async function buildReminderTemplatePayload({ templateName, ctx, legacyVars, supabase }) {
  const warnings = [];

  const { template, warnings: fetchWarnings } = await fetchReminderTemplate(templateName, { supabase });
  warnings.push(...fetchWarnings);

  const bodyMapping = template?.meta_param_mapping?.body;
  const hasUsableMapping = template
    && bodyMapping
    && typeof bodyMapping === 'object'
    && Object.keys(bodyMapping).length > 0;

  if (hasUsableMapping) {
    // MAPPING PAD (voorkeur — matcht altijd wat de template verwacht).
    const bodyVariables = buildMetaVariablesFromMapping(bodyMapping, ctx);
    const { components, warnings: buildWarnings } = buildSendComponents({
      template,
      bodyVariables,
    });
    warnings.push(...(buildWarnings || []));
    return {
      mode:             'mapping',
      components:       components.length ? components : null,
      variables:        null,
      templateLanguage: template.language || 'nl',
      usedVariables:    bodyVariables,
      warnings,
    };
  }

  // LEGACY PAD (backward-compat).
  warnings.push(
    template
      ? `template '${templateName}' heeft geen meta_param_mapping.body — legacy 5-positional fallback`
      : `template '${templateName}' niet gevonden in whatsapp_meta_templates — legacy 5-positional fallback`
  );
  const positional = buildLegacyPositionalVariables(legacyVars);
  // usedVariables in legacy-mode = { '1': v1, '2': v2, ... } zodat persist
  // in whatsapp_messages.template_variables consistent shape houdt.
  const usedVariables = Object.fromEntries(
    positional.map((v, i) => [String(i + 1), String(v)])
  );
  return {
    mode:             'legacy',
    components:       null,
    variables:        positional,
    templateLanguage: template?.language || 'nl',
    usedVariables,
    warnings,
  };
}
