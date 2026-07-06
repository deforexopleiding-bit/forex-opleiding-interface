// api/admin/historical-event-attendees-add.js
// POST { event_id, deal_ids: uuid[] }
// → { ok:true, added, skipped_duplicates, missing }
// Beveiliging: verifyAdmin + super_admin (zelfde patroon als historical-
// event-commit.js). Bouwt event_attendees-rijen incrementeel toe aan een
// historisch event dat NOG NIET is geboekt.
//
// Dedup: attendees met dezelfde (event_id, deal_id) worden overgeslagen.
// Geboekt-check: als events.bonus_geboekt=true → 409 Conflict (server-side
// veiligheid bovenop de UI-gating).
//
// De attendee-shape is identiek aan historical-event-save.js (status=
// 'aanwezig' + attended_at=events.starts_at + first_name/last_name/email/
// phone uit customers). Zo tellen ze mee bij een latere commit-run.

import { verifyAdmin, supabaseAdmin } from '../supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (admin.profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

  const body = req.body || {};
  const eventId = String(body.event_id || '');
  const dealIds = Array.isArray(body.deal_ids) ? body.deal_ids : [];
  if (!UUID_RE.test(eventId)) return res.status(400).json({ error: 'event_id (uuid) vereist' });
  if (!dealIds.length) return res.status(400).json({ error: 'deal_ids leeg' });
  for (const d of dealIds) if (!UUID_RE.test(String(d || ''))) return res.status(400).json({ error: 'deal_ids: uuid verwacht' });

  try {
    // 1) Event bestaan + geboekt-check.
    const { data: ev, error: evErr } = await supabaseAdmin
      .from('events').select('id, starts_at, bonus_geboekt').eq('id', eventId).maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!ev) return res.status(404).json({ error: 'event niet gevonden' });
    if (ev.bonus_geboekt === true) {
      return res.status(409).json({ error: 'Event is al geboekt — sales toevoegen is vergrendeld', bonus_geboekt: true });
    }
    const startsAt = ev.starts_at || new Date().toISOString();

    const uniqDeals = [...new Set(dealIds.map(String))];

    // 2) Bestaande koppelingen ophalen (dedup).
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('event_attendees')
      .select('deal_id')
      .eq('event_id', eventId)
      .in('deal_id', uniqDeals);
    if (exErr) throw new Error('bestaande attendees: ' + exErr.message);
    const alreadyLinked = new Set((existing || []).map(a => a.deal_id).filter(Boolean));
    const toInsertDeals = uniqDeals.filter(d => !alreadyLinked.has(d));

    if (!toInsertDeals.length) {
      return res.status(200).json({ ok: true, added: 0, skipped_duplicates: uniqDeals.length, missing: 0 });
    }

    // 3) Deals + customers ophalen voor naam/email (identieke shape als
    //    historical-event-save.js).
    const { data: deals } = await supabaseAdmin
      .from('deals').select('id, customer_id').in('id', toInsertDeals);
    const dealMap = new Map((deals || []).map(d => [d.id, d]));
    const missingDeals = toInsertDeals.filter(d => !dealMap.has(d));

    const custIds = [...new Set((deals || []).map(d => d.customer_id).filter(Boolean))];
    const custMap = new Map();
    if (custIds.length) {
      const { data: cs } = await supabaseAdmin.from('customers')
        .select('id, first_name, last_name, email, phone, is_company, company_name')
        .in('id', custIds);
      for (const c of cs || []) custMap.set(c.id, c);
    }

    // 4) attendee-rows bouwen — zelfde shape als historical-event-save.
    const rows = [];
    for (const dealId of toInsertDeals) {
      const deal = dealMap.get(dealId);
      if (!deal) continue;
      const c = deal.customer_id ? custMap.get(deal.customer_id) : null;
      const fn = c?.first_name || (c?.is_company ? (c.company_name || '(bedrijf)') : '');
      const ln = c?.last_name || '';
      rows.push({
        event_id:           eventId,
        first_name:         fn || '',
        last_name:          ln || '',
        email:              c?.email || null,
        phone:              c?.phone || null,
        status:             'aanwezig',
        attended_at:        startsAt,
        customer_id:        deal.customer_id || null,
        deal_id:            deal.id,
        created_by_user_id: admin.user.id,
        automation_enabled: false,
      });
    }

    if (!rows.length) {
      return res.status(200).json({
        ok: true,
        added: 0,
        skipped_duplicates: uniqDeals.length - toInsertDeals.length,
        missing: missingDeals.length,
      });
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('event_attendees')
      .insert(rows)
      .select('id, deal_id');
    if (insErr) throw new Error('event_attendees insert: ' + insErr.message);

    return res.status(200).json({
      ok: true,
      added: (inserted || []).length,
      skipped_duplicates: uniqDeals.length - toInsertDeals.length,
      missing: missingDeals.length,
    });
  } catch (e) {
    console.error('[historical-event-attendees-add]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
