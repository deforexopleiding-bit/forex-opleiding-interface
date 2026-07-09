// api/events-attendee-link-deal.js
//
// POST { attendee_id: uuid, deal_id: uuid }
//
// Koppelt een deal aan een attendee zodat de mentor-bonus bij het
// afronden (events-complete-core.js) via attendee.deal_id de juiste
// deal vindt. Zet ook attendee.customer_id als die nog leeg is
// (best-effort — kopieert deal.customer_id).
//
// Permission: events.attendee.edit (dezelfde als andere attendee-mutaties).
// Idempotent: als attendee.deal_id al gelijk is aan het target, geen
// no-op-response met success=true + already=true.
//
// Bonus-safety: raakt NIET mentor_ledger_entries. De bestaande afrond-
// flow pikt attendee.deal_id op via events-complete-core regel 286-294
// en gebruikt de idempotency-key ${event_id}:bonus:${att.id}:${m.user_id}
// zodat een herafronding geen dubbele bonus geeft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'events.attendee.edit');
  if (!allowed) allowed = await requirePermission(req, 'events.event.edit');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const attendeeId = String(body.attendee_id || '').trim();
  const dealId     = String(body.deal_id     || '').trim();
  if (!UUID_RE.test(attendeeId)) return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  if (!UUID_RE.test(dealId))     return res.status(400).json({ error: 'deal_id (uuid) vereist' });

  try {
    // Verifieer bestaan van beide entiteiten.
    const [attRes, dealRes] = await Promise.all([
      supabaseAdmin.from('event_attendees').select('id, deal_id, customer_id, event_id').eq('id', attendeeId).maybeSingle(),
      supabaseAdmin.from('deals').select('id, customer_id').eq('id', dealId).maybeSingle(),
    ]);
    if (attRes.error)  throw new Error('attendee fetch: ' + attRes.error.message);
    if (dealRes.error) throw new Error('deal fetch: '     + dealRes.error.message);
    const attendee = attRes.data;
    const deal     = dealRes.data;
    if (!attendee) return res.status(404).json({ error: 'Attendee niet gevonden' });
    if (!deal)     return res.status(404).json({ error: 'Deal niet gevonden' });

    // Idempotent no-op als de deal al gekoppeld is.
    if (attendee.deal_id === dealId) {
      return res.status(200).json({ ok: true, already: true, attendee_id: attendeeId, deal_id: dealId });
    }

    const updates = { deal_id: dealId };
    // customer_id niet overschrijven als 'ie al gezet is — de attendee's
    // eigen klant kan verschillen van de deal-eigenaar (broer-koopt-voor-zus).
    if (!attendee.customer_id && deal.customer_id) {
      updates.customer_id = deal.customer_id;
    }

    const { error: upErr } = await supabaseAdmin
      .from('event_attendees')
      .update(updates)
      .eq('id', attendeeId);
    if (upErr) throw new Error('attendee update: ' + upErr.message);

    return res.status(200).json({
      ok         : true,
      already    : false,
      attendee_id: attendeeId,
      deal_id    : dealId,
      customer_id: updates.customer_id || attendee.customer_id || null,
    });
  } catch (e) {
    console.error('[events-attendee-link-deal]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
