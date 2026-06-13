// api/_lib/meta-template-components-builder.js
// Pure builder voor de `components`-array die Meta's WhatsApp Cloud API
// /messages-endpoint verwacht bij een type='template' send.
//
// Gebruik:
//   const { components, warnings } = buildSendComponents({
//     template       : <whatsapp_meta_templates row, incl. header_type, header_content,
//                       body_text, buttons, meta_param_mapping>,
//     bodyVariables  : { "1": "Jeffrey", "2": "EUR 80,00" }, // positionele keys
//     runtimeMedia   : { type: 'image'|'video'|'document', link: '<https-url>', filename? },
//     runtimeButtonParams: { "0": { "1": "https-tail" } }    // optioneel, index -> {paramIdx -> value}
//   });
//
// Output: { components, warnings }
//   components = Components[] geschikt voor sendTemplate. Lege array wanneer
//                er niks dynamisch is.
//   warnings   = string[] met diagnose voor ontbrekende runtime-media e.d.
//                (niet fataal; caller logt + besluit zelf).
//
// Verantwoordelijkheden:
//   - HEADER component bouwen WANNEER template.header_type ∈ {IMAGE,VIDEO,DOCUMENT}
//     EN runtimeMedia.link aanwezig is. Bij TEXT header zonder runtime-vars
//     is geen component nodig (header_text is statisch in approved template).
//     TODO Fase C: TEXT header met dynamische vars (header_text-parameters).
//   - BODY component bouwen wanneer er bodyVariables zijn.
//   - BUTTON componenten bouwen voor URL-buttons met url_params (per index).
//
// Pure function: geen DB-calls, geen HTTP-calls, geen side-effects. Caller
// haalt de template-row en vars zelf op (zoals inbox-send-template.js al
// doet) en geeft het door.

const MEDIA_TYPES = new Set(['image', 'video', 'document']);

/**
 * Bouwt 1 header-component voor een media-header.
 * @returns {object|null} - component of null als skip.
 */
function buildMediaHeaderComponent(template, runtimeMedia, warnings) {
  const ht = String(template?.header_type || 'NONE').toUpperCase();
  if (ht === 'NONE' || ht === 'TEXT') return null;

  const expectedKind = ht.toLowerCase(); // 'image' | 'video' | 'document'
  if (!MEDIA_TYPES.has(expectedKind)) {
    warnings.push(`unsupported header_type='${ht}'`);
    return null;
  }
  if (!runtimeMedia || typeof runtimeMedia !== 'object') {
    warnings.push(`template heeft ${ht}-header maar runtimeMedia ontbreekt`);
    return null;
  }
  const link = typeof runtimeMedia.link === 'string' ? runtimeMedia.link.trim() : '';
  if (!link) {
    warnings.push(`runtimeMedia.link ontbreekt voor ${ht}-header`);
    return null;
  }
  // Meta accepteert per type een nested object. Voor documenten is filename
  // optioneel maar gewenst (zonder zou WhatsApp 'file' tonen).
  const param = { type: expectedKind, [expectedKind]: { link } };
  if (expectedKind === 'document' && typeof runtimeMedia.filename === 'string' && runtimeMedia.filename.trim()) {
    param.document.filename = runtimeMedia.filename.trim();
  }
  return {
    type: 'header',
    parameters: [param],
  };
}

/**
 * Bouwt 1 body-component met text-parameters voor positionele {{1}}..{{N}}.
 */
function buildBodyComponent(bodyVariables) {
  const keys = Object.keys(bodyVariables || {})
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));
  if (keys.length === 0) return null;
  const parameters = keys.map((k) => ({
    type: 'text',
    text: String(bodyVariables[k] ?? ''),
  }));
  return { type: 'body', parameters };
}

/**
 * Bouwt 0..N button-componenten voor URL-buttons met url_params.
 * URL-buttons zonder placeholder, QUICK_REPLY-buttons en PHONE_NUMBER-buttons
 * hebben geen runtime-params nodig (volledig statisch in approved template).
 *
 * Meta verwacht:
 *   { type:'button', sub_type:'url', index:'<idx>', parameters:[{type:'text', text:'<val>'}] }
 */
function buildButtonComponents(template, runtimeButtonParams, bodyVariables, warnings) {
  const mapping = template?.meta_param_mapping;
  if (!mapping || typeof mapping !== 'object') return [];
  const btnMappings = Array.isArray(mapping.buttons) ? mapping.buttons : [];
  if (btnMappings.length === 0) return [];

  const out = [];
  for (const bm of btnMappings) {
    if (!bm || typeof bm !== 'object') continue;
    const idx = Number.isInteger(bm.index) ? bm.index : null;
    const urlParams = bm.url_params && typeof bm.url_params === 'object' ? bm.url_params : null;
    if (idx == null || !urlParams) continue;

    // Volgorde van keys = positionele param-volgorde voor deze button.
    const paramKeys = Object.keys(urlParams)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    if (paramKeys.length === 0) continue;

    // Runtime-override wint boven body-vars (caller kan per-button per-param
    // expliciete waarden meegeven); anders proberen we body-vars en anders
    // lege string (Meta zal dan submit-fout returneren).
    const runtimeForIdx = runtimeButtonParams && typeof runtimeButtonParams === 'object'
      ? runtimeButtonParams[String(idx)]
      : null;

    const parameters = paramKeys.map((k) => {
      let val = null;
      if (runtimeForIdx && typeof runtimeForIdx === 'object' && runtimeForIdx[k] != null) {
        val = String(runtimeForIdx[k]);
      } else if (bodyVariables && bodyVariables[k] != null) {
        val = String(bodyVariables[k]);
      } else {
        warnings.push(`button-${idx} param ${k} ontbreekt in runtimeButtonParams en bodyVariables`);
        val = '';
      }
      return { type: 'text', text: val };
    });
    out.push({
      type      : 'button',
      sub_type  : 'url',
      index     : String(idx),
      parameters,
    });
  }
  return out;
}

/**
 * Public API.
 *
 * Backward-compat invariant: een body-only template (NONE-header, geen
 * button-url-params) met body-variables produceert EXACT 1 body-component
 * met text-parameters - identiek aan de huidige inbox-send-template flow.
 * Body-only template zonder body-variables produceert []. Beide gevallen
 * worden gedekt door de smoke-doc.
 */
export function buildSendComponents({
  template,
  bodyVariables       = {},
  runtimeMedia        = null,
  runtimeButtonParams = null,
} = {}) {
  const warnings = [];
  const components = [];

  const header = buildMediaHeaderComponent(template, runtimeMedia, warnings);
  if (header) components.push(header);

  const body = buildBodyComponent(bodyVariables);
  if (body) components.push(body);

  const btnComps = buildButtonComponents(template, runtimeButtonParams, bodyVariables, warnings);
  for (const c of btnComps) components.push(c);

  return { components, warnings };
}

export const __internals = {
  buildMediaHeaderComponent,
  buildBodyComponent,
  buildButtonComponents,
  MEDIA_TYPES,
};
