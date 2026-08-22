// api/onboarding-by-customer.js
//
// GET → de (actieve) onboarding van ÉÉN klant, compact, voor het Onboarding-vak
// op het klantprofiel (klanten-v2 profiel-tab). Er bestond nog geen per-klant
// lees-endpoint: onboarding-detail.js is op onboarding-`id` gekeyd en
// onboardings-admin-list.js filtert niet op customer_id. Dit endpoint sluit dat
// gat met dezelfde databron (`onboardings`) en dezelfde RBAC-scope als
// onboarding-detail.js (onboarding.admin = seesAll, onboarding.view_own = mentor
// ziet enkel eigen rijen).
//
// Query:  ?customer_id=<uuid>
// Response 200:
//   { ok:true, onboarding: null | {
//       id, status, current_step, start_date, started_at, completed_at,
//       traject_label, traject_type, calls, duur_maanden,
//       mentor_user_id, mentor_name } }
//
// null = deze klant heeft geen (niet-gearchiveerde) onboarding, óf de mentor mag
// deze rij niet zien (geen info-leak). Read-only, geen writes, geen migratie.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Zelfde scope-model als onboarding-detail.js: admin ziet alles, mentor
  // (view_own) enkel eigen rijen. De ownership-filter gebeurt ná de fetch.
  // Wie GEEN onboarding-rechten heeft maar wél het klantprofiel mag zien, krijgt
  // 200 met onboarding:null (geen data-leak, nette lege staat in het vak) i.p.v.
  // een 403 die als fout-kaartje zou tonen.
  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll && !scopeInfo.seesOwn) {
    return res.status(200).json({ ok: true, onboarding: null });
  }

  const customerId = typeof req.query?.customer_id === 'string' ? req.query.customer_id.trim() : '';
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });

  try {
    // Eén niet-gearchiveerde onboarding per klant (onboarding-create.js dwingt
    // dat af met een 409). We nemen defensief de meest recente. Gearchiveerd →
    // niet tonen in het profiel-vak.
    const { data: row, error: rowErr } = await supabaseAdmin
      .from('onboardings')
      .select(`id, customer_id, mentor_user_id, status, current_step,
               start_date, started_at, completed_at,
               traject:onboarding_trajecten(label, type, calls, duur_maanden)`)
      .eq('customer_id', customerId)
      .neq('status', 'gearchiveerd')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rowErr) throw new Error('onboarding fetch: ' + rowErr.message);

    // Geen rij, of mentor mag deze rij niet zien → null (geen info-leak, nette
    // lege staat in het vak).
    if (!row || (!scopeInfo.seesAll && row.mentor_user_id !== scopeInfo.userId)) {
      return res.status(200).json({ ok: true, onboarding: null });
    }

    // Mentor-naam (fail-soft: naam ontbreekt → null, kaart toont "toegewezen").
    let mentorName = null;
    if (row.mentor_user_id) {
      const { data: tm } = await supabaseAdmin
        .from('team_members')
        .select('name')
        .eq('user_id', row.mentor_user_id)
        .maybeSingle();
      mentorName = tm?.name || null;
    }

    const tr = row.traject || {};
    return res.status(200).json({
      ok: true,
      onboarding: {
        id:             row.id,
        status:         row.status,
        current_step:   row.current_step,
        start_date:     row.start_date,
        started_at:     row.started_at,
        completed_at:   row.completed_at,
        traject_label:  tr.label || null,
        traject_type:   tr.type || null,
        calls:          tr.calls != null ? tr.calls : null,
        duur_maanden:   tr.duur_maanden != null ? tr.duur_maanden : null,
        mentor_user_id: row.mentor_user_id || null,
        mentor_name:    mentorName,
      },
    });
  } catch (e) {
    console.error('[onboarding-by-customer]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
