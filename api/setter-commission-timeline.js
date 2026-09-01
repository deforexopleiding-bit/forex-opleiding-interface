// api/setter-commission-timeline.js
//
// BP3 v4 (2026-09-01) — Commissie-timeline voor de setter-Commissie-pagina.
// Geeft maand-buckets terug voor 6 maanden terug tot 18 maanden vooruit
// (25 buckets totaal: 6 verleden + huidige + 18 toekomst).
//
// Response:
//   {
//     setter_user_id, pct, months: [
//       { ym: 'YYYY-MM', label: 'mrt 2026', realized: <eur>, forecast: <eur> },
//       ...
//     ]
//   }
//
// Verleden buckets: som(setter_ledger_entries.amount) waar
//   status ∈ ('vrijgegeven','uitbetaald') EN created_at in de maand.
// Toekomst buckets: voor elke ACTIEVE subscription van setter-deals,
//   verdeel resterende termijnen × pct/100 over de toekomstige maanden
//   volgens `billing_cycle_in_months` (default 1 = per maand).
// Huidige maand mag beide bevatten (mix: al gerealiseerd + nog verwacht).
//
// Gate: setter.ledger.view. setter.ledger.admin mag ?setter_user_id=X.
//
// INCASSO-VEILIG: leest UITSLUITEND setter_config + setter_ledger_entries
// + deals + subscriptions + invoices. Schrijft NIETS.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CYCLE_M = { per_month: 1, per_2_months: 2, per_quarter: 3, per_6_months: 6, per_year: 12 };
function cycleMonths(label) {
  if (!label) return 1;
  if (CYCLE_M[label] != null) return CYCLE_M[label];
  const m = String(label).match(/per_(\d+)_months/);
  return m ? Number(m[1]) : 1;
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

const MONTHS_NL = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function ymOf(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
function labelOf(date) {
  return `${MONTHS_NL[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const CANCELLED = new Set(['cancelled', 'deactivated', 'geannuleerd']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'setter.ledger.view'))) {
    return res.status(403).json({ error: 'Geen rechten (setter.ledger.view)' });
  }

  const requestedSetter = String(req.query?.setter_user_id || '').trim();
  let targetSetter = user.id;
  if (requestedSetter && requestedSetter !== user.id) {
    if (!UUID_RE.test(requestedSetter)) return res.status(400).json({ error: 'setter_user_id ongeldig' });
    if (!(await requirePermission(req, 'setter.ledger.admin'))) {
      return res.status(403).json({ error: 'Alleen setter.ledger.admin mag andere setters bekijken' });
    }
    targetSetter = requestedSetter;
  }

  try {
    const now = new Date();
    const currentY = now.getUTCFullYear();
    const currentM = now.getUTCMonth();

    // Bucket-lijst: 6 mnd verleden + huidige + 18 mnd toekomst = 25 buckets.
    const months = [];
    for (let off = -6; off <= 18; off++) {
      const d = new Date(Date.UTC(currentY, currentM + off, 1));
      months.push({
        ym:       ymOf(d),
        label:    labelOf(d),
        realized: 0,
        forecast: 0,
        _startUtc: Date.UTC(currentY, currentM + off, 1),
        _endUtc:   Date.UTC(currentY, currentM + off + 1, 1),
      });
    }
    const ymIndex = new Map(months.map((m, i) => [m.ym, i]));

    // ── Verleden + huidige maand: setter_ledger_entries ──────────────────
    const rangeFrom = new Date(months[0]._startUtc).toISOString();
    const rangeTo   = new Date(Date.UTC(currentY, currentM + 1, 1)).toISOString(); // t/m einde huidige maand
    const { data: entries } = await supabaseAdmin
      .from('setter_ledger_entries')
      .select('amount, status, created_at')
      .eq('setter_user_id', targetSetter)
      .gte('created_at', rangeFrom)
      .lt('created_at', rangeTo)
      .limit(5000);
    for (const e of (entries || [])) {
      if (e.status !== 'vrijgegeven' && e.status !== 'uitbetaald') continue;
      const t = new Date(e.created_at);
      const ym = ymOf(t);
      const idx = ymIndex.get(ym);
      if (idx != null) months[idx].realized += Number(e.amount) || 0;
    }

    // ── setter-config voor pct ──────────────────────────────────────────
    const { data: cfg } = await supabaseAdmin
      .from('setter_config')
      .select('pct').eq('user_id', targetSetter).maybeSingle();
    const pct = cfg?.pct ? Number(cfg.pct) : 0;

    // ── Toekomst: uit haar actieve subscriptions ─────────────────────────
    const { data: deals } = await supabaseAdmin
      .from('deals').select('id').eq('setter_user_id', targetSetter);
    const dealIds = (deals || []).map((d) => d.id);
    if (dealIds.length && pct > 0) {
      const [subsRes, invsRes] = await Promise.all([
        supabaseAdmin.from('subscriptions')
          .select('id, deal_id, amount, term_count, status, billing_cycle, start_date')
          .in('deal_id', dealIds),
        supabaseAdmin.from('invoices')
          .select('deal_id, amount_paid').in('deal_id', dealIds),
      ]);
      const paidByDeal = {};
      for (const i of (invsRes.data || [])) {
        paidByDeal[i.deal_id] = (paidByDeal[i.deal_id] || 0) + (Number(i.amount_paid) || 0);
      }
      const currentMonthStart = new Date(Date.UTC(currentY, currentM, 1)).getTime();

      for (const s of (subsRes.data || [])) {
        if (CANCELLED.has(String(s.status || '').toLowerCase())) continue;
        const amount    = Number(s.amount) || 0;
        const termCount = Number(s.term_count) || 0;
        if (amount <= 0 || termCount <= 0) continue;
        const cycleMo = cycleMonths(s.billing_cycle) || 1;

        const totaal    = amount * termCount;
        const alBetaald = paidByDeal[s.deal_id] || 0;
        const resterend = Math.max(0, totaal - alBetaald);
        if (resterend <= 0) continue;
        const resterendeTermijnen = Math.ceil(resterend / amount);

        // Bepaal start-maand van de eerste toekomstige termijn. Als
        // start_date bekend is, gebruik die + (aantal reeds betaalde termijnen)
        // * cycleMo. Anders: eerstvolgende maand.
        let firstMonth;
        if (s.start_date) {
          const sd = new Date(s.start_date);
          if (!isNaN(sd.getTime())) {
            const betaaldeTermijnen = alBetaald > 0 ? Math.floor(alBetaald / amount) : 0;
            const y = sd.getUTCFullYear();
            const m = sd.getUTCMonth();
            firstMonth = new Date(Date.UTC(y, m + betaaldeTermijnen * cycleMo, 1)).getTime();
          }
        }
        if (!firstMonth) {
          firstMonth = new Date(Date.UTC(currentY, currentM + 1, 1)).getTime();
        }
        // Als firstMonth in het verleden ligt (achterstallige betalingen),
        // schuif door naar volgende maand vanaf nu.
        if (firstMonth < currentMonthStart) {
          firstMonth = new Date(Date.UTC(currentY, currentM + 1, 1)).getTime();
        }

        const commissiePerTermijn = amount * pct / 100;
        for (let k = 0; k < resterendeTermijnen; k++) {
          const start = firstMonth;
          const bucketDate = new Date(start);
          bucketDate.setUTCMonth(bucketDate.getUTCMonth() + k * cycleMo);
          const ym = ymOf(bucketDate);
          const idx = ymIndex.get(ym);
          if (idx == null) break; // buiten window (verder dan 18 mnd)
          months[idx].forecast += commissiePerTermijn;
        }
      }
    }

    // ── Cleanup + serialize ─────────────────────────────────────────────
    const out = months.map((m) => ({
      ym:       m.ym,
      label:    m.label,
      realized: round2(m.realized),
      forecast: round2(m.forecast),
    }));

    return res.status(200).json({
      setter_user_id: targetSetter,
      pct,
      months: out,
    });
  } catch (e) {
    console.error('[setter-commission-timeline]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
