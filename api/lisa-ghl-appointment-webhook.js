// api/lisa-ghl-appointment-webhook.js
// Webhook-ontvanger voor GHL appointment-events → Lisa werkt de conversatie automatisch bij.
//
// Auth: ?secret=LISA_WEBHOOK_SECRET (zelfde secret als de IG-webhook).
// Geeft ALTIJD 200 terug (behalve ontbrekend/ongeldig secret) → geen GHL-retry-storm.
// Stuurt GEEN bericht naar de volger (die krijgt al een GHL-bevestiging); logt alleen een
// systeem-event in de thread (is_system) en past de conversatie-status aan.

import { supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = process.env.LISA_WEBHOOK_SECRET;
  if (!expectedSecret) { console.error('[appointment-webhook] LISA_WEBHOOK_SECRET niet gezet'); return res.status(500).json({ error: 'Server misconfigured' }); }
  if (req.query.secret !== expectedSecret) { console.warn('[appointment-webhook] ongeldig secret'); return res.status(401).json({ error: 'Unauthorized' }); }

  try {
    const body = req.body || {};
    const customData = body.customData || {};
    const payload = {
      contactId: customData.contactId || body.contact_id || body.contactId,
      appointmentId: customData.appointmentId || body.appointment?.id || body.appointmentId,
      appointmentStatus: customData.appointmentStatus || body.appointment?.status || body.appointmentStatus || 'booked',
      startTime: customData.startTime || body.appointment?.startTime || body.startTime,
      eventType: customData.eventType || body.eventType || 'created',
      // Voor de leads-koppeling (kadootje-opstartsessie e.d.): GHL moet contact.email
      // + contact.phone meesturen, anders kunnen we de lead niet matchen.
      email: customData.email || body.contact?.email || body.email || null,
      phone: customData.phone || body.contact?.phone || body.phone || null,
    };

    const status = String(payload.appointmentStatus || '').toLowerCase();

    // NIEUW: koppel de afspraak aan de lead in public.leads (los van Lisa), gematcht op
    // lower(email) met telefoon als terugval. Fail-soft — een fout hier mag de Lisa-flow
    // niet breken (webhook blijft 200 → geen GHL-retry-storm).
    let leadKoppeling = null;
    try {
      leadKoppeling = await koppelAfspraakAanLead(payload, status);
    } catch (e) {
      console.error('[appointment-webhook] lead-koppeling faalde:', e?.message || e);
      leadKoppeling = { error: e?.message || String(e) };
    }

    if (!payload.contactId) return res.status(200).json({ skipped: 'no_contact_id', lead: leadKoppeling, payload_keys: Object.keys(body) });

    const { data: conv } = await supabaseAdmin.from('lisa_conversations').select('*')
      .eq('ghl_contact_id', payload.contactId).eq('is_sandbox', false).maybeSingle();
    if (!conv) {
      console.log('[appointment-webhook] geen conversatie voor', payload.contactId);
      return res.status(200).json({ skipped: 'no_conversation', contactId: payload.contactId, lead: leadKoppeling });
    }

    const now = new Date().toISOString();
    let updates = {};
    let logMessage = '';

    if (status === 'booked' || status === 'confirmed' || status === 'new' || payload.eventType === 'created') {
      updates = {
        call_booked: true, call_booked_at: now,
        phase: 'qualified', qualified: true, qualified_at: now,
        followup_paused: true, followup_paused_at: now, followup_paused_reason: 'appointment_booked',
      };
      logMessage = `📅 Afspraak geboekt (${payload.startTime || 'tijd onbekend'})`;
      await supabaseAdmin.from('lisa_followups')
        .update({ status: 'cancelled', cancelled_reason: 'appointment_booked' })
        .eq('conversation_id', conv.id).eq('status', 'scheduled');
    } else if (status === 'cancelled' || status === 'canceled' || status === 'no_show' || status === 'noshow') {
      updates = {
        call_booked: false, followup_paused: false, followup_paused_at: null, followup_paused_reason: null, phase: 'band',
      };
      logMessage = `❌ Afspraak ${status.startsWith('no') ? 'no-show' : 'geannuleerd'}`;
    } else if (status === 'completed' || status === 'showed') {
      updates = { phase: 'done' };
      logMessage = '✅ Afspraak afgerond';
    } else if (status === 'rescheduled') {
      updates = { call_booked_at: now };
      logMessage = `🔄 Afspraak verplaatst${payload.startTime ? ' naar ' + payload.startTime : ''}`;
    } else {
      console.log('[appointment-webhook] onbekende status:', status);
      return res.status(200).json({ ok: true, skipped: 'unknown_status', status });
    }

    if (Object.keys(updates).length) {
      await supabaseAdmin.from('lisa_conversations').update(updates).eq('id', conv.id);
    }

    await supabaseAdmin.from('lisa_messages').insert({
      conversation_id: conv.id, direction: 'out', content: logMessage,
      ai_generated: false, is_system: true, sent_at: now,
    });

    return res.status(200).json({ ok: true, conv_id: conv.id, action: status, updates_applied: Object.keys(updates), lead: leadKoppeling });
  } catch (err) {
    console.error('[appointment-webhook] error:', err?.message || err);
    return res.status(200).json({ ok: false, error: err?.message || 'onbekende fout' });
  }
}

