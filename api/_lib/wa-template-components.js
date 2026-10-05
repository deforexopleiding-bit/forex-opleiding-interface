// api/_lib/wa-template-components.js
//
// Bouwt het components-array voor een WhatsApp-template (Cloud-API-formaat:
// HEADER / BODY / FOOTER / BUTTONS, met example-waarden voor {{N}}) uit een
// whatsapp_meta_templates-rij. Named placeholders ({{klant.naam}}) worden
// omgezet naar positioneel ({{1}}, {{2}} …) — exact de omzetting waarmee de
// CRM later de variabelen invult (meta_param_mapping).
//
// Puur (geen DB, geen netwerk). Gedeeld door:
//   - api/admin-meta-templates-submit.js  (indienen bij Meta)
//   - scripts/360-templates-upload.mjs    (indienen bij 360dialog)

import {
  buildPositionalMapping,
  getExampleForKey,
  VARIABLE_REGEX,
} from './template-variables.js';

/**
 * Parse {{N}} placeholders uit text. Returnt gesorteerde array van unieke
 * indices als integers, bv. "Hallo {{1}}, je factuur {{2}}" → [1, 2].
 */
export function extractBodyVarIndices(text) {
  if (typeof text !== 'string') return [];
  const rx = /\{\{(\d+)\}\}/g;
  const seen = new Set();
  let m;
  while ((m = rx.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return Array.from(seen).sort((a, b) => a - b);
}

/**
 * Detecteert of een tekst named placeholders bevat ({{categorie.veld}}).
 * Pure regex-check, geen side-effects.
 */
function hasNamedPlaceholders(text) {
  if (!text || typeof text !== 'string') return false;
  const re = new RegExp(VARIABLE_REGEX.source, 'g');
  return re.test(text);
}

/**
 * Bouw example-array voor een named-mapping in volgorde van positie-keys.
 * mapping = { '1': 'klant.naam', '2': 'factuur.bedrag_open' }
 * → [getExampleForKey('klant.naam'), getExampleForKey('factuur.bedrag_open')]
 */
function buildNamedExampleArray(mapping) {
  const positions = Object.keys(mapping)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  return positions.map((p) => {
    const key = mapping[p];
    const ex = getExampleForKey(key);
    return (typeof ex === 'string' && ex.trim()) ? ex : 'voorbeeld';
  });
}

/**
 * Bouw het components-array dat Meta verwacht in /message_templates POST,
 * PLUS de meta_param_mapping die we zullen bewaren voor send-time resolve.
 *
 * Backward-compat:
 *   - Tekst zonder named placeholders → geen conversion, mapping = null voor
 *     dat onderdeel (legacy positioneel gedrag exact behouden).
 *   - Tekst met named placeholders → convert naar {{N}} + bouw mapping.
 *
 * Returnt { components, meta_param_mapping (object of null) }.
 */
export function buildComponents(tpl) {
  const components = [];
  const paramMapping = {};

  // ---- HEADER ----
  if (tpl.header_type && tpl.header_type !== 'NONE') {
    const hc = tpl.header_content || {};
    if (tpl.header_type === 'TEXT') {
      const rawHeaderText = hc.text || '';
      const headerHasNamed = hasNamedPlaceholders(rawHeaderText);

      if (headerHasNamed) {
        // Named → positional conversion.
        const { converted_text, mapping } = buildPositionalMapping(rawHeaderText);
        const header = { type: 'HEADER', format: 'TEXT', text: converted_text };
        const exampleArr = buildNamedExampleArray(mapping);
        if (exampleArr.length > 0) {
          header.example = { header_text: exampleArr };
        }
        paramMapping.header_text = mapping;
        components.push(header);
      } else {
        // Legacy positioneel: oude flow ongewijzigd.
        const header = { type: 'HEADER', format: 'TEXT', text: rawHeaderText };
        const headerVars = extractBodyVarIndices(rawHeaderText);
        if (headerVars.length > 0) {
          const exampleArr = headerVars.map((n) => {
            const ex = hc.example && hc.example[String(n)];
            return (typeof ex === 'string' && ex.trim()) ? ex : 'voorbeeld';
          });
          header.example = { header_text: exampleArr };
        }
        components.push(header);
      }
    } else {
      // IMAGE / VIDEO / DOCUMENT — Meta vereist example.header_handle: [<url>].
      const url = (hc.example_url && String(hc.example_url).trim()) || '';
      const header = { type: 'HEADER', format: tpl.header_type };
      if (url) header.example = { header_handle: [url] };
      components.push(header);
    }
  }

  // ---- BODY ----
  const rawBodyText = tpl.body_text || '';
  const bodyHasNamed = hasNamedPlaceholders(rawBodyText);

  if (bodyHasNamed) {
    // Named → positional conversion.
    const { converted_text, mapping } = buildPositionalMapping(rawBodyText);
    const bodyComp = { type: 'BODY', text: converted_text };
    const exampleArr = buildNamedExampleArray(mapping);
    if (exampleArr.length > 0) {
      bodyComp.example = { body_text: [exampleArr] };
    }
    paramMapping.body = mapping;
    components.push(bodyComp);
  } else {
    // Legacy positioneel: oude flow ongewijzigd.
    const bodyComp = { type: 'BODY', text: rawBodyText };
    const bodyVars = extractBodyVarIndices(rawBodyText);
    if (bodyVars.length > 0) {
      const examplesObj = (tpl.body_examples && typeof tpl.body_examples === 'object') ? tpl.body_examples : {};
      const exampleArr = bodyVars.map((n) => {
        const ex = examplesObj[String(n)];
        return (typeof ex === 'string' && ex.trim()) ? ex : 'voorbeeld';
      });
      bodyComp.example = { body_text: [exampleArr] };
    }
    components.push(bodyComp);
  }

  // ---- FOOTER ----
  if (tpl.footer_text && String(tpl.footer_text).trim()) {
    components.push({ type: 'FOOTER', text: String(tpl.footer_text).trim() });
  }

  // ---- BUTTONS ----
  if (Array.isArray(tpl.buttons) && tpl.buttons.length > 0) {
    const buttonMappings = [];
    const mapped = tpl.buttons.map((b, idx) => {
      if (!b || typeof b !== 'object') return null;
      if (b.type === 'URL') {
        const rawUrl = b.url || '';
        if (hasNamedPlaceholders(rawUrl)) {
          const { converted_text, mapping } = buildPositionalMapping(rawUrl);
          buttonMappings.push({ index: idx, url_params: mapping });
          // Meta vereist een example.url als de URL placeholders bevat.
          const exampleArr = buildNamedExampleArray(mapping);
          const out = { type: 'URL', text: b.text, url: converted_text };
          if (exampleArr.length > 0) {
            out.example = exampleArr;
          }
          return out;
        }
        return { type: 'URL', text: b.text, url: rawUrl };
      }
      if (b.type === 'PHONE_NUMBER') {
        return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
      }
      if (b.type === 'QUICK_REPLY') {
        return { type: 'QUICK_REPLY', text: b.text };
      }
      return null;
    }).filter(Boolean);
    if (mapped.length > 0) {
      components.push({ type: 'BUTTONS', buttons: mapped });
    }
    if (buttonMappings.length > 0) {
      paramMapping.buttons = buttonMappings;
    }
  }

  // Bewaar mapping alleen als er minimaal één onderdeel named-vars had.
  const meta_param_mapping = Object.keys(paramMapping).length > 0 ? paramMapping : null;
  return { components, meta_param_mapping };
}
