// api/teamleader-push-deal.js
// POST { deal_id } → push deal + contact + subscriptions naar TL.
// Update deal.tl_deal_id / tl_pushed_at / tl_push_status / tl_push_error.
//
// Kern-logica zit in pushDealToTl(dealId) — exporteerbaar zodat
// sales-deal-create.js die direct kan aanroepen (geen interne HTTP-roundtrip).
//
// TL IDs (De Forex Opleiding B.V. Online):
// DEPARTMENT_ID = 09d67371-6947-03f6-bd5e-410dd8636344
// TAX_RATE_21 = c21432be-3447-0c1c-824c-0f0e7ea9c381
// TAX_RATE_6 = cfa50e79-496a-06cc-a944-ba1d9a70bbb6

import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { supabaseAdmin } from './supabase.js';
import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const TL_DEPARTMENT_ID = '09d67371-6947-03f6-bd5e-410dd8636344';
const TL_TAX_RATE_21 = 'c21432be-3447-0c1c-824c-0f0e7ea9c381';
const TL_TAX_RATE_6 = 'cfa50e79-496a-06cc-a944-ba1d9a70bbb6';
const TL_TAX_RATE_0 = '096b88ea-0f8c-01cb-b242-4d23447cbbb0';

function taxRateIdForVat(vatPct) {
      const v = Number(vatPct);
      if (v === 6) return TL_TAX_RATE_6;
      if (v === 0) return TL_TAX_RATE_0;
      return TL_TAX_RATE_21; // default 21%
}

