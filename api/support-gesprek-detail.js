// api/support-gesprek-detail.js
//
// GET ?id=<uuid> — één gesprek met de volledige thread, de voorgestelde
// acties en (als het gesprek geverifieerd is) de klantgegevens die de bot
// ook zag.
//
// Die laatste zijn er zodat een medewerker niet hoeft te gaan zoeken in drie
// modules om te zien waarom iemand niet in het LMS komt. Ze worden live
// opgehaald, niet uit de meta van de bot: die kan een kwartier oud zijn.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { bouwContext } from './_lib/support-lookups.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'GET')) return;

  const staff = await staffUit(req, res, 'support.module.access');
  if (!staff) return;

  const id = String(req.query?.id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig id' });

  try {
    const { data: gesprek, error } = await supabaseAdmin
      .from('support_gesprekken').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!gesprek) return res.status(404).json({ error: 'Gesprek niet gevonden' });

    const [{ data: berichten }, { data: acties }] = await Promise.all([
      supabaseAdmin.from('support_berichten')
        .select('id, afzender, afzender_user_id, tekst, meta, created_at')
        .eq('gesprek_id', id).order('created_at', { ascending: true }).limit(500),
      supabaseAdmin.from('support_acties')
        .select('*').eq('gesprek_id', id).order('created_at', { ascending: false }),
    ]);

    // Ongelezen-teller terugzetten: wie het gesprek opent, heeft het gelezen.
    if (gesprek.ongelezen_voor_ons > 0) {
      await supabaseAdmin.from('support_gesprekken')
        .update({ ongelezen_voor_ons: 0 }).eq('id', id);
      gesprek.ongelezen_voor_ons = 0;
    }

    const context = gesprek.geverifieerd ? await bouwContext(gesprek) : null;

    // sessie_token_hash en ip_hash gaan niet mee naar de browser. Ze staan
    // in de tabel voor de server, niet voor een scherm.
    const { sessie_token_hash: _t, ip_hash: _i, ...veilig } = gesprek;

    return res.status(200).json({
      gesprek: veilig,
      berichten: berichten || [],
      acties: acties || [],
      context,
    });
  } catch (e) {
    console.error('[support-gesprek-detail] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon het gesprek niet ophalen.' });
  }
}
