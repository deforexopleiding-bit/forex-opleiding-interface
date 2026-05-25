// api/_lib/lisa-ghl-send.js
// Helper om Lisa-berichten naar GoHighLevel (Instagram) te sturen via de Conversations API.
// Native fetch (Node 18+, ESM). Token: GHL_PIT_TOKEN of GHL_API_KEY (zelfde als follow-up-modules).

import { supabaseAdmin } from '../supabase.js';

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';

function ghlToken() {
  return process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY || null;
}

/**
 * Verstuur een bericht naar GHL (type IG = Instagram).
 * @param {string} contactId
 * @param {string} message
 * @param {{conversationId?:string, locationId?:string}} options
 * @returns {Promise<{ok:boolean, message_id?:string, error?:string, raw?:object}>}
 */
export async function sendToGhl(contactId, message, options = {}) {
  const token = ghlToken();
  if (!token) return { ok: false, error: 'GHL_PIT_TOKEN/GHL_API_KEY ontbreekt in env' };
  if (!contactId || !message) return { ok: false, error: 'contactId + message vereist' };

  try {
    const body = {
      type: 'IG',
      contactId,
      message,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    };
    const response = await fetch(`${GHL_API}/conversations/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
        ...(options.locationId ? { LocationId: options.locationId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[lisa-ghl-send] GHL send error:', response.status, errorText);
      return { ok: false, error: `GHL API ${response.status}: ${errorText}` };
    }
    const data = await response.json().catch(() => ({}));
    return { ok: true, message_id: data.messageId || data.id || null, raw: data };
  } catch (err) {
    console.error('[lisa-ghl-send] exception:', err?.message || err);
    return { ok: false, error: err?.message || 'onbekende fout' };
  }
}

/**
 * Haal contactgegevens op uit GHL (best-effort; null bij fout).
 */
export async function getGhlContact(contactId) {
  const token = ghlToken();
  if (!token || !contactId) return null;
  try {
    const response = await fetch(`${GHL_API}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    return data.contact || data || null;
  } catch (err) {
    console.error('[lisa-ghl-send] getGhlContact error:', err?.message || err);
    return null;
  }
}

// ── Response-delay (F10) ──────────────────────────────────────────────────────
/** Bereken response-delay in ms o.b.v. settings + fase (fixed/random/per_phase). */
export function computeResponseDelay(settings, phase) {
  if (!settings) return 0;
  const mode = settings.response_delay_mode || 'random';
  if (mode === 'fixed') return Math.max(0, (settings.response_delay_fixed_seconds || 45) * 1000);
  if (mode === 'per_phase') {
    const perPhase = settings.response_delay_per_phase || {};
    const v = parseInt(perPhase[phase], 10);
    return Math.max(0, (isNaN(v) ? 45 : v) * 1000);
  }
  // random (default)
  const min = Math.max(0, settings.response_delay_min_seconds || 30);
  const max = Math.max(min, settings.response_delay_max_seconds || 90);
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stuur een typing-indicator naar GHL. Fail-soft (mogelijk niet ondersteund voor IG). */
export async function sendTypingIndicator(contactId, options = {}) {
  const token = ghlToken();
  if (!token || !contactId) return { ok: false, error: 'no_token_or_contact' };
  try {
    const body = { type: 'IG', contactId, isTyping: true, ...(options.conversationId ? { conversationId: options.conversationId } : {}) };
    const response = await fetch(`${GHL_API}/conversations/messages/typing`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, Version: GHL_VERSION, 'Content-Type': 'application/json',
        ...(options.locationId ? { LocationId: options.locationId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const txt = await response.text();
      console.log('[lisa-typing] failed:', response.status, txt.slice(0, 120));
      return { ok: false, error: String(response.status) };
    }
    return { ok: true };
  } catch (err) {
    console.log('[lisa-typing] exception:', err?.message || err);
    return { ok: false, error: err?.message || 'onbekende fout' };
  }
}

// ── Booking-match (F12) ───────────────────────────────────────────────────────
async function logSystemMessage(conversationId, content) {
  try {
    await supabaseAdmin.from('lisa_messages').insert({
      conversation_id: conversationId, direction: 'out', content, ai_generated: false, is_system: true, sent_at: new Date().toISOString(),
    });
  } catch (_) { /* niet kritiek */ }
}

// Zoek een GHL-contact op e-mail via een fallback-keten (de exacte endpoint-variant
// verschilt per GHL-account). Probeert 3 endpoints tot een exacte e-mail-match.
// Returnt altijd { contacts: [...] } (leeg = geen match) — nooit een throw.
async function searchGhlContactByEmail(email, locationId, token) {
  const target = String(email).toLowerCase().trim();
  const hdr = { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' };
  const exact = (arr) => (arr || []).filter((c) => String(c.email || '').toLowerCase().trim() === target);

  // Poging 1: GET /contacts/?locationId=&query= (moderne API; query kan fuzzy zijn)
  try {
    const u = `${GHL_API}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(target)}`;
    const r = await fetch(u, { headers: hdr });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const m = exact(d.contacts || d.results);
      if (m.length) { console.log('[booking-match] via /contacts/?query'); return { contacts: m, source: 'query' }; }
    } else { console.log('[booking-match] /contacts/?query failed:', r.status); }
  } catch (e) { console.log('[booking-match] /contacts/?query exception:', e?.message || e); }

  // Poging 2: GET /contacts/search/duplicate?locationId=&email= (geeft één duplicate-contact)
  try {
    const u = `${GHL_API}/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&email=${encodeURIComponent(target)}`;
    const r = await fetch(u, { headers: hdr });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const c = d.contact || (Array.isArray(d.contacts) ? d.contacts[0] : null);
      if (c && String(c.email || '').toLowerCase().trim() === target) { console.log('[booking-match] via /search/duplicate'); return { contacts: [c], source: 'duplicate' }; }
    } else { console.log('[booking-match] /search/duplicate failed:', r.status); }
  } catch (e) { console.log('[booking-match] /search/duplicate exception:', e?.message || e); }

  // Poging 3: POST /contacts/search (nieuwste API)
  try {
    const r = await fetch(`${GHL_API}/contacts/search`, {
      method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, filters: [{ field: 'email', operator: 'eq', value: target }] }),
    });
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const m = exact(d.contacts);
      if (m.length) { console.log('[booking-match] via POST /contacts/search'); return { contacts: m, source: 'post_search' }; }
    } else { console.log('[booking-match] POST /contacts/search failed:', r.status); }
  } catch (e) { console.log('[booking-match] POST /contacts/search exception:', e?.message || e); }

  return { contacts: [], source: 'none' };
}

