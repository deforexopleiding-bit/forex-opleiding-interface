// api/sales-subscription-create.js
// POST { deal_id, tl_department_id, first_call_at, subscriptions[], sync_to_tl }
// Wizard 2: maakt meerdere subscriptions (+ optionele bonus) lokaal aan en
// pusht ze best-effort naar TL. Permission: sales.deal.create.
//
// subscriptions[]: {
//   description, start_date, end_date, term_count,
//   line_items: [{ description, amount, vat_percentage }]   // amount = EXCL BTW
// }
// Backwards-compat: een sub zonder line_items mag nog { amount, vat_percentage }
// aanleveren — dat wordt één synthetische regel.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { getOrCreateTlCustomer } from './_lib/teamleader-contact.js';
import { taxRateIdFor } from './_lib/teamleader-quotation.js';
import { createTlInvoice } from './_lib/invoice-create-core.js';
import { assertStartDateNotTooEarly } from './_lib/onboarding-start-date.js';

// Offerte-beveiliging bouwstap 2/2 — €100 reserveringsfee bij late-start-
// uitzondering met fee-akkoord. Fee is INCL. btw; excl. wordt afgeleid van
// het hoogste btw-tarief in de deal-regels. Vast bedrag hier; kan later
// naar app_settings verhuizen zonder API-shape wijziging.
const RESERVATION_FEE_INCL = 100;

// Server-side spiegel van _daysBetweenTodayAnd() in modules/sales-wizard.html
// (regel 1604-1612). Exact zelfde formule (Date.UTC + Math.round op /86400000)
// zodat de late-start-guard hieronder 1-op-1 dezelfde uitkomst geeft als de
// wizard-UI voor identieke input. Returnt null bij onbekend/misvormd formaat.
function _daysBetweenTodayAnd(dateIso) {
  const s = String(dateIso || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  const now    = new Date();
  const today  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86400000);
}

// Haal de late-start-drempel uit app_settings (sales_max_start_days). De
// waarde-shape in app_settings varieert historisch (raw number, string, of
// jsonb { days: N }); alle drie ondersteunen we. Fallback 40 als de key
// ontbreekt of niet-parseerbaar is — zelfde default als de wizard-UI.
async function _resolveMaxStartDays(admin) {
  try {
    const { data: setting } = await admin.from('app_settings')
      .select('value').eq('key', 'sales_max_start_days').maybeSingle();
    const raw = setting?.value;
    let parsed = null;
    if (typeof raw === 'number' && Number.isFinite(raw)) parsed = raw;
    else if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.days))) parsed = Number(raw.days);
    else if (typeof raw === 'string' && Number.isFinite(Number(raw))) parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch (_) { /* fallback */ }
  return 40;
}

