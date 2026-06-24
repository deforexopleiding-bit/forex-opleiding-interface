// api/onboarding-invite-send.js
//
// POST -> verstuur (of resend) de geconfigureerde onboarding-WhatsApp-invite.
//
// Twee auth-paden (sibling-pattern):
//   (a) X-Internal-Token = INTERNAL_API_TOKEN -> system-pad
//        (gebruikt door api/onboarding-create.js auto-trigger ná provisioning).
//        RBAC geskipt; sentByUserId = NULL.
//   (b) Bearer-JWT + onboarding.inbox.send permission-check
//        (handmatige knop in modules/onboarding-admin.html).
//
// Body:
//   { onboarding_id: uuid (verplicht),
//     force: boolean (default false; bij true overschrijft 'ie invite_sent_at) }
//
// Response 200 — fail-soft over de helper-output:
//   { sent: bool, reason?, error?, wizard_link?, template_name?,
//     message_id?, meta_wamid?, conv_id?, already_sent_at? }
//
// Errors:
//   400  body / onboarding_id ontbreekt of ongeldig
//   401  geen sessie
//   403  geen onboarding.inbox.send rechten
//   500  onverwachte fout

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendOnboardingInvite } from './_lib/onboarding-invite.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const internalTokenHeader   = req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || null;
  const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
  const isInternalCall = !!(
    internalTokenHeader &&
    expectedInternalToken &&
    typeof internalTokenHeader === 'string' &&
    internalTokenHeader === expectedInternalToken
  );

  let user = null;
  if (!isInternalCall) {
    const userClient = createUserClient(req);
    const { data: { user: u }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !u) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    user = u;

    if (!(await requirePermission(req, 'onboarding.inbox.send'))) {
      return res.status(403).json({ error: 'Geen rechten (onboarding.inbox.send)' });
    }
  }

  // ---- Body parse ----
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!isUuid(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) vereist' });
  }
  const force = body.force === true;

  // ---- Helper aanroep (fail-soft) ----
  try {
    const result = await sendOnboardingInvite({
      onboardingId,
      force,
      sentByUserId: user ? user.id : null,
      source:       isInternalCall ? 'system' : 'manual',
    });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[onboarding-invite-send]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
