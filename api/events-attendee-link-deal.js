// api/events-attendee-link-deal.js
//
// POST { attendee_id: uuid, deal_id: uuid }    — koppelen
// POST { attendee_id: uuid, unlink: true }      — ontkoppelen (v=2, 2026-08-27)
//
// KOPPELEN: zet attendee.deal_id = deal_id + attendee.customer_id (als leeg)
// = deal.customer_id + bonus_excluded=false zodat de bonus-motor 'em oppikt.
//
// ONTKOPPELEN: zet attendee.deal_id = NULL + attendee.bonus_excluded = TRUE.
// customer_id blijft behouden. De bonus_excluded-vlag voorkomt dat de bonus-
// motor via customer_id-fallback (events-complete-core.js sectie 7) alsnog
// een bonus toekent op basis van "de meest recente accepted/signed deal van
// deze klant". Ontkoppelen betekent: expliciete geen-bonus-intentie.
//
// Permission: events.attendee.edit (dezelfde als andere attendee-mutaties).
// Idempotent: al gelijk → no-op response met success=true + already=true.
//
// Bonus-safety: raakt NIET mentor_ledger_entries. De bestaande afrond-flow
// respecteert de idempotency-key ${event_id}:bonus:${att.id}:${m.user_id}
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
  const isUnlink   = body.unlink === true;
  const dealId     = String(body.deal_id     || '').trim();

  if (!UUID_RE.test(attendeeId)) return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  if (!isUnlink && !UUID_RE.test(dealId)) return res.status(400).json({ error: 'deal_id (uuid) vereist (of unlink=true)' });

  try {
    // Attendee altijd fetchen (zowel voor koppel als unlink).
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, deal_id, customer_id, event_id, bonus_excluded')
      .eq('id', attendeeId).maybeSingle();
    if (attErr) throw new Error('attendee fetch: ' + attErr.message);
    if (!attendee) return res.status(404).json({ error: 'Attendee niet gevonden' });

    // ── UNLINK-pad ──────────────────────────────────────────────────────
    if (isUnlink) {
      // Idempotent: al ontkoppeld + al uitgesloten → no-op.
      if (attendee.deal_id === null && attendee.bonus_excluded === true) {
        return res.status(200).json({ ok: true, already: true, attendee_id: attendeeId, deal_id: null, bonus_excluded: true });
      }
      const updates = { deal_id: null, bonus_excluded: true };
      // customer_id BEWUST NIET aangeraakt — behoud voor rapportages.
      const { error: upErr } = await supabaseAdmin
        .from('event_attendees')
        .update(updates)
        .eq('id', attendeeId);
      if (upErr) throw new Error('attendee unlink: ' + upErr.message);
      return res.status(200).json({
        ok: true, already: false, attendee_id: attendeeId,
        deal_id: null, bonus_excluded: true,
        customer_id: attendee.customer_id || null,
      });
    }

    // ── LINK-pad ────────────────────────────────────────────────────────
    // Deal alleen bij link-pad fetchen.
    const { data: deal, error: dealErr } = await supabaseAdmin
      .from('deals').select('id, customer_id').eq('id', dealId).maybeSingle();
    if (dealErr) throw new Error('deal fetch: ' + dealErr.message);
    if (!deal)   return res.status(404).json({ error: 'Deal niet gevonden' });

    // Idempotent no-op als de deal al gekoppeld is EN bonus_excluded op false staat.
    if (attendee.deal_id === dealId && attendee.bonus_excluded === false) {
      return res.status(200).json({ ok: true, already: true, attendee_id: attendeeId, deal_id: dealId });
    }

    // Bij (her)koppelen ALTIJD bonus_excluded resetten naar false — anders
    // blijft een eerder ontkoppelde attendee uitgesloten zelfs na nieuwe koppel.
    const updates = { deal_id: dealId, bonus_excluded: false };
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
      bonus_excluded: false,
      customer_id: updates.customer_id || attendee.customer_id || null,
    });
  } catch (e) {
    console.error('[events-attendee-link-deal]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
