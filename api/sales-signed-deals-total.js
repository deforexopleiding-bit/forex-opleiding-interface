// api/sales-signed-deals-total.js
// GET → totaal getekende offertes (deals met tl_quotation_status in
// ('accepted','signed')) binnen een periode. Sommeert INCL BTW per line-item.
//
// Query-params:
//   period   'today' | 'week' | 'month' | 'all' (default 'month')
//            filter op tl_quotation_accepted_at (fallback tl_quotation_signed_at).
//
// Response:
//   { total_incl_vat: number, count: number, period, since }
//
// Permission: sales.view (fallback: dashboard.view).
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOfWeek(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : (1 - day);
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function sinceForPeriod(p) {
  const now = new Date();
  if (p === 'today') return isoDate(now);
  if (p === 'week')  return isoDate(mondayOfWeek(now));
  if (p === 'month') return isoDate(startOfMonth(now));
  return null;
}

// Line-item → incl BTW subtotaal.
// price_includes_vat=true  → unit_price is al incl → sub = unit_price × qty
// price_includes_vat=false → sub = unit_price × qty × (1 + vat/100)
function lineInclVat(li) {
  const qty = Number(li.quantity) || 0;
  const up  = Number(li.unit_price) || 0;
  const vat = Number(li.vat_percentage) || 0;
  const sub = up * qty;
  return li.price_includes_vat ? sub : sub * (1 + vat / 100);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = (await requirePermission(req, 'sales.view'))
    || (await requirePermission(req, 'dashboard.view'));
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    const q = req.query || {};
    const periodRaw = String(q.period || 'month').toLowerCase();
    const period = ['today', 'week', 'month', 'all'].includes(periodRaw) ? periodRaw : 'month';
    const since  = sinceForPeriod(period);

    // Stap 1: accepted/signed deals ophalen binnen periode.
    // Filter op tl_quotation_accepted_at OR tl_quotation_signed_at ≥ since.
    let qy = supabaseAdmin
      .from('deals')
      .select('id, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at')
      .in('tl_quotation_status', ['accepted', 'signed'])
      .limit(5000);
    if (since) {
      // PostgREST-syntax: .or() met 2 velden ≥ since (inclusief). Één moet matchen.
      const iso = since + 'T00:00:00';
      qy = qy.or(`tl_quotation_accepted_at.gte.${iso},tl_quotation_signed_at.gte.${iso}`);
    }
    const { data: deals, error: dErr } = await qy;
    if (dErr) throw new Error('deals: ' + dErr.message);

    const ids = (deals || []).map(d => d.id);
    if (!ids.length) {
      return res.status(200).json({ total_incl_vat: 0, count: 0, period, since });
    }

    // Stap 2: line-items voor deze deals → som incl BTW.
    const { data: lines, error: lErr } = await supabaseAdmin
      .from('deal_line_items')
      .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
      .in('deal_id', ids);
    if (lErr) throw new Error('deal_line_items: ' + lErr.message);

    let total = 0;
    for (const li of (lines || [])) total += lineInclVat(li);

    // Kleine defensieve afronding: 2 decimalen (financiële weergave).
    total = Math.round(total * 100) / 100;

    return res.status(200).json({
      total_incl_vat: total,
      count: ids.length,
      period,
      since,
    });
  } catch (e) {
    console.error('[sales-signed-deals-total]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
