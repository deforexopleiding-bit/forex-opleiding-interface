// api/inbox-conversation-context.js
// GET → context-bundel voor het Inbox klant-paneel (3e kolom in de nieuwe redesign).
// Permission: finance.inbox.view (zelfde gate als inbox-messages-list / conversations-list).
//
// In 1 round-trip levert dit endpoint:
//   - conversation: id, phone_number, last_inbound_at, window_open (24h-bool)
//   - customer:      gekoppelde klant (NULL als conversation.customer_id leeg is
//                    EN er geen exact-1 phone-match in customers gevonden wordt)
//   - open_invoices: max 25 openstaande facturen, op due_date oplopend
//                    (open + partially_paid, NIET volledig gecrediteerd)
//   - totals:        open_amount + invoice_count voor het paneel-totaal
//
// Query params:
//   conversation_id  uuid (required)
//
// Response (altijd 200 — zelfs zonder klant — zodat de UI een placeholder kan tonen):
//   {
//     conversation: { id, phone_number, last_inbound_at, window_open },
//     customer: { id, name, email, phone, created_at, is_company } | null,
//     open_invoices: [{ id, invoice_number, total_amount, amount_open,
//                       due_date, days_overdue, is_overdue, status,
//                       tl_invoice_id }],
//     totals: { open_amount, invoice_count }
//   }
//
// Error responses:
//   400  conversation_id ontbreekt of geen geldige uuid
//   401  geen sessie
//   403  geen permission
//   404  conversation niet gevonden
//   500  database-fout (eerste fout teruggegeven, gelogged met console.error)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OPEN_INVOICES = 25;

// Strip alles behalve cijfers — geen '+' bewaren. Klant-telefoonnummers worden
// soms met en soms zonder '+' opgeslagen ('+31655270212' vs '31655270212'),
// dus we vergelijken puur op digits om die mismatch op te lossen.
function normalizePhone(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

// Best-effort phone-match. Match-strategie (in volgorde):
//   1) exact digits-match → koppel als precies 1 hit
//   2) fallback laatste 9 digits (lokale variant zonder country-code)
//      → koppel als precies 1 hit
// Over-fetch is acceptabel voor < 5k klanten (gelijk aan inbox-webhook.js patroon).
async function findCustomerIdByPhone(phone) {
  const target = normalizePhone(phone);
  if (!target) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, phone')
      .not('phone', 'is', null)
      .is('archived_at', null)
      .is('anonymized_at', null);
    if (error) {
      console.error('[inbox-conversation-context] phone-fetch fail:', error.message);
      return null;
    }
    const rows = (data || []).map(c => ({ id: c.id, digits: normalizePhone(c.phone) }))
                              .filter(r => r.digits);
    const exact = rows.filter(r => r.digits === target);
    if (exact.length === 1) return exact[0].id;
    // Fallback: laatste 9 digits (lokale variant zonder landcode).
    if (target.length >= 9) {
      const tail = target.slice(-9);
      const tailMatches = rows.filter(r => r.digits.slice(-9) === tail);
      if (tailMatches.length === 1) return tailMatches[0].id;
    }
    return null;
  } catch (e) {
    console.error('[inbox-conversation-context] phone-match exception:', e && e.message);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth-gate — zelfde permission als de andere read-side inbox-endpoints.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.view)' });
  }

  const q = req.query || {};
  const convId = String(q.conversation_id || '').trim();
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  }

  try {
    // 1) Conversation ophalen. 404 als 'ie niet bestaat zodat UI helder kan reageren.
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, customer_id, last_inbound_at')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // 24h customer-service window — server-side bepaald zodat client geen
    // klok-skew problemen heeft. Spiegelt inbox-messages-list.js + inbox-send.js.
    const nowMs = Date.now();
    let windowOpen = false;
    if (conv.last_inbound_at) {
      const t = new Date(conv.last_inbound_at).getTime();
      if (Number.isFinite(t) && (nowMs - t) <= TWENTY_FOUR_HOURS_MS) windowOpen = true;
    }

    // 2) Klant-resolutie. Eerst direct via conv.customer_id (set door webhook
    //    op inbound-time). Als dat NULL is: probeer 1x exact-phone-match.
    let customerId = conv.customer_id || null;
    if (!customerId && conv.phone_number) {
      customerId = await findCustomerIdByPhone(conv.phone_number);
    }

    let customerOut = null;
    if (customerId) {
      const { data: cust, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, company_name, first_name, last_name, email, phone, created_at')
        .eq('id', customerId)
        .maybeSingle();
      if (custErr) {
        console.error('[inbox-conversation-context] customer lookup:', custErr.message);
        // Soft-fail — geef conversation nog steeds terug, customer wordt null.
      } else if (cust) {
        customerOut = {
          id: cust.id,
          name: customerDisplayName(cust, '') || null,
          email: cust.email || null,
          phone: cust.phone || null,
          created_at: cust.created_at || null,
          is_company: !!cust.is_company,
        };
      }
    }

    // 3) Openstaande facturen. Alleen ophalen als we daadwerkelijk een klant
    //    hebben — anders is de lijst per definitie leeg en sparen we een query.
    const openInvoices = [];
    let totalOpen = 0;
    if (customerOut) {
      const { data: rows, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select(
          'id, invoice_number, amount_total, amount_paid, credited_amount, ' +
          'due_date, issue_date, status, tl_invoice_id'
        )
        .eq('customer_id', customerOut.id)
        .in('status', ['open', 'partially_paid'])
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(MAX_OPEN_INVOICES);
      if (invErr) {
        console.error('[inbox-conversation-context] invoices lookup:', invErr.message);
        // Soft-fail — UI toont dan een lege facturen-strip.
      } else {
        for (const inv of rows || []) {
          const total = Number(inv.amount_total) || 0;
          const paid = Number(inv.amount_paid) || 0;
          const credited = Number(inv.credited_amount) || 0;
          const fullyCredited = credited > 0 && total > 0 && credited >= total;
          if (fullyCredited) continue; // sluit ge-crediteerde facturen uit
          const amountOpen = Math.max(0, total - paid);
          if (amountOpen <= 0) continue; // niets meer openstaand
          // days_overdue: hele dagen tussen due_date en vandaag (lokale dagen
          // volstaan — facturen-datums zijn date-only, geen tijdcomponent).
          let daysOverdue = 0;
          if (inv.due_date) {
            const due = new Date(inv.due_date + 'T00:00:00').getTime();
            if (Number.isFinite(due) && due < nowMs) {
              daysOverdue = Math.floor((nowMs - due) / ONE_DAY_MS);
            }
          }
          openInvoices.push({
            id: inv.id,
            invoice_number: inv.invoice_number || null,
            total_amount: total,
            amount_open: Math.round(amountOpen * 100) / 100,
            due_date: inv.due_date || null,
            days_overdue: daysOverdue,
            is_overdue: daysOverdue > 0,
            status: inv.status,
            tl_invoice_id: inv.tl_invoice_id || null,
          });
          totalOpen += amountOpen;
        }
      }
    }

    return res.status(200).json({
      conversation: {
        id: conv.id,
        phone_number: conv.phone_number || null,
        last_inbound_at: conv.last_inbound_at || null,
        window_open: windowOpen,
      },
      customer: customerOut,
      open_invoices: openInvoices,
      totals: {
        open_amount: Math.round(totalOpen * 100) / 100,
        invoice_count: openInvoices.length,
      },
    });
  } catch (e) {
    console.error('[inbox-conversation-context]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
