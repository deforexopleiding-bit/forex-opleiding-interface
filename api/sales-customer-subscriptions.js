// api/sales-customer-subscriptions.js
// GET ?customer_id=X → subscriptions van een klant (via diens deals).
// Geeft ook terug of er een 'accepted' offerte zonder subs is (→ knop Wizard 2).
// Permission: sales.customer.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.customer.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.customer.view)' });
  }

  const customerId = req.query?.customer_id;
  if (!customerId) return res.status(400).json({ error: 'customer_id vereist' });

  try {
    // Bypass-audit-kolommen mee-fetchen (nullable) zodat de klantpagina een
    // banner kan tonen wanneer bij een van de deals de €100-reserveringsfee
    // is omzeild. Als een deal geen bypass had blijven de velden NULL.
    const { data: deals } = await supabaseAdmin.from('deals')
      .select('id, tl_quotation_status, reservation_fee_bypassed_by, reservation_fee_bypassed_at, reservation_fee_bypass_reason')
      .eq('customer_id', customerId).is('archived_at', null);
    const dealIds = (deals || []).map(d => d.id);
    let subscriptions = [];
    const dealsWithSubs = new Set();
    if (dealIds.length) {
      const { data: subs } = await supabaseAdmin.from('subscriptions')
        .select('id, deal_id, description, amount, vat_percentage, term_count, start_date, end_date, teamleader_subscription_id, status, line_items, postponed_months, original_start_date')
        .in('deal_id', dealIds).order('start_date', { ascending: true });
      subscriptions = subs || [];
      for (const s of subscriptions) dealsWithSubs.add(s.deal_id);

      // Per sub: heeft-al-facturen-vlag zodat de UI de "Aanpassen"-knop kan
      // gate-en. Waterdichte definitie: alleen als teamleader_subscription_id
      // NOT NULL EN >=1 invoice-rij bestaat met tl_subscription_id gelijk aan
      // die TL-id (identiek aan de check in sales-subscription-update.js).
      // Zonder TL-koppeling is er sowieso geen factuur (TL genereert ze, wij
      // spiegelen ze read-only via cron-finance-sync).
      const tlSubIds = subscriptions.map((s) => s.teamleader_subscription_id).filter(Boolean);
      const hasInvoiceByTlId = new Map();
      if (tlSubIds.length) {
        try {
          const { data: invRows, error: invErr } = await supabaseAdmin
            .from('invoices')
            .select('tl_subscription_id')
            .in('tl_subscription_id', tlSubIds);
          if (invErr) throw new Error(invErr.message);
          for (const r of invRows || []) {
            if (r?.tl_subscription_id) hasInvoiceByTlId.set(r.tl_subscription_id, true);
          }
        } catch (e) {
          console.warn('[customer-subs] invoice-lookup fail-open:', e.message);
          // Fail-secure zou "alle subs → gefactureerd markeren" zijn (edit
          // blokkeren). Fail-open zou "alles editeerbaar" zijn (risico op
          // corrupte edit). We kiezen FAIL-SECURE: server-side endpoint
          // controleert nog een keer bij daadwerkelijke edit-poging, dus
          // een verkeerde UI-flag hier is niet catastrofaal — maar toch
          // voorzichtig: bij DB-fout markeren we alle TL-gekoppelde subs
          // als "gefactureerd" (edit-knop verborgen).
          for (const id of tlSubIds) hasInvoiceByTlId.set(id, true);
        }
      }
      subscriptions = subscriptions.map((s) => ({
        ...s,
        has_any_invoice: !!(s.teamleader_subscription_id && hasInvoiceByTlId.get(s.teamleader_subscription_id)),
      }));
    }
    // Getekende offerte zonder subs → Wizard 2 mogelijk.
    const acceptedWithoutSubs = (deals || []).find(d => d.tl_quotation_status === 'accepted' && !dealsWithSubs.has(d.id));

    // Verzamel bypass-events (alleen deals waar bypass daadwerkelijk is
    // toegepast). Voeg naam van de gebruiker toe via profiles-lookup.
    const bypassRows = (deals || []).filter(d => d.reservation_fee_bypassed_by);
    let bypassEvents = [];
    if (bypassRows.length) {
      const userIds = Array.from(new Set(bypassRows.map(d => d.reservation_fee_bypassed_by)));
      const { data: profs } = await supabaseAdmin.from('profiles')
        .select('id, full_name, email').in('id', userIds);
      const nameById = new Map((profs || []).map(p => [p.id, p.full_name || p.email || 'onbekend']));
      bypassEvents = bypassRows.map(d => ({
        deal_id:    d.id,
        by_user_id: d.reservation_fee_bypassed_by,
        by_name:    nameById.get(d.reservation_fee_bypassed_by) || 'onbekend',
        at:         d.reservation_fee_bypassed_at,
        reason:     d.reservation_fee_bypass_reason,
      }));
    }

    return res.status(200).json({
      subscriptions,
      pending_deal_id: acceptedWithoutSubs ? acceptedWithoutSubs.id : null,
      bypass_events:   bypassEvents,
    });
  } catch (e) {
    console.error('[sales-customer-subscriptions]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
