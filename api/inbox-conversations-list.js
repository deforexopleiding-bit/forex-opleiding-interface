// api/inbox-conversations-list.js
// GET → lijst whatsapp_conversations met klant-koppeling en 24h-window flag.
//
// Module-scoping (Fase 1 events-inbox + B1 onboarding-inbox):
// parameter ?module=finance|events|onboarding.
//   - Default 'finance' (backward-compat: bestaande callers blijven exact
//     hetzelfde gedrag krijgen — query, pnId-lookup en permissie ongewijzigd).
//   - module='events':     gefilterd op events-phone_number_id uit
//                          whatsapp_module_config (Fase 1).
//   - module='onboarding': idem onboarding-phone_number_id (B1).
//
// Permission per module (parallelle takken):
//   module='finance'    -> finance.inbox.view (zoals voor)
//   module='events'     -> events.inbox.view  (Fase 1)
//   module='onboarding' -> onboarding.inbox.view (B1)
//
// Andere modules worden geweigerd (400) zodat we niet per ongeluk een
// nieuwe agent introduceren zonder permission-key te registreren.
//
// Query params:
//   module  text   'finance' | 'events' (default 'finance')
//   limit   integer (default 50, clamp 1..100)
//   offset  integer (default 0)
//   search  text — filtert phone_number / display_name (ILIKE)
//
// Response: { items: [{ id, phone_number, display_name, customer_id, customer_name,
//                       status, last_message_at, last_message_preview, unread_count,
//                       last_inbound_at, can_send_text }], total, configured, module }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
// NOTE: Fase 2b mentor-scoping op de onboarding-tak is bewust uitgezet:
// per ontwerp is de onboarding-inbox gedeeld voor iedereen met
// onboarding.inbox.view (alle mentoren zien elkaars studenten-convs).
// getOnboardingScope / getMentorCustomerIds zijn daarom niet meer nodig
// in dit endpoint. De permission-gate (regel ~40) blijft staan.

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

