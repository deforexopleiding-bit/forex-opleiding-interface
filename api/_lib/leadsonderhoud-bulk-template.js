// api/_lib/leadsonderhoud-bulk-template.js
//
// Shared template-resolver + live-mode-status voor de leadsonderhoud-bulk-
// flow. Hergebruikt de drip-motor-helpers (bouwVariabelen + keyWaarde) uit
// leadsonderhoud-sjabloon.js — één bron van waarheid voor placeholder-
// resolutie in drip én bulk (preview, test-send, cron).

import { supabaseAdmin } from '../supabase.js';
import { bouwVariabelen, keyWaarde } from './leadsonderhoud-sjabloon.js';

export function liveModeStatus() {
  const uit = ['1', 'true', 'aan', 'on', 'ja'].includes(String(process.env.LEADSONDERHOUD_UIT || '').trim().toLowerCase());
  const live = String(process.env.LEADSONDERHOUD_LIVE || '').trim() === '1';
  return { live: live && !uit, uit, checked_at: new Date().toISOString() };
}

// Analyzeer een template. Return { positions: [{ pos, key, isLead }] }.
// Bron 1: meta_param_mapping.body (autoritatief; matcht Meta's approved template).
// Bron 2: body_text-parser (fallback voor templates zonder mapping).
export function analyzeTemplate(templateName, metaMapping, bodyText) {
  const positions = [];
  const mapping = metaMapping && typeof metaMapping === 'object' ? (metaMapping.body || metaMapping) : null;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    const posKeys = Object.keys(mapping).filter(k => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    for (const p of posKeys) {
      const key = String(mapping[p] || '').trim();
      if (!key) continue;
      positions.push({ pos: Number(p), key, isLead: /^lead\./.test(key) });
    }
  } else if (bodyText) {
    const seen = new Map();
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g; let m;
    while ((m = re.exec(bodyText))) {
      const k = m[1].trim();
      if (!seen.has(k)) seen.set(k, seen.size + 1);
    }
    for (const [k, pos] of seen.entries()) {
      positions.push({ pos, key: k, isLead: /^lead\./.test(k) || (bouwVariabelen({}, {})[k] !== undefined) });
    }
  }
  return { positions };
}

// Bouw variables[] voor Meta sendTemplate voor ÉÉN specifieke lead.
// Positional in volgorde van meta_param_mapping.body-posities.
// - lead.X-tokens en drip-vars-tokens (voornaam/dag/tijd/...) → resolved via lead-row.
// - unknown tokens → static_vars-value (of leeg).
export function resolveVariables(positions, leadRow, staticVars) {
  const lead = leadRow || {};
  const vars = bouwVariabelen(lead, {});
  const out = [];
  for (const p of positions) {
    if (p.isLead || vars[p.key] != null) {
      out.push(keyWaarde(p.key, lead, vars));
    } else {
      out.push(String((staticVars && staticVars[p.key]) || ''));
    }
  }
  return out;
}

export function renderTemplateBody(bodyText, positions, values) {
  let s = String(bodyText || '');
  positions.forEach((p, i) => {
    const val = values[i] != null ? String(values[i]) : '';
    const key = p.key;
    const rePos = new RegExp('\\{\\{\\s*' + String(p.pos) + '\\s*\\}\\}', 'g');
    const reKey = new RegExp('\\{\\{\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\}\\}', 'g');
    s = s.replace(rePos, val).replace(reKey, val);
  });
  return s;
}

export async function fetchTemplateMeta(templateName) {
  if (!templateName) return null;
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('name, language, body_text, meta_param_mapping, status')
      .eq('name', templateName)
      .limit(5);
    const approved = (data || []).find(r => String(r.status || '').toLowerCase() === 'approved');
    return approved || (data || [])[0] || null;
  } catch (_) { return null; }
}
