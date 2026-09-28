// api/inbox-send.js
// POST → verzend een outbound WhatsApp-bericht via Meta Cloud API.
// Permission: finance.inbox.send (of events.simone.use / onboarding.inbox.send,
// afhankelijk van de module waar het gesprek bij hoort)
//
// Body:
//   conversation_id     uuid  required
//   mode                'text' | 'template' | 'image' | 'document' | 'video'
//   body                text  required bij mode='text' (free-form)
//   template_name       text  required bij mode='template'
//   template_language   text  optional (default 'nl')
//   template_variables  object optional — wordt 1-op-1 in audit/DB bewaard
//   template_components array optional — Meta's components-payload
//   media_link/caption/filename bij de media-modes
//
// 24h customer-service window:
//   mode='text' en de media-modes vereisen een inbound msg binnen 24h. Buiten
//   24h → 422 met de melding dat er een approved template nodig is.
//
// Response: 200 { success: true, message_id, meta_wamid }
//           422 { error: '24h_window_expired', ... }
//           502 { error, meta_error } bij Meta-API fout
//           503 { error, missing: [] } bij niet-geconfigureerde Meta
//
// ── WAT HIER SINDS G2-SERVER STAAT, EN WAT NIET MEER ─────────────────────────
// Het lezen van het verzoek, de rechten en het antwoord staan hier. Het
// verzenden zelf staat in _lib/inbox-verzenden.js, omdat er sinds het
// uitgestelde versturen drie aanroepers zijn (dit endpoint, het scherm dat na
// dertig seconden alsnog verstuurt, en de cron voor als dat scherm dicht is).
// Drie kopieën van die logica is precies hoe je krijgt dat een bericht via de
// ene weg wél in de audit-log belandt en via de andere niet.
//
// De vormen van het antwoord zijn letterlijk hetzelfde gebleven: vijf schermen
// hangen aan dit endpoint en kennen die uit hun hoofd.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
// NOTE: Fase 2b per-mentor-ACL (checkOnboardingConvAccess) op de
// onboarding-tak is bewust uitgezet: de onboarding-inbox is gedeeld voor
// iedereen met onboarding.inbox.send. De module-permissie-cascade in
// _lib/inbox-verzenden.js blijft de enige gate per conv-module.
import { getClientIp } from './_lib/audit-customer.js';
import { leesVerzendOpdracht, verstuurInGesprek } from './_lib/inbox-verzenden.js';

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

  // Coarse-grained upfront gate: tenminste één van finance.inbox.send,
  // events.simone.use of onboarding.inbox.send moet granted zijn. De
  // definitieve module-check gebeurt ná conv-load (autoritatief op
  // conv.phone_number_id → whatsapp_module_config). Finance-callers met
  // finance.inbox.send blijven byte-identiek dankzij short-circuit.
  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  const gelezen = leesVerzendOpdracht(req.body);
  if (!gelezen.ok) return res.status(gelezen.http).json(gelezen.payload);

  const uitkomst = await verstuurInGesprek(gelezen.opdracht, {
    userId : user.id,
    ip     : getClientIp(req),
    rechten: { finance: hasFinanceSend, simone: hasSimoneUse, onboarding: hasOnboardingSend },
  });
  return res.status(uitkomst.http).json(uitkomst.payload);
}