// ---- Leads-koppeling (kadootje-opstartsessie e.d.) ------------------------------
// Zet public.leads.afspraak_op op basis van een GHL-appointment-event, onafhankelijk
// van Lisa. Match op lower(email) (ilike zonder wildcards = case-insensitive exact),
// met telefoon (laatste 9 cijfers) als terugval. Booking → afspraak_op = starttijd;
// annulering/no-show → afspraak_op = null (Call gepland weer 'nee'); overige statussen
// → geen wijziging. Best-effort; de aanroeper vangt fouten op.
function parseStart(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function koppelAfspraakAanLead(payload, status) {
  const email = (payload.email || '').trim().toLowerCase();
  const phoneDigits = (payload.phone || '').replace(/[^0-9]/g, '');
  if (!email && !phoneDigits) return { skipped: 'no_email_or_phone' };

  const isBooking = status === 'booked' || status === 'confirmed' || status === 'new'
    || status === 'rescheduled' || payload.eventType === 'created';
  const isCancel = status === 'cancelled' || status === 'canceled'
    || status === 'no_show' || status === 'noshow';

  let afspraakOp;
  if (isBooking) {
    afspraakOp = parseStart(payload.startTime);
    if (!afspraakOp) return { skipped: 'no_valid_start' };
  } else if (isCancel) {
    afspraakOp = null; // afspraak vervalt → Call gepland terug naar 'nee'
  } else {
    return { skipped: 'status_no_change', status };
  }

  const escLike = (s) => s.replace(/[%_\\]/g, (m) => '\\' + m);

  // 1) Match op lower(email).
  if (email) {
    const { data, error } = await supabaseAdmin.from('leads')
      .update({ afspraak_op: afspraakOp })
      .ilike('email', escLike(email))
      .is('verwijderd_op', null)
      .select('id');
    if (error) throw new Error('leads(email): ' + error.message);
    if (data && data.length) return { matched: 'email', count: data.length, afspraak_op: afspraakOp };
  }

  // 2) Terugval op telefoon (laatste 9 cijfers, formaat-onafhankelijk).
  if (phoneDigits.length >= 8) {
    const staart = phoneDigits.slice(-9);
    const { data, error } = await supabaseAdmin.from('leads')
      .update({ afspraak_op: afspraakOp })
      .ilike('telefoon', '%' + staart + '%')
      .is('verwijderd_op', null)
      .select('id');
    if (error) throw new Error('leads(phone): ' + error.message);
    if (data && data.length) return { matched: 'phone', count: data.length, afspraak_op: afspraakOp };
  }

  return { matched: 'none', hadEmail: !!email, hadPhone: !!phoneDigits };
}
