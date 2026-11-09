// api/sales-bonus-overview.js
// GET → sales-bonusoverzicht + controle per bonus. super_admin / admin.
//
// Sinds 6 nov 2026 (regels Maxim) rekent alles via api/_lib/sales-bonus-stand.js:
// een bonus telt pas mee naar wat er EFFECTIEF BETAALD is. Per bonus: ontvanger,
// klant, deal + sale, abonnementstatus, betaald, verdiend, en een VOORSTEL
// (houden / ongeldig / aanpassen) met reden. Maxim beslist per bonus via
// api/sales-bonus-beslissing.js; dit endpoint schrijft niets.
//
// Query: ?voided=1 → ook de ongeldige bonussen (historiek).
//
// Response:
//   {
//     per_sales_user: [{ user_id, user_name, user_email,
//       totals: { verdiend_open, nog_niet_verdiend, uitbetaald, voided, pending, earned }  // {count,sum}
//       bonuses: [ stand-rij ] }],
//     grand_totals: idem,
//     totalen: { verdiend_open, nog_niet_verdiend, uitbetaald, aantal_actief, bonus_bedrag_actief },
//     voorstellen: { houden:{count,sum}, ongeldig:{count,sum}, aanpassen:{count,sum} },
//     total_bonuses
//   }
// `pending` en `earned` blijven voor oude schermen: pending = bonusbedrag van
// alles wat nog niet uitbetaald is, earned = het VERDIENDE deel daarvan.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { laadBonusStand } from './_lib/sales-bonus-stand.js';

export const BONUS_ADMIN_ROLLEN = ['super_admin', 'admin'];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const leegTotaal = () => ({
  verdiend_open: { count: 0, sum: 0 }, nog_niet_verdiend: { count: 0, sum: 0 },
  uitbetaald: { count: 0, sum: 0 }, voided: { count: 0, sum: 0 },
  pending: { count: 0, sum: 0 }, earned: { count: 0, sum: 0 },
});
function tel(t, s) {
  const plus = (k, v) => { t[k].count += 1; t[k].sum += v; };
  if (s.status === 'voided') return plus('voided', s.bedrag);
  if (s.status === 'paid') return plus('uitbetaald', s.bedrag);
  if (s.verdiend > 0) plus('verdiend_open', s.verdiend);
  if (s.nog_niet_verdiend > 0) plus('nog_niet_verdiend', s.nog_niet_verdiend);
  plus('pending', s.bedrag);
  if (s.verdiend > 0) plus('earned', s.verdiend);
}
const rond = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { count: v.count, sum: r2(v.sum) }]));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin || !BONUS_ADMIN_ROLLEN.includes(admin.profile?.role)) {
    return res.status(403).json({ error: 'Alleen super_admin of admin.' });
  }

  try {
    const metVoided = String(req.query?.voided || '') === '1';
    const { stand, totalen } = await laadBonusStand(supabaseAdmin, { metVoided });

    const perUser = new Map();
    const grand = leegTotaal();
    const voorstellen = { houden: { count: 0, sum: 0 }, ongeldig: { count: 0, sum: 0 }, aanpassen: { count: 0, sum: 0 } };
    for (const s of stand) {
      const uid = s.ontvanger_id || '__unassigned__';
      if (!perUser.has(uid)) {
        perUser.set(uid, {
          user_id: s.ontvanger_id || null,
          user_name: s.ontvanger_naam || (s.ontvanger_id ? s.ontvanger_id : '(geen ontvanger)'),
          user_email: null,
          totals: leegTotaal(),
          bonuses: [],
        });
      }
      const row = perUser.get(uid);
      tel(row.totals, s);
      if (!s.is_test) tel(grand, s);
      row.bonuses.push(s);
      if (s.status !== 'voided' && !s.beslissing && voorstellen[s.voorstel]) {
        voorstellen[s.voorstel].count += 1;
        voorstellen[s.voorstel].sum += s.bedrag;
      }
    }
    const per_sales_user = [...perUser.values()]
      .map((r) => ({ ...r, totals: rond(r.totals), bonuses: r.bonuses.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))) }))
      .sort((a, b) => (b.totals.verdiend_open.sum + b.totals.nog_niet_verdiend.sum) - (a.totals.verdiend_open.sum + a.totals.nog_niet_verdiend.sum));

    // Wie kan een bonus krijgen (aanpassen / handmatig toekennen)?
    let mogelijke_ontvangers = [];
    try {
      const { data } = await supabaseAdmin.from('profiles')
        .select('id, full_name, email, role, is_active')
        .in('role', ['sales', 'mentor', 'manager', 'admin', 'super_admin']);
      mogelijke_ontvangers = (data || []).filter((p) => p.is_active !== false)
        .map((p) => ({ id: p.id, naam: p.full_name || p.email || p.id, rol: p.role }))
        .sort((a, b) => String(a.naam).localeCompare(String(b.naam)));
    } catch (e) { console.warn('[sales-bonus-overview] ontvangers:', e?.message || e); }

    return res.status(200).json({
      mogelijke_ontvangers,
      per_sales_user,
      grand_totals: rond(grand),
      totalen,
      voorstellen: Object.fromEntries(Object.entries(voorstellen).map(([k, v]) => [k, { count: v.count, sum: r2(v.sum) }])),
      total_bonuses: stand.length,
      kan_beslissen: BONUS_ADMIN_ROLLEN.includes(admin.profile?.role),
    });
  } catch (e) {
    console.error('[sales-bonus-overview]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