/**
 * Match een conversatie tegen een GHL-contact via e-mail; bij 1 match + actieve afspraak
 * wordt de booking automatisch gekoppeld. Fail-safe (gooit nooit). Max 2 GHL-calls.
 * @returns {Promise<{ok:boolean, status?:string, contactId?:string, hasAppointment?:boolean, error?:string}>}
 */
export async function matchBookingByEmail(conversationId, email, locationId) {
  const token = ghlToken();
  if (!token) return { ok: false, error: 'no_token' };
  const target = String(email || '').toLowerCase().trim();
  if (!target) return { ok: false, error: 'no_email' };

  const setStatus = async (status, extra = {}) => {
    await supabaseAdmin.from('lisa_conversations')
      .update({ booking_match_status: status, booking_match_at: new Date().toISOString(), ...extra })
      .eq('id', conversationId);
  };

  try {
    // 1. locationId bepalen (param → conv → env-fallback).
    let loc = locationId;
    if (!loc) {
      const { data: conv } = await supabaseAdmin.from('lisa_conversations').select('ghl_location_id').eq('id', conversationId).maybeSingle();
      loc = conv?.ghl_location_id || process.env.GHL_DEFAULT_LOCATION_ID || null;
    }
    if (!loc) { console.log('[booking-match] geen locationId'); return { ok: false, error: 'no_location_id' }; }

    // 2. Contact zoeken via fallback-keten (exacte e-mail-match binnenin).
    const { contacts: matches } = await searchGhlContactByEmail(target, loc, token);

    if (matches.length === 0) { await setStatus('no_match'); await logSystemMessage(conversationId, `🔍 Booking-match: geen GHL-contact gevonden voor ${target}`); return { ok: true, status: 'no_match' }; }
    if (matches.length > 1) { await setStatus('multiple_matches'); await logSystemMessage(conversationId, `🔍 Booking-match: meerdere GHL-contacten met ${target} — handmatig controleren`); return { ok: true, status: 'multiple_matches' }; }

    const c = matches[0];
    const naam = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.contactName || target;

    // 2. Heeft dit contact een actieve afspraak?
    let hasAppointment = false;
    try {
      const ar = await fetch(`${GHL_API}/contacts/${c.id}/appointments`, { headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' } });
      if (ar.ok) {
        const ad = await ar.json().catch(() => ({}));
        hasAppointment = (ad.events || ad.appointments || []).some((a) =>
          ['confirmed', 'booked', 'new'].includes(String(a.appointmentStatus || a.status || '').toLowerCase()));
      }
    } catch (_) { /* appointment-check is best-effort */ }

    const extra = { booking_matched_contact_id: c.id };
    if (hasAppointment) {
      const now = new Date().toISOString();
      Object.assign(extra, {
        call_booked: true, call_booked_at: now, qualified: true, qualified_at: now,
        phase: 'qualified', followup_paused: true, followup_paused_at: now, followup_paused_reason: 'booking_matched',
      });
      await supabaseAdmin.from('lisa_followups')
        .update({ status: 'cancelled', cancelled_reason: 'booking_matched' })
        .eq('conversation_id', conversationId).eq('status', 'scheduled');
    }
    await setStatus('matched', extra);
    await logSystemMessage(conversationId, hasAppointment
      ? `✅ Booking gematched: ${naam} — afspraak gekoppeld`
      : `🔍 Booking gematched: ${naam} — nog geen actieve afspraak`);
    return { ok: true, status: 'matched', contactId: c.id, hasAppointment };
  } catch (err) {
    console.error('[booking-match] error:', err?.message || err);
    return { ok: false, error: err?.message || 'onbekende fout' };
  }
}
