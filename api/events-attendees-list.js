// api/events-attendees-list.js
// GET -> paginated lijst van deelnemers per event, incl. tags-array per attendee.
//
// Permission: events.attendee.view.
//
// Query-params:
//   event_id  uuid (verplicht)
//   status    CSV optional (aangemeld|aanwezig|no_show|sale|switched_to_other_event)
//   q         text optional (ILIKE op first_name / last_name / email)
//   limit     int, default 100, clamp 1..500
//   offset    int, default 0
//
// Response:
//   {
//     items: [
//       {
//         id, event_id, first_name, last_name, email, phone, status,
//         customer_id, deal_id, subscription_id,
//         ghl_contact_id, ghl_form_submission_id, assessment_response_id,
//         switched_from_event_id, switched_at,
//         registered_at, attended_at, no_show_marked_at, sale_at,
//         follow_up_flagged, follow_up_reason,
//         created_at, updated_at,
//         tags: [ { slug, label, color, source } ]
//       }, ...
//     ],
//     total, limit, offset,
//     counts: { byStatus: { aangemeld, aanwezig, no_show, sale, switched_to_other_event } }
//   }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeDealTotals } from './_lib/deal-total.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['aangemeld', 'aanwezig', 'no_show', 'sale', 'switched_to_other_event', 'geannuleerd'];

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function parseCsv(raw) {
  if (raw == null) return [];
  return String(raw).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
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
  if (!(await requirePermission(req, 'events.attendee.view'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.view)' });
  }

  const q = req.query || {};
  const eventId = q.event_id ? String(q.event_id) : null;
  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }

  const statusList = parseCsv(q.status).map((s) => s.toLowerCase());
  const invalidStatus = statusList.filter((s) => !VALID_STATUS.includes(s));
  if (invalidStatus.length > 0) {
    return res.status(400).json({
      error: `Ongeldige status: ${invalidStatus.join(',')}; verwacht ${VALID_STATUS.join('|')}`,
    });
  }

  const search = q.q ? String(q.q).trim() : null;
  const limit  = clampInt(q.limit, 100, 1, 500);
  const offset = Math.max(0, clampInt(q.offset, 0, 0, 1_000_000));

  try {
    // switched_to_event_id is nieuw sinds migratie 026. Fail-soft: bij
    // 42703/PGRST204 (kolom ontbreekt) retry zonder — dan blijft
    // 'switched_to_event_title' NULL en toont de UI enkel 'Verplaatst'.
    const RICH_SELECT = `
      id, event_id, first_name, last_name, email, phone, status,
      attendance_status, outcome,
      customer_id, deal_id, subscription_id,
      ghl_contact_id, ghl_form_submission_id, assessment_response_id,
      switched_from_event_id, switched_to_event_id, switched_at,
      registered_at, attended_at, no_show_marked_at, sale_at,
      follow_up_flagged, follow_up_reason, called_at, call_status, call_status_at, notes,
      source, automation_enabled,
      created_at, updated_at
    `;
    const CORE_SELECT = `
      id, event_id, first_name, last_name, email, phone, status,
      attendance_status, outcome,
      customer_id, deal_id, subscription_id,
      ghl_contact_id, ghl_form_submission_id, assessment_response_id,
      switched_from_event_id, switched_at,
      registered_at, attended_at, no_show_marked_at, sale_at,
      follow_up_flagged, follow_up_reason, called_at, call_status, call_status_at, notes,
      source, automation_enabled,
      created_at, updated_at
    `;
    const buildQuery = (selectCols) => {
      let q = supabaseAdmin
        .from('event_attendees')
        .select(selectCols, { count: 'exact' })
        .eq('event_id', eventId)
        // Automation-tester: filter test-rijen uit reguliere lijsten.
        .eq('is_test', false)
        .order('registered_at', { ascending: true })
        .range(offset, offset + limit - 1);
      if (statusList.length === 1) q = q.eq('status', statusList[0]);
      else if (statusList.length > 1) q = q.in('status', statusList);
      if (search) {
        const safe = search.replace(/[%,]/g, '');
        if (safe.length > 0) {
          const pattern = `*${safe}*`;
          q = q.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
        }
      }
      return q;
    };

    let rows;
    let count;
    {
      const r1 = await buildQuery(RICH_SELECT);
      if (r1.error && (r1.error.code === '42703' || r1.error.code === 'PGRST204')) {
        console.warn('[attendees-list] switched_to_event_id kolom ontbreekt — draai migratie 026 voor bestemmings-titel');
        const r2 = await buildQuery(CORE_SELECT);
        if (r2.error) throw new Error('attendees-list: ' + r2.error.message);
        rows = r2.data;
        count = r2.count;
      } else if (r1.error) {
        throw new Error('attendees-list: ' + r1.error.message);
      } else {
        rows = r1.data;
        count = r1.count;
      }
    }

    // Batch-lookup: titels van doel-events voor de rijen die verplaatst
    // zijn. Één query per unieke switched_to_event_id (max 1 round-trip).
    const targetEventIds = Array.from(new Set(
      (rows || []).map((r) => r.switched_to_event_id).filter(Boolean)
    ));
    const targetTitleById = new Map();
    const targetDateById  = new Map();
    if (targetEventIds.length > 0) {
      try {
        const { data: tRows, error: tErr } = await supabaseAdmin
          .from('events')
          .select('id, title, starts_at')
          .in('id', targetEventIds);
        if (tErr) {
          console.error('[attendees-list target-titles]', tErr.message);
        } else {
          for (const t of tRows || []) {
            targetTitleById.set(t.id, t.title || null);
            targetDateById.set(t.id, t.starts_at || null);
          }
        }
      } catch (e) {
        console.error('[attendees-list target-titles-catch]', e?.message || e);
      }
    }

    // Tags per attendee (1 query met IN-clause + groepering in JS).
    const ids = (rows || []).map((r) => r.id);
    const tagsByAttendee = new Map();
    if (ids.length > 0) {
      const { data: tagRows, error: tagErr } = await supabaseAdmin
        .from('event_attendee_tags')
        .select('attendee_id, tag_slug, source, added_at, event_tags_catalog:tag_slug ( slug, label, color )')
        .in('attendee_id', ids);
      if (tagErr) {
        console.error('[events-attendees-list tags]', tagErr.message);
      } else {
        for (const t of tagRows || []) {
          const list = tagsByAttendee.get(t.attendee_id) || [];
          const cat = t.event_tags_catalog || {};
          list.push({
            slug:   t.tag_slug,
            label:  cat.label || t.tag_slug,
            color:  cat.color || null,
            source: t.source,
            added_at: t.added_at,
          });
          tagsByAttendee.set(t.attendee_id, list);
        }
      }
    }

    // PR Z: sale-detectie via gekoppelde deals — pure flag, geen handmatige optie.
    // Een attendee is "sale" als zijn deal_id een tl_quotation_status in
    // ('accepted','signed') heeft, of een tl_quotation_accepted_at-stempel.
    const signedDealIds = new Set();
    // Blok B: bewaar per sale-deal ook de totaal-waarde incl BTW zodat de
    // frontend 'Sale ✓ €X.XXX' kan tonen. Gebruikt computeDealTotals
    // (zelfde helper als events-complete-core voor de bonus-berekening).
    const saleInfoByDealId = new Map();
    const dealIds = Array.from(new Set((rows || []).map((r) => r.deal_id).filter(Boolean)));
    if (dealIds.length > 0) {
      try {
        const { data: deals, error: dealErr } = await supabaseAdmin
          .from('deals')
          .select('id, discount_percentage, sale_type, tl_quotation_status, tl_quotation_accepted_at')
          .in('id', dealIds);
        if (dealErr) {
          console.error('[events-attendees-list deals]', dealErr.message);
        } else {
          const signedDeals = [];
          for (const d of deals || []) {
            const st = String(d.tl_quotation_status || '').toLowerCase();
            if (st === 'accepted' || st === 'signed' || d.tl_quotation_accepted_at) {
              signedDealIds.add(d.id);
              signedDeals.push(d);
            }
          }
          // Line items ophalen voor sale-deals in één batch en per deal
          // groeperen; dan computeDealTotals aanroepen.
          if (signedDeals.length > 0) {
            const signedIds = signedDeals.map((d) => d.id);
            try {
              const { data: lines, error: linesErr } = await supabaseAdmin
                .from('deal_line_items')
                .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
                .in('deal_id', signedIds);
              if (linesErr) {
                console.error('[events-attendees-list line-items]', linesErr.message);
              } else {
                const linesByDeal = new Map();
                for (const li of lines || []) {
                  const arr = linesByDeal.get(li.deal_id) || [];
                  arr.push(li);
                  linesByDeal.set(li.deal_id, arr);
                }
                for (const d of signedDeals) {
                  try {
                    const totals = computeDealTotals(d, linesByDeal.get(d.id) || []);
                    saleInfoByDealId.set(d.id, {
                      total_incl : Number.isFinite(totals?.incl) ? Number(totals.incl) : null,
                      status     : d.tl_quotation_status || null,
                    });
                  } catch (e) {
                    console.error('[events-attendees-list total-calc]', d.id, e?.message || e);
                    saleInfoByDealId.set(d.id, { total_incl: null, status: d.tl_quotation_status || null });
                  }
                }
              }
            } catch (e) {
              console.error('[events-attendees-list totals-fetch]', e?.message || e);
            }
          }
        }
      } catch (e) {
        console.error('[events-attendees-list deals-fetch]', e?.message || e);
      }
    }

    // ── Sale-suggestie (Blok B follow-up) — server-side sterke match ──
    // Voor attendees zonder gekoppelde sale-deal berekenen we per attendee
    // een suggestie zodat het afrond-scherm '💡 Mogelijke sale: €X.XXX'
    // met 1-klik koppelen kan tonen. Gebatcht — geen N+1.
    // STERK = deal.customer_id === attendee.customer_id, of matchende
    // e-mail (lowercase). Alleen accepted/signed-deals. Deals die al aan
    // enige andere attendee zijn gekoppeld → uitgesloten (voorkomt dubbele
    // koppeling). Zelfde helper computeDealTotals voor bedrag.
    const suggestionByAttendeeId = new Map();
    try {
      const attNoSale = (rows || []).filter(
        (r) => !(r.deal_id && signedDealIds.has(r.deal_id))
              && (r.customer_id || (r.email || '').trim())
      );
      if (attNoSale.length > 0) {
        const noSaleCids   = Array.from(new Set(attNoSale.map((r) => r.customer_id).filter(Boolean)));
        const noSaleEmails = Array.from(new Set(
          attNoSale.map((r) => String(r.email || '').trim().toLowerCase()).filter(Boolean)
        ));

        // Email-lookup: welke customers matchen de attendee-emails?
        const emailToCustIds = new Map(); // lowercase email → [customer_id]
        const custIdToName   = new Map(); // customer_id → naam (label)
        let emailMatchedCids = [];
        if (noSaleEmails.length > 0) {
          try {
            const { data: emailCusts, error: eErr } = await supabaseAdmin
              .from('customers')
              .select('id, email, first_name, last_name, company_name')
              .in('email', noSaleEmails);
            if (!eErr) {
              for (const c of emailCusts || []) {
                const em = String(c.email || '').trim().toLowerCase();
                if (em) {
                  const arr = emailToCustIds.get(em) || [];
                  arr.push(c.id);
                  emailToCustIds.set(em, arr);
                }
                const nm = (c.company_name || '').trim()
                  || `${(c.first_name || '').trim()} ${(c.last_name || '').trim()}`.trim();
                if (nm) custIdToName.set(c.id, nm);
              }
              emailMatchedCids = Array.from(new Set((emailCusts || []).map((c) => c.id)));
            }
          } catch (e) { console.warn('[events-attendees-list email-lookup]', e?.message || e); }
        }

        const allCandidateCids = Array.from(new Set([...noSaleCids, ...emailMatchedCids]));
        if (allCandidateCids.length > 0) {
          // Signed-only deals voor deze customer_ids.
          const { data: candDeals, error: candErr } = await supabaseAdmin
            .from('deals')
            .select('id, customer_id, quote_reference, tl_quotation_status, tl_quotation_accepted_at, discount_percentage, sale_type, created_at')
            .in('customer_id', allCandidateCids)
            .or('tl_quotation_status.eq.accepted,tl_quotation_status.eq.signed,tl_quotation_accepted_at.not.is.null');
          if (candErr) {
            console.warn('[events-attendees-list sugg-deals]', candErr.message);
          } else if (candDeals && candDeals.length > 0) {
            // Uitsluiten: deals die al aan enige event_attendees-rij gekoppeld zijn.
            const candIds = candDeals.map((d) => d.id);
            let linkedSet = new Set();
            try {
              const { data: linkedRows } = await supabaseAdmin
                .from('event_attendees')
                .select('deal_id')
                .in('deal_id', candIds);
              for (const l of linkedRows || []) {
                if (l.deal_id) linkedSet.add(l.deal_id);
              }
            } catch (e) { console.warn('[events-attendees-list linked-lookup]', e?.message || e); }
            const freeDeals = candDeals.filter((d) => !linkedSet.has(d.id));

            if (freeDeals.length > 0) {
              // Batch line items voor computeDealTotals.
              const freeIds = freeDeals.map((d) => d.id);
              const linesByDeal = new Map();
              try {
                const { data: lines } = await supabaseAdmin
                  .from('deal_line_items')
                  .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
                  .in('deal_id', freeIds);
                for (const li of lines || []) {
                  const arr = linesByDeal.get(li.deal_id) || [];
                  arr.push(li);
                  linesByDeal.set(li.deal_id, arr);
                }
              } catch (e) { console.warn('[events-attendees-list sugg-lines]', e?.message || e); }

              // Extra customer-namen voor de labels (customer_id-only matches).
              const missingCustIds = Array.from(new Set(
                freeDeals.map((d) => d.customer_id).filter((cid) => cid && !custIdToName.has(cid))
              ));
              if (missingCustIds.length > 0) {
                try {
                  const { data: extraCusts } = await supabaseAdmin
                    .from('customers')
                    .select('id, first_name, last_name, company_name')
                    .in('id', missingCustIds);
                  for (const c of extraCusts || []) {
                    const nm = (c.company_name || '').trim()
                      || `${(c.first_name || '').trim()} ${(c.last_name || '').trim()}`.trim();
                    if (nm) custIdToName.set(c.id, nm);
                  }
                } catch (_) {}
              }

              // Group by customer_id, sort recentst-accepted eerst.
              const dealsByCust = new Map();
              for (const d of freeDeals) {
                let total_incl = null;
                try {
                  const t = computeDealTotals(d, linesByDeal.get(d.id) || []);
                  total_incl = Number.isFinite(t?.incl) ? Number(t.incl) : null;
                } catch (_) {}
                const enriched = {
                  deal_id         : d.id,
                  total_incl,
                  quote_reference : d.quote_reference || null,
                  customer_id     : d.customer_id,
                  customer_label  : custIdToName.get(d.customer_id) || null,
                  accepted_at     : d.tl_quotation_accepted_at || d.created_at || null,
                };
                const arr = dealsByCust.get(d.customer_id) || [];
                arr.push(enriched);
                dealsByCust.set(d.customer_id, arr);
              }
              for (const arr of dealsByCust.values()) {
                arr.sort((a, b) => String(b.accepted_at || '').localeCompare(String(a.accepted_at || '')));
              }

              // Per attendee: kies STERKE match — customer_id primair, email secundair.
              // Voorkom hetzelfde deal-id twee keer suggereren binnen deze lijst.
              const alreadySuggested = new Set();
              for (const a of attNoSale) {
                let best = null;
                if (a.customer_id) {
                  const arr = dealsByCust.get(a.customer_id) || [];
                  best = arr.find((x) => !alreadySuggested.has(x.deal_id)) || null;
                }
                if (!best) {
                  const em = String(a.email || '').trim().toLowerCase();
                  if (em) {
                    const emCids = emailToCustIds.get(em) || [];
                    for (const emCid of emCids) {
                      const arr = dealsByCust.get(emCid) || [];
                      const cand = arr.find((x) => !alreadySuggested.has(x.deal_id));
                      if (cand) { best = cand; break; }
                    }
                  }
                }
                if (best) {
                  alreadySuggested.add(best.deal_id);
                  const { customer_id: _cid, accepted_at: _acc, ...pub } = best;
                  suggestionByAttendeeId.set(a.id, pub);
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[events-attendees-list sale-suggestion]', e?.message || e);
    }

    // Taal per aanwezige — mirror van het tags/deals secundaire-fetch-patroon.
    // Bron: assessment_responses.answers->>'taal' (de nieuwe radio-vraag
    // 'taal' met waarden 'nl'|'en'|'anders'). Afwezigheid van de vraag
    // (oude inzendingen) → taal=null; events-detail toont dan geen badge.
    // Fail-soft: bij DB-fout → taal=null op alle rijen, geen 500.
    const responseIds = Array.from(new Set(
      (rows || []).map((r) => r.assessment_response_id).filter(Boolean)
    ));
    const taalByResponse = new Map();
    // Vragenlijst-invuldatum: canonieke kolom is submitted_at (zie
    // assessment-submit.js); fallback created_at voor zeldzame oudere
    // inzendingen waar submitted_at NULL is.
    const filledAtByResponse = new Map();
    if (responseIds.length > 0) {
      try {
        const { data: respRows, error: respErr } = await supabaseAdmin
          .from('assessment_responses')
          .select('id, answers, submitted_at, created_at')
          .in('id', responseIds);
        if (respErr) {
          console.error('[events-attendees-list responses]', respErr.message);
        } else {
          for (const rr of respRows || []) {
            const a = rr && rr.answers;
            const t = (a && typeof a === 'object' && typeof a.taal === 'string')
              ? a.taal.trim().toLowerCase()
              : null;
            taalByResponse.set(rr.id, t || null);
            filledAtByResponse.set(rr.id, rr.submitted_at || rr.created_at || null);
          }
        }
      } catch (e) {
        console.error('[events-attendees-list responses-fetch]', e?.message || e);
      }
    }

    const items = (rows || []).map((r) => {
      const saleInfo = (r.deal_id && signedDealIds.has(r.deal_id))
        ? (saleInfoByDealId.get(r.deal_id) || null)
        : null;
      return {
        ...r,
        tags: tagsByAttendee.get(r.id) || [],
        has_signed_deal: !!(r.deal_id && signedDealIds.has(r.deal_id)),
        // Blok B: sale-info per attendee. Frontend toont
        // 'Sale ✓ €{sale_total_incl}' + koppel-status.
        sale_deal_id     : saleInfo ? r.deal_id : null,
        sale_total_incl  : saleInfo ? saleInfo.total_incl : null,
        sale_deal_status : saleInfo ? saleInfo.status : null,
        // Sterke-match-suggestie (Blok B follow-up): NULL bij geen match.
        // Frontend toont '💡 Mogelijke sale: €X.XXX — Koppel' met 1-klik.
        suggested_deal   : suggestionByAttendeeId.get(r.id) || null,
        taal: r.assessment_response_id ? (taalByResponse.get(r.assessment_response_id) || null) : null,
        questionnaire_filled_at: r.assessment_response_id
          ? (filledAtByResponse.get(r.assessment_response_id) || null)
          : null,
        // Bestemmings-titel voor verplaatst-attendees (migratie 026). NULL
        // voor legacy-rijen zonder switched_to_event_id.
        switched_to_event_title: r.switched_to_event_id
          ? (targetTitleById.get(r.switched_to_event_id) || null)
          : null,
        // Bestemmings-datum (starts_at) zodat de UI "→ titel · datum" kan
        // tonen — nuttig sinds alle events dezelfde titel dragen.
        switched_to_event_date: r.switched_to_event_id
          ? (targetDateById.get(r.switched_to_event_id) || null)
          : null,
      };
    });

    // byStatus counts (zonder paginatie, zonder status-filter, met search).
    const byStatus = { aangemeld: 0, aanwezig: 0, no_show: 0, sale: 0, switched_to_other_event: 0, geannuleerd: 0 };
    try {
      await Promise.all(VALID_STATUS.map(async (s) => {
        let cq = supabaseAdmin
          .from('event_attendees')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', eventId)
          .eq('is_test', false)
          .eq('status', s);
        if (search) {
          const safe = search.replace(/[%,]/g, '');
          if (safe.length > 0) {
            const pattern = `*${safe}*`;
            cq = cq.or(`first_name.ilike.${pattern},last_name.ilike.${pattern},email.ilike.${pattern}`);
          }
        }
        const { count: c, error: ce } = await cq;
        if (ce) { console.error('[events-attendees-list count', s, ']', ce.message); return; }
        byStatus[s] = typeof c === 'number' ? c : 0;
      }));
    } catch (e) {
      console.error('[events-attendees-list byStatus]', e.message);
    }

    const total = typeof count === 'number' ? count : items.length;
    return res.status(200).json({
      items, total, limit, offset,
      counts: { byStatus },
    });
  } catch (e) {
    console.error('[events-attendees-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
