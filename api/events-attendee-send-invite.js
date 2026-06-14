// api/events-attendee-send-invite.js
//
// POST → stuur een deelnemer z'n persoonlijke keuze-link via WhatsApp
// (Simone-lijn) + e-mail. Operator-actie vanuit events-detail Aanwezigen-tab.
// Beide kanalen onafhankelijk: één faal-tak blokkeert de andere niet.
//
// Permission: events.attendee.edit (bestaande key; operatie op bestaande rij).
//
// Body (JSON):
//   { attendee_id: uuid }
//
// Response 200 — beide kanalen los gerapporteerd:
//   {
//     mail     : { ok, skipped?, reason?, error? },
//     whatsapp : { ok, skipped?, reason?, message_id?, meta_wamid?, error? }
//   }
//
// Errors:
//   400  attendee_id ontbreekt / ongeldige uuid
//   401  geen sessie
//   403  geen events.attendee.edit rechten
//   404  attendee niet gevonden / event niet gevonden
//   500  database-fout (totale flow; per-kanaal-fouten worden in body gerapporteerd)
//
// CONFIGURATIE:
//   - PUBLIC_BASE_URL  (env, fallback https://forex-opleiding-interface.vercel.app)
//                      bron voor de keuze-link; zelfde patroon als
//                      api/_lib/template-variables.js getAttendeeValue.
//   - EVENTS_KEUZE_LINK_TEMPLATE_NAME (env, fallback 'events_keuze_link')
//                      naam van de goedgekeurde WhatsApp-template die we
//                      versturen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendMail, wrapEmailHtml } from './mailer.js';
import { sendEventWhatsAppTemplate } from './_lib/events-send.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app';
const TEMPLATE_NAME   = process.env.EVENTS_KEUZE_LINK_TEMPLATE_NAME || 'events_keuze_link';
const TEMPLATE_LANG   = 'nl';

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Operator-mail-helper (bespoke; blijft hier, niet in de lib) ─────────────
async function sendInviteMail({ firstName, keuzeLink, toEmail }) {
  if (!toEmail) return { ok: false, skipped: true, reason: 'no-email' };

  const subject = 'Kies de datum voor je Forex Masterclass';
  const naam = firstName || 'jij';

  const html = wrapEmailHtml(subject, `
    <p>Hoi ${escHtml(naam)},</p>
    <p>Leuk dat je erbij wilt zijn! Kies hieronder de datum die jou het beste past — je ziet meteen welke data nog plek hebben.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${escHtml(keuzeLink)}" style="display:inline-block;background:#093d54;color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none">Kies je datum</a>
    </p>
    <p>Heb je de korte vragenlijst nog niet ingevuld? Dat doe je in dezelfde stap; zo krijg je meteen het advies dat bij jouw niveau past.</p>
    <p style="margin-top:32px">Tot snel!<br>— Simone, De Forex Opleiding</p>
  `);

  const text = `Hoi ${naam}, kies de datum voor je Forex Masterclass: ${keuzeLink} — Simone, De Forex Opleiding`;

  try {
    await sendMail({ to: toEmail, subject, text, html });
    return { ok: true };
  } catch (e) {
    console.error('[events-attendee-send-invite] mail:', e?.message || e);
    return { ok: false, error: e?.message || 'mail send failed' };
  }
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth + RBAC.
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.edit)' });
  }

  // Body parse.
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });
  const attendeeId = typeof body.attendee_id === 'string' ? body.attendee_id.trim() : '';
  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist.' });
  }

  try {
    // Load attendee.
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee fetch: ' + attErr.message);
    if (!attendee) return res.status(404).json({ error: 'Deelnemer niet gevonden.' });
    if (!attendee.choice_token) {
      return res.status(500).json({ error: 'Deelnemer mist choice_token (data-anomalie).' });
    }

    // Load event.
    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, location, niveau, capacity, status')
      .eq('id', attendee.event_id)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return res.status(404).json({ error: 'Event niet gevonden.' });

    // Build keuze-link (zelfde patroon als attendee.keuze_link template-var).
    const keuzeLink = `${PUBLIC_BASE_URL}/modules/event-keuze.html?t=${encodeURIComponent(attendee.choice_token)}`;

    // Parallel: WhatsApp via herbruikbare lib + bespoke operator-mail.
    const [waResult, mailResult] = await Promise.all([
      sendEventWhatsAppTemplate({
        attendee,
        event,
        templateName : TEMPLATE_NAME,
        languageCode : TEMPLATE_LANG,
        sentByUserId : user.id,
      }),
      sendInviteMail({
        firstName: attendee.first_name,
        keuzeLink,
        toEmail  : attendee.email,
      }),
    ]);

    return res.status(200).json({
      attendee_id : attendee.id,
      event_id    : event.id,
      keuze_link  : keuzeLink,
      mail        : mailResult,
      whatsapp    : waResult,
    });
  } catch (e) {
    console.error('[events-attendee-send-invite] fatal:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
