// api/mentor-cash-traject-save.js
// POST { id?, event_id, customer_id?, client_label,
//        total_amount, term_count, start_month, note? }
// → { ok:true, traject }
// Permission: mentor.ledger.write (zelfde als mentor-ledger-set-status).
//
// Handmatig traject is EVENT-GEDREVEN sinds 2026-07-06-cash-trajects-
// event-driven.sql: er wordt géén vaste mentor gekoppeld. De cron
// verdeelt elke termijn-bonus over event_mentors.was_present=true.
// mentor_user_id blijft nullable in de DB (kolom bewaard voor evt.
// toekomstig 'lock op één mentor'-gebruik) maar wordt NIET meer gezet.
//
// pct + bonus_total worden gesnapshot bij aanmaak (BONUS_PCT=3);
// wijziging van de constante raakt lopende trajects niet retroactief.
// GEEN ledger-entries hier — die maakt de cron per maand aan.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { BONUS_PCT } from './_lib/events-complete-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Normaliseer een datum-string naar YYYY-MM-01 (kalendermaand, geen UTC-shift).
function toStartMonth(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const y = m[1], mm = m[2];
  if (Number(mm) < 1 || Number(mm) > 12) return null;
  return `${y}-${mm}-01`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.ledger.write'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.ledger.write)' });
  }

  const b = req.body || {};
  const {
    id, event_id,
    customer_id = null, client_label,
    total_amount, term_count, start_month, note = null,
  } = b;

  // Validatie (op UPDATE mag event_id ontbreken; op INSERT verplicht).
  // mentor_user_id is niet meer verplicht sinds event-driven variant.
  if (id && !UUID_RE.test(String(id))) return res.status(400).json({ error: 'id ongeldig' });
  const isUpdate = !!id;
  if (!isUpdate) {
    if (!UUID_RE.test(String(event_id || ''))) return res.status(400).json({ error: 'event_id vereist' });
  }
  if (customer_id != null && customer_id !== '' && !UUID_RE.test(String(customer_id))) {
    return res.status(400).json({ error: 'customer_id ongeldig' });
  }
  if (client_label != null && (typeof client_label !== 'string' || !client_label.trim())) {
    return res.status(400).json({ error: 'client_label vereist' });
  }
  const totalNum = Number(total_amount);
  if (total_amount !== undefined && (!Number.isFinite(totalNum) || totalNum < 0)) {
    return res.status(400).json({ error: 'total_amount moet ≥ 0' });
  }
  const tcNum = Number(term_count);
  if (term_count !== undefined && (!Number.isInteger(tcNum) || tcNum < 1)) {
    return res.status(400).json({ error: 'term_count moet integer ≥ 1' });
  }
  const startMonthNorm = start_month !== undefined ? toStartMonth(start_month) : undefined;
  if (start_month !== undefined && !startMonthNorm) {
    return res.status(400).json({ error: 'start_month moet YYYY-MM-DD/YYYY-MM zijn' });
  }

  try {
    // Bij INSERT: event verifiëren + pct snapshot. mentor_user_id blijft null
    // (event-gedreven — cron verdeelt over event_mentors.was_present=true).
    if (!isUpdate) {
      const { data: ev } = await supabaseAdmin
        .from('events').select('id').eq('id', event_id).maybeSingle();
      if (!ev) return res.status(404).json({ error: 'event niet gevonden' });

      const pct         = BONUS_PCT; // gesnapshot
      const bonusTotal  = round2(totalNum * pct / 100);

      const row = {
        mentor_user_id: null,          // event-gedreven; verdeling gebeurt in cron
        event_id,
        customer_id: customer_id || null,
        client_label: String(client_label).trim(),
        total_amount: round2(totalNum),
        term_count:   tcNum,
        pct,
        bonus_total:  bonusTotal,
        start_month:  startMonthNorm,
        status:       'active',
        created_by:   user.id,
        note:         note ? String(note).slice(0, 2000) : null,
      };
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('mentor_cash_trajects').insert(row).select('*').maybeSingle();
      if (insErr) throw new Error('insert: ' + insErr.message);
      return res.status(200).json({ ok: true, traject: inserted });
    }

    // UPDATE: alleen aangeleverde velden aanraken. pct blijft gesnapshot;
    // bonus_total wordt bijgetrokken op de nieuwe total_amount (× oude pct).
    const patch = {};
    if (customer_id !== undefined) patch.customer_id = customer_id || null;
    if (client_label !== undefined) patch.client_label = String(client_label).trim();
    if (term_count !== undefined) patch.term_count = tcNum;
    if (start_month !== undefined) patch.start_month = startMonthNorm;
    if (note !== undefined) patch.note = note ? String(note).slice(0, 2000) : null;
    if (total_amount !== undefined) {
      patch.total_amount = round2(totalNum);
      // pct uit bestaande rij lezen zodat we bonus_total consistent bijwerken.
      const { data: cur } = await supabaseAdmin
        .from('mentor_cash_trajects').select('pct').eq('id', id).maybeSingle();
      if (!cur) return res.status(404).json({ error: 'traject niet gevonden' });
      patch.bonus_total = round2(patch.total_amount * Number(cur.pct) / 100);
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'geen wijzigingen' });

    const { data: updated, error: upErr } = await supabaseAdmin
      .from('mentor_cash_trajects').update(patch).eq('id', id).select('*').maybeSingle();
    if (upErr) throw new Error('update: ' + upErr.message);
    if (!updated) return res.status(404).json({ error: 'traject niet gevonden' });
    return res.status(200).json({ ok: true, traject: updated });
  } catch (e) {
    console.error('[mentor-cash-traject-save]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
