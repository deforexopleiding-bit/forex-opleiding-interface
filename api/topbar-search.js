// api/topbar-search.js
// GET → mixed customers + invoices zoek voor de shell-topbar (#appTopbarSearch).
//
// STRIKTE RBAC-scoping (kernvereiste van deze endpoint):
//   - ADMIN_ROLES (super_admin / admin / manager) via verifyAdmin()  → volledige scope.
//   - MENTOR      (isMentorOnly → seesOwn && !seesAll)              → alleen customers waar
//                                                                     onboardings.mentor_user_id = user.id
//                                                                     (via getMentorCustomerIds) + facturen VAN die klanten.
//   - Alle andere rollen                                             → 403.
//   Mentor kan NOOIT een niet-eigen klant of hun facturen zien via dit endpoint —
//   scope-filter wordt in de query zelf afgedwongen, niet client-side.
//
// Query params:
//   q       string  — zoekterm (min 2 chars, anders 200 met lege items).
//   limit   int     — totaal max results, clamp 1..10 (default 10).
//
// Response 200:
//   { items: [{ type: 'customer'|'invoice', id, label, sublabel, deeplink }] }
//   Volgorde: eerst tot 5 customers, daarna tot 5 invoices; gecombineerde limit.
//
// Errors: 401 (geen sessie), 403 (geen scope), 500 (db-fout).
//
// Hergebruikt patronen uit:
//   - api/customers.js (multi-word ILIKE op first/last/company/email/phone)
//   - api/finance-invoices.js (invoice_number ILIKE + customer-id fallback)
//   - api/inbox-customer-search.js (isMentorOnly-guard).
// GEEN supabaseAdmin zonder RBAC-check bovenaan.

import { createUserClient, supabaseAdmin, verifyAdmin } from './supabase.js';
import { getMentorCustomerIds, isMentorOnly } from './_lib/onboardingScope.js';
import { customerDisplayName } from './_lib/customer-name.js';

const CUSTOMER_LIMIT = 5;
const INVOICE_LIMIT  = 5;

function escLike(s) {
  // PostgREST ILIKE-escapen: %, _, en \ moeten backslash-prefixed.
  return String(s).replace(/[%_\\]/g, '\\$&');
}

function formatEur(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth: user moet bestaan.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Query params.
  const q = String(req.query.q || '').trim();
  const rawLimit = parseInt(req.query.limit, 10) || 10;
  const limit = Math.min(10, Math.max(1, rawLimit));
  if (q.length < 2) {
    return res.status(200).json({ items: [] });
  }

  // Scope-bepaling:
  //   - Admin (ADMIN_ROLES via verifyAdmin) → null (geen filter).
  //   - Mentor (isMentorOnly) → array van customer_ids (kan leeg zijn → 0 results).
  //   - Anders → 403.
  const admin = await verifyAdmin(req);
  let scopeCustomerIds = null;
  if (!admin) {
    const mentorOnly = await isMentorOnly(req);
    if (!mentorOnly) {
      return res.status(403).json({ error: 'Geen zoek-permissie' });
    }
    scopeCustomerIds = await getMentorCustomerIds(user.id);
    if (scopeCustomerIds.length === 0) {
      // Mentor zonder gekoppelde students → altijd 0 results (fail-closed).
      return res.status(200).json({ items: [] });
    }
  }

  try {
    // ── Customer-search ────────────────────────────────────────────────────
    // Multi-word ILIKE: elk woord moet ergens in eerst/last/company/email/phone
    // matchen (AND-tussen-woorden via chained .or()). Actief-only.
    const words = q.split(/\s+/).filter(Boolean);
    let custQ = supabaseAdmin
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone')
      .is('archived_at', null)
      .is('anonymized_at', null);
    if (scopeCustomerIds) custQ = custQ.in('id', scopeCustomerIds);
    for (const w of words) {
      const like = '%' + escLike(w) + '%';
      custQ = custQ.or(
        `first_name.ilike.${like},last_name.ilike.${like},company_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`
      );
    }
    custQ = custQ.limit(CUSTOMER_LIMIT);
    const { data: custRows, error: custErr } = await custQ;
    if (custErr) throw new Error('customer-search: ' + custErr.message);

    // ── Invoice-search ─────────────────────────────────────────────────────
    // Admin: invoice_number ILIKE OF customer_id ∈ matched customers.
    // Mentor: hard scope op mentor-customer-ids, plus invoice_number ILIKE
    //         (klant-match voor mentor is impliciet: alle facturen uit de
    //         scope tellen als kandidaten voor invoice_number-match).
    const matchedCustIds = (custRows || []).map((c) => c.id);
    let invQ = supabaseAdmin
      .from('invoices')
      .select(
        'id, customer_id, invoice_number, amount_total, status, ' +
        'customer:customers(is_company, company_name, first_name, last_name)'
      );
    if (scopeCustomerIds) {
      // Mentor: STRIKTE scope-filter op scope-customer-ids (facturen van
      // niet-eigen klanten kunnen NOOIT terugkomen — al zou q toevallig
      // op een niet-scope factuur-nummer matchen).
      invQ = invQ.in('customer_id', scopeCustomerIds);
      invQ = invQ.ilike('invoice_number', '%' + escLike(q) + '%');
    } else {
      // Admin: OR-clause tussen invoice_number en customer_id-set van
      // matched customers uit de vorige query.
      const like = '%' + escLike(q) + '%';
      const orTerms = [`invoice_number.ilike.${like}`];
      if (matchedCustIds.length > 0) {
        orTerms.push(`customer_id.in.(${matchedCustIds.join(',')})`);
      }
      invQ = invQ.or(orTerms.join(','));
    }
    invQ = invQ.limit(INVOICE_LIMIT);
    const { data: invRows, error: invErr } = await invQ;
    if (invErr) throw new Error('invoice-search: ' + invErr.message);

    // ── Build unified response ─────────────────────────────────────────────
    // Volgorde: customers eerst, dan invoices. Beide gecapt op eigen limit
    // (5+5), totaal cap via `limit` (client-side ook nogmaals).
    const items = [];
    for (const c of (custRows || [])) {
      items.push({
        type:     'customer',
        id:       c.id,
        label:    customerDisplayName(c, '(zonder naam)'),
        sublabel: c.email || c.phone || '',
        deeplink: '/modules/klanten.html?id=' + encodeURIComponent(c.id),
      });
    }
    for (const inv of (invRows || [])) {
      const custName = inv.customer ? customerDisplayName(inv.customer, '—') : '—';
      items.push({
        type:     'invoice',
        id:       inv.id,
        label:    inv.invoice_number || ('#' + String(inv.id).slice(0, 6)),
        sublabel: custName + ' · € ' + formatEur(inv.amount_total),
        deeplink: '/modules/finance.html?tab=facturen&invoice_id=' + encodeURIComponent(inv.id),
      });
    }
    return res.status(200).json({ items: items.slice(0, limit) });
  } catch (e) {
    console.error('[topbar-search]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
