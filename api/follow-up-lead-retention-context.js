// api/follow-up-lead-retention-context.js
//
// GET ?customer_id=<uuid> → { abo_description, abo_end_date, traject_label }
//
// Voor retentie-leads in de Sales-cockpit: haalt het LAATSTE abonnement
// (active + cancelled) van de klant op en de traject-naam via de gekoppelde
// deal. Bedoeld voor het lead-context-paneel. Fail-soft: kolommen die
// ontbreken worden overgeslagen; leeg antwoord i.p.v. 500.
//
// Permissie: sales.tab.retentie OF sales.customer.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const customerId = String(req.query?.customer_id || '').trim();
  if (!UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  }

  try {
    // 1) Deals van de klant (non-archived).
    let dealRows = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('deals')
        .select('id, traject_variant_id, archived_at')
        .eq('customer_id', customerId)
        .is('archived_at', null);
      if (error) {
        if (error.code === '42P01' || error.code === '42703') {
          return res.status(200).json({ abo_description: null, abo_end_date: null, traject_label: null });
        }
        throw error;
      }
      dealRows = data || [];
    } catch (e) {
      console.warn('[lead-retention-context] deals:', e?.message || e);
    }
    if (!dealRows.length) {
      return res.status(200).json({ abo_description: null, abo_end_date: null, traject_label: null });
    }

    const dealIds = dealRows.map((d) => d.id).filter(Boolean);
    const variantIds = [...new Set(dealRows.map((d) => d.traject_variant_id).filter(Boolean))];

    // 2) Meest recente sub (active/cancelled) op deze deal-set.
    let latestSub = null;
    try {
      const { data, error } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, description, end_date, status')
        .in('deal_id', dealIds)
        .in('status', ['active', 'cancelled'])
        .order('end_date', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error && error.code !== '42P01' && error.code !== '42703') {
        console.warn('[lead-retention-context] subs:', error.message);
      } else {
        latestSub = data || null;
      }
    } catch (e) {
      console.warn('[lead-retention-context] subs fatal:', e?.message || e);
    }

    // 3) Traject-label: traject_variants → trajects.
    let trajectLabel = null;
    if (variantIds.length) {
      try {
        const { data: vs } = await supabaseAdmin
          .from('traject_variants')
          .select('id, name, traject_id')
          .in('id', variantIds);
        const tIds = [...new Set((vs || []).map((v) => v.traject_id).filter(Boolean))];
        const tName = {};
        if (tIds.length) {
          const { data: ts } = await supabaseAdmin
            .from('trajects').select('id, name').in('id', tIds);
          for (const t of (ts || [])) tName[t.id] = t.name;
        }
        // Kies label bij deal die hoort bij de latestSub — anders eerste variant.
        let preferredVariantId = null;
        if (latestSub?.deal_id) {
          const d = dealRows.find((x) => x.id === latestSub.deal_id);
          if (d?.traject_variant_id) preferredVariantId = d.traject_variant_id;
        }
        if (!preferredVariantId) preferredVariantId = variantIds[0];
        const v = (vs || []).find((x) => x.id === preferredVariantId);
        if (v) {
          trajectLabel = [tName[v.traject_id], v.name].filter(Boolean).join(' > ') || null;
        }
      } catch (e) {
        console.warn('[lead-retention-context] trajects:', e?.message || e);
      }
    }

    return res.status(200).json({
      abo_description : latestSub?.description || null,
      abo_end_date    : latestSub?.end_date    || null,
      abo_status      : latestSub?.status      || null,
      traject_label   : trajectLabel,
    });
  } catch (e) {
    console.error('[lead-retention-context] fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
