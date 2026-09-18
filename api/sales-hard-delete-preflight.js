// api/sales-hard-delete-preflight.js
//
// GET ?deal_id=<uuid> → blast-radius rapport voor de hard-delete-flow.
//
// Retourneert per gerelateerde tabel wat er zou gebeuren bij DELETE FROM deals:
//   * blockers: rijen die de delete WEIGEREN (invoices, arrangements, bonuses,
//     setter_ledger_entries — allemaal representeren ze geld of open incasso).
//   * cascade: rijen die MEE-verwijderd worden (subscriptions, deal_line_items,
//     meta_capi_events — via ON DELETE CASCADE).
//   * set_null: rijen die BLIJVEN staan met deal_id=NULL (event_attendees,
//     setter_ledger_entries — mits die laatste 0 rijen heeft; anders is 't
//     een blocker).
//
// UI gebruikt deze data om (a) de knop conditioneel te enablen en (b) op de
// bevestigingsstap ALLE gevolgen te tonen.
//
// Auth: user IN ('super_admin', 'sales') + is_active. admin/manager
// expliciet niet — spec Jeffrey 2026-09-18.
//
// 0 mutaties. Pure read.

import { createUserClient, supabaseAdmin } from './supabase.js';

const TOEGESTANE_ROLLEN = new Set(['super_admin', 'sales']);

