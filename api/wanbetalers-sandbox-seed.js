// api/wanbetalers-sandbox-seed.js
// POST { name, phone, email, invoice_count?, amount_per_invoice_eur?, days_overdue? }
//   Maakt óf ververst 1 is_test-customer (naam prefixed met "🧪 TEST — "),
//   N is_test-invoices met vervaldatum backdated, en een pipeline-rij in 'nieuw'.
//   Slaat phone/email ook op in app_settings.dunning_sandbox_contact (recipient-guard).
// Idempotent: als er al een is_test-customer bestaat → wordt ge-update i.p.v.
// een 2e persoon gemaakt (de sandbox-flow werkt met 1 test-persoon per omgeving).
// Super_admin only.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer, setSandboxContact, sandboxDisplayName } from './_lib/wanbetalers-sandbox.js';
import { invalidateDryRunCache } from './_lib/dunning-dry-run.js';

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const phone   = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email   = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const invoiceCount   = Math.max(1, Math.min(10, Number(body.invoice_count) || 2));
  const amountEur      = Math.max(1, Math.min(10_000, Number(body.amount_per_invoice_eur) || 250));
  const daysOverdue    = Math.max(1, Math.min(365, Number(body.days_overdue) || 30));
  // #806 — optioneel maandbedrag abo INCL BTW. null/0/negatief → geen abo
  // aanmaken. De #788-ondergrens-check ziet dan hasSubscription=false en
  // Joost escaleert bij regeling-vragen. Dat is een geldig test-pad.
  const monthlyRaw = Number(body.monthly_amount_eur);
  const monthlyAmountEur = (Number.isFinite(monthlyRaw) && monthlyRaw > 0)
    ? Math.min(10_000, monthlyRaw) : null;

  if (!rawName || !phone || !email) {
    return res.status(400).json({ error: 'name, phone en email zijn verplicht' });
  }

  try {
    // 1) Customer upsert. Als er al een is_test-persoon is, update die.
    const displayName = sandboxDisplayName(rawName);
    let customer = await getSandboxCustomer();
    if (customer) {
      const { data: upd, error: uErr } = await supabaseAdmin
        .from('customers')
        .update({
          first_name: displayName,
          last_name : '',
          email,
          phone,
          is_company: false,
        })
        .eq('id', customer.id)
        .select('id, first_name, last_name, email, phone, is_test')
        .single();
      if (uErr) throw new Error('customer update: ' + uErr.message);
      customer = upd;
    } else {
      const { data: ins, error: iErr } = await supabaseAdmin
        .from('customers')
        .insert({
          first_name: displayName,
          last_name : '',
          email,
          phone,
          is_company: false,
          is_test   : true,
        })
        .select('id, first_name, last_name, email, phone, is_test')
        .single();
      if (iErr) throw new Error('customer insert: ' + iErr.message);
      customer = ins;
    }

    // 2) Verwijder oude test-invoices van deze klant (idempotent refresh).
    const { error: delErr } = await supabaseAdmin
      .from('invoices').delete().eq('customer_id', customer.id).eq('is_test', true);
    if (delErr) console.warn('[sandbox-seed] oude test-invoices delete soft-fail:', delErr.message);

    // 3) Maak N nieuwe invoices, allemaal 'open', vervaldatum backdated.
    const nowIso = new Date().toISOString().slice(0, 10);
    const dueIso = isoDaysAgo(daysOverdue);
    const invRows = Array.from({ length: invoiceCount }).map((_, i) => ({
      customer_id  : customer.id,
      amount_total : amountEur,
      amount_paid  : 0,
      status       : 'open',
      due_date     : dueIso,
      issue_date   : isoDaysAgo(daysOverdue + 14),
      invoice_number: 'TEST-' + Date.now().toString(36) + '-' + (i + 1),
      is_test      : true,
    }));
    const { data: newInvs, error: invErr } = await supabaseAdmin
      .from('invoices').insert(invRows).select('id, invoice_number, amount_total, due_date, status');
    if (invErr) throw new Error('invoices insert: ' + invErr.message);

    // 4) Pipeline-rij (of reset) → 'nieuw'.
    const { data: existingPipe } = await supabaseAdmin
      .from('dunning_pipeline_customers').select('id').eq('customer_id', customer.id).maybeSingle();
    const stagePayload = {
      customer_id     : customer.id,
      stage_slug      : 'nieuw',
      stage_changed_at: new Date().toISOString(),
      stage_changed_by: 'sandbox:seed',
      last_activity_at: new Date().toISOString(),
    };
    if (existingPipe) {
      await supabaseAdmin.from('dunning_pipeline_customers').update(stagePayload).eq('id', existingPipe.id);
    } else {
      await supabaseAdmin.from('dunning_pipeline_customers').insert(stagePayload);
    }

    // 5) Sandbox-contact opslaan voor de recipient-guard.
    const contact = await setSandboxContact({ phone, email });
    invalidateDryRunCache();

    // 6) Test-abonnement voor de crediteerronde-sandbox (PR-4). Idempotent:
    //    er bestaat max één test-sub per test-klant, geïdentificeerd op
    //    description='TEST-abonnement'. Als de kolom is_test bestaat wordt
    //    die op true gezet; anders valt de scope terug op customer_id + de
    //    unieke description. Geen teamleader_subscription_id → nooit een
    //    TL-mutatie via sandbox-flows.
    let subscription = null;
    try {
      const today = new Date();
      const startDate = new Date(today);
      startDate.setMonth(startDate.getMonth() - 6);
      const endDate = new Date(today);
      endDate.setMonth(endDate.getMonth() + 12);
      const iso = (d) => d.toISOString().slice(0, 10);
      const subPayload = {
        customer_id             : customer.id,
        description             : 'TEST-abonnement',
        amount                  : 300,
        term_count              : 24,
        start_date              : iso(startDate),
        end_date                : iso(endDate),
        status                  : 'actief',
        teamleader_subscription_id: null,
        postponed_months        : 0,
        original_start_date     : null,
        original_end_date       : null,
      };
      // Bestaand test-sub zoeken (op customer_id + description).
      const { data: existingSub } = await supabaseAdmin
        .from('subscriptions').select('id')
        .eq('customer_id', customer.id).eq('description', 'TEST-abonnement')
        .maybeSingle();
      if (existingSub) {
        // Refresh — reset counters zodat een re-seed altijd dezelfde
        // start-state oplevert.
        const { data: upd, error: uSubErr } = await supabaseAdmin
          .from('subscriptions').update(subPayload).eq('id', existingSub.id)
          .select('id, customer_id, description, amount, term_count, start_date, end_date, status, postponed_months')
          .single();
        if (uSubErr) throw new Error('subscription update: ' + uSubErr.message);
        subscription = upd;
      } else {
        // Poging 1: mét is_test=true (nieuwere migraties).
        const withFlag = { ...subPayload, is_test: true };
        const first = await supabaseAdmin
          .from('subscriptions').insert(withFlag)
          .select('id, customer_id, description, amount, term_count, start_date, end_date, status, postponed_months')
          .single();
        if (first.error) {
          const msg = String(first.error?.message || '').toLowerCase();
          const isSchemaMiss = msg.includes('is_test') || msg.includes('column');
          if (!isSchemaMiss) throw new Error('subscription insert: ' + first.error.message);
          // Poging 2: zonder is_test (kolom bestaat nog niet).
          const { data: ins2, error: iErr2 } = await supabaseAdmin
            .from('subscriptions').insert(subPayload)
            .select('id, customer_id, description, amount, term_count, start_date, end_date, status, postponed_months')
            .single();
          if (iErr2) throw new Error('subscription insert (fallback): ' + iErr2.message);
          subscription = ins2;
        } else {
          subscription = first.data;
        }
      }
    } catch (e) {
      // Sub-seed is fail-soft — als het niet lukt, verstoort dat niet de
      // klant/facturen-seed. De simulate-credit-round-endpoint checkt zelf
      // of er een test-sub bestaat en past zich aan.
      console.warn('[sandbox-seed] test-sub soft-fail:', e?.message || e);
    }

    // 7) #806 — Regeling-abo (voor #788 ondergrens-check).
    //
    // getCustomerMonthlyPayment (api/_lib/customer-monthly-payment.js) verwacht:
    //   * deal.customer_id = customer.id
    //   * subscription.deal_id = deal.id
    //   * subscription.status = 'active' (Engels, niet 'actief')
    //   * subscription.billing_cycle = 'per_month' | 'per_year' | ...
    //   * subscription.amount + vat_percentage → monthly = incl / cycleMonths
    //
    // Als monthlyAmountEur = null → verwijder eventueel bestaand regel-abo
    // (opdat het escalatie-pad testbaar blijft). Anders idempotent
    // upsert op description='TEST-regeling-abo'.
    //
    // Fail-soft: fout hier verstoort niet de klant/facturen-seed.
    let regelingSubscription = null;
    let regelingDeal = null;
    try {
      // Bestaande regeling-abo + deal opsporen (op description-marker).
      const { data: existingRegSub } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id')
        .eq('description', 'TEST-regeling-abo')
        .maybeSingle();

      if (monthlyAmountEur == null) {
        // Geen abo gewenst — wis bestaande regeling-abo + deal (indien any).
        if (existingRegSub?.id) {
          await supabaseAdmin.from('subscriptions').delete().eq('id', existingRegSub.id);
        }
        if (existingRegSub?.deal_id) {
          await supabaseAdmin.from('deals').delete().eq('id', existingRegSub.deal_id);
        }
      } else {
        // Wél abo gewenst. Deal opzoeken/aanmaken, dan sub.
        let dealId = existingRegSub?.deal_id || null;
        if (!dealId) {
          const { data: newDeal, error: dErr } = await supabaseAdmin
            .from('deals')
            .insert({
              customer_id: customer.id,
              source:      'sandbox_seed',
            })
            .select('id, customer_id')
            .single();
          if (dErr) throw new Error('deal insert: ' + dErr.message);
          dealId = newDeal.id;
          regelingDeal = newDeal;
        } else {
          const { data: dGet } = await supabaseAdmin
            .from('deals').select('id, customer_id').eq('id', dealId).maybeSingle();
          regelingDeal = dGet;
        }

        // Sub-payload. Amount = value / 1.21 zodat incl. BTW = value.
        // Rond naar 2 decimalen; kleine round-trip-drift is voor sandbox oké.
        const VAT = 21;
        const amountExVat = Math.round((monthlyAmountEur / (1 + VAT / 100)) * 100) / 100;
        const iso = (d) => d.toISOString().slice(0, 10);
        const today = new Date();
        const startD = new Date(today); startD.setMonth(startD.getMonth() - 3);
        const subPayload = {
          deal_id:        dealId,
          description:    'TEST-regeling-abo',
          amount:         amountExVat,
          vat_percentage: VAT,
          billing_cycle:  'per_month',
          status:         'active',
          start_date:     iso(startD),
        };
        if (existingRegSub?.id) {
          const { data: upd, error: upErr } = await supabaseAdmin
            .from('subscriptions').update(subPayload).eq('id', existingRegSub.id)
            .select('id, deal_id, amount, vat_percentage, billing_cycle, status, description')
            .single();
          if (upErr) throw new Error('regeling-sub update: ' + upErr.message);
          regelingSubscription = upd;
        } else {
          const { data: ins, error: iErr } = await supabaseAdmin
            .from('subscriptions').insert(subPayload)
            .select('id, deal_id, amount, vat_percentage, billing_cycle, status, description')
            .single();
          if (iErr) throw new Error('regeling-sub insert: ' + iErr.message);
          regelingSubscription = ins;
        }
      }
    } catch (e) {
      console.warn('[sandbox-seed] regeling-abo soft-fail:', e?.message || e);
    }

    return res.status(200).json({
      ok       : true,
      customer,
      invoices : newInvs || [],
      contact,
      pipeline_stage: 'nieuw',
      subscription,
      regeling_deal:         regelingDeal,
      regeling_subscription: regelingSubscription,
      monthly_amount_eur:    monthlyAmountEur,
    });
  } catch (e) {
    console.error('[sandbox-seed]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