// Pure push-logica, GEEN req/res, GEEN auth-check (caller is verantwoordelijk).
// Returnt { success, tl_contact_id?, tl_deal_id?, subscriptions_pushed, subscriptions_failed, subscription_details, error? }.
// Update de deals-rij zelf op 'synced' (success) of 'failed' (fout) — nooit stuck.
export async function pushDealToTl(dealId) {
      try {
              const tok = await getActiveToken();
              if (!tok) throw new Error('Geen TL-token actief');

        // 1. Load deal + customer + subscriptions.
        const { data: deal, error: dErr } = await supabaseAdmin.from('deals').select('*').eq('id', dealId).maybeSingle();
              if (dErr || !deal) throw new Error('Deal niet gevonden');
              const { data: customer } = await supabaseAdmin.from('customers').select('*').eq('id', deal.customer_id).maybeSingle();
              const { data: subs } = await supabaseAdmin.from('subscriptions').select('*').eq('deal_id', dealId);

        // 2. POST /contacts.add — skip indien customer.tl_contact_id reeds gezet.
        let tlContactId = customer?.tl_contact_id || null;
              if (!tlContactId) {
                        const contactBody = {
                                    first_name: customer.first_name || '',
                                    last_name: customer.last_name || '',
                                    emails: customer.email ? [{ type: 'primary', email: customer.email }] : [],
                                    telephones: customer.phone ? [{ type: 'phone', number: customer.phone }] : [],
                        };
                        const cr = await tlFetch('/contacts.add', { method: 'POST', body: JSON.stringify(contactBody) });
                        if (!cr.ok) {
                                    const txt = await cr.text();
                                    throw new Error(`TL contacts.add HTTP ${cr.status}: ${txt.slice(0, 200)}`);
                        }
                        const cData = await cr.json();
                        tlContactId = cData.data?.id || (cData.data?.type === 'contact' ? cData.data?.id : null);
                        if (tlContactId) {
                                    await supabaseAdmin.from('customers').update({ tl_contact_id: tlContactId }).eq('id', customer.id);
                        }
              }

        // 3. POST /deals.create.
        const dealBody = {
                  lead: { customer: { type: 'contact', id: tlContactId } },
                  title: `Deal ${deal.id.slice(0, 8)}`,
                  estimated_value: deal.total_amount ? { amount: Number(deal.total_amount), currency: 'EUR' } : undefined,
        };
              const dr = await tlFetch('/deals.create', { method: 'POST', body: JSON.stringify(dealBody) });
              if (!dr.ok) {
                        const txt = await dr.text();
                        throw new Error(`TL deals.create HTTP ${dr.status}: ${txt.slice(0, 200)}`);
              }
              const dData = await dr.json();
              const tlDealId = dData.data?.id;

        // 4. Subscriptions push — best-effort, failures blokkeren deal-success NIET.
        const subResults = [];
              for (const sub of (subs || [])) {
                        // Idempotency: skip subs die al gesynchroniseerd zijn.
                if (sub.teamleader_subscription_id) {
                            subResults.push({ sub_id: sub.id, already_synced: true, tl_sub_id: sub.teamleader_subscription_id });
                            continue;
                }

                try {
                            const taxRateId = taxRateIdForVat(sub.vat_percentage);
                            const unitPriceExcl = Number(sub.amount) / (1 + Number(sub.vat_percentage || 21) / 100);

                          // billing_cycle is an object per TL API spec:
                          //   periodicity: { unit: 'month'|'week'|'year', period: N }
                          //   days_in_advance: 0|7|14|21|28  (0 = same day as invoice)
                          // unit_price does NOT include currency — currency is set at department level.
                          // tax is specified via tax_rate_id (flat string), not nested tax object.
                          const tlSubBody = {
                                        invoicee: { customer: { type: 'contact', id: tlContactId } },
                                        department_id: TL_DEPARTMENT_ID,
                                        starts_on: sub.start_date || new Date().toISOString().slice(0, 10),
                                        title: `Deal ${deal.id.slice(0, 8)} — termijnen`,
                                        billing_cycle: {
                                                        periodicity: { unit: 'month', period: 1 },
                                                        days_in_advance: 0,
                                        },
                                        payment_term: { type: 'after_invoice_date', days: 14 },
                                        grouped_lines: [{
                                                        section: { title: null },
                                                        line_items: [{
                                                                          quantity: sub.term_count || 1,
                                                                          description: `Termijn — deal ${deal.id.slice(0, 8)}`,
                                                                          unit_price: {
                                                                                              amount: Math.round(unitPriceExcl * 100) / 100,
                                                                                              tax: 'excluding',
                                                                          },
                                                                          tax: { type: 'taxRate', id: taxRateId },
                                                        }],
                                        }],
                                        invoice_generation: { action: 'book' },
                          };

                          const tlSubRes = await tlFetch('/subscriptions.create', {
                                        method: 'POST',
                                        body: JSON.stringify(tlSubBody),
                          });

                          if (tlSubRes.ok) {
                                        const tlSubData = await tlSubRes.json();
                                        const tlSubId = tlSubData.data?.id;
                                        if (tlSubId) {
                                                        await supabaseAdmin
                                                          .from('subscriptions')
                                                          .update({ teamleader_subscription_id: tlSubId })
                                                          .eq('id', sub.id);
                                        }
                                        subResults.push({ sub_id: sub.id, tl_sub_id: tlSubId, success: true });
                          } else {
                                        const errText = await tlSubRes.text();
                                        console.error(`[tl-push] sub push failed for ${sub.id} (HTTP ${tlSubRes.status}):`, errText.slice(0, 300));
                                        subResults.push({ sub_id: sub.id, success: false, error: `HTTP ${tlSubRes.status}: ${errText.slice(0, 200)}` });
                          }
                } catch (subErr) {
                            console.error(`[tl-push] sub push exception for ${sub.id}:`, subErr.message);
                            subResults.push({ sub_id: sub.id, success: false, error: subErr.message });
                }
              }

        const subsPushed = subResults.filter(r => r.success || r.already_synced).length;
              const subsFailed = subResults.filter(r => !r.success && !r.already_synced).length;

        console.log(`[tl-push] deal ${dealId}: contact=${tlContactId}, deal=${tlDealId}, subs pushed=${subsPushed}, failed=${subsFailed}`);

        await supabaseAdmin.from('deals').update({
                  tl_deal_id: tlDealId,
                  tl_pushed_at: new Date().toISOString(),
                  tl_push_status: 'synced',
                  tl_push_error: null,
        }).eq('id', dealId);

        return {
                  success: true,
                  tl_contact_id: tlContactId,
                  tl_deal_id: tlDealId,
                  subscriptions_pushed: subsPushed,
                  subscriptions_failed: subsFailed,
                  subscription_details: subResults,
        };
      } catch (e) {
              await supabaseAdmin.from('deals').update({
                        tl_push_status: 'failed',
                        tl_push_error: e.message.slice(0, 500),
              }).eq('id', dealId);
              return { success: false, error: e.message };
      }
}

// Default handler voor handmatige retry (admin / deal-detail).
export default async function handler(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
      if (!(await requirePermission(req, 'finance.subscription.push'))) {
              return res.status(403).json({ error: 'Geen rechten (finance.subscription.push)' });
      }

  const { deal_id } = req.body || {};
      if (!deal_id) return res.status(400).json({ error: 'deal_id verplicht' });

  const result = await pushDealToTl(deal_id);
      return res.status(result.success ? 200 : 500).json(result);
}
