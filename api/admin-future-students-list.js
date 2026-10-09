// api/admin-future-students-list.js
//
// GET — Admin/manager-instroom-overzicht van ÁLLE onboardings (Fase A van
// instroom-pijplijn). Bevat de hele trechter: nog-geen-mentor → nog te
// benaderen → intake-statussen → gestart → geannuleerd/gearchiveerd.
//
// Permission-gate: gelijk aan onboardings-admin-list.js. Een seesOwn-only
// gebruiker (mentor) krijgt 403 — die heeft z'n eigen toekomst-tab al in
// mentor-students.html. Alleen seesAll mag dit endpoint zien.
//
// Query params (allemaal optioneel):
//   ?scope=active|archived   default 'active' (status != 'gearchiveerd')
//   ?q=<string>              ilike op customer_name
//   ?mentor_user_id=<uuid>   exacte mentor-filter (of 'none' voor no-mentor)
//   ?traject_id=<uuid>       exacte traject-filter
//
// 1-op-1 status-afleiding komt uit het LMS (lazy, via
// api/onboarding-intake-status.js) — geen Bubble meer.
//
// Bedenktijd + waiver: gebatchte deals-lookup per uniek customer_id (mirror
// van onboardings-admin-list.js). Wizard-structuur 1× per request.
//
// Response 200: { future, rows, ... }
//   Beide arrays bevatten dezelfde rij-shape; `rows` is een alias voor
//   backward-compat met de hub (onboarding-overzicht.js loadList).
//
// Sort default: rank asc (problemen bovenaan), tie-break op start_date asc
// (dichtstbijzijnde eerst), daarna customer_name.

import { createUserClient } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { bouwOverzichtRijen } from './_lib/onboarding-overzicht-rijen.js';

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

  // Gate identiek aan onboardings-admin-list.js, maar alleen seesAll mag —
  // deze view is bewust admin/manager-only. Mentor heeft eigen toekomst-tab.
  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin vereist).' });
  }

  // Query params (allemaal optioneel — backward-compat met onboardings-admin-list).
  const scopeRaw = typeof req.query?.scope === 'string' ? req.query.scope.trim().toLowerCase() : '';
  const scope = (scopeRaw === 'archived') ? 'archived' : 'active';
  const qRaw  = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  const mentorFilter  = typeof req.query?.mentor_user_id === 'string' ? req.query.mentor_user_id.trim() : '';
  const trajectFilter = typeof req.query?.traject_id === 'string' ? req.query.traject_id.trim() : '';
  // 'none' = expliciet filteren op onboardings zonder mentor (de no-mentor-tier).
  const wantNoMentor = (mentorFilter.toLowerCase() === 'none');
  if (mentorFilter && !wantNoMentor && !UUID_RE.test(mentorFilter)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid of "none") ongeldig' });
  }
  if (trajectFilter && !UUID_RE.test(trajectFilter)) {
    return res.status(400).json({ error: 'traject_id (uuid) ongeldig' });
  }

  try {
    const future = await bouwOverzichtRijen({ scope, qRaw, mentorFilter, wantNoMentor, trajectFilter });
    return res.status(200).json({ future, rows: future });
  } catch (e) {
    console.error('[admin-future-students-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
