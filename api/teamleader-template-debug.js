// api/teamleader-template-debug.js
// GET ?id=<template_id> → ruwe TL mailTemplate-shape uit list + info.
//
// Diagnose-endpoint zodat we kunnen zien waar TL de subject/body van een
// mailTemplate exposeert. teamleader-mail-substitution.js verwacht nu
// tpl.content.subject / tpl.content.body, maar getekende mails komen kaal
// aan → veldpaden matchen waarschijnlijk niet. Dit endpoint geeft ons de
// ruwe structuur zodat we het correcte pad kunnen kiezen.
//
// Auth: alleen super_admin / admin (manager expliciet geweigerd, ondanks
// bredere ADMIN_ROLES). Token/secret komen niet in response of console.
// Fail-soft: TL-fout → 200 met partial data + error-veld.
//
// Puur diagnose — géén writes. Bedoeld om éénmalig te consulteren en
// daarna te verwijderen zodra de content-paden bekend zijn.

import { tlFetch, getActiveToken, refreshIfNeeded } from './_lib/teamleader-token.js';
import { verifyAdmin } from './supabase.js';

const DEFAULT_TEMPLATE_ID = 'b603e6de-c3a9-0e69-a46c-6a00b827b3aa';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!['super_admin', 'admin'].includes(admin.profile?.role)) {
    return res.status(403).json({ error: 'Geen rechten (super_admin/admin vereist)' });
  }

  const templateId = String(req.query?.id || DEFAULT_TEMPLATE_ID);
  const tok = await getActiveToken();
  if (!tok) return res.status(200).json({ error: 'no_token', template_id: templateId });

  const out = {
    template_id: templateId,
    list_item:   null,
    info_item:   null,
    keys:        { list_top: null, content_keys: null, info_top: null },
    errors:      { list: null, info: null },
  };

  try { await refreshIfNeeded(); } catch (e) { /* niet-fataal */ }

  // 1) mailTemplates.list — vereist filter.type ('quotation' bij offertes).
  try {
    const r = await tlFetch('/mailTemplates.list', {
      method: 'POST',
      body:   JSON.stringify({ filter: { type: 'quotation' } }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      out.errors.list = `HTTP ${r.status}: ${body.slice(0, 300)}`;
    } else {
      const data = await r.json();
      const items = Array.isArray(data?.data) ? data.data : [];
      out.list_item = items.find(x => String(x?.id) === templateId) || null;
      if (out.list_item) {
        out.keys.list_top     = Object.keys(out.list_item || {});
        out.keys.content_keys = out.list_item?.content ? Object.keys(out.list_item.content) : null;
      }
    }
  } catch (e) {
    out.errors.list = 'exception: ' + e.message;
  }

  // 2) mailTemplates.info — bestaat mogelijk niet in TL v2. 404/400 → melden.
  try {
    const r = await tlFetch('/mailTemplates.info', {
      method: 'POST',
      body:   JSON.stringify({ id: templateId }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      out.errors.info = r.status === 404
        ? 'geen info-endpoint (404)'
        : `HTTP ${r.status}: ${body.slice(0, 300)}`;
    } else {
      const data = await r.json();
      out.info_item      = data?.data || data || null;
      out.keys.info_top  = out.info_item ? Object.keys(out.info_item) : null;
    }
  } catch (e) {
    out.errors.info = 'exception: ' + e.message;
  }

  return res.status(200).json(out);
}
