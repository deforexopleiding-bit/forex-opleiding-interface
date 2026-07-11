// api/finance-invoice-credit.js
// POST → factuur (volledig) crediteren via TL invoices.credit. Permission: finance.invoice.credit.
// MINIMAL parameters → TL gebruikt zijn default-mapping (geen grootboek/BTW-overrides);
// Combidesk → e-boekhouden flow blijft identiek aan handmatig TL-knopwerk.
// TL-first + validate-first. Na succes: re-sync creditnota's voor deze factuur.
//
// Body: { invoice_id, description? }
//
// Sinds crediteerronde PR-2: TL-call + sync gebeurt in _lib/invoice-credit.js
// (helper `creditInvoiceCore`). Gedrag hier is IDENTIEK aan de originele
// standalone versie — deze handler doet nog steeds RBAC, request-parsing,
// audit-log en HTTP-status-mapping; de refactor gaat alleen om code-share
// met de nieuwe bulk-crediteerronde endpoints.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getClientIp } from './_lib/audit-customer.js';
import { requirePermission } from './_lib/requirePermission.js';
import { creditInvoiceCore } from './_lib/invoice-credit.js';

// Map creditInvoiceCore's typed-error code → HTTP-status voor deze handler.
// Behoudt de exact-zelfde codes die de oude versie teruggaf (400/404/409/422/502/500).
function mapCoreErrorToHttp(err) {
  switch (err?.code) {
    case 'NOT_FOUND'             : return { status: 404, body: { error: err.message } };
    case 'NO_TL_ID'              : return { status: 400, body: { error: err.message } };
    case 'CONCEPT_NOT_CREDITABLE': return { status: 409, body: { error: err.message } };
    case 'TL_NETWORK'            : return { status: 502, body: { error: err.message } };
    case 'TL_REFUSED'            : return {
      status: 422,
      body: { error: err.message, tl_status: err.tlStatus, tl_response: err.tlText },
    };
    default: return { status: 500, body: { error: err?.message || 'Interne fout' } };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.credit'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.credit)' });
  }

  const { invoice_id, description } = req.body || {};
  if (!invoice_id) return res.status(400).json({ error: 'invoice_id vereist' });

  try {
    const result = await creditInvoiceCore(invoice_id, { description, userId: user.id });
    // Audit — zelfde payload/reason als de originele versie.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id: user.id,
        action: 'invoice.credit',
        entity_type: 'invoice',
        entity_id: result.invoice.id,
        after_json: {
          tl_credit_note_id: result.tl_credit_note_id,
          description: result.description || null,
          synced: result.synced,
        },
        reason_text: `Factuur ${result.invoice.invoice_number} gecrediteerd (creditnota ${result.tl_credit_note_id || '?'})`,
        ip_address: getClientIp(req),
      });
    } catch (e) { console.error('[finance-invoice-credit] audit', e.message); }

    return res.status(200).json({
      success: true,
      invoice_id: result.invoice.id,
      tl_credit_note_id: result.tl_credit_note_id,
      synced: result.synced,
    });
  } catch (e) {
    console.error('[finance-invoice-credit]', e?.message || e);
    const mapped = mapCoreErrorToHttp(e);
    return res.status(mapped.status).json(mapped.body);
  }
}
