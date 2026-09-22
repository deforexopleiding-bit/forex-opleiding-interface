// api/support-gesprekken-list.js
//
// GET — de werklijst. Filters via querystring: ?status=&onderwerp=&mijn=1&q=
//
// Leest met supabaseAdmin en niet met de RLS-client, omdat er per gesprek
// een paar afgeleide velden bij moeten (naam van de toegewezen collega,
// aantal openstaande acties) die anders vijf losse rondjes kosten. De
// autorisatie zit in staffUit(); RLS is hier het tweede slot, niet het
// eerste.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';

const STATUSSEN = ['bot', 'wacht_op_ons', 'in_behandeling', 'wacht_op_klant', 'afgehandeld'];
const MAX = 200;

/**
 * Tellers voor de KPI-strip. Bewust LOS van de lijst-query en dus ongevoelig
 * voor de actieve filters: een strip die meetelt wat er toevallig in beeld
 * staat, toont op het tabblad Wachtrij altijd nul bij "bij de bot" — en dan
 * is het geen teller meer maar een herhaling van de lijst eronder.
 *
 * Head-counts, geen rijen over de lijn. Fail-soft per teller: één kapotte
 * query mag de werklijst niet tegenhouden.
 */
async function haalTellingen(userId) {
  const tel = async (bouw) => {
    try {
      const { count, error } = await bouw();
      if (error) throw new Error(error.message);
      return count || 0;
    } catch (e) {
      console.warn('[support-gesprekken-list] teller mislukt:', e?.message || e);
      return null;
    }
  };

  const basis = () => supabaseAdmin.from('support_gesprekken').select('id', { count: 'exact', head: true });

  const [wacht, bot, behandeling, mijn, acties] = await Promise.all([
    tel(() => basis().eq('status', 'wacht_op_ons')),
    tel(() => basis().eq('status', 'bot')),
    tel(() => basis().eq('status', 'in_behandeling')),
    tel(() => basis().eq('toegewezen_aan', userId).not('status', 'eq', 'afgehandeld')),
    tel(() => supabaseAdmin.from('support_acties').select('id', { count: 'exact', head: true }).eq('status', 'voorgesteld')),
  ]);

  return { wacht_op_ons: wacht, bot, in_behandeling: behandeling, van_mij: mijn, open_acties: acties };
}

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'GET')) return;

  const staff = await staffUit(req, res, 'support.module.access');
  if (!staff) return;

  const status = STATUSSEN.includes(req.query?.status) ? req.query.status : null;
  const onderwerp = typeof req.query?.onderwerp === 'string' ? req.query.onderwerp : null;
  const alleenMijn = req.query?.mijn === '1';
  const zoek = String(req.query?.q || '').trim().slice(0, 100);
  const limiet = Math.min(Number(req.query?.limit) || 60, MAX);

  try {
    let q = supabaseAdmin
      .from('support_gesprekken')
      .select('id, kenmerk, soort, onderwerp, status, prioriteit, naam, email, telefoon, customer_id, geverifieerd, toegewezen_aan, ongelezen_voor_ons, laatste_bericht_op, laatste_klant_bericht_op, escalatie_reden, created_at')
      .order('laatste_bericht_op', { ascending: false, nullsFirst: false })
      .limit(limiet);

    if (status) q = q.eq('status', status);
    else q = q.neq('status', 'afgehandeld');      // standaard: alleen werk
    if (onderwerp) q = q.eq('onderwerp', onderwerp);
    if (alleenMijn) q = q.eq('toegewezen_aan', staff.user.id);
    if (zoek) q = q.or(`naam.ilike.%${zoek}%,email.ilike.%${zoek}%,kenmerk.ilike.%${zoek}%`);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const rijen = data || [];

    // Namen van de toegewezen collega's in één lookup.
    const ids = [...new Set(rijen.map((r) => r.toegewezen_aan).filter(Boolean))];
    const namen = new Map();
    if (ids.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, full_name').in('id', ids);
      for (const p of profs || []) namen.set(p.id, p.full_name);
    }

    // Openstaande acties per gesprek, ook in één lookup.
    const acties = new Map();
    if (rijen.length) {
      const { data: acts } = await supabaseAdmin
        .from('support_acties')
        .select('gesprek_id')
        .eq('status', 'voorgesteld')
        .in('gesprek_id', rijen.map((r) => r.id));
      for (const a of acts || []) acties.set(a.gesprek_id, (acties.get(a.gesprek_id) || 0) + 1);
    }

    return res.status(200).json({
      gesprekken: rijen.map((r) => ({
        ...r,
        toegewezen_naam: r.toegewezen_aan ? (namen.get(r.toegewezen_aan) || null) : null,
        open_acties: acties.get(r.id) || 0,
      })),
      tellingen: await haalTellingen(staff.user.id),
    });
  } catch (e) {
    console.error('[support-gesprekken-list] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon de gesprekken niet ophalen.' });
  }
}
