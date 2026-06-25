// api/onboarding-detail.js
//
// ADMIN — volledige onboarding-detailrij inclusief vragenlijst-antwoorden
// (jsonb), traject-info, mentor-naam en paid-vlag.
//
// Permission: onboarding.admin.
//
// Query:
//   ?id=<uuid>   (verplicht)
//
// Response 200:
//   { ok:true, onboarding:{ ...alle kolommen..., traject_label, traject_type,
//                           calls, duur_maanden, mentor_name, paid } }
// 404 bij onbekend id.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  findAvailabilityBlock,
  buildAvailabilityView,
} from './_lib/onboarding-wizard-default.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Loop door alle blokken van de gepubliceerde structuur en pak de
// consent_key van het EERSTE file_download/consent-blok met is_waiver=true.
// Geeft null wanneer geen waiver-blok bestaat.
function findWaiverConsentKey(structure) {
  if (!structure || typeof structure !== 'object') return null;
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  for (const p of pages) {
    for (const b of (p?.blocks || [])) {
      if (!b || !b.is_waiver) continue;
      if (b.type === 'file_download' && b.consent_key) return b.consent_key;
      if (b.type === 'consent'       && b.key)         return b.key;
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'onboarding.admin'))) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin)' });
  }

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: row, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, customer_name, traject_id, mentor_user_id,
               status, current_step, answers, token,
               started_at, completed_at, assigned_at, archived_at,
               created_by, created_at,
               bubble_provisioned, bubble_provisioned_at, bubble_provision_error, bubble_user_id,
               invite_sent_at,
               credentials_email_sent_at, credentials_wa_sent_at,
               traject:onboarding_trajecten(label, type, calls, duur_maanden)`)
      .eq('id', id)
      .maybeSingle();
    if (rowErr) throw new Error('onboarding fetch: ' + rowErr.message);
    if (!row)  return res.status(404).json({ error: 'Onboarding niet gevonden' });

    // Mentor-naam ophalen indien toegewezen.
    let mentorName = null;
    if (row.mentor_user_id) {
      const { data: tm, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('name')
        .eq('user_id', row.mentor_user_id)
        .maybeSingle();
      if (tmErr) throw new Error('team_member fetch: ' + tmErr.message);
      mentorName = tm?.name || null;
    }

    // Paid-vlag: heeft de klant ≥1 invoice met status='paid'.
    let paid = false;
    if (row.customer_id) {
      const { data: inv, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('id')
        .eq('customer_id', row.customer_id)
        .eq('status', 'paid')
        .limit(1)
        .maybeSingle();
      if (invErr) throw new Error('invoices fetch: ' + invErr.message);
      paid = !!inv;
    }

    // GEPUBLICEERDE wizard-structuur 1× per request laden voor twee
    // afgeleide velden:
    //   - waiver: consent_key uit het EERSTE blok met is_waiver=true.
    //   - availability: het EERSTE blok van type 'availability',
    //     gemapped naar label-vorm via buildAvailabilityView.
    // Fail-soft: bij DB-glitch of geen gepubliceerde structuur →
    // beide velden blijven null.
    let waiver       = null;
    let availability = null;
    try {
      const { data: wiz, error: wizErr } = await supabaseAdmin
        .from('onboarding_wizard')
        .select('published_structure')
        .eq('id', 1)
        .maybeSingle();
      if (wizErr) {
        console.warn('[onboarding-detail] wizard config fetch:', wizErr.message);
      } else {
        const pub = wiz?.published_structure;
        const ans = (row.answers && typeof row.answers === 'object') ? row.answers : {};
        const waiverKey = findWaiverConsentKey(pub);
        if (waiverKey) {
          waiver = {
            agreed : ans[waiverKey] === true,
            at     : ans[waiverKey + '_at'] || null,
          };
        }
        const availabilityBlock = findAvailabilityBlock(pub);
        availability = availabilityBlock ? buildAvailabilityView(availabilityBlock, ans) : null;
      }
    } catch (e) {
      console.warn('[onboarding-detail] wizard config exception:', e?.message || e);
    }

    const t = row.traject || null;
    return res.status(200).json({
      ok: true,
      onboarding: {
        id             : row.id,
        customer_id    : row.customer_id,
        customer_name  : row.customer_name || null,
        traject_id     : row.traject_id,
        traject_label  : t?.label         || null,
        traject_type   : t?.type          || null,
        calls          : t?.calls         || null,
        duur_maanden   : t?.duur_maanden  || null,
        mentor_user_id : row.mentor_user_id || null,
        mentor_name    : mentorName,
        status         : row.status,
        current_step   : row.current_step || null,
        answers        : row.answers || null,
        paid,
        waiver,
        availability,
        token          : row.token,
        started_at     : row.started_at,
        completed_at   : row.completed_at,
        assigned_at    : row.assigned_at,
        archived_at    : row.archived_at,
        created_by     : row.created_by || null,
        created_at     : row.created_at,
        bubble_provisioned     : row.bubble_provisioned === true,
        bubble_provisioned_at  : row.bubble_provisioned_at || null,
        bubble_provision_error : row.bubble_provision_error || null,
        bubble_user_id            : row.bubble_user_id || null,
        invite_sent_at            : row.invite_sent_at || null,
        credentials_email_sent_at : row.credentials_email_sent_at || null,
        credentials_wa_sent_at    : row.credentials_wa_sent_at || null,
      },
    });
  } catch (e) {
    console.error('[onboarding-detail]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
