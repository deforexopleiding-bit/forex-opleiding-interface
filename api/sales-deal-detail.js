// api/sales-deal-detail.js
// GET ?id=<deal_id> → deal + customer + line_items + traject-info.
// Permission: sales.deal.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { syncDealStatusFromTl } from './_lib/teamleader-deal-sync.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.view)' });
  }

  const id = req.query?.id;
  if (!id) return res.status(400).json({ error: 'id vereist' });

  try {
    let { data: deal } = await supabaseAdmin.from('deals').select('*').eq('id', id).maybeSingle();
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });

    // Live TL-status pull bij openen — onafhankelijk van de webhook. Fail-soft.
    // Zet quotation-velden op 'accepted' als TL de deal als 'won' bevestigt en
    // wij nog niet 'accepted' zijn. Idempotent + veilig (raakt geen invoices/
    // subscriptions/payments; geen TL-write). Bij .changed her-lezen we de
    // deal-rij zodat de response de VERSE status bevat.
    if (deal.tl_deal_id) {
      try {
        const syncRes = await syncDealStatusFromTl(deal);
        if (syncRes.changed) {
          const { data: refreshed } = await supabaseAdmin.from('deals').select('*').eq('id', id).maybeSingle();
          if (refreshed) deal = refreshed;
        }
      } catch (e) {
        console.warn('[sales-deal-detail] TL sync (soft):', e?.message || e);
      }
    }

    const { data: customer } = await supabaseAdmin.from('customers')
      .select('id, is_company, company_name, kvk_number, vat_number, first_name, last_name, email, phone, address_street, address_number, address_postal, address_city, address_country, onboarding_status, onboarding_sent_at, onboarding_completed_at')
      .eq('id', deal.customer_id).maybeSingle();
    const { data: lineItems } = await supabaseAdmin.from('deal_line_items')
      .select('*').eq('deal_id', id).order('position', { ascending: true });

    let traject = null;
    if (deal.traject_variant_id) {
      const { data: variant } = await supabaseAdmin.from('traject_variants')
        .select('id, name, traject_id, default_duration_months').eq('id', deal.traject_variant_id).maybeSingle();
      if (variant) {
        const { data: t } = await supabaseAdmin.from('trajects').select('name').eq('id', variant.traject_id).maybeSingle();
        traject = { variant_id: variant.id, variant_name: variant.name, traject_name: t?.name || null,
                    label: [t?.name, variant.name].filter(Boolean).join(' > ') };
      }
    }

    let entity = null;
    if (deal.tl_department_id) {
      const { data: ent } = await supabaseAdmin.from('company_entities')
        .select('label').eq('tl_department_id', deal.tl_department_id).maybeSingle();
      entity = ent?.label || null;
    }

    // Totalen (mix-safe per regel) + deal-niveau korting + type verkoop.
    const factor = 1 - (Number(deal.discount_percentage) || 0) / 100;
    const zeroVat = deal.sale_type && deal.sale_type !== 'domestic';
    let excl = 0, incl = 0;
    for (const l of lineItems || []) {
      const rate = zeroVat ? 0 : Number(l.vat_percentage) / 100;
      const base = Number(l.quantity) * Number(l.unit_price);
      const lineExcl = (l.price_includes_vat ? base / (1 + rate) : base) * factor;
      const lineIncl = lineExcl * (1 + rate);
      excl += lineExcl; incl += lineIncl;
    }

    // Heeft-abbo-marker voor de "Omzetten naar abonnement"-knop: toont
    // "Abbo al ingevoerd" wanneer:
    //   (a) er al ≥1 sub bestaat voor deze deal (klassieke deal-match), OF
    //   (b) er al ≥1 sub bestaat voor een andere deal van dezelfde klant
    //       (klant-match) — dekt TL-imports (source='tl_import') en
    //       standalone-subs die aan een ghost-deal hangen, OF
    //   (c) de deal handmatig is afgevinkt via het
    //       subscription_marked_done-vlaggetje (migratie 035). Dit is
    //       de "achterstand-afvink"-route voor geaccepteerde offertes
    //       waarvan het abo buiten de omzet-knop om is binnengekomen.
    // Knop blijft klikbaar (bewust opnieuw omzetten mogelijk).
    let has_subscription = false;
    try {
      const { data: subsDeal } = await supabaseAdmin.from('subscriptions')
        .select('id').eq('deal_id', id).limit(1);
      const dealMatch = Array.isArray(subsDeal) && subsDeal.length > 0;

      let custMatch = false;
      if (!dealMatch && deal.customer_id) {
        // 2-staps klant-match — subscriptions heeft geen customer_id.
        try {
          const { data: custDeals } = await supabaseAdmin.from('deals')
            .select('id').eq('customer_id', deal.customer_id);
          const dealIds = Array.isArray(custDeals) ? custDeals.map((d) => d.id).filter(Boolean) : [];
          if (dealIds.length > 0) {
            const { data: subsCust } = await supabaseAdmin.from('subscriptions')
              .select('id').in('deal_id', dealIds).limit(1);
            custMatch = Array.isArray(subsCust) && subsCust.length > 0;
          }
        } catch (eCust) {
          // Fail-soft: klant-match faalt → val terug op deal-match.
          console.warn('[sales-deal-detail] klant-match sub-lookup faalde:', eCust?.message || eCust);
        }
      }

      const markedDone = deal.subscription_marked_done === true;
      has_subscription = dealMatch || custMatch || markedDone;
    } catch (eSub) {
      console.warn('[sales-deal-detail] deal-match sub-lookup faalde:', eSub?.message || eSub);
      // Zelfs bij sub-lookup-fout blijft het handmatige vlaggetje leidend.
      has_subscription = (deal.subscription_marked_done === true);
    }

    return res.status(200).json({
      deal, customer, line_items: lineItems || [], traject, entity,
      discount_percentage: Number(deal.discount_percentage) || 0,
      totals: { excl: Math.round(excl * 100) / 100, incl: Math.round(incl * 100) / 100 },
      has_subscription,
    });
  } catch (e) {
    console.error('[sales-deal-detail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
