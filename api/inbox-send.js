// api/inbox-send.js
// POST → verzend een outbound WhatsApp-bericht.
// Permission: finance.inbox.send (of events.simone.use / onboarding.inbox.send,
//             afhankelijk van de module van het gesprek)
//
// Body:
//   conversation_id     uuid  required
//   mode                'text' | 'template' | 'image' | 'document' | 'video'
//   body                text  required bij mode='text'
//   template_name       text  required bij mode='template'
//   template_language   text  optional (default 'nl')
//   template_variables  object optional
//   template_components array optional — Meta's components-payload
//   media_link          https-url required bij image/document/video
//   caption, filename   optional bij media
//
// Response: 200 { success: true, message_id, meta_wamid }
//           422 { error: '24h_window_expired', ... }
//           502 { error, meta_error } bij een fout van de transportlaag
//           503 { error, missing: [] } bij niet-geconfigureerde WhatsApp
//
// ── DIT BESTAND DOET ALLEEN HTTP ─────────────────────────────────────────────
// Het keuren, versturen en boeken staat in api/_lib/inbox-verzenden.js. Reden:
// het uitgestelde versturen heeft drie aanroepers die exact hetzelfde moeten
// doen (het scherm na dertig seconden, de cron als het scherm dichtgaat, en dit
// endpoint voor wie niet wil wachten). Drie kopieën van zo'n weg is drie keer
// een plek waar een wijziging aan de WhatsApp-kant vergeten kan worden.
//
// Wat hier blijft: methode, authenticatie, de grove rechtenpoort, het lezen van
// de body en het omzetten van een uitkomst naar een statuscode. Niets anders.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { getConfigStatus } from './_lib/meta-whatsapp.js';
import { leesVerzendOpdracht } from './_lib/inbox-verzendopdracht.js';
import { verstuurInGesprek } from './_lib/inbox-verzenden.js';

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

  // Grove poort vooraf: tenminste één van de drie moet er zijn. De
  // definitieve module-check gebeurt ná het laden van het gesprek, want pas
  // dan weten we bij welke module het hoort. Finance-callers kosten dankzij de
  // short-circuit nog steeds één opvraging.
  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  const gelezen = leesVerzendOpdracht(req.body);
  if (!gelezen.ok) return res.status(gelezen.http).json(gelezen.payload);

  const cfg = getConfigStatus();
  if (!cfg.configured) {
    return res.status(503).json({
      error: 'Meta WhatsApp niet geconfigureerd',
      missing: cfg.missing,
    });
  }

  try {
    const uit = await verstuurInGesprek(
      gelezen.opdracht,
      { hasFinanceSend, hasSimoneUse, hasOnboardingSend },
      user.id,
      { ip: getClientIp(req) },
    );
    if (!uit.ok) return res.status(uit.http).json(uit.payload);
    return res.status(200).json(uit.payload);
  } catch (e) {
    console.error('[inbox-send]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