async function checkAuth(req) {
  const sb = createUserClient(req);
  const { data: { user }, error } = await sb.auth.getUser();
  if (error || !user) return { ok: false, status: 401, error: 'Niet geauthenticeerd' };
  const { data: profile } = await supabaseAdmin.from('profiles')
    .select('id, role, is_active, full_name').eq('id', user.id).maybeSingle();
  if (!profile)               return { ok: false, status: 403, error: 'Geen profiel gevonden' };
  if (!profile.is_active)     return { ok: false, status: 403, error: 'Profiel is niet actief' };
  if (!TOEGESTANE_ROLLEN.has(profile.role)) {
    return { ok: false, status: 403,
      error: `Alleen super_admin en sales mogen hard-deleten (jouw rol: ${profile.role})` };
  }
  return { ok: true, user, profile };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const auth = await checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const deal_id = (req.query?.deal_id || '').toString().trim();
  if (!deal_id) return res.status(400).json({ error: 'deal_id (uuid) vereist' });

  try {
    // 1) Deal-info + huidige customer/sales/status.
    // 2026-09-18 fix: customers-tabel heeft GEEN 'name'-kolom (had 42703-fout
    // "column customers_1.name does not exist" → embed-query error → data=null
    // → misleidende 404 "Deal niet gevonden"). Nu selecteren we de correcte
    // shape (is_company + company_name + first_name + last_name) en bouwen
    // de weergavenaam in JS. Ook: `error` destructureren zodat een toekomstige
    // embed-fout NIET stil-fail-t als 404.
    const { data: deal, error: dealErr } = await supabaseAdmin.from('deals')
      .select(`id, customer_id, sales_user_id, tl_deal_id, tl_quotation_id,
               tl_quotation_status, tl_quotation_sent_at, tl_quotation_accepted_at,
               quote_reference, notes, archived_at,
               customer:customers(id, is_company, company_name, first_name, last_name, email),
               sales:profiles!deals_sales_user_id_fkey(id, full_name, email)`)
      .eq('id', deal_id).maybeSingle();
    if (dealErr) return res.status(500).json({ error: 'Deal-lookup fout', detail: dealErr.message });
    if (!deal) return res.status(404).json({ error: 'Deal niet gevonden' });

    // 2) BLOCKERS ─────────────────────────────────────────────────────────
    //    2a) Invoices (elke rij blokkeert — factuur betekent boekhoud-koppeling).
    const { data: invoices } = await supabaseAdmin.from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, issue_date, status')
      .eq('deal_id', deal_id)
      .order('issue_date', { ascending: false });

    //    2b) Payment-arrangements die aan een van die invoices hangen én nog
    //        levend zijn.
    const invoiceIds = (invoices || []).map((i) => i.id);
    let arrangements = [];
    if (invoiceIds.length > 0) {
      const { data: arr } = await supabaseAdmin.from('payment_arrangements')
        .select('id, type, status, details, notes, created_at')
        .overlaps('invoice_ids', invoiceIds)
        .in('status', ['VOORGESTELD', 'ACTIEF', 'voorgesteld', 'goedgekeurd', 'actief']);
      arrangements = arr || [];
    }

    //    2c) Bonuses — RESTRICT-FK, elke rij is een uitbetaalbare commissie.
    const { data: bonuses } = await supabaseAdmin.from('bonuses')
      .select('id, sales_user_id, amount, status, earned_at, paid_at')
      .eq('deal_id', deal_id);

    //    2d) Setter-ledger-entries — elke rij is realized commissie, geld
    //        verschuldigd (vrijgegeven) of al betaald (uitbetaald). Beide
    //        blokkeren. Zie docs/sql-migrations/2026-08-31-bp2-setter-
    //        attributie-grootboek.sql:141-158 voor status-model.
    const { data: setterLedger } = await supabaseAdmin.from('setter_ledger_entries')
      .select('id, setter_user_id, amount, status, created_at, paid_at')
      .eq('deal_id', deal_id);

    const blockers = [];
    if ((invoices || []).length > 0) {
      const totaal = invoices.reduce((s, i) => s + Number(i.amount_total || 0), 0);
      blockers.push({
        type       : 'invoices',
        label      : 'Factu(u)r(en) gekoppeld',
        count      : invoices.length,
        totaal_eur : Math.round(totaal * 100) / 100,
        detail     : `${invoices.length} factuur/facturen (totaal €${totaal.toFixed(2)}). Handel de facturering af — verwijder de facturen of markeer creditnota's — vóór je de offerte kunt hard-deleten.`,
        rijen      : invoices.map((i) => ({
          id: i.id, nummer: i.invoice_number, bedrag: Number(i.amount_total || 0),
          betaald: Number(i.amount_paid || 0), datum: i.issue_date, status: i.status,
        })),
      });
    }
    if ((arrangements || []).length > 0) {
      blockers.push({
        type   : 'payment_arrangements',
        label  : 'Actieve betalingsregeling(en)',
        count  : arrangements.length,
        detail : `${arrangements.length} regeling(en) op deze facturen zijn nog niet afgesloten. Rond de regeling af (of markeer geannuleerd) vóór hard-delete.`,
        rijen  : arrangements.map((a) => ({
          id: a.id, type: a.type, status: a.status, aangemaakt: a.created_at, notes: a.notes,
        })),
      });
    }
    if ((bonuses || []).length > 0) {
      const totaal = bonuses.reduce((s, b) => s + Number(b.amount || 0), 0);
      blockers.push({
        type       : 'bonuses',
        label      : 'Sales-bonus(sen) gekoppeld',
        count      : bonuses.length,
        totaal_eur : Math.round(totaal * 100) / 100,
        detail     : `${bonuses.length} bonus-recht(en) op deze deal (€${totaal.toFixed(2)}). We raken bonus-status nooit automatisch aan — regel dit via de sales-admin.`,
        rijen      : bonuses.map((b) => ({
          id: b.id, bedrag: Number(b.amount || 0), status: b.status,
          verdiend_op: b.earned_at, betaald_op: b.paid_at, sales_user_id: b.sales_user_id,
        })),
      });
    }
    if ((setterLedger || []).length > 0) {
      const totaal = setterLedger.reduce((s, e) => s + Number(e.amount || 0), 0);
      blockers.push({
        type       : 'setter_ledger_entries',
        label      : 'Setter-commissie(s) gekoppeld',
        count      : setterLedger.length,
        totaal_eur : Math.round(totaal * 100) / 100,
        detail     : `${setterLedger.length} setter-commissie-boeking(en) (€${totaal.toFixed(2)}). Zowel vrijgegeven als uitbetaald representeren geld — geen "log-achtige" entries in deze tabel — dus alle statussen blokkeren.`,
        rijen      : setterLedger.map((e) => ({
          id: e.id, bedrag: Number(e.amount || 0), status: e.status,
          setter_user_id: e.setter_user_id, aangemaakt: e.created_at, betaald_op: e.paid_at,
        })),
      });
    }

    // 3) CASCADE + SET NULL (informatief voor de UI) ──────────────────────
    const [subs, lineItems, capiEvents, eventAttendees] = await Promise.all([
      supabaseAdmin.from('subscriptions').select('id, amount, term_count, status').eq('deal_id', deal_id),
      supabaseAdmin.from('deal_line_items').select('id, description, amount').eq('deal_id', deal_id),
      supabaseAdmin.from('meta_capi_events').select('id, event_name, status').eq('deal_id', deal_id),
      supabaseAdmin.from('event_attendees').select('id, first_name, last_name, email, status').eq('deal_id', deal_id),
    ]);

    const cascade = [];
    if ((subs.data || []).length > 0) cascade.push({
      type: 'subscriptions', label: 'Abonnement(en)/termijnen',
      count: subs.data.length, on_delete: 'CASCADE',
      detail: 'Verdwijnt automatisch mee met de deal. Onherstelbaar.',
      rijen: subs.data,
    });
    if ((lineItems.data || []).length > 0) cascade.push({
      type: 'deal_line_items', label: 'Offerte-regels',
      count: lineItems.data.length, on_delete: 'CASCADE',
      detail: 'Verdwijnt automatisch mee. Onherstelbaar.',
      rijen: lineItems.data,
    });
    if ((capiEvents.data || []).length > 0) cascade.push({
      type: 'meta_capi_events', label: 'Meta CAPI-event(s)',
      count: capiEvents.data.length, on_delete: 'CASCADE',
      detail: 'Verdwijnt automatisch. Metrics blijven bij Meta zelf staan.',
      rijen: capiEvents.data,
    });

    const set_null = [];
    if ((eventAttendees.data || []).length > 0) set_null.push({
      type: 'event_attendees', label: 'Event-aanmelding(en)',
      count: eventAttendees.data.length, on_delete: 'SET NULL',
      detail: 'Deze aanmelding-rij blijft bestaan; alleen de deal-referentie verdwijnt.',
      rijen: eventAttendees.data,
    });

    // Meta over de deal zelf.
    // 2026-09-18 fix: bouw klantnaam in JS uit is_company + company_name /
    // first_name + last_name (customers-tabel heeft géén enkele 'name'-kolom).
    // UI (offerte-detail-v2.js:831) verwacht `deal.klant?.naam` — shape blijft
    // identiek, alleen bron-mapping is nu correct.
    const c = deal.customer;
    const klantNaam = c
      ? ((c.is_company ? c.company_name : [c.first_name, c.last_name].filter(Boolean).join(' ')) || '(onbekend)')
      : null;
    const deletable = blockers.length === 0;
    return res.status(200).json({
      ok: true,
      deletable,
      by_role: auth.profile.role,
      deal: {
        id: deal.id,
        klant : c ? { id: c.id, naam: klantNaam, email: c.email } : null,
        sales : deal.sales ? { id: deal.sales.id, naam: deal.sales.full_name, email: deal.sales.email } : null,
        offerte_referentie: deal.quote_reference,
        tl_deal_id       : deal.tl_deal_id,
        tl_quotation_id  : deal.tl_quotation_id,
        tl_quotation_status: deal.tl_quotation_status,
        tl_quotation_accepted_at: deal.tl_quotation_accepted_at,
        archived_at      : deal.archived_at,
      },
      blockers,
      cascade,
      set_null,
      note: deletable
        ? 'Geen blockers. Klaar voor hard-delete met dubbele bevestiging + typ "VERWIJDER".'
        : 'Er staan blockers open. Los die eerst op — daarna wordt de knop actief.',
    });
  } catch (e) {
    console.error('[sales-hard-delete-preflight]', e?.message || e);
    return res.status(500).json({ error: 'Preflight faalde', detail: e?.message || String(e) });
  }
}
