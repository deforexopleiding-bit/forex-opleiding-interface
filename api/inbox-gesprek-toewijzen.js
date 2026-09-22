// api/inbox-gesprek-toewijzen.js
//
// Wie pakt dit op?
//
// ── HET GAT ──────────────────────────────────────────────────────────────────
// Nergens stond wie een gesprek oppakt. Bij twee mensen op één postbus is dat
// geen randgeval maar de normale gang van zaken: twee mensen antwoorden, of
// niemand doet het omdat allebei aannemen dat de ander al bezig is. Gat G4 uit
// docs/iris/02-gesprekken-audit.md.
//
// Het veld bestond al — `iris_gesprekken.toegewezen_aan`, met NULL als "Iris
// houdt het vast, er is nog geen mens aan toegewezen". Er was alleen niets dat
// het zette of toonde.
//
// ── TWEE METHODES, ÉÉN BESTAND ───────────────────────────────────────────────
//   GET  → aan wie kún je toewijzen
//   POST → wijs toe (of haal de toewijzing weg met profile_id: null)
//
// De lijst hoort hier en niet in een admin-endpoint: toewijzen is iets wat
// iedereen doet die de inbox bedient, en die heeft geen beheerrechten.
//
// ── DE RECHTEN ───────────────────────────────────────────────────────────────
// `finance.inbox.send`, hetzelfde recht als antwoorden. Wie mag antwoorden mag
// het ook claimen; dat is precies dezelfde groep mensen, en er is dus geen
// nieuw recht en geen migratie voor nodig.
//
// ── WAT DIT NOOIT DOET ───────────────────────────────────────────────────────
// Stil slagen. Een gesprek dat Iris nog niet gezien heeft, heeft geen rij in
// iris_gesprekken — dan kán er niets toegewezen worden. Dat geeft een duidelijk
// antwoord terug, want "opgeslagen!" gevolgd door een leeg vakje na de volgende
// verversing is erger dan een foutmelding.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { gesprekkenV2Aan } from './_lib/gesprekken-vlag.js';
import { werkSleutel, TOEWIJSBARE_ROLLEN } from './_lib/gesprekken-werkstand.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'GET of POST' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.inbox.send'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send)' });
  }
  if (!gesprekkenV2Aan()) {
    return res.status(404).json({ error: 'Toewijzen staat uit (GESPREKKEN_V2)' });
  }

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, email, role')
        .eq('is_active', true)
        .in('role', TOEWIJSBARE_ROLLEN)
        .order('full_name', { ascending: true });
      if (error) throw new Error('profiles: ' + error.message);
      return res.status(200).json({
        mensen: (data || []).map((p) => ({
          id: p.id,
          naam: p.full_name || p.email || 'Naamloos',
          rol: p.role,
          ben_ik: p.id === user.id,
        })),
      });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

    const convId = String(body.conversation_id || '').trim();
    if (!UUID_RE.test(convId)) {
      return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
    }

    // null betekent uitdrukkelijk "niemand": terug naar Iris. Dat is een
    // geldige keuze en geen ontbrekende waarde.
    const ruw = body.profile_id;
    const naarNiemand = ruw === null || ruw === '' || ruw === undefined;
    const profileId = naarNiemand ? null : String(ruw).trim();
    if (!naarNiemand && !UUID_RE.test(profileId)) {
      return res.status(400).json({ error: 'profile_id moet een uuid zijn of null' });
    }

    // Toewijzen aan iemand die niet mag antwoorden legt het gesprek stil bij
    // iemand die er niets mee kan. Daarom controleren we het, in plaats van
    // erop te vertrouwen dat het scherm alleen geldige mensen aanbiedt.
    if (!naarNiemand) {
      const { data: p, error: pFout } = await supabaseAdmin
        .from('profiles')
        .select('id, full_name, email, is_active, role')
        .eq('id', profileId)
        .maybeSingle();
      if (pFout) throw new Error('profiel: ' + pFout.message);
      if (!p) return res.status(404).json({ error: 'Die persoon bestaat niet' });
      if (!p.is_active) return res.status(400).json({ error: 'Die persoon is niet actief' });
      if (!TOEWIJSBARE_ROLLEN.includes(p.role)) {
        return res.status(400).json({ error: `Rol ${p.role} kan geen gesprek oppakken` });
      }
    }

    const sleutel = werkSleutel(convId);
    const { data: bij, error: uFout } = await supabaseAdmin
      .from('iris_gesprekken')
      .update({ toegewezen_aan: profileId, bijgewerkt_op: new Date().toISOString() })
      .eq('extern_uniek', sleutel)
      .select('id, toegewezen_aan');
    if (uFout) throw new Error('toewijzen: ' + uFout.message);

    // Geen rij betekent dat Iris dit gesprek nog niet verwerkt heeft. Dat is
    // geen fout van de gebruiker en ook geen succes — het is iets dat vanzelf
    // goedkomt zodra de werk-cron langsgeweest is, en dat hoort er te staan.
    if (!Array.isArray(bij) || !bij.length) {
      return res.status(409).json({
        error: 'Iris heeft dit gesprek nog niet verwerkt; toewijzen kan zo nog niet.',
        code: 'GEEN_GESPREKSRIJ',
      });
    }

    let naam = null;
    if (profileId) {
      const { data: p } = await supabaseAdmin
        .from('profiles').select('full_name, email').eq('id', profileId).maybeSingle();
      naam = p?.full_name || p?.email || null;
    }

    return res.status(200).json({ ok: true, toegewezen_aan: profileId, toegewezen_naam: naam });
  } catch (e) {
    console.error('[inbox-gesprek-toewijzen]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
