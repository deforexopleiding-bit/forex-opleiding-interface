// api/_lib/leadsonderhoud-bulk-segment.js
//
// FASE 3 helper: server-side segment-query voor leadsonderhoud-bulk-preview.
// Hergebruikt dezelfde filters als /api/leads-list (leads_overzicht view) +
// de nieuwe multi-traject + score-range parameters uit dezelfde brok.
//
// Input: segment-object { traject: string[], afspraak: 'ja'|'nee'|null,
//                         score_min?: number, score_max?: number, bron?: string,
//                         q?: string }
// Output: { rows: [ ...leads_overzicht rijen incl. score/traject/telefoon/email ],
//           total }
// Cap: input-limit; caller is verantwoordelijk voor de hard_cap-check.

import { supabaseAdmin } from '../supabase.js';

export async function queryLeadsBySegment(segment, opts) {
  const seg = (segment && typeof segment === 'object') ? segment : {};
  const limit = Math.max(1, Math.min(2000, Number(opts?.limit) || 500));

  // leads_overzicht view heeft alleen basisvelden. Voor telefoon_e164 en
  // consent-kolommen doen we een tweede batch-query op de raw leads-tabel.
  let qy = supabaseAdmin
    .from('leads_overzicht')
    .select('id, naam, email, telefoon, soort, bron, traject, kwalificatie, score, drempel, status, aangemaakt, afspraak_op', { count: 'exact' })
    .is('verwijderd_op', null)
    .order('score', { ascending: false, nullsFirst: false })
    .range(0, limit - 1);

  const trajectArr = Array.isArray(seg.traject) ? seg.traject.filter(Boolean) : [];
  if (trajectArr.length) qy = qy.in('traject', trajectArr);

  if (seg.afspraak === 'ja')      qy = qy.not('afspraak_op', 'is', null);
  else if (seg.afspraak === 'nee') qy = qy.is('afspraak_op', null);

  // S1 fix: strikt lege input = geen filter (null blijft null, undefined blijft
  // null). Nummer-parse alleen als er echt iets in staat.
  const parseNum = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const sMin = parseNum(seg.score_min);
  const sMax = parseNum(seg.score_max);
  // S2 fix: null-score behandeld als 0. Als sMin ≤ 0 én sMax ≥ 45 → geen
  // filter (default range). Anders: gebruik .or() met is.null-inclusie bij
  // sMin === 0 (dan telt null-score als 0 en past). Bij sMin > 0: null-score
  // valt buiten (correcte semantiek: user filtert bewust op warm+).
  if (sMin != null && sMin > 0) qy = qy.gte('score', sMin);
  else if (sMin === 0) qy = qy.or('score.gte.0,score.is.null'); // include null-score
  if (sMax != null && sMax < 45) qy = qy.or(`score.lte.${sMax},score.is.null`); // include null als "0"
  // Als sMax >= 45 én sMin <= 0 → geen filter (alle scores + null).

  if (seg.bron) qy = qy.eq('bron', String(seg.bron).trim());

  const search = seg.q ? String(seg.q).trim() : '';
  if (search) {
    const like = `%${search.replace(/[%_]/g, m => '\\' + m)}%`;
    qy = qy.or(`naam.ilike.${like},email.ilike.${like}`);
  }

  const { data, error, count } = await qy;
  if (error) throw new Error('segment-query: ' + error.message);
  const rows = data || [];

  // Verrijk met telefoon_e164 + consent uit de raw leads-tabel. Fail-soft:
  // ontbrekende kolommen op de leads-tabel (bv. toestemming_email bestaat
  // niet in schema) -> we hangen null aan en de caller neemt geen consent-
  // check aan die kant. Voor WA is toestemming_whatsapp de bepalende kolom.
  if (rows.length) {
    try {
      const ids = rows.map(r => r.id);
      const { data: raw } = await supabaseAdmin
        .from('leads')
        .select('id, telefoon_e164, toestemming_whatsapp')
        .in('id', ids);
      const byId = new Map((raw || []).map(l => [l.id, l]));
      for (const r of rows) {
        const l = byId.get(r.id) || {};
        r.telefoon_e164 = l.telefoon_e164 || null;
        r.toestemming_whatsapp = l.toestemming_whatsapp === true;
      }
    } catch (e) {
      console.warn('[ls-bulk-segment] verrijking soft-fail:', e?.message || e);
      for (const r of rows) {
        r.telefoon_e164 = null;
        r.toestemming_whatsapp = false; // veilige default: geen consent
      }
    }
  }

  return { rows, total: count || rows.length };
}