// Normaliseer een sub naar een line_items-array (backwards-compat met oude
// single-amount payloads). Returnt altijd een array (mogelijk leeg na filter).
function normalizeLineItems(s) {
  if (Array.isArray(s.line_items) && s.line_items.length) {
    return s.line_items
      .map(li => ({
        description: li.description || s.description || 'Abonnement',
        amount: Number(li.amount) || 0,
        vat_percentage: li.vat_percentage ?? 21,
        product_id: li.product_id || null,
      }))
      .filter(li => li.amount > 0);
  }
  // Legacy: één regel uit amount + vat_percentage.
  const amt = Number(s.amount) || 0;
  return amt > 0 ? [{ description: s.description || 'Abonnement', amount: amt, vat_percentage: s.vat_percentage ?? 21, product_id: null }] : [];
}

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

  const { deal_id, mode, customer_data = {}, matched_customer_id, tl_imported_contact_id,
          sale_type, tl_department_id, first_call_at, subscriptions = [], sync_to_tl = false } = req.body || {};
  const standalone = mode === 'standalone' || !deal_id;
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) return res.status(400).json({ error: 'minimaal 1 abonnement vereist' });

  try {
    // Elke sub naar regels normaliseren + valideren dat er een bedrag in zit.
    const subsNorm = subscriptions.map(s => ({ ...s, _lines: normalizeLineItems(s) }));
    for (const s of subsNorm) {
      if (!s._lines.length) return res.status(400).json({ error: `Abonnement "${s.description || ''}" heeft geen regel met bedrag > 0` });
    }

    // Ondergrens-gate (#816-consistent): elke sub-startdatum >= vandaag+3
    // kalenderdagen NL. Voorkomt dat een subscription in het verleden start
    // (Bubble payment-buffer + factuur-buffer -3d zouden anders historisch
    // vallen). Bewuste keuze: NIET stil clampen, 400 met sub-index zodat de
    // wizard-user weet welke sub aangepast moet worden.
    for (let i = 0; i < subsNorm.length; i++) {
      const s = subsNorm[i];
      if (!s.start_date) {
        return res.status(400).json({
          error: `Abonnement "${s.description || ''}" (index ${i}) mist start_date`,
          field: 'subscriptions[' + i + '].start_date',
          code:  'START_DATE_MISSING',
        });
      }
      const tooEarly = assertStartDateNotTooEarly(s.start_date);
      if (tooEarly) {
        return res.status(400).json({
          error: `Abonnement "${s.description || ''}" (index ${i}): ${tooEarly.message}`,
          code:  tooEarly.code,
          field: 'subscriptions[' + i + '].start_date',
          min:   tooEarly.min,
          got:   tooEarly.got,
        });
      }
    }

    // ── Late-start-server-side guard ──
    // Spiegelt _detectExceptions (modules/sales-wizard.html regel 1668-1677):
    // vroegste sub-startdatum > app_settings.sales_max_start_days ⇒ late start.
    // Bij late start MOET er ofwel (a) een gemarkeerde deal zijn met
    // exception_flagged=true, 'late_start' in exception_reasons én
    // exception_fee_agreed=true (dan boekt de bestaande fee-invoice-flow
    // hieronder de €100), ofwel de startdatum moet aangepast worden.
    //
    // Zonder deze guard kunnen deals die BUITEN de wizard om ontstaan zijn
    // (bv. import, admin-flow, standalone-abo) stilletjes een late start
    // krijgen zonder dat de €100 reserveringsfee wordt geboekt — dat gat
    // dichten we hier. De bestaande fee-logica hieronder is de ENIGE plek
    // die de €100 boekt; deze guard voegt niets extra toe qua geld.
    let deal = null, dealId = null;
    {
      const earliestStartIso = subsNorm
        .map((s) => (typeof s.start_date === 'string' && s.start_date) ? String(s.start_date).slice(0, 10) : null)
        .filter(Boolean)
        .sort()[0] || null;
      if (earliestStartIso) {
        const maxDays     = await _resolveMaxStartDays(supabaseAdmin);
        const daysToStart = _daysBetweenTodayAnd(earliestStartIso);
        const isLateStart = Number.isFinite(daysToStart) && daysToStart > maxDays;
        if (isLateStart) {
          const errMsg  = `Late start (>${maxDays} dagen) gedetecteerd maar geen reserveringsfee afgesproken — bevestig de €100 in de offerte of pas de startdatum aan.`;
          const errBody = { error: errMsg, code: 'LATE_START_NO_FEE', details: { earliest_start_date: earliestStartIso, days_to_start: daysToStart, max_days: maxDays } };
          if (standalone) {
            // Standalone-abo heeft geen offerte-context met exception-vlag →
            // altijd blokkeren zodra late start.
            return res.status(422).json(errBody);
          }
          // Deal-modus: fetch de deal om de vlag te checken. We hergebruiken
          // dit `deal`-object hieronder zodat we niet nogmaals fetchen.
          const { data: d } = await supabaseAdmin.from('deals').select('*').eq('id', deal_id).maybeSingle();
          if (!d) return res.status(404).json({ error: 'Deal niet gevonden' });
          deal = d; dealId = d.id;
          const reasons = String(d.exception_reasons || '');
          const feeAgreedForLate = !!d.exception_flagged
            && reasons.split(',').map((r) => r.trim()).includes('late_start')
            && !!d.exception_fee_agreed;
          if (!feeAgreedForLate) return res.status(422).json(errBody);
        }
      }
    }

    // ── Deal resolven: bestaande deal (uit Wizard 1) OF ghost-deal (standalone) ──
    // Als de late-start-guard hierboven de deal al gefetcht heeft (non-standalone
    // + late-start-met-vlag) staan `deal` en `dealId` al gezet; anders fetchen
    // we hem nu op de reguliere manier.
    if (!standalone) {
      if (!deal) {
        const { data: d } = await supabaseAdmin.from('deals').select('*').eq('id', deal_id).maybeSingle();
        if (!d) return res.status(404).json({ error: 'Deal niet gevonden' });
        deal = d; dealId = d.id;
      }
    } else {
      // Bedrijfsentiteit valideren.
      if (tl_department_id) {
        const { data: ent } = await supabaseAdmin.from('company_entities')
          .select('tl_department_id').eq('tl_department_id', tl_department_id).eq('is_active', true).maybeSingle();
        if (!ent) return res.status(400).json({ error: 'Ongeldige bedrijfsentiteit (tl_department_id)' });
      }
      // Klant: hergebruik OF aanmaken.
      let customerId = matched_customer_id || null;
      if (!customerId) {
        const custPayload = {
          first_name: customer_data.first_name || null, last_name: customer_data.last_name || null,
          email: customer_data.email || null, phone: customer_data.phone || null,
          date_of_birth: customer_data.date_of_birth || null,
          address_street: customer_data.address_street || null, address_number: customer_data.address_number || null,
          address_postal: customer_data.address_postal || null, address_city: customer_data.address_city || null,
          address_country: (customer_data.address_country === 'BE' ? 'BE' : (customer_data.address_country === 'NL' ? 'NL' : null)),
          tl_contact_id: tl_imported_contact_id || null, created_by_user_id: user.id,
        };
        const { data: cust, error: cErr } = await supabaseAdmin.from('customers').insert(custPayload).select('id').single();
        if (cErr) {
          if (cErr.code === '23505') return res.status(409).json({ error: 'Email reeds in gebruik' });
          throw cErr;
        }
        customerId = cust.id;
      }
      // Ghost-deal (geen offerte): subs hangen altijd onder een deal.
      const totalExcl = subsNorm.reduce((sum, s) => sum + s._lines.reduce((a, li) => a + (Number(li.amount) || 0) * (Number(s.term_count) || 1), 0), 0);
      const earliestStart = subsNorm.map(s => s.start_date).filter(Boolean).sort()[0] || new Date().toISOString().slice(0, 10);
      const { data: gd, error: gdErr } = await supabaseAdmin.from('deals').insert({
        customer_id: customerId, total_amount: Math.round(totalExcl * 100) / 100,
        start_date: earliestStart, status: 'active', sales_user_id: user.id,
        source: 'subscription_only', tl_department_id: tl_department_id || null,
        sale_type: sale_type || 'domestic', tl_push_status: 'not_pushed', tl_quotation_status: 'no_quotation',
      }).select('*').single();
      if (gdErr) throw gdErr;
      deal = gd; dealId = gd.id;
    }
    const departmentId = tl_department_id || deal.tl_department_id || null;

    // Pre-flight: bij TL-sync de tax_rate_id's per regel vóóraf valideren, zodat
    // een ontbrekende env-var een duidelijke 422 geeft VÓÓR er lokaal subs worden
    // aangemaakt (consistent met Wizard 1, geen partial state).
    if (sync_to_tl) {
      try {
        for (const s of subsNorm) for (const li of s._lines) taxRateIdFor(li.vat_percentage, departmentId, deal.sale_type);
      } catch (e) {
        return res.status(422).json({ error: e.message });
      }
    }

    // ── Offerte-beveiliging bouwstap 2/2 — €100 reserveringsfee ──
    // Aftrap VÓÓR de subs worden aangemaakt zodat een falende factuur de
    // abbo-flow blokkeert (alles-of-niets: geen half werk). Idempotent op
    // deals.reservation_fee_invoice_id: bij retry wordt geen tweede factuur
    // gemaakt. Alleen bij deal-modus (standalone-abbo heeft geen offerte
    // met exception-context).
    if (!standalone) {
      const reasons  = String(deal?.exception_reasons || '');
      const feeDue   = !!deal?.exception_flagged
                    && reasons.split(',').map(s => s.trim()).includes('late_start')
                    && !!deal?.exception_fee_agreed
                    && !deal?.reservation_fee_invoice_id;
      if (feeDue) {
        // 1. Hoogste btw-tarief uit de deal-regels (fallback 21).
        const { data: dealLines } = await supabaseAdmin.from('deal_line_items')
          .select('vat_percentage').eq('deal_id', dealId);
        const rates = (dealLines || [])
          .map(l => Number(l.vat_percentage))
          .filter(v => Number.isFinite(v));
        const topVat = rates.length ? Math.max(...rates) : 21;
        // 2. Klant + department resolven voor de factuur.
        const { data: feeCustomer } = await supabaseAdmin.from('customers')
          .select('id, is_company, company_name, first_name, last_name, email, phone, tl_contact_id, tl_company_id, address_street, address_number, address_postal, address_city, address_country')
          .eq('id', deal.customer_id).maybeSingle();
        if (!feeCustomer) return res.status(404).json({ error: 'Klant niet gevonden bij fee-factuur' });
        const feeDeptId = departmentId || deal.tl_department_id;
        if (!feeDeptId) return res.status(422).json({ error: 'Fee-factuur mislukt: geen bedrijfsentiteit gekoppeld aan de deal.' });
        // 3. €100 incl → excl afleiden met hoogste tarief.
        const unitExcl = Math.round((RESERVATION_FEE_INCL / (1 + topVat / 100)) * 100) / 100;
        // 4. Boeken + versturen via de gedeelde helper.
        let feeRes;
        try {
          feeRes = await createTlInvoice({
            customer:     feeCustomer,
            departmentId: feeDeptId,
            lines: [{
              description:     'Reserveringsfee (reservering startdatum)',
              quantity:        1,
              unit_price_excl: unitExcl,
              vat_percentage:  topVat,
            }],
            action: 'book_and_send',
            opts:   { saleType: deal.sale_type || 'domestic', language: 'nl' },
          });
        } catch (e) {
          // Draft/network/link-fout → hard blokkeren, geen abbo aanmaken.
          console.error('[sub-create] fee-factuur draft-fout', e.stage, e.message);
          return res.status(e.stage === 'draft_network' ? 502 : 422).json({
            error: 'Reserveringsfee-factuur mislukt: ' + e.message,
            stage: e.stage || null,
          });
        }
        if (!feeRes.booked || !feeRes.sent) {
          // Book of send is mislukt → abbo NIET aanmaken; nette foutmelding.
          console.error('[sub-create] fee-factuur book/send mislukt', { booked: feeRes.booked, sent: feeRes.sent, bookErr: feeRes.bookErr, sendErr: feeRes.sendErr });
          return res.status(422).json({
            error:  'Reserveringsfee-factuur is niet geboekt of niet verstuurd — abonnement niet aangemaakt.',
            booked: feeRes.booked,
            sent:   feeRes.sent,
            bookErr: feeRes.bookErr,
            sendErr: feeRes.sendErr,
            tl_invoice_id: feeRes.tl_invoice_id,
          });
        }
        // 5. Idempotentie-marker: lokale invoice-id opslaan op de deal.
        await supabaseAdmin.from('deals')
          .update({ reservation_fee_invoice_id: feeRes.invoice_id || feeRes.tl_invoice_id })
          .eq('id', dealId);
        deal.reservation_fee_invoice_id = feeRes.invoice_id || feeRes.tl_invoice_id;
      }
    }

    // 1. Deal bijwerken (1e call).
    await supabaseAdmin.from('deals').update({ first_call_at: first_call_at || null }).eq('id', dealId);

    // 2. Subscriptions lokaal aanmaken. amount = som regels (EXCL); vat_percentage
    //    = tarief van de eerste regel (legacy-kolommen, behouden voor compat).
    const subRows = [];
    for (const s of subsNorm) {
      const totalExcl = s._lines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0);
      const { data: row } = await supabaseAdmin.from('subscriptions').insert({
        deal_id:           dealId,
        description:        s.description || null,
        amount:            Math.round(totalExcl * 100) / 100,
        vat_percentage:    s._lines[0].vat_percentage ?? 21,
        term_count:        Number(s.term_count) || 1,
        start_date:        s.start_date || null,
        end_date:          s.end_date || null,
        tl_department_id:  departmentId,
        line_items:        s._lines.map(li => ({ description: li.description, amount: li.amount, vat_percentage: li.vat_percentage, product_id: li.product_id || null })),
        status:            'active',
      }).select('*').single();
      if (row) subRows.push(row);
    }

    // 3. Bonus op de eerste 1-termijn-sub (aanbetaling): over het totaalbedrag.
    let bonus = null;
    const downSub = subsNorm.find(s => (Number(s.term_count) || 1) === 1);
    const downAmount = downSub ? downSub._lines.reduce((sum, li) => sum + (Number(li.amount) || 0), 0) : 0;
    if (downAmount > 0 && deal.sales_user_id) {
      const { data: cfg } = await supabaseAdmin.from('sales_bonus_configs')
        .select('percentage, threshold_amount').eq('user_id', deal.sales_user_id)
        .order('active_from', { ascending: false }).limit(1).maybeSingle();
      const pct = cfg?.percentage ?? 3;
      const threshold = cfg?.threshold_amount ?? 1000;
      if (downAmount >= Number(threshold)) {
        const bonusAmount = Math.round(downAmount * Number(pct)) / 100;
        const { data: b } = await supabaseAdmin.from('bonuses').insert({
          deal_id: dealId, sales_user_id: deal.sales_user_id, amount: bonusAmount, status: 'pending',
        }).select('*').single();
        bonus = b || { amount: bonusAmount, status: 'pending' };
      }
    }

    // 4. Best-effort TL-push per sub (non-blocking).
    const tlResults = [];
    const tok = sync_to_tl ? await getActiveToken() : null;
    if (sync_to_tl && tok) {
      const { data: customer } = await supabaseAdmin.from('customers').select('*').eq('id', deal.customer_id).maybeSingle();
      // B2B (is_company=true) → companies-ref; B2C → contacts-ref. Één
      // helper doet beide (getOrCreateTlCustomer delegeert intern naar
      // getOrCreateContact voor B2C, en gebruikt companies.add + bewaart
      // tl_company_id voor B2B). Voor B2C is het gedrag identiek aan de
      // oude getOrCreateContact-call: dezelfde tl_contact_id, dezelfde
      // customers.tl_contact_id-write, geen regressie.
      let tlCustomerRef = null;
      let tlCustomerResolveError = null;
      try {
        tlCustomerRef = await getOrCreateTlCustomer(customer);
        // Sanity: ref moet {type, id} met beide gevuld zijn.
        if (!tlCustomerRef || !tlCustomerRef.id) {
          tlCustomerResolveError = 'TL customer-ref onvolledig (id ontbreekt) na getOrCreateTlCustomer';
          tlCustomerRef = null;
        }
      } catch (e) {
        tlCustomerResolveError = 'TL customer-resolve mislukt: ' + (e?.message || 'onbekend');
        console.error('[sub-create] customer-resolve:', tlCustomerResolveError);
      }

      // Definitieve billing_cycle-shape (uit live discovery + TL-docs):
      //   periodicity.unit = 'month' (NIET 'monthly'); period (NIET quantity).
      // days_in_advance: factuur X dagen vóór de termijndatum aanmaken (default 7).
      // payment_term verplicht: 14 dagen na factuurdatum.
      const DAYS_IN_ADVANCE = Number(process.env.TEAMLEADER_SUB_DAYS_IN_ADVANCE) || 7;
      const billing_cycle = { periodicity: { unit: 'month', period: 1 }, days_in_advance: DAYS_IN_ADVANCE };
      // invoice_generation correcte oneOf-shape (uit live discovery): book_and_send
      // VEREIST sending_methods. Default factuur automatisch per e-mail versturen
      // (Jeffrey's eis). Zet TEAMLEADER_SUB_AUTOSEND='false' voor enkel boeken.
      const autosend = process.env.TEAMLEADER_SUB_AUTOSEND !== 'false';
      const invoice_generation = autosend
        ? { action: 'book_and_send', sending_methods: [{ method: 'email' }] }
        : { action: 'book' };

      for (let i = 0; i < subRows.length; i++) {
        const row = subRows[i];
        const lines = subsNorm[i]._lines;
        // Als de TL-customer-resolve gefaald is: markeer deze sub als
        // tl-failed met dezelfde reden — geen stille skip meer waarbij
        // de wizard-toast 'alles goed' zei terwijl teamleader_subscription_id
        // leeg bleef (root cause voor B2B-klanten met tl_company_id).
        if (!tlCustomerRef) {
          tlResults.push({
            sub_id : row.id,
            success: false,
            error  : tlCustomerResolveError || 'TL customer-ref ontbreekt (is_company + tl_company_id resolve faalde)',
          });
          continue;
        }
        // Tax-rate is in de pre-flight al gevalideerd → hier veilig.
        // LET OP intracommunautair: vat_percentage in DB blijft het echte tarief
        // (bv. 21) voor administratie-helderheid; taxRateIdFor(.., sale_type)
        // mapt naar het INTRA-tarief (0%) zodat TL géén BTW berekent.
        const tlLineItems = lines.map(li => ({
          quantity: 1,
          description: li.description || row.description || 'Abonnement',
          unit_price: { amount: Number(li.amount), currency: 'EUR', tax: 'excluding' },
          tax_rate_id: taxRateIdFor(li.vat_percentage, departmentId, deal.sale_type),
        }));
        const body = {
          // B2B (is_company=true) → { type: 'company', id: tl_company_id };
          // B2C → { type: 'contact', id: tl_contact_id }. tlCustomerRef is
          // door getOrCreateTlCustomer opgebouwd volgens is_company.
          invoicee: { customer: { type: tlCustomerRef.type, id: tlCustomerRef.id } },
          department_id: departmentId,
          starts_on: row.start_date,
          title: row.description || 'Abonnement',
          billing_cycle,
          payment_term: { type: 'after_invoice_date', days: 14 },
          invoice_generation,
          grouped_lines: [{ line_items: tlLineItems }],
        };
        // ends_on uit frontend (start + (term-1) mnd + 2 dagen buffer); ook voor
        // eenmalige subs (term_count=1 → start + 2 dagen).
        if (row.end_date) body.ends_on = row.end_date;

        try {
          const r = await tlFetch('/subscriptions.create', { method: 'POST', body: JSON.stringify(body) });
          if (r.ok) {
            const d = await r.json();
            const tlSubId = d.data?.id;
            if (tlSubId) await supabaseAdmin.from('subscriptions').update({ teamleader_subscription_id: tlSubId }).eq('id', row.id);
            tlResults.push({ sub_id: row.id, tl_sub_id: tlSubId, success: true });
          } else {
            const err = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
            console.error('[sub-create] subscriptions.create mislukt:', err);
            tlResults.push({ sub_id: row.id, success: false, error: err });
          }
        } catch (e) {
          console.error('[sub-create] exception:', e.message);
          tlResults.push({ sub_id: row.id, success: false, error: e.message });
        }
      }
    }

    return res.status(200).json({
      success: true,
      deal_id: dealId,
      customer_id: deal.customer_id,
      subscription_ids: subRows.map(r => r.id),
      bonus,
      tl_pushed: tlResults.filter(r => r.success).length,
      tl_failed: tlResults.filter(r => !r.success).length,
      tl_results: tlResults,
    });
  } catch (e) {
    console.error('[sales-subscription-create]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
