// api/dunning-briefs-list.js
// GET → lijst van dunning_briefs voor 1 klant (of 1 brief via ?brief_id=).
// Met signed download-URL per rij zodat de UI direct kan linken naar de
// bewaarde PDF (juridisch bewijs).
//
// FASE 6 — WIK-brief scope 2.
//
// Query:  ?customer_id=<uuid>  OR  ?brief_id=<uuid>
// Permission: finance.dunning.view (lezen genoeg).
//
// Response 200:
//   {
//     items: [{
//       id, customer_id, invoice_id, template_code, country,
//       generated_at, generated_by_user_id,
//       sent_via, sent_at, sent_to_email, sent_by_user_id, send_error,
//       pdf_size_bytes,
//       download_url, download_url_expires_at,      // signed URL (1 uur)
//       filename                                     // suggested display-name
//     }],
//     count
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'dunning-briefs';
const SIGNED_URL_TTL_SECONDS = 3600; // 1 uur

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const q = req.query || {};
  const customerId = q.customer_id ? String(q.customer_id).trim() : '';
  const briefId    = q.brief_id    ? String(q.brief_id).trim()    : '';
  if (!customerId && !briefId) {
    return res.status(400).json({ error: 'customer_id of brief_id (uuid) vereist' });
  }
  if (customerId && !UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id geen uuid' });
  if (briefId    && !UUID_RE.test(briefId))    return res.status(400).json({ error: 'brief_id geen uuid' });

  try {
    let query = supabaseAdmin
      .from('dunning_briefs')
      .select('id, customer_id, invoice_id, template_code, country, pdf_path, pdf_size_bytes, generated_at, generated_by_user_id, sent_via, sent_at, sent_to_email, sent_by_user_id, send_error')
      .order('generated_at', { ascending: false });
    if (briefId)    query = query.eq('id', briefId);
    if (customerId) query = query.eq('customer_id', customerId);
    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);

    // Signed download-URLs bulk-genereren (elke rij heeft eigen URL, TTL 1u).
    // Fail-soft per rij: als één URL faalt, andere blijven werken.
    const items = [];
    for (const r of (rows || [])) {
      let downloadUrl = null;
      try {
        const { data: signed, error: sErr } = await supabaseAdmin.storage
          .from(BUCKET)
          .createSignedUrl(r.pdf_path, SIGNED_URL_TTL_SECONDS);
        if (!sErr && signed?.signedUrl) downloadUrl = signed.signedUrl;
        else console.warn('[dunning-briefs-list] signed URL failed for', r.pdf_path, sErr?.message);
      } catch (e) { console.warn('[dunning-briefs-list] signed URL exception:', e?.message); }

      const filename = `WIK-brief_${r.country}_${(r.customer_id || '').slice(0, 8)}_${(r.generated_at || '').slice(0, 10)}.pdf`;
      items.push({
        id: r.id,
        customer_id: r.customer_id,
        invoice_id: r.invoice_id,
        template_code: r.template_code,
        country: r.country,
        generated_at: r.generated_at,
        generated_by_user_id: r.generated_by_user_id,
        sent_via: r.sent_via,
        sent_at: r.sent_at,
        sent_to_email: r.sent_to_email,
        sent_by_user_id: r.sent_by_user_id,
        send_error: r.send_error,
        pdf_size_bytes: r.pdf_size_bytes,
        download_url: downloadUrl,
        download_url_expires_at: downloadUrl ? new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString() : null,
        filename,
      });
    }

    return res.status(200).json({ items, count: items.length });
  } catch (e) {
    console.error('[dunning-briefs-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
