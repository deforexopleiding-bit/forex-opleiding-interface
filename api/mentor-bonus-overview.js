// api/mentor-bonus-overview.js
//
// GET → self-scope read-only bonus-overzicht + termijn-projectie + 12-maands
// forecast voor de ingelogde mentor.
//
// Permission: mentor.module.access. Self-scope: mentor_user_id = auth.uid().
//
// Bron-of-truth:
//   - mentor_ledger_entries (entry_type='bonus'). Geannuleerde entries
//     worden WEL opgehaald (zichtbaar met grijze 'geannuleerd'-badge in
//     de UI, voor transparantie), maar tellen NIET mee in earned_total,
//     betaald_uit, open, deze_maand, volgende_maand, projection_12m of
//     mentor_share_total. Ze zijn puur informatief.
//   - subscriptions (via deals.customer_id) levert termijnschema (per_term_incl,
//     term_count, billing_cycle, start_date).
//   - invoices.amount_paid bepaalt hoeveel termijnen reeds betaald zijn.
//
// PURE PROJECTIE — geen mutaties aan ledger, vrijgave-engine of subscriptions.
// Bij ontbrekend schema (open-ended sub, term_count NULL, geen subscription
// gevonden) wordt 1 termijn getoond met `schema='onbekend'` zodat de UI weet
// dat de raming voorlopig is.
//
// Response 200:
//   {
//     ok: true,
//     scope: 'self',
//     totals: {
//       earned_total, betaald_uit, open,
//       deze_maand, volgende_maand,
//     },
//     projection_12m: [
//       { month: 'YYYY-MM', amount }
//     ],
//     per_event: [
//       { event_id, event_title, starts_at,
//         sales: [
//           { customer_id, customer_label, sale_total_incl, mentor_share_total,
//             term_count, per_term_amount, schema_unknown,
//             termijnen: [{ index, due_date, amount, status }] }
//         ] }
//     ],
//   }
// 401/403/405 zoals andere mentor-endpoints.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { releaseDate as cashReleaseDate } from './_lib/mentor-cash-release-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Bedrag incl. BTW per termijn. Identiek aan helper in sales-subscriptions-list.js.
function inclPerTerm(sub) {
  if (!sub) return 0;
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce((sum, li) => sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}

// Identiek aan helper in finance-dashboard-counts.js.
function billingCycleMonths(cycle) {
  if (!cycle) return 1;
  const c = String(cycle).toLowerCase();
  if (c === 'per_month')    return 1;
  if (c === 'per_2_months') return 2;
  if (c === 'per_quarter')  return 3;
  if (c === 'per_6_months') return 6;
  if (c === 'per_year')     return 12;
  const m = c.match(/per_(\d+)_months/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 1;
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// 'YYYY-MM' van een Date.
function ymKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Voeg N hele kalendermaanden toe aan een datum. JS Date.setMonth handelt
// overflow correct af (31 jan + 1 maand = 28/29 feb), wat we ook willen voor
// bv. quarterly termijnen vanaf 31 mrt.
function addMonths(d, n) {
  const out = new Date(d.getTime());
  out.setMonth(out.getMonth() + n);
  return out;
}

function customerLabel(c) {
  if (!c) return '—';
  if (c.is_company) return c.company_name || c.email || '(klant)';
  const parts = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return parts || c.company_name || c.email || '(klant)';
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * Kern-berekening: dezelfde output als de HTTP-handler, maar aanroepbaar
 * vanuit andere endpoints (o.a. payout-generate-core, om de bonus voor het
 * rapport uit dezelfde bron te halen als de mentor-cashflow-tooltip).
 * Werpt fouten via throw i.p.v. res.status(500).
 */
export async function computeBonusOverview(effectiveUserId) {
    // 1) Bonus-entries van deze mentor (excl. geannuleerd).
    // Geannuleerde entries WORDEN meegehaald voor transparantie (grijze badge
    // in de UI). Ze tellen niet mee in KPI's/mentor_share_total; zie de
    // isCancelled-check in de verwerkingslus hieronder.
    // CHILD-entries (parent_entry_id != null) worden UITGESLOTEN — die zijn
    // vrijgave-slices van hun parent en zouden anders als losse sale-rijen
    // dubbel geteld worden in de projectie/telling. Voor de "reeds vrijgevallen"-
    // weergave halen we de children-som per parent apart op (zie hieronder).
    const { data: entries, error: entErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .select('id, mentor_user_id, event_id, entry_type, basis, amount, original_amount, parent_entry_id, pct, status, attendee_id, customer_id, source_invoice_id, source_quote_id, idempotency_key, created_at')
      .eq('mentor_user_id', effectiveUserId)
      .eq('entry_type', 'bonus')
      .is('parent_entry_id', null)
      .limit(5000);
    if (entErr) throw new Error('ledger fetch: ' + entErr.message);

    const rows = entries || [];

    // Children-som per parent (voor `released_share` op de sale-cell).
    // Alleen vrijgegeven + uitbetaalde children tellen als "reeds vrijgevallen".
    const releasedByParent = new Map(); // parent_id -> sum(child.amount)
    if (rows.length > 0) {
      const parentIds = rows.map((r) => r.id);
      const { data: kids, error: kidsErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .select('parent_entry_id, amount, status')
        .in('parent_entry_id', parentIds)
        .in('status', ['vrijgegeven', 'uitbetaald']);
      if (kidsErr) throw new Error('children fetch: ' + kidsErr.message);
      for (const c of (kids || [])) {
        if (!c.parent_entry_id) continue;
        const cur = releasedByParent.get(c.parent_entry_id) || 0;
        releasedByParent.set(c.parent_entry_id, cur + (Number(c.amount) || 0));
      }
    }

    // Snel pad: geen bonussen. 43 maanden lege buckets (-6..+36) — zelfde
    // range als de hoofd-projectie zodat de frontend consistent kan renderen.
    if (rows.length === 0) {
      const now = new Date();
      const projection_12m = [];
      for (let i = -6; i <= 36; i++) {
        projection_12m.push({ month: ymKey(addMonths(now, i)), amount: 0, paid: 0, expected: 0, breakdown: [], rest_count: 0, rest_amount: 0 });
      }
      return {
        ok: true,
        scope: 'self',
        totals: { earned_total: 0, betaald_uit: 0, open: 0, deze_maand: 0, volgende_maand: 0, cf_received: 0, cf_this_month: 0, cf_expected: 0 },
        projection_12m,
        per_event: [],
      };
    }

    // 2) Bijbehorende customers, deals, subscriptions, invoices.
    const eventIds    = [...new Set(rows.map((r) => r.event_id).filter(Boolean))];
    const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
    const invoiceIds  = [...new Set(rows.map((r) => r.source_invoice_id).filter(Boolean))];

    const eventById    = new Map();
    const customerById = new Map();
    const dealsByCust  = new Map(); // customer_id → [deals]
    const subByDeal    = new Map(); // deal_id → subscription (latest by start_date)
    const invoiceById  = new Map();

    if (eventIds.length) {
      const { data: evs } = await supabaseAdmin
        .from('events')
        .select('id, title, starts_at')
        .in('id', eventIds);
      for (const e of evs || []) eventById.set(e.id, e);
    }
    if (customerIds.length) {
      const { data: custs } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, company_name, first_name, last_name, email')
        .in('id', customerIds);
      for (const c of custs || []) customerById.set(c.id, c);
    }
    if (customerIds.length) {
      const { data: deals } = await supabaseAdmin
        .from('deals')
        .select('id, customer_id')
        .in('customer_id', customerIds)
        .is('archived_at', null);
      for (const d of deals || []) {
        if (!dealsByCust.has(d.customer_id)) dealsByCust.set(d.customer_id, []);
        dealsByCust.get(d.customer_id).push(d);
      }
      const dealIds = (deals || []).map((d) => d.id);
      if (dealIds.length) {
        const { data: subs } = await supabaseAdmin
          .from('subscriptions')
          .select('id, deal_id, amount, vat_percentage, term_count, start_date, billing_cycle, line_items, status, teamleader_subscription_id')
          .in('deal_id', dealIds)
          .order('start_date', { ascending: false });
        // Latest sub per deal wint.
        for (const s of subs || []) {
          if (!subByDeal.has(s.deal_id)) subByDeal.set(s.deal_id, s);
        }
      }
    }
    if (invoiceIds.length) {
      const { data: invs } = await supabaseAdmin
        .from('invoices')
        .select('id, amount_total, amount_paid, status, paid_date')
        .in('id', invoiceIds);
      for (const v of invs || []) invoiceById.set(v.id, v);
    }

    // Aggregeer betaalde bedragen per subscription EN per customer voor
    // nbPaid-detectie bij historische bonussen (source_invoice_id=NULL).
    // Primair: subscription (via invoices.tl_subscription_id). Fallback:
    // customer (breder, matcht ook subscriptions zonder TL-id).
    const subPaidMap  = new Map(); // teamleader_subscription_id → { paid_total, last_paid_date }
    const custPaidMap = new Map(); // customer_id                → { paid_total, last_paid_date }
    // Factuur-lijsten per subscription en per customer — gesorteerd op due_date
    // (asc). Dit is de bron van waarheid voor per-termijn status (echte
    // vervaldatum + betaalstatus i.p.v. berekende addMonths).
    const invoicesBySub  = new Map(); // tl_subscription_id → [{id, due_date, amount_total, amount_paid, status, paid_date}]
    const invoicesByCust = new Map(); // customer_id        → [idem]

    // Verzamel alle bekende teamleader_subscription_ids uit subByDeal.
    const tlSubIds = [];
    for (const s of subByDeal.values()) {
      if (s?.teamleader_subscription_id) tlSubIds.push(s.teamleader_subscription_id);
    }
    const uniqTlSubIds = [...new Set(tlSubIds)];

    if (uniqTlSubIds.length) {
      const { data: subInvs, error: subInvErr } = await supabaseAdmin
        .from('invoices')
        .select('id, tl_subscription_id, amount_total, amount_paid, status, paid_date, due_date')
        .in('tl_subscription_id', uniqTlSubIds);
      if (!subInvErr) {
        for (const inv of (subInvs || [])) {
          if (!inv.tl_subscription_id) continue;
          if (!subPaidMap.has(inv.tl_subscription_id)) {
            subPaidMap.set(inv.tl_subscription_id, { paid_total: 0, last_paid_date: null });
          }
          const acc = subPaidMap.get(inv.tl_subscription_id);
          acc.paid_total += Number(inv.amount_paid) || 0;
          if (inv.paid_date && (!acc.last_paid_date || inv.paid_date > acc.last_paid_date)) {
            acc.last_paid_date = inv.paid_date;
          }
          if (!invoicesBySub.has(inv.tl_subscription_id)) invoicesBySub.set(inv.tl_subscription_id, []);
          invoicesBySub.get(inv.tl_subscription_id).push(inv);
        }
        // Sorteer per sub op due_date asc (facturen zonder due_date achteraan).
        for (const arr of invoicesBySub.values()) {
          arr.sort((a, b) => {
            const da = a.due_date || '9999-12-31';
            const db = b.due_date || '9999-12-31';
            return da < db ? -1 : da > db ? 1 : 0;
          });
        }
      }
    }
    // Overdue-map (klant-breed): factuur voorbij due_date + amount_paid < amount_total.
    // We hangen 'em uit de customer-fetch (breder dan sub-primair) omdat de mentor
    // achterstand op ELKE openstaande factuur van de klant wil zien.
    const custOverdueMap = new Map(); // customer_id → { count, amount, invoice_ids Set }
    const todayISO = new Date().toISOString().slice(0, 10);
    if (customerIds.length) {
      const { data: custInvs, error: custInvErr } = await supabaseAdmin
        .from('invoices')
        .select('id, customer_id, amount_total, amount_paid, status, paid_date, due_date')
        .in('customer_id', customerIds);
      if (!custInvErr) {
        for (const inv of (custInvs || [])) {
          if (!inv.customer_id) continue;
          if (!custPaidMap.has(inv.customer_id)) {
            custPaidMap.set(inv.customer_id, { paid_total: 0, last_paid_date: null });
          }
          const acc = custPaidMap.get(inv.customer_id);
          acc.paid_total += Number(inv.amount_paid) || 0;
          if (inv.paid_date && (!acc.last_paid_date || inv.paid_date > acc.last_paid_date)) {
            acc.last_paid_date = inv.paid_date;
          }
          if (!invoicesByCust.has(inv.customer_id)) invoicesByCust.set(inv.customer_id, []);
          invoicesByCust.get(inv.customer_id).push(inv);
          // Overdue: due_date < vandaag EN nog niet volledig betaald.
          const total = Number(inv.amount_total) || 0;
          const paid  = Number(inv.amount_paid)  || 0;
          if (inv.due_date && inv.due_date < todayISO && paid < total) {
            if (!custOverdueMap.has(inv.customer_id)) {
              custOverdueMap.set(inv.customer_id, { count: 0, amount: 0, ids: new Set() });
            }
            const od = custOverdueMap.get(inv.customer_id);
            if (!od.ids.has(inv.id)) {
              od.ids.add(inv.id);
              od.count += 1;
              od.amount += Math.max(0, total - paid);
            }
          }
        }
        // Sorteer per customer op due_date asc.
        for (const arr of invoicesByCust.values()) {
          arr.sort((a, b) => {
            const da = a.due_date || '9999-12-31';
            const db = b.due_date || '9999-12-31';
            return da < db ? -1 : da > db ? 1 : 0;
          });
        }
      }
    }

    // 3) Per bonus-entry de termijnen projecteren.
    // Grouping: event_id → customer_id → projected sale.
    const now    = new Date();
    const thisYm = ymKey(now);
    const nextYm = ymKey(addMonths(now, 1));

    // monthBuckets: 43 maanden — 6 terug t/m 36 vooruit. Veld-naam
    // projection_12m blijft voor backward-compat; de frontend legt er een
    // schuifbaar 12-maands venster overheen. Termijnen buiten dit venster
    // worden hieronder genegeerd (bucket-check `monthAmount.has(k)`).
    // monthPaid + monthOpen splitsen paid/expected voor de cashflow-projectie.
    // monthBreakdown: per maand een lijst met bijdragen ({label, term, amount,
    // status}) voor de hover-tooltip. Lazy gevuld.
    const monthOrder = [];
    const monthAmount = new Map();
    const monthPaid = new Map();
    const monthOpen = new Map();
    const monthBreakdown = new Map();
    for (let i = -6; i <= 36; i++) {
      const k = ymKey(addMonths(now, i));
      monthOrder.push(k);
      monthAmount.set(k, 0);
      monthPaid.set(k, 0);
      monthOpen.set(k, 0);
    }

    const perEventMap = new Map(); // event_id → { event, salesByCust }
    let earned_total = 0;
    let betaald_uit  = 0;
    let open_total   = 0;

    // ── Handmatige trajecten (cashtraject:*) — aparte weergave ─────────────
    // Deze entries hebben GEEN abonnement/factuur. entry.amount ÍS de al
    // vrijgegeven bonus. Herken via idempotency_key-prefix, groepeer per
    // traject_id, verrijk met mentor_cash_trajects (client_label,
    // start_month, release_day, ...), push als één sale-cell per traject
    // in perEventMap en tel op in KPI's (behalve geannuleerde).
    //
    // Regex: 'cashtraject:<uuid>:term:<n>:mentor:<uid>' — trajectId is de
    // 1e capture, termIdx de 2e. Legacy 'cashtraject:<uuid>:term:<n>' zonder
    // mentor-suffix wordt ook geaccepteerd voor backwards-compat.
    const CASHTRAJECT_KEY_RE = /^cashtraject:([0-9a-f-]{36}):term:(\d+)(?::mentor:[0-9a-f-]{36})?$/i;

    const cashByTraject = new Map(); // trajectId → array van entries (deze mentor)
    const regularRows   = [];
    for (const r of rows) {
      const key = r.idempotency_key;
      const m = typeof key === 'string' ? CASHTRAJECT_KEY_RE.exec(key) : null;
      if (m) {
        const tid = m[1];
        if (!cashByTraject.has(tid)) cashByTraject.set(tid, []);
        cashByTraject.get(tid).push({ ...r, _termIdx: Number(m[2]) });
      } else {
        regularRows.push(r);
      }
    }

    // Trajecten ophalen om client_label/term_count/bonus_total etc. te weten.
    const trajectIds = [...cashByTraject.keys()];
    const trajectById = new Map();
    if (trajectIds.length) {
      const { data: ts } = await supabaseAdmin
        .from('mentor_cash_trajects')
        .select('id, client_label, term_count, bonus_total, event_id, start_month, release_day, status')
        .in('id', trajectIds);
      for (const t of (ts || [])) trajectById.set(t.id, t);
    }

    // Ontbrekende events (voor cashtraject-entries met event_id dat nog niet
    // in eventById zit — kan gebeuren als de reguliere fetch dit event niet
    // ophaalde). Aanvullen zodat event_title/starts_at kloppen.
    const missingEventIds = [];
    for (const t of trajectById.values()) {
      if (t.event_id && !eventById.has(t.event_id)) missingEventIds.push(t.event_id);
    }
    if (missingEventIds.length) {
      const { data: evs } = await supabaseAdmin
        .from('events').select('id, title, starts_at').in('id', [...new Set(missingEventIds)]);
      for (const e of evs || []) eventById.set(e.id, e);
    }

    // Per traject een sale-cell bouwen en KPI's optellen.
    for (const [tid, ents] of cashByTraject.entries()) {
      const t = trajectById.get(tid);
      if (!t) {
        // Traject-rij ontbreekt (bv. verwijderd) — sla over met warning-log.
        console.warn('[mentor-bonus-overview] cashtraject entry zonder traject-rij:', tid);
        continue;
      }
      const termCount   = Number(t.term_count) || 1;
      const releaseDay  = Number(t.release_day) || 1;
      const startMonth  = t.start_month;

      // Distincte termijnen die deze mentor al vrij heeft gekregen +
      // amount-per-termijn map (index → entry.amount, laatste wint bij
      // duplicaten wat theoretisch onmogelijk is dankzij idempotency_key).
      const paidTermIdx = new Set();
      const amountByTerm = new Map();
      let mentorShareTotal = 0;
      let mentorShareNonCancelled = 0;   // voor KPI-tellingen
      let hasCancelled = false;
      for (const e of ents) {
        const cancelled = e.status === 'geannuleerd';
        if (cancelled) hasCancelled = true;
        const amt = Number(e.amount) || 0;
        paidTermIdx.add(e._termIdx);
        amountByTerm.set(e._termIdx, amt);
        mentorShareTotal += (cancelled ? 0 : amt);
        if (!cancelled) mentorShareNonCancelled += amt;
      }

      // Fallback per-termijn bedrag (voor nog-niet-vrijgevallen termijnen).
      // Gemiddelde van reeds vrijgevallen entries; als er nog geen zijn:
      // bonus_total / term_count / N-onbekend → conservatief: gebruik
      // bonus_total / term_count als proxy.
      let perTermFallback;
      if (amountByTerm.size > 0) {
        const sum = [...amountByTerm.values()].reduce((s, a) => s + a, 0);
        perTermFallback = round2(sum / amountByTerm.size);
      } else {
        perTermFallback = round2(Number(t.bonus_total || 0) / termCount);
      }

      // Termijnen array bouwen (alle N termijnen; status per termijn).
      const termijnen = [];
      for (let i = 1; i <= termCount; i++) {
        const paid = paidTermIdx.has(i);
        const amt  = paid ? (amountByTerm.get(i) || 0) : perTermFallback;
        termijnen.push({
          index    : i,
          due_date : cashReleaseDate(startMonth, i, releaseDay),
          amount   : round2(amt),
          status   : paid ? 'betaald' : 'open',
        });
      }

      // Cashflow-projectie: handmatige trajecten ook in de maand-buckets
      // (voorheen volledig afwezig). Geannuleerde trajecten
      // (mentorShareNonCancelled <= 0) tellen NIET mee — consistent met KPI-
      // uitsluiting. cashReleaseDate returnt een YYYY-MM-DD string; normaliseer
      // naar Date tijdzone-veilig via `T00:00:00Z`.
      const trajectActive = !(hasCancelled && mentorShareNonCancelled <= 0);
      if (trajectActive) {
        for (const term of termijnen) {
          if (!term.due_date) continue;
          const k = ymKey(new Date(String(term.due_date).slice(0, 10) + 'T00:00:00Z'));
          const amt = round2(Number(term.amount) || 0);
          if (amt <= 0) continue;
          if (term.status === 'betaald') {
            if (monthPaid.has(k)) monthPaid.set(k, round2((monthPaid.get(k) || 0) + amt));
          } else {
            open_total += amt;
            if (monthOpen.has(k)) monthOpen.set(k, round2((monthOpen.get(k) || 0) + amt));
          }
          if (monthAmount.has(k)) monthAmount.set(k, round2((monthAmount.get(k) || 0) + amt));
          if (monthAmount.has(k)) {
            if (!monthBreakdown.has(k)) monthBreakdown.set(k, []);
            monthBreakdown.get(k).push({
              label : t.client_label || '(traject)',
              term  : term.index,
              amount: amt,
              status: term.status === 'betaald' ? 'betaald' : 'verwacht',
            });
          }
        }
      }

      // Sale-status voor de badge.
      let saleStatus;
      if (t.status === 'completed')        saleStatus = 'voltooid';
      else if (t.status === 'paused')      saleStatus = 'pauze';
      else if (paidTermIdx.size >= 1)      saleStatus = 'actief';
      else                                 saleStatus = 'wacht_1e_betaling';
      // Alleen forceren als ALLES geannuleerd is (geen actieve termijnen).
      if (hasCancelled && mentorShareNonCancelled <= 0) saleStatus = 'geannuleerd';

      // KPI-tellingen. Vrijgegeven mentor-amount telt in earned_total +
      // betaald_uit (het is al uitgekeerd/vrijgegeven). Geannuleerde niet.
      earned_total += mentorShareNonCancelled;
      betaald_uit  += mentorShareNonCancelled;

      // Groeperen onder event (event_id vanuit traject).
      const evKey = t.event_id || 'no-event';
      if (!perEventMap.has(evKey)) {
        const ev = eventById.get(t.event_id) || null;
        perEventMap.set(evKey, {
          event_id    : t.event_id || null,
          event_title : ev?.title     || null,
          starts_at   : ev?.starts_at || null,
          _sales      : new Map(),
        });
      }
      const evNode = perEventMap.get(evKey);
      // Sale-key: traject-id (uniek per handmatig traject).
      evNode._sales.set('cashtraject:' + t.id, {
        customer_id        : null,
        customer_label     : t.client_label || '(traject)',
        sale_total_incl    : round2(Number(t.bonus_total) || 0),
        // Volledige traject-bonus over alle N termijnen. mentor_share_total is
        // hier de som van reeds vrijgevallen termijnen (kan lager zijn); UI
        // toont beide zodat totaal én vrijgevallen naast elkaar zichtbaar zijn.
        traject_total_incl : round2(Number(t.bonus_total) || 0),
        mentor_share_total : round2(mentorShareTotal),
        term_count         : termCount,
        per_term_amount    : perTermFallback,
        schema_unknown     : false,
        status             : saleStatus,
        paid_term_count    : paidTermIdx.size,
        first_invoice_paid : paidTermIdx.size >= 1,
        last_payment_date  : null,
        has_overdue        : false,
        overdue_count      : 0,
        overdue_amount     : 0,
        is_cash_traject    : true,
        termijnen,
      });
    }

    for (const r of regularRows) {
      // Geannuleerde entries blijven in de lijst (zichtbaar met grijze
      // 'Geannuleerd'-badge) maar mogen NERGENS meetellen. Effective
      // mentorAmount = 0 → geen invloed op earned_total, betaald_uit,
      // open_total, month-buckets, mentor_share_total. saleStatus wordt
      // hieronder geforceerd op 'geannuleerd'.
      const isCancelled  = r.status === 'geannuleerd';
      // Volledige mentor-aandeel: bij proportional-releases is parent.amount
      // verlaagd (rest); original_amount is het snapshot van vóór de eerste
      // slice. Gebruik dat als "totaal" zodat mentor_share_total consistent
      // het volledige bedrag toont, niet het restbedrag.
      const mentorAmount = isCancelled ? 0
        : (r.original_amount != null ? Number(r.original_amount) : Number(r.amount) || 0);
      const basis        = Number(r.basis) || 0;
      // Reeds vrijgevallen deel op deze parent:
      //   * Klassieke pre-proportional flow: parent zelf op 'vrijgegeven'/
      //     'uitbetaald' → volledige mentorAmount is vrij.
      //   * Proportional flow: parent blijft 'pending'/'wachten_op_betaling'
      //     → som(children) is vrij.
      let entryReleased;
      if (isCancelled) {
        entryReleased = 0;
      } else if (r.status === 'vrijgegeven' || r.status === 'uitbetaald') {
        entryReleased = mentorAmount;
      } else {
        entryReleased = round2(releasedByParent.get(r.id) || 0);
      }
      // KPI-totalen: schema_unknown-entries (zie hieronder) worden UITGESLOTEN
      // omdat er nog geen abonnement bekend is. De klant verschijnt wel in de
      // lijst met een 'geen_abonnement'-badge, maar telt niet mee in de KPI's
      // tot er een schema ingericht is.

      // Combineer subs van de klant tot één sale-schema, afgebakend op de
      // bonus-basis. Reden: bij een AANBETALING staan er altijd 2 subs klaar
      // (aanbetaling = 1 termijn groot bedrag + termijnen-abbo = N × klein
      // bedrag), op verschillende deals maar samen één sale. Oude gedrag
      // (kies laatste-start_date sub) toont "0/1" voor Richiano-achtige
      // sales. We nemen subs op VOLGORDE (start_date asc) op zolang de
      // cumulatieve waarde de bonus-basis niet significant overschrijdt
      // (5% marge). Zo horen aanbetaling + termijnen samen (samen ≈ basis);
      // een ECHT losse tweede sale (basis zou ver overschreden worden)
      // wordt NIET meegesleept. Fallback zonder basis: laatste-start_date
      // sub (oude gedrag) — voorkomt regressies bij klanten zonder basis.
      // Randgeval multi-sale klant: bij >1 sale per customer kan de custPaid-
      // route (nbPaid) facturen van meerdere sales bevatten; de basis-marge
      // hier voorkomt dat de subs samensmelten. Exactheid verbetert zodra de
      // wizard-flow alles onder één deal zet.
      const customerDeals = dealsByCust.get(r.customer_id) || [];
      const allCustSubs = [];
      for (const d of customerDeals) {
        const s = subByDeal.get(d.id);
        if (s) allCustSubs.push(s);
      }
      allCustSubs.sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));

      // #625-regressie-fix: filter cancelled subs eruit vóór de combinatie
      // zodat een geannuleerde aanbetaling-sub niet als leidend gekozen wordt
      // en niet meetelt in sale_total_incl/termCount. Als ALLE subs cancelled
      // zijn: val terug op allCustSubs zodat de sale nog getoond wordt als
      // geannuleerd (zie subCancelled hieronder).
      const activeSubs = allCustSubs.filter(
        (s) => String(s.status || '').toLowerCase() !== 'cancelled'
      );
      const subsPool = activeSubs.length > 0 ? activeSubs : allCustSubs;

      let subsForSale = [];
      let saleTotalFromSubs = 0;
      if (basis > 0 && subsPool.length > 0) {
        const cap = basis * 1.05;
        let cum = 0;
        for (const s of subsPool) {
          const w = (inclPerTerm(s) || 0) * (Number(s.term_count) || 0);
          if (subsForSale.length > 0 && cum + w > cap) break;
          subsForSale.push(s);
          cum += w;
          if (cum >= cap) break;
        }
        saleTotalFromSubs = round2(cum);
      }
      if (subsForSale.length === 0) {
        // Fallback: laatste-start_date sub (oude gedrag).
        let latest = null;
        for (const s of subsPool) {
          if (!latest || String(s.start_date || '') > String(latest.start_date || '')) latest = s;
        }
        if (latest) {
          subsForSale = [latest];
          saleTotalFromSubs = round2((inclPerTerm(latest) || 0) * (Number(latest.term_count) || 0));
        }
      }
      // Leidende sub = eerste chronologisch (bij aanbetaling-patroon: de
      // aanbetaling; anders de enige sub).
      const sub = subsForSale[0] || null;

      // Schema bepalen. combinedTermCount = som van term_counts van de
      // meegenomen subs. Fallback bij ontbrekend schema: 1 termijn met
      // due_date = invoice-issue OF ledger-created_at, status afgeleid van
      // ledger-status zodat de UI iets toont.
      let combinedTermCount = 0;
      for (const s of subsForSale) combinedTermCount += (Number(s.term_count) || 0);
      let termCount    = combinedTermCount > 0 ? combinedTermCount : null;
      const perTermInc = inclPerTerm(sub);
      const cycleMo    = billingCycleMonths(sub?.billing_cycle);
      const startStr   = sub?.start_date || null;
      let startDate    = startStr ? new Date(startStr) : null;
      if (!startDate || isNaN(startDate.getTime())) startDate = new Date(r.created_at);
      const schemaUnknown = !sub || !termCount || termCount < 1 || !perTermInc;

      if (schemaUnknown) {
        termCount = 1;
      }

      // Per-termijn-bonus:
      //   * enkele sub of geen combined: mentor × (per_term_incl / basis).
      //   * combined multi-sub: mentor / termCount (proxy — individuele
      //     termijnen kunnen andere waardes hebben; echte factuur-due_date
      //     + amount worden per termijn overrulet via invList[i]).
      let perTermMentor;
      if (schemaUnknown || basis <= 0) {
        perTermMentor = mentorAmount;
      } else if (subsForSale.length > 1) {
        perTermMentor = mentorAmount / termCount;
      } else {
        perTermMentor = (mentorAmount * perTermInc) / basis;
      }

      // Aantal betaalde termijnen — twee routes, we nemen het maximum:
      //
      //   (A) source_invoice_id-route (bestaand): invoice.amount_paid /
      //       per_term_incl. Werkt voor normale sales waar de bonus-entry
      //       een concrete invoice-koppeling heeft.
      //
      //   (B) klant/subscription-route (nieuw): totaal betaald bedrag op
      //       de subscription (invoices.tl_subscription_id) of anders alle
      //       facturen van de klant. Vangt HISTORISCHE bonussen (van het
      //       event-tool) op waar source_invoice_id NULL is en de klant
      //       toch al betaald heeft.
      //
      // Zonder schema (schemaUnknown) blijft de fallback: ledger-status
      // 'uitbetaald' → 1, anders 0. Beide routes doen niks extra bij
      // schemaUnknown / perTermInc<=0.
      const invoice  = invoiceById.get(r.source_invoice_id) || null;
      const paidAmt  = Number(invoice?.amount_paid) || 0;

      // Route B: totaal betaald — MAX van subscription- en customer-route.
      // Waarom max en niet else-if: als de subscription 1 gekoppelde betaalde
      // factuur heeft (bv. eerste termijn) maar volgende termijnen komen
      // binnen als klant-facturen ZONDER tl_subscription_id, mist een pure
      // else-if die vervolg-betalingen. Customer-route bevat álle klant-
      // facturen (incl. de gekoppelde) en is dus altijd ≥ sub-route.
      // Randgeval: bij klanten met meerdere sales/subs telt de customer-
      // route facturen van alle sales — nbPaid wordt echter door
      // Math.min(termCount, …) begrensd tot de termijnen van deze sale, en
      // exacter wordt het pas als wizard-subs consequent gekoppeld zijn.
      let paidTotalFromInvs = 0;
      let lastPaidFromInvs  = null;
      {
        const subKey  = sub?.teamleader_subscription_id || null;
        const subAcc  = subKey ? subPaidMap.get(subKey) : null;
        const custAcc = r.customer_id ? custPaidMap.get(r.customer_id) : null;
        const subPaid  = (subAcc  && subAcc.paid_total  > 0) ? subAcc.paid_total  : 0;
        const custPaid = (custAcc && custAcc.paid_total > 0) ? custAcc.paid_total : 0;
        paidTotalFromInvs = Math.max(subPaid, custPaid);
        // last_paid_date: kies de datum uit de route met het hoogste bedrag
        // (typisch = de recentste betaling). Fallback op de andere route.
        lastPaidFromInvs  =
          (custPaid >= subPaid ? custAcc?.last_paid_date : subAcc?.last_paid_date)
          || subAcc?.last_paid_date || custAcc?.last_paid_date || null;
      }

      // Bepaal factuur-lijst (invList) vóór nbPaid, want nbPaid telt nu het
      // aantal daadwerkelijk (volledig) betaalde facturen — niet de bedrag/
      // termijn-deling die bij grote aanbetalingen 12/12 forceerde.
      // Bron van waarheid = ECHTE facturen. Termijn i wordt gematcht op de i-de
      // factuur in de op due_date gesorteerde lijst; die factuur bepaalt due_date
      // + betaal-status. We kiezen bewust de COMPLEETSTE van invoicesBySub en
      // invoicesByCust (langste lijst wint; gelijkspel → sub, dan preciezer).
      // Reden: bij klanten waar sommige facturen wel en andere niet aan de sub
      // gekoppeld zijn (tl_subscription_id=NULL op deel), is de sub-lijst
      // incompleet maar niet leeg — pure "sub-tenzij-leeg" zou dan de rest van
      // de termijnen op berekende datums laten vallen en ze onterecht
      // 'achterstallig' maken.
      // Randgeval multi-sale klant: bij >1 sale per customer kan invoicesByCust
      // facturen van meerdere sales bevatten (langer, maar niet 1-op-1). Voor
      // de nu bekende gevallen (1 sale, deels ongekoppelde facturen) is
      // "completere lijst" correct; de exactheid verbetert zodra facturen
      // consequent aan de sub gekoppeld zijn (wizard-flow).
      const subKeyForTerm = sub?.teamleader_subscription_id || null;
      const invListSub    = subKeyForTerm ? (invoicesBySub.get(subKeyForTerm) || null) : null;
      const invListCust   = r.customer_id ? (invoicesByCust.get(r.customer_id) || null) : null;
      const subLen        = invListSub  ? invListSub.length  : 0;
      const custLen       = invListCust ? invListCust.length : 0;
      const invList       = (custLen > subLen) ? invListCust : (invListSub || invListCust);

      // nbPaid = aantal VOLLEDIG betaalde facturen (niet bedrag/perTerm).
      // Bij een grote aanbetaling (bv. Cedric: €4000 + €266/mnd) zou de oude
      // bedrag-deling €4266 / €266 ≈ 16 → geklampt op termCount → 12/12 tonen
      // terwijl er echt maar 2 facturen betaald zijn. Factuur-telling voorkomt
      // dat: 1 aanbetaling + 1 termijn = 2 betaalde facturen = 2/N.
      let nbPaid;
      if (schemaUnknown || perTermInc <= 0) {
        // Fallback: gebruik ledger-status — 'uitbetaald'=1, anders 0.
        nbPaid = r.status === 'uitbetaald' ? 1 : 0;
      } else if (invList && invList.length) {
        const paidCount = invList.filter((inv) => {
          const tot = Number(inv.amount_total) || 0;
          const pd  = Number(inv.amount_paid)  || 0;
          return tot > 0 && pd + 0.005 >= tot;
        }).length;
        nbPaid = Math.max(0, Math.min(termCount, paidCount));
      } else {
        // Geen factuurlijst → oude bedrag-deling als fallback.
        const nbPaidA = Math.max(0, Math.min(termCount, Math.floor((paidAmt            + 0.005) / perTermInc)));
        const nbPaidB = Math.max(0, Math.min(termCount, Math.floor((paidTotalFromInvs  + 0.005) / perTermInc)));
        nbPaid = Math.max(nbPaidA, nbPaidB);
      }

      // KPI-earned + betaald_uit — schema-unknown entries niet meetellen.
      if (!schemaUnknown) {
        earned_total += mentorAmount;
        if (r.status === 'uitbetaald') betaald_uit += mentorAmount;
      }

      // Genereer termijnen.
      // Bij ontbrekende factuur voor termijn i (toekomstige termijn die nog niet
      // is aangemaakt), fallback op de berekende addMonths-datum + nbPaid-teller.

      const termijnen = [];
      for (let i = 0; i < termCount; i++) {
        const calcDate = addMonths(startDate, i * cycleMo);
        const calcYmd  = calcDate.toISOString().slice(0, 10);
        const tAmount  = round2(perTermMentor);

        const invForTerm = (invList && i < invList.length) ? invList[i] : null;

        let effectiveYmd;
        let isPaidTerm;
        let bucketDate;
        if (invForTerm) {
          effectiveYmd = invForTerm.due_date || calcYmd;
          const total  = Number(invForTerm.amount_total) || 0;
          const paid   = Number(invForTerm.amount_paid)  || 0;
          isPaidTerm   = total > 0 && paid + 0.005 >= total;
          bucketDate   = invForTerm.due_date ? new Date(invForTerm.due_date + 'T00:00:00Z') : calcDate;
        } else {
          effectiveYmd = calcYmd;
          isPaidTerm   = i < nbPaid;
          bucketDate   = calcDate;
        }

        // Status: 'betaald' | 'achterstallig' (open + due voorbij) | 'open' (toekomst).
        let tStatus;
        if (isPaidTerm)                    tStatus = 'betaald';
        else if (effectiveYmd < todayISO)  tStatus = 'achterstallig';
        else                                tStatus = 'open';

        termijnen.push({
          index   : i + 1,
          due_date: effectiveYmd,
          amount  : tAmount,
          status  : tStatus,
        });
        // Cashflow-projectie: vul zowel monthPaid (betaalde termijnen, historie)
        // als monthOpen (openstaande termijnen, toekomst). open_total blijft
        // ALLEEN open termijnen (KPI ongewijzigd). monthAmount = paid+open per
        // maand (backward-compat). monthBreakdown: per bijdrage (voor tooltip).
        if (!schemaUnknown) {
          const k = ymKey(bucketDate);
          if (isPaidTerm) {
            if (monthPaid.has(k)) monthPaid.set(k, round2((monthPaid.get(k) || 0) + tAmount));
          } else {
            open_total += tAmount;
            if (monthOpen.has(k)) monthOpen.set(k, round2((monthOpen.get(k) || 0) + tAmount));
          }
          if (monthAmount.has(k)) monthAmount.set(k, round2((monthAmount.get(k) || 0) + tAmount));
          if (tAmount > 0 && monthAmount.has(k)) {
            const custObj = r.customer_id ? customerById.get(r.customer_id) : null;
            if (!monthBreakdown.has(k)) monthBreakdown.set(k, []);
            monthBreakdown.get(k).push({
              label : customerLabel(custObj),
              term  : i + 1,
              amount: round2(tAmount),
              status: isPaidTerm ? 'betaald' : 'verwacht',
            });
          }
        }
      }

      // Status-afleiding voor UI-badges.
      //   schema_unknown          → 'geen_abonnement'
      //   sub.status='cancelled'  → 'geannuleerd'
      //   alle termijnen betaald  → 'voltooid'
      //   ≥1 termijn betaald      → 'actief'
      //   0 betaald + 0 facturen verstuurd + startdatum in toekomst
      //                            → 'wacht_op_start' (met datum in badge)
      //   anders (0 betaald)      → 'wacht_1e_betaling'
      // Startdatum-detectie: sub.start_date primair; fallback = due_date van
      // de vroegste factuur voor deze sale (invList[0]).
      const firstInvoiceSent = !!(invList && invList.length > 0);
      const firstInvoiceDue  = firstInvoiceSent ? (invList[0].due_date || null) : null;
      const saleStartYmd     = sub?.start_date || firstInvoiceDue || null;
      let saleStatus;
      // Alleen 'geannuleerd' als ALLE actieve subs weg zijn (= activeSubs
      // leeg). Zo blijft een sale met 1 cancelled aanbetaling + 1 actieve
      // termijnen-sub gewoon lopend/actief.
      const subCancelled = activeSubs.length === 0 && allCustSubs.length > 0;
      if (schemaUnknown)          saleStatus = 'geen_abonnement';
      else if (subCancelled)      saleStatus = 'geannuleerd';
      else if (nbPaid >= termCount && termCount > 0) saleStatus = 'voltooid';
      else if (nbPaid >= 1)       saleStatus = 'actief';
      else if (!firstInvoiceSent && saleStartYmd && saleStartYmd > todayISO) saleStatus = 'wacht_op_start';
      else                        saleStatus = 'wacht_1e_betaling';
      // Geannuleerde ledger-entry overschrijft alle andere status-afleiding:
      // sale is zichtbaar in de lijst met de grijze 'Geannuleerd'-badge en
      // telt nergens mee (mentorAmount was al 0).
      if (isCancelled) saleStatus = 'geannuleerd';

      // Extra afgeleide velden voor de UI. last_payment_date valt eerst
      // terug op de source_invoice_id.paid_date; als die er niet is,
      // pakken we de laatste betaaldatum uit de klant/subscription-route.
      // Bij een GEANNULEERDE sale (isCancelled OF subCancelled OF
      // saleStatus='geannuleerd') GEEN groene '1e factuur betaald'-badge
      // tonen — de sale is niet meer geldig, betaling doet niet ter zake.
      const firstInvoicePaid = (isCancelled || saleStatus === 'geannuleerd') ? false : (nbPaid >= 1);
      let lastPaymentDate = null;
      if (nbPaid >= 1) {
        lastPaymentDate = invoice?.paid_date || lastPaidFromInvs || null;
      }
      // Overdue (betalingsachterstand). Klant-breed omdat de mentor elke
      // openstaande factuur op de klant wil zien, niet alleen degene die
      // aan deze sale gekoppeld is.
      const overdueAcc = r.customer_id ? custOverdueMap.get(r.customer_id) : null;
      const overdueCount  = overdueAcc?.count  || 0;
      const overdueAmount = round2(overdueAcc?.amount || 0);
      const hasOverdue    = overdueCount > 0;

      // Groeperen onder event → sale (customer_id).
      const evKey = r.event_id || 'no-event';
      if (!perEventMap.has(evKey)) {
        const ev = eventById.get(r.event_id) || null;
        perEventMap.set(evKey, {
          event_id    : r.event_id || null,
          event_title : ev?.title     || null,
          starts_at   : ev?.starts_at || null,
          _sales      : new Map(),
        });
      }
      const evNode = perEventMap.get(evKey);
      const saleKey = r.customer_id || ('att:' + (r.attendee_id || r.id));
      if (!evNode._sales.has(saleKey)) {
        const cust = customerById.get(r.customer_id) || null;
        evNode._sales.set(saleKey, {
          customer_id        : r.customer_id || null,
          customer_label     : customerLabel(cust),
          sale_total_incl    : round2(saleTotalFromSubs > 0 ? saleTotalFromSubs : (perTermInc * termCount)),
          mentor_share_total : round2(mentorAmount),
          released_share     : round2(entryReleased),
          term_count         : termCount,
          per_term_amount    : round2(perTermMentor),
          schema_unknown     : schemaUnknown,
          // Nieuw (per-klant status + voortgang):
          status             : saleStatus,
          start_date         : saleStartYmd,
          paid_term_count    : nbPaid,
          first_invoice_paid : firstInvoicePaid,
          last_payment_date  : lastPaymentDate,
          // Betalingsachterstand (klant-breed):
          has_overdue        : hasOverdue,
          overdue_count      : overdueCount,
          overdue_amount     : overdueAmount,
          termijnen,
        });
      } else {
        // Meerdere bonus-rijen op zelfde sale (bv. extra entry): tel mentor-aandeel
        // op en breid de termijnen-array niet uit (zelfde schema).
        const cell = evNode._sales.get(saleKey);
        cell.mentor_share_total = round2(cell.mentor_share_total + mentorAmount);
        cell.released_share     = round2((cell.released_share || 0) + entryReleased);
        // Als er een nieuwere betaling is (paid_date), bewaar de laatste.
        if (lastPaymentDate && (!cell.last_payment_date || lastPaymentDate > cell.last_payment_date)) {
          cell.last_payment_date = lastPaymentDate;
        }
      }
    }

    // Per-event array bouwen.
    const per_event = Array.from(perEventMap.values())
      .map((n) => ({
        event_id    : n.event_id,
        event_title : n.event_title,
        starts_at   : n.starts_at,
        sales       : Array.from(n._sales.values()),
      }))
      .sort((a, b) => (b.starts_at || '').localeCompare(a.starts_at || ''));

    // 12-maands projectie array — per maand paid + expected + totaal + breakdown.
    // breakdown: top 12 bijdragen (hoogste eerst) + rest_count/rest_amount voor
    // maanden met meer dan 12 bijdragen, om de response-grootte te beperken.
    const BREAKDOWN_CAP = 12;
    const projection_12m = monthOrder.map((k) => {
      const list = (monthBreakdown.get(k) || []).slice().sort((a, b) => b.amount - a.amount);
      let breakdown = list;
      let rest_count = 0;
      let rest_amount = 0;
      if (list.length > BREAKDOWN_CAP) {
        breakdown = list.slice(0, BREAKDOWN_CAP);
        const rest = list.slice(BREAKDOWN_CAP);
        rest_count = rest.length;
        rest_amount = round2(rest.reduce((s, x) => s + (Number(x.amount) || 0), 0));
      }
      return {
        month   : k,
        amount  : round2((monthPaid.get(k) || 0) + (monthOpen.get(k) || 0)),
        paid    : round2(monthPaid.get(k) || 0),
        expected: round2(monthOpen.get(k) || 0),
        breakdown,
        rest_count,
        rest_amount,
      };
    });

    const deze_maand     = round2(monthAmount.get(thisYm) || 0);
    const volgende_maand = round2(monthAmount.get(nextYm) || 0);

    // Cashflow-KPI's:
    //   cf_received   = som paid t/m huidige maand (verleden + deze maand betaald)
    //   cf_this_month = paid + expected van deze maand
    //   cf_expected   = alles wat de mentor nog moet krijgen = som parent-status
    //     pending + vrijgegeven − uitbetaald. Geannuleerde parents tellen niet
    //     mee. Zo pakt de KPI ook achterstallige open termijnen uit het verleden
    //     én vrijgegeven-maar-nog-niet-uitbetaalde bonussen (die met de oude
    //     monthOpen-som gemist werden).
    let cf_received = 0;
    for (const k of monthOrder) {
      if (k <= thisYm) cf_received += (monthPaid.get(k) || 0);
    }
    let cf_expected = 0;
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (r.status === 'pending' || r.status === 'vrijgegeven') cf_expected += amt;
      else if (r.status === 'uitbetaald')                       cf_expected -= amt;
      // 'geannuleerd' telt niet mee
    }
    cf_expected = round2(cf_expected);
    const cf_this_month = round2((monthPaid.get(thisYm) || 0) + (monthOpen.get(thisYm) || 0));

    return {
      ok: true,
      scope: 'self',
      totals: {
        earned_total: round2(earned_total),
        betaald_uit : round2(betaald_uit),
        open        : round2(open_total),
        deze_maand,
        volgende_maand,
        cf_received : round2(cf_received),
        cf_this_month,
        cf_expected,
      },
      projection_12m,
      per_event,
    };
}

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

  // Dual-gate: ?mentor_user_id=… → admin-pad (mentor.admin.view);
  // afwezig → self-pad (mentor.module.access, auth.uid()).
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) {
      return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    }
    if (!(await requirePermission(req, 'mentor.admin.view'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    }
    effectiveUserId = requestedMentorId;
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    }
    effectiveUserId = user.id;
  }

  try {
    const out = await computeBonusOverview(effectiveUserId);
    return res.status(200).json(out);
  } catch (e) {
    console.error('[mentor-bonus-overview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