const MODULE_PERMISSIONS = {
  finance   : 'finance.inbox.view',
  events    : 'events.inbox.view',
  onboarding: 'onboarding.inbox.view',
};

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

  const q = req.query || {};
  // Module-resolve: default 'finance' voor backward-compat met bestaande
  // finance-callers die geen ?module meegeven.
  const moduleRaw = typeof q.module === 'string' && q.module.trim()
    ? q.module.trim().toLowerCase()
    : 'finance';
  const permKey = MODULE_PERMISSIONS[moduleRaw];
  if (!permKey) {
    return res.status(400).json({
      error: `module='${moduleRaw}' niet ondersteund; verwacht ${Object.keys(MODULE_PERMISSIONS).join('|')}`,
    });
  }
  if (!(await requirePermission(req, permKey))) {
    return res.status(403).json({ error: `Geen rechten (${permKey})` });
  }

  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 100) limit = 100;
  let offset = parseInt(q.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const search = String(q.search || '').trim();
  // status_filter: 'active' (default) = alleen 'open'. 'afgehandeld' = alleen
  // 'closed' (definitief-tijdelijk, komt terug bij inbound). 'archief' =
  // alleen 'archived' (definitief; NIET auto-heropenen — bewuste splitsing
  // sinds Jeffrey's onderscheid). 'all' = geen filter.
  const statusFilterRaw = String(q.status_filter || 'active').trim().toLowerCase();
  const statusFilter = ['active', 'afgehandeld', 'archief', 'all'].includes(statusFilterRaw) ? statusFilterRaw : 'active';

  try {
    // Module-config: welk phone_number_id hoort bij de gevraagde module?
    // Identiek pattern aan de oude finance-only lookup, alleen .eq('module', ...)
    // is nu parameter ipv hardcoded.
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', moduleRaw)
      .eq('is_active', true)
      .maybeSingle();
    if (modErr) {
      console.error('[inbox-conversations-list] module-config lookup:', modErr.message);
      // Fail-soft: behandel als niet-geconfigureerd i.p.v. 500.
    }
    const modulePnId = modCfg?.phone_number_id || null;
    if (!modulePnId) {
      // Geen actieve config voor deze module — return leeg, UI toont config-banner.
      return res.status(200).json({
        items: [],
        total: 0,
        configured: false,
        module: moduleRaw,
        warning: `Geen actieve ${moduleRaw}-config in whatsapp_module_config — vraag een admin om in te stellen.`,
      });
    }

    // Onboarding-inbox is GEDEELD: iedereen met onboarding.inbox.view ziet
    // alle onboarding-convs. De eerdere Fase 2b per-mentor-filter
    // (getMentorCustomerIds) is bewust uitgezet — alle mentoren werken in
    // één gedeeld postvak en kunnen elkaars studenten-gesprekken zien.
    // Finance- en events-takken zijn ongewijzigd: die houden hun eigen
    // module-permissie (finance.inbox.view / events.inbox.view) als gate.

    let query = supabaseAdmin
      .from('whatsapp_conversations')
      .select(
        'id, phone_number, display_name, customer_id, attendee_id, status, last_message_at, ' +
        'last_message_preview, unread_count, last_inbound_at, ' +
        'customer:customers(id, first_name, last_name, company_name, is_company), ' +
        'attendee:event_attendees!attendee_id(id, first_name, last_name, email, ' +
          'event:event_id(id, title, starts_at))',
        { count: 'exact' }
      )
      .eq('phone_number_id', modulePnId)
      // Simone-sandbox dummy-convs uitfilteren (cleanup-safety-net).
      .not('phone_number', 'ilike', '+99999%')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    // Status-filter server-side. Splitsing 'afgehandeld' (closed, komt terug
    // bij inbound) vs 'archief' (archived, komt NIET terug bij inbound).
    if      (statusFilter === 'active')      query = query.eq('status', 'open');
    else if (statusFilter === 'afgehandeld') query = query.eq('status', 'closed');
    else if (statusFilter === 'archief')     query = query.eq('status', 'archived');
    // 'all' → geen extra status-clause.

    if (search) {
      const like = '%' + search.replace(/[%_]/g, m => '\\' + m) + '%';
      // PostgREST OR-filter: phone_number / display_name + gekoppelde klantnaam.
      // Voor klantnaam-match doen we een 2-step lookup: eerst customer_ids ophalen
      // die matchen op first_name/last_name/company_name, dan die inzetten via
      // customer_id.in.(...) als extra OR-clause. Zelfde patroon als
      // finance-invoices.js:126-135. Reden: PostgREST kan .or() niet direct over
      // een embedded relation doen, en display_name blijft op veel outbound-
      // initiated conversations NULL (WhatsApp-profiel pas na klant-reply gezet).
      const orParts = [
        `phone_number.ilike.${like}`,
        `display_name.ilike.${like}`,
      ];
      if (search.length >= 2) {
        try {
          const { data: matchCust, error: mcErr } = await supabaseAdmin
            .from('customers')
            .select('id')
            .or(`first_name.ilike.${like},last_name.ilike.${like},company_name.ilike.${like}`)
            .limit(500);
          if (mcErr) {
            console.error('[inbox-conversations-list] customer-search lookup:', mcErr.message);
          } else if (matchCust && matchCust.length > 0) {
            const custIds = matchCust.map(c => c.id).filter(Boolean);
            if (custIds.length > 0) {
              orParts.push(`customer_id.in.(${custIds.join(',')})`);
            }
          }
        } catch (e) {
          // Fail-soft: als de klant-lookup faalt, zoek dan enkel op phone/display_name.
          console.error('[inbox-conversations-list] customer-search fail:', e?.message || e);
        }
      }
      query = query.or(orParts.join(','));
    }

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);

    // ── Wanbetaler-verrijking (gebatcht, geen N+1) ──────────────────────
    // 1 query op invoices voor alle unieke customer_ids in de lijst; client-
    // side aggregeren. Cents-precisie (round-half-up bij toCents).
    const openInvoicesByCustomer = new Map(); // customer_id → { count, cents }
    try {
      const custIds = Array.from(new Set(
        (data || []).map((r) => r.customer_id).filter(Boolean)
      ));
      if (custIds.length > 0) {
        const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
        const { data: invRows, error: iErr } = await supabaseAdmin
          .from('invoices')
          .select('customer_id, amount_total, amount_paid, credited_amount, status')
          .in('customer_id', custIds)
          .in('status', OPEN_STATUSES);
        if (iErr) {
          console.error('[inbox-conversations-list] invoices batch:', iErr.message);
        } else {
          for (const inv of invRows || []) {
            const total = Number(inv.amount_total)    || 0;
            const paid  = Number(inv.amount_paid)     || 0;
            const cred  = Number(inv.credited_amount) || 0;
            const openEur = Math.max(0, total - paid - cred);
            if (openEur <= 0) continue;
            const agg = openInvoicesByCustomer.get(inv.customer_id) || { count: 0, cents: 0 };
            agg.count += 1;
            agg.cents += Math.round(openEur * 100);
            openInvoicesByCustomer.set(inv.customer_id, agg);
          }
        }
      }
    } catch (e) {
      // Fail-soft: als de invoices-lookup faalt, verrijken we niet — de
      // inbox-lijst zelf mag niet omvallen.
      console.error('[inbox-conversations-list] wanbetaler-agg fail:', e?.message || e);
    }

    const now = Date.now();
    const items = (data || []).map(row => {
      const cust = row.customer || null;
      let customerName = null;
      if (cust) {
        const parts = [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim();
        // Bedrijven: bedrijfsnaam als primair label; contactpersoon als fallback.
        // Particulieren: eerst voor+achternaam, company_name alleen als leeg.
        customerName = cust.is_company
          ? (cust.company_name || parts || null)
          : (parts || cust.company_name || null);
      }
      const att = row.attendee || null;
      let attendeeName = null;
      let attendeeEventTitle = null;
      let attendeeEventStartsAt = null;
      if (att) {
        const parts = [att.first_name, att.last_name].filter(Boolean).join(' ').trim();
        attendeeName = parts || att.email || null;
        attendeeEventTitle    = att.event?.title     || null;
        attendeeEventStartsAt = att.event?.starts_at || null;
      }
      let canSendText = false;
      if (row.last_inbound_at) {
        const t = new Date(row.last_inbound_at).getTime();
        if (Number.isFinite(t) && (now - t) <= TWENTY_FOUR_HOURS_MS) canSendText = true;
      }
      const agg = row.customer_id ? openInvoicesByCustomer.get(row.customer_id) : null;
      return {
        id: row.id,
        phone_number: row.phone_number,
        display_name: row.display_name,
        customer_id: row.customer_id,
        customer_name: customerName,
        attendee_id: row.attendee_id,
        attendee_name: attendeeName,
        attendee_event_title: attendeeEventTitle,
        attendee_event_starts_at: attendeeEventStartsAt,
        status: row.status,
        last_message_at: row.last_message_at,
        last_message_preview: row.last_message_preview,
        unread_count: row.unread_count || 0,
        last_inbound_at: row.last_inbound_at,
        can_send_text: canSendText,
        // Wanbetaler-info (F1). is_debtor is true zodra er >0 open facturen
        // zijn voor de gekoppelde klant. Ongekoppelde conv: 0 / false.
        open_invoice_count: agg ? agg.count : 0,
        total_open_cents  : agg ? agg.cents : 0,
        is_debtor         : !!(agg && agg.count > 0),
      };
    });

    return res.status(200).json({
      items,
      total: count || items.length,
      configured: true,
      module: moduleRaw,
    });
  } catch (e) {
    console.error('[inbox-conversations-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
