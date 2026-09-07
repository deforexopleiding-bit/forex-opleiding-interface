// api/public-event-bevestiging.js
//
// Publieke bevestigings-endpoint voor de FASE-1 event-kwalificatie-aanmelding op
// deforexopleiding.nl. Server-to-server via x-internal-token == OPSTARTSESSIE_SECRET
// (de gedeelde dfo-website↔CRM-token; dfo-website's book-route roept dit fail-soft
// aan). Stuurt één eenvoudige bevestigingsmail vanaf events@.
//
// POST { to, voornaam?, event_titel? }
//
// Response:
//   200 { ok:true, messageId }
//   400 { error }        — validatie
//   401 { error }        — token
//   502 { error }        — SMTP-fout
//   503 { error }        — OPSTARTSESSIE_SECRET niet geconfigureerd
//
// 0 DB-writes.

import { sendEmailViaSmtp } from './_lib/send-email-core.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FROM_MAILBOX = 'events@deforexopleiding.nl';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth (zelfde patroon als public-opstartsessie-*).
  const tokenHeader = req.headers['x-internal-token'] || null;
  const verwacht = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if (!tokenHeader || tokenHeader !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const to = String(body.to || '').trim().toLowerCase().slice(0, 200);
  const voornaam = String(body.voornaam || '').trim().slice(0, 80);
  const titel = String(body.event_titel || '').trim().slice(0, 200);
  if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'geldig e-mailadres vereist' });

  const naam = voornaam || 'daar';
  const evLabel = titel || 'het event';
  const subject = `Je plek is bevestigd — ${evLabel}`;
  const text =
    `Hoi ${naam},\n\n` +
    `Je plek voor ${evLabel} is bevestigd. We kijken ernaar uit je te zien!\n\n` +
    `We sturen je binnenkort meer informatie ter voorbereiding.\n\n` +
    `Team De Forex Opleiding`;
  const html =
    `<p>Hoi ${esc(naam)},</p>` +
    `<p>Je plek voor <b>${esc(evLabel)}</b> is bevestigd. We kijken ernaar uit je te zien!</p>` +
    `<p>We sturen je binnenkort meer informatie ter voorbereiding.</p>` +
    `<p>Team De Forex Opleiding</p>`;

  try {
    const r = await sendEmailViaSmtp({ fromMailbox: FROM_MAILBOX, to, subject, text, html });
    if (!r?.ok) {
      if (r?.code === 'SMTP_NOT_CONFIGURED') {
        return res.status(503).json({ error: 'events@-mailbox niet geconfigureerd', detail: r.reason });
      }
      return res.status(502).json({ error: 'Versturen mislukt', detail: r?.reason });
    }
    return res.status(200).json({ ok: true, messageId: r.messageId || null });
  } catch (e) {
    console.error('[public-event-bevestiging]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
