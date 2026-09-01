// api/sales-deal-create.js
// POST { customer_data, deal_data, products[], matched_customer_id?, tl_imported_contact_id?, sync_to_tl }
// → { customer_id, deal_id, tl_quotation_status, tl_quotation_id?, tl_deal_id?, tl_contact_id?, tl_error? }
//
// Wizard 1 (offerte-flow): maakt klant + deal + offerte-regels, en pusht een
// OFFERTE (quotation) naar TL. Subscriptions worden hier NIET meer aangemaakt;
// die volgen in Wizard 2 nadat de offerte is getekend.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getActiveToken } from './_lib/teamleader-token.js';
import { pushQuotationToTl } from './_lib/teamleader-quotation.js';
import { assertStartDateNotTooEarly, assertDateNotInPast } from './_lib/onboarding-start-date.js';
import { applyCustomerPatchFromWizard } from './_lib/customer-patch-from-wizard.js';

// Lege string / undefined → null (voorkomt 'invalid input syntax for type uuid').
const emptyToNull = (v) => (v === '' || v === undefined ? null : v);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.create)' });
  }

  const body = req.body || {};
  const { customer_data = {}, deal_data = {}, products = [],
          matched_customer_id, tl_imported_contact_id, sync_to_tl = false,
          // Optioneel: wizard gestart vanuit Events-aanwezige. Zo ja, koppelen
          // we event_attendees.customer_id server-side (best-effort, fail-soft)
          // zodat de aanwezigen-tabel meteen tl_quotation_status mee krijgt via
          // de bestaande join. Voorheen deed de wizard een client-side PATCH op
          // /api/events-attendee-update, wat events.attendee.edit-rechten
          // vereiste. Server-side draait dit binnen de al verleende
          // sales.deal.create-scope (geen extra RBAC nodig).
          event_attendee_id } = body;

  // Lead-bron is optioneel geworden (P2): geen verplichting meer.
  if (!Array.isArray(products) || products.length === 0) return res.status(400).json({ error: 'minimaal 1 product vereist' });

  // Ondergrens-gate op de startdatums: payment_start_date >= vandaag+3
  // (SEPA + Rogier-buffer maakt afgeleide betaaldatums start-3d — die
  // liggen anders zelf al in het verleden). payment_term_start_date en
  // payment_downpayment_date mogen wél vandaag zijn (bij startdatum=
  // vandaag+3 is start-3d = vandaag), maar niet gisteren of eerder.
  // NIET stil clampen — front-end en back-end moeten dezelfde ondergrens
  // afdwingen zodat een verkeerde datum zichtbaar wordt.
  const startDateForCheck = deal_data.payment_start_date;
  const startTooEarly = assertStartDateNotTooEarly(startDateForCheck);
  if (startTooEarly) {
    return res.status(400).json({
      error: 'Cursus-startdatum: ' + startTooEarly.message,
      code:  startTooEarly.code,
      field: 'payment_start_date',
      min:   startTooEarly.min,
      got:   startTooEarly.got,
    });
  }
  const termInPast = assertDateNotInPast(deal_data.payment_term_start_date, 'Datum 1e termijn');
  if (termInPast) {
    return res.status(400).json({
      error: termInPast.message,
      code:  termInPast.code,
      field: 'payment_term_start_date',
      today: termInPast.today,
      got:   termInPast.got,
    });
  }
  const downInPast = assertDateNotInPast(deal_data.payment_downpayment_date, 'Aanbetaling-datum');
  if (downInPast) {
    return res.status(400).json({
      error: downInPast.message,
      code:  downInPast.code,
      field: 'payment_downpayment_date',
      today: downInPast.today,
      got:   downInPast.got,
    });
  }

  try {
    // 0. Bedrijfsentiteit valideren (indien meegegeven) tegen company_entities.
    let departmentId = deal_data.tl_department_id || null;
    if (departmentId) {
      const { data: ent } = await supabaseAdmin.from('company_entities')
        .select('tl_department_id').eq('tl_department_id', departmentId).eq('is_active', true).maybeSingle();
      if (!ent) return res.status(400).json({ error: 'Ongeldige bedrijfsentiteit (tl_department_id)' });
    }

    // 1. Customer: reuse OF create.
    // Bij REUSE (matched_customer_id): pas eerst wizard-edits toe (vat_number,
    // company_name, adres, etc). Voorheen werden die genegeerd waardoor de
    // push met OUDE DB-waarde draaide — bv. gebruiker verbeterde vat_number
    // in de wizard, maar de push kreeg de oude waarde en TL 400'te.
    let customerId = matched_customer_id || null;
    if (customerId) {
      try {
        const patchRes = await applyCustomerPatchFromWizard(supabaseAdmin, customerId, customer_data);
        if (patchRes.applied) {
          console.log('[sales-deal-create] customer wizard-patch toegepast', { customerId, fields: patchRes.fields });
        }
      } catch (e) {
        console.error('[sales-deal-create] customer wizard-patch mislukt:', customerId, e?.message);
        return res.status(500).json({ error: 'Kon klantgegevens niet bijwerken vóór push: ' + (e?.message || 'onbekend') });
      }
    }
    if (!customerId) {
      const isCompanyPayload = customer_data.is_company === true || customer_data.is_company === 'true';
      // Bij B2B: NOOIT een tl_imported_contact_id op tl_contact_id zetten in
      // deze insert. Reden: dat is een persoons-contact uit TL search-match dat
      // niks met het bedrijf zelf te maken heeft; koppelen zou verwarrend zijn
      // omdat onze push-flow tl_company_id + eigen contact-koppeling gebruikt.
      // De contact wordt bij B2B pas aangemaakt en gelinkt door
      // ensureCompanyWithContact tijdens de eerste push.
      const custPayload = {
        is_company:      isCompanyPayload,
        company_name:    customer_data.company_name || null,
        kvk_number:      customer_data.kvk_number || null,
        vat_number:      customer_data.vat_number || null,
        first_name:      customer_data.first_name || null,
        last_name:       customer_data.last_name || null,
        email:           customer_data.email || null,
        phone:           customer_data.phone || null,
        date_of_birth:   customer_data.date_of_birth || null,
        address_street:  customer_data.address_street || null,
        address_number:  customer_data.address_number || null,
        address_postal:  customer_data.address_postal || null,
        address_city:    customer_data.address_city || null,
        address_country: (customer_data.address_country === 'BE' ? 'BE' : (customer_data.address_country === 'NL' ? 'NL' : null)),
        tl_contact_id:   isCompanyPayload ? null : (tl_imported_contact_id || null),
        created_by_user_id: user.id,
      };
      // Idempotent op tl_contact_id: bestaat er al een (actieve) customer voor
      // dit TL-contact, hergebruik die i.p.v. een tweede rij te maken. Dit is de
      // root-cause-fix van de dubbele-klant-bug: die ontstond als de wizard géén
      // matched_customer_id meestuurde terwijl er al een customer met dit
      // tl_contact_id bestond. B2C only — bij B2B zetten we tl_contact_id bewust
      // niet op de klant (zie comment hierboven).
      if (!isCompanyPayload && tl_imported_contact_id) {
        const { data: existRows } = await supabaseAdmin.from('customers')
          .select('id')
          .eq('tl_contact_id', tl_imported_contact_id)
          .is('archived_at', null).is('anonymized_at', null)
          .order('created_at', { ascending: true }).limit(1);
        if (existRows && existRows.length) customerId = existRows[0].id;
      }
      if (!customerId) {
        // Email-uniciteit check (race-safe via DB error 23505 als constraint bestaat).
        const { data: cust, error: cErr } = await supabaseAdmin.from('customers').insert(custPayload).select('id').single();
        if (cErr) {
          if (cErr.code === '23505') return res.status(409).json({ error: 'Email reeds in gebruik (race-conditie)' });
          throw cErr;
        }
        customerId = cust.id;
      }
    }

    // 1b. Best-effort: koppel de aanwezige aan deze klant zodat de
    //     Events-aanwezigentabel meteen offerte-status toont. Failures
    //     loggen we alleen — mogen de deal-creatie nooit breken.
    if (event_attendee_id && customerId) {
      try {
        const { error: eaErr } = await supabaseAdmin
          .from('event_attendees')
          .update({ customer_id: customerId })
          .eq('id', event_attendee_id);
        if (eaErr) {
          console.warn('[sales-deal-create] event_attendees back-link failed:', eaErr.message);
        }
      } catch (e) {
        console.warn('[sales-deal-create] event_attendees back-link exception:', e?.message || e);
      }
    }

    // 2. Bereken total_amount uit producten.
    const totalAmount = products.reduce((sum, p) => sum + (Number(p.price_per_unit) * Number(p.quantity)), 0);

    // BP2 setter-attributie (v2 2026-09-01 klant-catch-all).
    // Resolutie-volgorde:
    //   1. Expliciet: deal_data.setter_user_id uit de wizard-picker.
    //   2. source_lead_id → leads.email/telefoon → oudste boeking.
    //   3. NIEUW — customerId → customers.email/phone → oudste boeking.
    //      Dekt vers-in-de-wizard scenarios waarin verkoper niet vanuit
    //      lead start maar de klant identiek is aan een setter-boeking.
    //   4. NULL → wizard toont "⚠ geen setter"-badge.
    // Match alleen tegen boekingen mét setter_user_id → geen valse attributie.
    // Email primair, telefoon-last9 fallback. Oudste-boeking-wint.
    async function _resolveByEmail(email) {
      if (!email) return null;
      const { data } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('setter_user_id, scheduled_at')
        .ilike('lead_email', email)
        .not('setter_user_id', 'is', null)
        .order('scheduled_at', { ascending: true })
        .limit(1).maybeSingle();
      return data?.setter_user_id || null;
    }
    async function _resolveByPhone(telefoon) {
      const digits = String(telefoon || '').replace(/\D/g, '');
      if (digits.length < 8) return null;
      const tel9 = digits.slice(-9);
      const { data } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('setter_user_id, lead_phone, scheduled_at')
        .not('setter_user_id', 'is', null)
        .order('scheduled_at', { ascending: true })
        .limit(500);
      const hit = (data || []).find((r) => {
        const rd = String(r.lead_phone || '').replace(/\D/g, '');
        return rd && rd.slice(-9) === tel9;
      });
      return hit?.setter_user_id || null;
    }

    let resolvedSetter = emptyToNull(deal_data.setter_user_id);
    // Stap 2: via source_lead_id.
    if (!resolvedSetter && deal_data.source_lead_id) {
      try {
        const { data: lead } = await supabaseAdmin
          .from('leads').select('email, telefoon').eq('id', deal_data.source_lead_id).maybeSingle();
        if (lead?.email)    resolvedSetter = await _resolveByEmail(String(lead.email).trim().toLowerCase());
        if (!resolvedSetter && lead?.telefoon) resolvedSetter = await _resolveByPhone(lead.telefoon);
      } catch (e) {
        console.warn('[sales-deal-create] setter-lookup lead (soft):', e?.message || e);
      }
    }
    // Stap 3: klant-catch-all — customers.email/phone.
    if (!resolvedSetter && customerId) {
      try {
        const { data: cust } = await supabaseAdmin
          .from('customers').select('email, phone').eq('id', customerId).maybeSingle();
        if (cust?.email)    resolvedSetter = await _resolveByEmail(String(cust.email).trim().toLowerCase());
        if (!resolvedSetter && cust?.phone) resolvedSetter = await _resolveByPhone(cust.phone);
      } catch (e) {
        console.warn('[sales-deal-create] setter-lookup customer (soft):', e?.message || e);
      }
    }

    // 3. Deal aanmaken.
    const dealPayload = {
      customer_id:        customerId,
      total_amount:       totalAmount,
      start_date:         deal_data.start_date || new Date().toISOString().slice(0, 10),
      end_date:           deal_data.end_date || null,
      status:             'active',
      sales_user_id:      user.id,
      setter_user_id:     resolvedSetter,          // BP2: NULL bij lookup-miss + geen expliciete keuze
      source:             deal_data.source || null,
      source_lead_id:     emptyToNull(deal_data.source_lead_id),
      downpayment_amount: deal_data.downpayment_amount || null,
      first_call_at:      deal_data.first_call_at || null,
      quote_reference:    deal_data.quote_reference || null,
      tl_department_id:   departmentId,
      traject_variant_id: emptyToNull(deal_data.traject_variant_id),
      discount_percentage: Number(deal_data.discount_percentage) || 0,
      sale_type:          deal_data.sale_type || 'domestic',
      payment_start_date:         deal_data.payment_start_date || null,
      payment_downpayment_amount: deal_data.payment_downpayment_amount || null,
      payment_downpayment_date:   deal_data.payment_downpayment_date || null,
      payment_term_count:         deal_data.payment_term_count || null,
      payment_term_start_date:    deal_data.payment_term_start_date || null,
      payment_term_amount:        deal_data.payment_term_amount || null,
      tl_push_status:     'not_pushed',
      tl_quotation_status: 'draft',
    };
    // Offerte-beveiliging bouwstap 1/2: manager-goedkeuring-audit. Alleen
    // meenemen als de wizard een goedkeuring registreerde (flagged=true);
    // anders default false/null uit de migratie. exception_approved_by =
    // ingelogde sales-user die de goedkeuring vastlegde (klant-attest,
    // geen 2FA). fee_agreed alleen betekenisvol bij late_start.
    if (deal_data.exception_flagged === true) {
      dealPayload.exception_flagged     = true;
      dealPayload.exception_reasons     = deal_data.exception_reasons     || null;
      dealPayload.exception_reason_note = deal_data.exception_reason_note || null;
      dealPayload.exception_fee_agreed  = !!deal_data.exception_fee_agreed;
      dealPayload.exception_approved_by = user.id;
      dealPayload.exception_approved_at = new Date().toISOString();
    }
    // BP2 42703 fail-soft: als setter_user_id-kolom nog niet bestaat
    // (pre-BP2 migratie), retry zonder de kolom zodat deal-creatie
    // niet blokkeert.
    let deal, dErr;
    ({ data: deal, error: dErr } = await supabaseAdmin.from('deals').insert(dealPayload).select('id').single());
    if (dErr && dErr.code === '42703' && String(dErr.message || '').toLowerCase().includes('setter_user_id')) {
      const fallback = { ...dealPayload };
      delete fallback.setter_user_id;
      ({ data: deal, error: dErr } = await supabaseAdmin.from('deals').insert(fallback).select('id').single());
    }
    if (dErr) throw dErr;
    const dealId = deal.id;

    // 4. Offerte-regels (producten) persisteren voor de quotation-push.
    const lineRows = products.map((p, idx) => ({
      deal_id:            dealId,
      product_id:         p.product_id || null,
      product_name:       p.product_name || 'Product',
      quantity:           Number(p.quantity) || 1,
      unit_price:         Number(p.price_per_unit) || 0,
      vat_percentage:     p.vat_percentage ?? 21,
      price_includes_vat: !!p.price_includes_vat,
      position:           idx,
    }));
    if (lineRows.length) {
      const { error: liErr } = await supabaseAdmin.from('deal_line_items').insert(lineRows);
      if (liErr) throw liErr;
    }

    // 5. Optionele TL-offerte-push — synchroon via directe module-call.
    let tlResult = { success: false };
    const tokenExists = sync_to_tl ? !!(await getActiveToken()) : false;
    if (sync_to_tl && tokenExists) {
      try {
        tlResult = await pushQuotationToTl(dealId);
      } catch (err) {
        console.error('[sales-deal-create] TL quotation push exception:', err.message);
        tlResult = { success: false, error: err.message };
        // pushQuotationToTl update DB zelf bij fout, maar extra safety bij unexpected throw.
        await supabaseAdmin.from('deals').update({
          tl_quotation_status: 'draft',
          tl_push_error:       err.message.slice(0, 500),
        }).eq('id', dealId);
      }
    }

    const quotationStatus = tlResult.success
      ? (tlResult.tl_quotation_status || 'sent')
      : (sync_to_tl && tokenExists ? 'failed' : 'not_pushed');

    return res.status(200).json({
      customer_id:         customerId,
      deal_id:             dealId,
      tl_quotation_status: quotationStatus,
      tl_quotation_id:     tlResult.tl_quotation_id || null,
      tl_contact_id:       tlResult.tl_contact_id || null,
      tl_deal_id:          tlResult.tl_deal_id || null,
      tl_error:            tlResult.error || null,
    });
  } catch (err) {
    console.error('[sales-deal-create]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
