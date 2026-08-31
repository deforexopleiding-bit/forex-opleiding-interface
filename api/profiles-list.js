// api/profiles-list.js
//
// GET → { members: [{ id, full_name, email, role }] }
//
// Lijst actieve profiles voor assignee-dropdowns (task-modal, ticket-create, etc).
// Gebruikt supabaseAdmin omdat profiles-RLS niet uniform is (zelfde pattern als
// ticket-detail.js assignees-fetch). Niet te verwarren met /api/team-members
// dat de aparte team_members-tabel exposeert.

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // FEAT-4 (ronde 8, aangescherpt ronde 3): query-param ?staff_only=1
  // filtert op interne team-rollen server-side. Backward-compat: zonder
  // param → alle actieve profiles (bestaand gedrag).
  //
  // ALLOWLIST (exact wat je krijgt bij staff_only=1):
  //   super_admin  — platform-beheer (Amigo)
  //   manager      — team-lead (Jeffrey)  ← EXPLICIET opgenomen
  //   sales        — sales-team
  //   mentor       — mentoren
  //   administratie — Finance/administratie
  //
  // NIET in de allowlist:
  //   admin        — verwijderd; de DB-CHECK (migratie 002) accepteert 'admin'
  //                  wel, maar in de praktijk gebruikt DFO alleen super_admin
  //                  voor platform-beheer. Als er ooit 'admin'-users komen die
  //                  wél teamleden zijn, moet 'admin' weer in deze set.
  //   marketing    — niet-team (externe agency-flow)
  //   viewer       — read-only extern (klant/lead-portalen)
  //   NULL / anders — klant/student-accounts
  // BP2 (2026-08-31): appointmentsetter toegevoegd zodat Romy in staff-
  // dropdowns verschijnt (Bronnen-koppeling + wizard setter-picker).
  const STAFF_ROLES = ['super_admin', 'manager', 'sales', 'mentor', 'administratie', 'appointmentsetter'];
  const staffOnly = String(req.query?.staff_only || '') === '1';

  let q = supabaseAdmin
    .from('profiles')
    .select('id, full_name, email, role')
    .eq('is_active', true)
    .order('full_name', { ascending: true, nullsFirst: false });
  if (staffOnly) q = q.in('role', STAFF_ROLES);

  const { data, error } = await q;
  if (error) {
    console.error('[profiles-list]', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ members: data || [] });
}
