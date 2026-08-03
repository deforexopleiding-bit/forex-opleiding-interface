// api/_lib/render-template-preview.js
//
// Pure helper: bouw een leesbare tekst-preview van een verstuurd Meta-template
// door de approved template-body op te halen uit whatsapp_meta_templates en de
// {{N}}-placeholders te vullen met de opgeslagen template_variables.
//
// GEBRUIKT DOOR (write-side inbox-preview + body):
//   * cron-dunning-conversation-reminders.js (r1-fallback + r2 body + last_message_preview)
//   * _lib/dunning-step-executors.js         (last_message_preview)
//   * inbox-send-template.js                 (last_message_preview)
//   * inbox-send.js                          (last_message_preview)
//   * joost-outbound-send.js                 (last_message_preview)
//
// GEEN wijziging aan de SEND-zelf (geen sendTemplate/sendText/sendEmail-calls
// vanuit deze module). Puur weergave-helper voor de inbox-thread + conv-lijst.
//
// FAIL-SAFE:
//   Elk pad dat faalt (DB-fout, template niet gevonden, geen variables) valt
//   graceful terug op het oude label '[template] <naam>'. Zo kan een helper-
//   crash NOOIT een send-flow blokkeren of blancop-berichten in de DB laten
//   landen. Bij totaal-onbekend (geen naam) → '[bericht]'.
//
// CACHE:
//   In-memory Map met TTL. Reason: dezelfde template wordt vaak N-keer op rij
//   opgehaald (bulk-send, reminder-cirkel). Cache invalidate is expliciet
//   (resetTemplatePreviewCache) — templates wisselen zelden en admin-updates
//   die de body-tekst raken zijn low-frequency.

// Lazy supabase-import — pure helpers testbaar zonder SUPABASE_URL.
// Zelfde patroon als conv-reminder-template.js en pending-actions-guard.js.

// Inline regex-escape zodat we geen extra util-import nodig hebben. Alleen
// digits in de key betekent dat regex-metacharacters strikt genomen niet
// vóórkomen (keys zijn "1"/"2"/…), maar we escapen defensief voor het geval
// een toekomstige feature niet-numerieke keys toestaat.
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuten
const _tplCache = new Map(); // name → { fetchedAt, body_text | null }

/**
 * Wis de template-cache. Gebruikt door tests + optioneel door admin-endpoints
 * die net een template hebben bijgewerkt en willen dat de volgende preview
 * de nieuwe body_text toont.
 */
export function resetTemplatePreviewCache() {
  _tplCache.clear();
}

/**
 * Vervang {{N}}-placeholders in `body` met waarden uit `vars` (jsonb-shape:
 * { "1": "waarde1", "2": "waarde2", ... }). Onbekende placeholders blijven
 * staan (matcht render-gedrag van andere helpers zoals dunning-template-render).
 *
 * Pure functie — geen DB, geen async. Losstaand testbaar.
 *
 * @param {string} body           template body-tekst met {{N}}-slots
 * @param {object} vars           { "1": "waarde", ... }
 * @returns {string}
 */
export function substituteNumericPlaceholders(body, vars) {
  if (!body || typeof body !== 'string') return '';
  if (!vars || typeof vars !== 'object') return body;
  let out = body;
  for (const key of Object.keys(vars)) {
    if (!/^\d+$/.test(key)) continue;
    const re = new RegExp('\\{\\{\\s*' + escapeRegExp(key) + '\\s*\\}\\}', 'g');
    out = out.replace(re, String(vars[key] == null ? '' : vars[key]));
  }
  return out;
}

/**
 * Fetch template body_text via supabase (cached). Returnt string of null.
 * Fail-safe: bij DB-fout returnt null zodat caller de fallback gebruikt.
 *
 * @param {string} templateName
 * @param {object} supabase       supabaseAdmin (verplicht — geen lazy default,
 *                                caller weet best welke client)
 * @returns {Promise<string|null>}
 */
async function fetchTemplateBody(templateName, supabase) {
  if (!templateName || typeof templateName !== 'string') return null;
  if (!supabase) return null;

  const now = Date.now();
  const cached = _tplCache.get(templateName);
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.body_text;
  }

  try {
    const { data, error } = await supabase
      .from('whatsapp_meta_templates')
      .select('name, status, body_text')
      .eq('name', templateName)
      .limit(5); // tolereert dubbelen; we pakken de eerste approved
    if (error) {
      console.warn('[render-template-preview] fetch fail:', error.message);
      return null;
    }
    const approved = (Array.isArray(data) ? data : [])
      .find((r) => String(r.status || '').toLowerCase() === 'approved');
    const body_text = approved?.body_text || null;
    _tplCache.set(templateName, { fetchedAt: now, body_text });
    return body_text;
  } catch (e) {
    console.warn('[render-template-preview] exception:', e?.message || e);
    return null;
  }
}

/**
 * Bouw een leesbare tekst-preview voor een template-send.
 *
 * @param {object} args
 * @param {string} args.templateName       Meta-template-naam (bv. 'joost_reminder_2_nl')
 * @param {object} args.templateVariables  { "1":..., "2":..., ... } uit whatsapp_messages
 * @param {object} args.supabase           supabaseAdmin (verplicht)
 *
 * @returns {Promise<{
 *   body:   string,                    // volledige gerenderde tekst OF fallback-label
 *   source: 'meta_template' | 'legacy_label' | 'no_template_name',
 * }>}
 */
export async function renderTemplatePreview({ templateName, templateVariables, supabase }) {
  const name = String(templateName || '').trim();
  if (!name) {
    return { body: '[bericht]', source: 'no_template_name' };
  }

  const bodyText = await fetchTemplateBody(name, supabase);
  if (!bodyText) {
    return { body: '[template] ' + name, source: 'legacy_label' };
  }

  // Substitutie werkt óók als templateVariables leeg/null is — dan blijven
  // {{N}}-slots letterlijk in de tekst staan (voorkeur boven crash of blank).
  const rendered = substituteNumericPlaceholders(
    bodyText,
    (templateVariables && typeof templateVariables === 'object') ? templateVariables : {},
  );
  return { body: rendered, source: 'meta_template' };
}
