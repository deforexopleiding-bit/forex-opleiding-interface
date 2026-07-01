// api/events-attendee-add.js
// POST -> nieuwe deelnemer toevoegen aan een event.
//
// Permission: events.attendee.create.
//
// Body (JSON):
//   {
//     event_id:   uuid    (verplicht),
//     first_name: string  (optioneel),
//     last_name:  string  (optioneel),
//     email:      string  (optioneel; uniek per event als opgegeven),
//     phone:      string  (optioneel),
//     status:     string  (optioneel, default 'aangemeld'),
//     send_invite: bool   (optioneel, default false) — bepaalt automation_enabled
//                  op de nieuwe rij. true → attendee wordt door automations
//                  opgepakt (bv. on_signup stuurt zelf bevestiging+vragenlijst
//                  bij eerstvolgende cron-tick). false → STILLE handmatige
//                  toevoeging, uitgesloten van ALLE automations. Geen one-shot
//                  invite meer (oude dubbele-communicatie-bug).
//   }
//
// Capacity-check: bij status in (aangemeld|aanwezig|sale) wordt eerst
// gecontroleerd of capacity nog niet vol zit. Bij vol -> 409 SEATS_FULL.
//
// Email-uniciteit: case-insensitive unique per event (partial unique index
// uq_event_attendees_event_email). Bij duplicate -> 409 EMAIL_EXISTS.
//
// Audit-log: event_attendee_audit_log entry met action='created'.
//
// Response 201: { attendee: { ...row }, invite: null }
//   `invite` blijft in de shape voor backwards-compat met oude UI's, maar is
//   altijd null (one-shot path verwijderd).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  CONFIRMED_STATUSES,
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
} from './_lib/event-registration.js';
// Sinds opt-in herontwerp: 'send_invite' triggert nu automation_enabled i.p.v.
// een one-shot invite. De sendEventAttendeeInvite-helper is dus niet meer nodig
// hier (blijft beschikbaar voor andere callers zoals de move-flow).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUS = ['aangemeld', 'aanwezig', 'no_show', 'sale', 'switched_to_other_event', 'geannuleerd'];
const ACTIVE_STATUSES = ['aangemeld', 'aanwezig', 'sale'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.create'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.create)' });
  }

  const body = req.body || {};
  const eventId   = body.event_id ? String(body.event_id) : null;
  const firstName = body.first_name != null ? String(body.first_name).trim() : null;
  const lastName  = body.last_name  != null ? String(body.last_name).trim()  : null;
  const email     = body.email      != null ? String(body.email).trim()      : null;
  const phone     = body.phone      != null ? String(body.phone).trim()      : null;
  const status    = body.status ? String(body.status).toLowerCase() : 'aangemeld';
  const sendInvite = body.send_invite === true || body.send_invite === 'true';
  // Optioneel: koppel de nieuwe aanwezige direct aan een bestaande klant.
  // Gebruikt door de inbox-template-picker (0-kandidaten flow) zodat de
  // net-toegevoegde aanwezige meteen via customer_id-match terugkomt in
  // _evResolveAttendeeCandidatesForConv. NULL = niet gekoppeld.
  const customerId = body.customer_id != null ? String(body.customer_id).trim() || null : null;

  if (!eventId || !UUID_RE.test(eventId)) return res.status(400).json({ error: 'event_id (uuid) vereist' });
  if (customerId && !UUID_RE.test(customerId)) {
    return res.status(400).json({ error: 'customer_id moet geldige uuid zijn' });
  }
  if (!VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: `status moet ${VALID_STATUS.join('|')} zijn` });
  }
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'email ongeldig' });
  }
  if (!firstName && !lastName && !email && !phone) {
    return res.status(400).json({ error: 'minimaal 1 identificerend veld vereist (first_name/last_name/email/phone)' });
  }

  try {
    // Event-existence + capacity-fetch
    const { data: ev, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, capacity, status, signups_closed, webflow_item_id')
      .eq('id', eventId)
      .maybeSingle();
    if (evErr) throw new Error('event-lookup: ' + evErr.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });
    if (ev.status === 'archived') {
      return res.status(409).json({ error: 'Event is gearchiveerd' });
    }

    // Capacity-check: alleen voor actieve statussen.
    if (ACTIVE_STATUSES.includes(status)) {
      const { count: active, error: cErr } = await supabaseAdmin
        .from('event_attendees')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId)
        .in('status', ACTIVE_STATUSES);
      if (cErr) throw new Error('capacity-count: ' + cErr.message);
      const cnt = typeof active === 'number' ? active : 0;
      if (cnt >= ev.capacity) {
        return res.status(409).json({
          code:  'SEATS_FULL',
          error: `Event is vol (${cnt}/${ev.capacity}); kies status='no_show' of verhoog capacity`,
        });
      }
    }

    // Phone-dedup binnen dit event. Geen partial unique index op
    // (event_id, phone) — telefoonnummers staan vrij geformatteerd in DB —
    // dus we doen een expliciete check op exact match (zelfde shape als
    // _evResolveAttendeeCandidatesForConv die op phone matcht). Voorkomt
    // dat de inbox-add-flow per ongeluk dubbele rijen aanmaakt wanneer de
    // operator de knop tweemaal indrukt of de check-flow eerder mis-merged
    // had.
    if (phone) {
      const { data: existingPhone, error: pErr } = await supabaseAdmin
        .from('event_attendees')
        .select('id')
        .eq('event_id', eventId)
        .eq('phone', phone)
        .limit(1)
        .maybeSingle();
      if (pErr) {
        console.error('[events-attendee-add phone-check]', pErr.message);
        // Fail-soft: bij een DB-fout op de check NIET hard-falen — laat de
        // INSERT z'n werk doen. Een echte dubbele wordt dan eventueel door
        // de email-uniqueness-constraint nog gevangen.
      } else if (existingPhone) {
        return res.status(409).json({
          code:  'PHONE_EXISTS',
          error: 'Dit nummer staat al op dit event.',
        });
      }
    }

    const nowIso = new Date().toISOString();
    const insertRow = {
      event_id:           eventId,
      first_name:         firstName,
      last_name:          lastName,
      email:              email,
      phone:              phone,
      status,
      source:             'manual',
      // send_invite (true/false) bepaalt of de attendee door automations wordt
      // opgepakt. true → automation_enabled=true (default; bv. on_signup pakt
      // 'm op bij de eerstvolgende tick en stuurt bevestiging/vragenlijst).
      // false → automation_enabled=false → STILLE handmatige toevoeging,
      // geen mail/WA. Zelfde endpoint blijft één call voor de UI.
      automation_enabled: sendInvite,
      created_by_user_id: user?.id || null,
      // Timestamp-stempels op create voor statussen die al doorlopen zijn.
      attended_at:        status === 'aanwezig' ? nowIso : null,
      no_show_marked_at:  status === 'no_show'  ? nowIso : null,
      sale_at:            status === 'sale'     ? nowIso : null,
      // Optionele customer-koppeling (zie body-destructuring boven).
      customer_id:        customerId,
    };

    const { data: row, error } = await supabaseAdmin
      .from('event_attendees')
      .insert(insertRow)
      .select(`
        id, event_id, first_name, last_name, email, phone, status,
        customer_id, deal_id, subscription_id,
        ghl_contact_id, ghl_form_submission_id, assessment_response_id,
        switched_from_event_id, switched_at,
        registered_at, attended_at, no_show_marked_at, sale_at,
        follow_up_flagged, follow_up_reason,
        choice_token,
        created_at, updated_at
      `)
      .single();

    if (error) {
      // 23505 = unique-violation (partial unique index op (event_id, lower(email))).
      if (error.code === '23505') {
        return res.status(409).json({
          code:  'EMAIL_EXISTS',
          error: `Deze email is al aangemeld voor dit event`,
        });
      }
      throw new Error('attendee-insert: ' + error.message);
    }

    // Audit-log entry (fail-soft)
    try {
      await supabaseAdmin.from('event_attendee_audit_log').insert({
        attendee_id:  row.id,
        action:       'created',
        before_state: null,
        after_state:  {
          event_id:   row.event_id,
          first_name: row.first_name,
          last_name:  row.last_name,
          email:      row.email,
          phone:      row.phone,
          status:     row.status,
        },
        by_user_id:   user?.id || null,
      });
    } catch (e) {
      console.error('[events-attendee-add audit]', e.message);
    }

    // Auto-close-check: bij een nieuwe rij in CONFIRMED_STATUSES kan de
    // confirmed_count over capacity heen tikken. Hergebruikt de bestaande
    // triplet (getConfirmedCount + syncGastenlijstWebflow + autoCloseIfFull);
    // autoCloseIfFull is idempotent (guard op >=capacity && !signups_closed).
    // Fail-soft — mag de attendee-insert NOOIT breken.
    if (CONFIRMED_STATUSES.includes(status)) {
      try {
        const cnt = await getConfirmedCount(eventId);
        await syncGastenlijstWebflow(ev, cnt);
        await autoCloseIfFull(ev, cnt);
      } catch (e) {
        console.warn('[events-attendee-add] auto-close (soft):', e?.message || e);
      }
    }

    // GEEN one-shot invite meer vanuit deze endpoint. send_invite=true zet
    // automation_enabled=true (zie INSERT hierboven) — de on_signup-automation
    // pikt de attendee bij de eerstvolgende cron-tick op en stuurt zelf de
    // bevestiging/vragenlijst. Voorkomt de oude dubbele communicatie
    // (one-shot + automation). send_invite=false → automation_enabled=false
    // → stille handmatige toevoeging, zonder berichten.
    // 'invite' blijft in de response voor backwards-compat met UI's die het
    // veld nog uitlezen, maar is altijd null.
    return res.status(201).json({ attendee: row, invite: null });
  } catch (e) {
    console.error('[events-attendee-add]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
