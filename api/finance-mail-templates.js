// api/finance-mail-templates.js
// GET ?diag=1 → lijst TL mail-templates (voor de Verzenden-modal in finance).
// Permission: finance.invoice.send (hergebruikt, geen nieuwe key).
//
// TL endpoint: /mailTemplates.list. Probeert filter type='invoice' (apiary-key onbekend);
// als TL die niet accepteert → val terug op ongefilterd ophalen. ?diag=1 returnt de raw
// response zodat we het echte filter-veld zien (bv. document_type / kind / type).

import { createUserClient } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { requirePermission } from './_lib/requirePermission.js';

function isInvoiceTemplate(t) {
  // Defensief: meerdere mogelijke veldnamen waarop TL z'n type opslaat.
  const candidates = [t.type, t.document_type, t.kind, t.category, t.subject_type, t.entity_type];
  for (const c of candidates) {
    if (typeof c === 'string' && /invoice|factuur/i.test(c)) return true;
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.send'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.send)' });

  const diag = req.query?.diag === '1' || req.query?.diag === 'true';

  try {
    // Poging 1: filter type=invoice.
    let raw = null, used = null, list = [];
    const tryCall = async (body, label) => {
      const r = await tlFetch('/mailTemplates.list', { method: 'POST', body: JSON.stringify(body) });
      const text = await r.text().catch(() => '');
      let json = null; try { json = JSON.parse(text); } catch {}
      return { http: r.status, ok: r.ok, raw: text, parsed: json, label };
    };

    let attempt = await tryCall({ filter: { type: 'invoice' }, page: { size: 100, number: 1 } }, 'filter.type=invoice');
    used = attempt.label;
    if (attempt.ok && Array.isArray(attempt.parsed?.data)) {
      list = attempt.parsed.data;
    }
    raw = attempt;

    // Fallback: zonder filter, dan client-side filteren (heuristisch).
    if (!attempt.ok || !list.length) {
      const fb = await tryCall({ page: { size: 200, number: 1 } }, 'no-filter');
      used = fb.label;
      raw = fb;
      if (fb.ok && Array.isArray(fb.parsed?.data)) {
        // Client-side filter; als geen field matcht → geef volledige lijst (UI kan kiezen).
        const all = fb.parsed.data;
        const filtered = all.filter(isInvoiceTemplate);
        list = filtered.length ? filtered : all;
      }
    }

    if (!raw.ok) {
      console.error('[finance-mail-templates] mailTemplates.list HTTP', raw.http, raw.raw.slice(0, 400));
      return res.status(502).json({ error: `TL mailTemplates.list HTTP ${raw.http}`, tl_response: raw.raw });
    }

    const templates = list.map(t => ({
      id: t.id,
      name: t.name || t.title || '(zonder naam)',
      language: t.language || null,
      is_default: !!(t.is_default || t.default),
      // Diagnostisch: alle keys mee voor diag-mode zodat UI/onderzoeker het type-veld kan vinden.
      ...(diag ? { _keys: Object.keys(t), _sample: t } : {}),
    }));

    // Default sortering: is_default eerst, dan naam.
    templates.sort((a, b) => (b.is_default - a.is_default) || String(a.name).localeCompare(String(b.name)));

    return res.status(200).json({
      templates,
      filter_used: used,
      count: templates.length,
      ...(diag ? { diag: { used, http: raw.http, sample_keys: list[0] ? Object.keys(list[0]) : null, raw_sample: list[0] || null } } : {}),
    });
  } catch (e) {
    console.error('[finance-mail-templates]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
