// api/admin/tl-b2b-audit.js
// GET → dry-run audit: welke B2B-klanten hebben een tl_company_id maar geen
// tl_contact_id, en welke offertes/facturen/abo's hangen aan de persoon (contact)
// terwijl ze op het bedrijf horen. Voert GEEN mutaties uit; puur rapport.
//
// Response 200:
//   {
//     summary: {
//       b2b_customers_total, without_contact, contact_only, deals_on_contact_at_b2b,
//     },
//     b2b_without_contact: [{ id, company_name, first_name, last_name, email,
//                             tl_company_id, has_person_name, blocker }],
//     b2b_missing_company: [{ id, company_name, tl_contact_id }],
//     deals_wrong_entity: [{ deal_id, tl_deal_id, tl_quotation_id,
//                            customer_id, customer_name, is_company,
//                            tl_company_id, tl_contact_id, note }],
//   }
//
// Permission: super_admin (audit-tool).

import { createUserClient, supabaseAdmin } from '../supabase.js';

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

  // super_admin-only — hardgate. Andere audit-tools staan hier ook op super_admin.
  const { data: prof } = await supabaseAdmin.from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
  if (!prof?.is_active || prof.role !== 'super_admin') {
    return res.status(403).json({ error: 'super_admin vereist' });
  }

  try {
    // 1) Alle B2B-klanten opladen (min. velden).
    const { data: b2bAll, error: b2bErr } = await supabaseAdmin.from('customers')
      .select('id, company_name, vat_number, first_name, last_name, email, tl_company_id, tl_contact_id, archived_at, anonymized_at, created_at')
      .eq('is_company', true)
      .is('archived_at', null)
      .is('anonymized_at', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (b2bErr) throw new Error('b2b select: ' + b2bErr.message);

    // 2) B2B zonder contact — missen dus een primary contact in TL.
    const b2bWithoutContact = (b2bAll || [])
      .filter((c) => c.tl_company_id && !c.tl_contact_id)
      .map((c) => {
        const firstName = String(c.first_name || '').trim();
        const lastName  = String(c.last_name  || '').trim();
        const hasName = !!(firstName || lastName);
        return {
          id: c.id,
          company_name: c.company_name,
          first_name: c.first_name,
          last_name: c.last_name,
          email: c.email,
          tl_company_id: c.tl_company_id,
          has_person_name: hasName,
          blocker: hasName ? null : 'no_person_name — vul first_name/last_name aan zodat contact aangemaakt kan worden',
        };
      });

    // 3) B2B zonder company (is_company=true maar tl_company_id NULL) — die krijgen bij
    //    de eerstvolgende push zowel een company als contact via ensureCompanyWithContact.
    const b2bMissingCompany = (b2bAll || [])
      .filter((c) => !c.tl_company_id)
      .map((c) => ({
        id: c.id,
        company_name: c.company_name,
        tl_contact_id: c.tl_contact_id,
        vat_number: c.vat_number,
      }));

    // 4) Deals waar het bedrijf ontbrak toen ze werden gepusht — nu op contact in TL.
    //    Heuristiek: klant is_company=true + tl_company_id gevuld + er is een deal met
    //    tl_deal_id maar de bijbehorende customer had toen (waarschijnlijk) geen
    //    tl_company_id. We kunnen dat historisch niet 100% zeker weten — we tonen alle
    //    deals van B2B-klanten met tl_deal_id zodat je in TL zelf via /deals.info
    //    kunt kijken op welke customer-type ze staan.
    const b2bWithCompanyIds = (b2bAll || []).filter((c) => c.tl_company_id).map((c) => c.id);
    let dealsWrongEntity = [];
    if (b2bWithCompanyIds.length) {
      const { data: deals, error: dErr } = await supabaseAdmin.from('deals')
        .select('id, tl_deal_id, tl_quotation_id, customer_id, tl_pushed_at, total_amount')
        .in('customer_id', b2bWithCompanyIds)
        .not('tl_deal_id', 'is', null)
        .order('tl_pushed_at', { ascending: false })
        .limit(500);
      if (dErr) throw new Error('deals select: ' + dErr.message);
      const custById = new Map((b2bAll || []).map((c) => [c.id, c]));
      dealsWrongEntity = (deals || []).map((d) => {
        const c = custById.get(d.customer_id);
        return {
          deal_id: d.id,
          tl_deal_id: d.tl_deal_id,
          tl_quotation_id: d.tl_quotation_id,
          tl_pushed_at: d.tl_pushed_at,
          total_amount: d.total_amount,
          customer_id: d.customer_id,
          customer_name: c?.company_name || `${c?.first_name || ''} ${c?.last_name || ''}`.trim(),
          is_company: !!c?.is_company,
          tl_company_id: c?.tl_company_id || null,
          tl_contact_id: c?.tl_contact_id || null,
          note: 'Verifieer via POST /deals.info {"id":"<tl_deal_id>"} — als lead.customer.type=="contact", pushte de oude code op de persoon. Nieuwe push (na deze PR) zou op company landen.',
        };
      });
    }

    // 5) Facturen op B2B-klanten waar tl_invoice_id gevuld is — zelfde verificatie-actie.
    let invoicesWrongEntity = [];
    if (b2bWithCompanyIds.length) {
      const { data: invs, error: iErr } = await supabaseAdmin.from('invoices')
        .select('id, tl_invoice_id, customer_id, invoice_number, status, amount_total, issue_date')
        .in('customer_id', b2bWithCompanyIds)
        .not('tl_invoice_id', 'is', null)
        .order('issue_date', { ascending: false })
        .limit(500);
      if (iErr) throw new Error('invoices select: ' + iErr.message);
      const custById = new Map((b2bAll || []).map((c) => [c.id, c]));
      invoicesWrongEntity = (invs || []).map((iv) => {
        const c = custById.get(iv.customer_id);
        return {
          invoice_id: iv.id,
          tl_invoice_id: iv.tl_invoice_id,
          invoice_number: iv.invoice_number,
          status: iv.status,
          amount_total: iv.amount_total,
          issue_date: iv.issue_date,
          customer_id: iv.customer_id,
          customer_name: c?.company_name || `${c?.first_name || ''} ${c?.last_name || ''}`.trim(),
          tl_company_id: c?.tl_company_id || null,
          tl_contact_id: c?.tl_contact_id || null,
          note: 'Verifieer via POST /invoices.info {"id":"<tl_invoice_id>"} — kijk naar invoicee.customer.type.',
        };
      });
    }

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      summary: {
        b2b_customers_total: (b2bAll || []).length,
        without_contact:     b2bWithoutContact.length,
        without_person_name: b2bWithoutContact.filter((r) => !r.has_person_name).length,
        missing_company:     b2bMissingCompany.length,
        deals_to_verify:     dealsWrongEntity.length,
        invoices_to_verify:  invoicesWrongEntity.length,
      },
      b2b_without_contact: b2bWithoutContact,
      b2b_missing_company: b2bMissingCompany,
      deals_to_verify:     dealsWrongEntity,
      invoices_to_verify:  invoicesWrongEntity,
    });
  } catch (e) {
    console.error('[tl-b2b-audit]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
