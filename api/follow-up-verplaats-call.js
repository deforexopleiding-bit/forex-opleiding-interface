// De verzetting zelf staat in api/_lib/verzet-afspraak.js: GHL eerst, oude rij
// op 'verplaatst', nieuwe rij met parent_appointment_id, Zoom en bevestiging
// best-effort. Dit bestand doet alleen nog auth, scope en de vertaling van een
// foutcode naar HTTP — hetzelfde lib+endpoint-patroon als bij de
// TL-betaallink (zie CLAUDE.md, lesson 17). Sinds PR 10 gebruikt ook het
// afrondvenster in Opvolging diezelfde motor.
import { createClient } from '@supabase/supabase-js';
import { requirePermission } from './_lib/requirePermission.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { verzetAfspraak, mapGhlError } from './_lib/verzet-afspraak.js';
dayjs.extend(utc);
dayjs.extend(timezone);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_ROLES = ['sales', 'manager', 'admin', 'super_admin'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Ongeldige token' });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  // Additief (zie #1265): rol ∈ ALLOWED_ROLES ÓF per-user RBAC-grant
  // followup.module.access (honoreert user_permissions via de RPC). Zo werkt
  // een per-persoon-uitzondering (bv. mentor met expliciete follow-up-toegang)
  // zonder de rol te wijzigen.
  const canFollowupManage = (profile && !ALLOWED_ROLES.includes(profile.role))
    ? await requirePermission(req, 'followup.module.access') : false;
  // Scope volgt followup.scope.all_vs_own: grantee zonder die key mag alleen
  // eigen rijen (als sales), mét = brede toegang (als admin/manager).
  const canFollowupAll = canFollowupManage
    ? await requirePermission(req, 'followup.scope.all_vs_own') : false;
  if (!profile || (!ALLOWED_ROLES.includes(profile.role) && !canFollowupManage)) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }

  const { appointment_id, new_datetime, duration_minutes = 30 } = req.body;
  if (!appointment_id || !new_datetime) {
    return res.status(400).json({ error: 'appointment_id en new_datetime vereist' });
  }

  // Fetch huidige appointment
  const { data: oldAppt, error: fetchErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('*')
    .eq('id', appointment_id)
    .maybeSingle();

  if (fetchErr || !oldAppt) {
    return res.status(404).json({ error: 'Appointment niet gevonden' });
  }

  // Sales: alleen eigen appointments
  if ((profile.role === 'sales' || (canFollowupManage && !canFollowupAll)) && oldAppt.owner_id !== user.id) {
    return res.status(403).json({ error: 'Niet jouw appointment' });
  }

  // new_datetime arrives as "2026-07-01T14:00:00" (no Z, no offset) — Amsterdam local time
  // Parse as Europe/Amsterdam, convert to UTC for storage and API calls
  const newStartISO = dayjs.tz(new_datetime, 'Europe/Amsterdam').utc().toISOString();

  let uit;
  try {
    uit = await verzetAfspraak({
      supabaseAdmin,
      afspraak     : oldAppt,
      nieuwStartIso: newStartISO,
      duurMinuten  : duration_minutes,
      doorUserId   : user.id,
      bron         : 'manual',
    });
  } catch (e) {
    if (e?.code === 'GHL_UPDATE') {
      return res.status(422).json({ error: mapGhlError(e.ghlStatus, e.ghlBody), ghl_status: e.ghlStatus });
    }
    // PARENT_UPDATE en CHILD_INSERT zijn allebei een databankfout; de motor
    // heeft de oude rij bij een mislukte insert al teruggezet.
    return res.status(500).json({ error: e?.message || 'Verzetten mislukt' });
  }

  return res.status(200).json({
    success        : true,
    new_appointment: uit.nieuweAfspraak,
    zoom_updated   : uit.zoomBijgewerkt,
    ghl_updated    : uit.ghlBijgewerkt,
  });
}
