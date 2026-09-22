// api/support-gesprek-update.js
//
// PATCH — status, prioriteit en toewijzing van een gesprek.
//
// Statuswijzigingen die de bezoeker merkt (afhandelen) krijgen een regel in
// de thread. Iemand die zijn chat opent en ziet dat het gesprek gesloten is
// zonder dat er iets staat, denkt dat 'ie genegeerd is.

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { schrijfBericht } from './_lib/support-sessie.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSSEN = ['bot', 'wacht_op_ons', 'in_behandeling', 'wacht_op_klant', 'afgehandeld'];
const PRIORITEITEN = ['laag', 'middel', 'hoog'];

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, 'PATCH')) return;

  const staff = await staffUit(req, res, 'support.assign');
  if (!staff) return;

  const id = String(req.body?.gesprek_id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig gesprek_id' });

  const patch = {};
  const nu = new Date().toISOString();

  if (req.body?.status !== undefined) {
    if (!STATUSSEN.includes(req.body.status)) return res.status(400).json({ error: 'Ongeldige status' });
    patch.status = req.body.status;
    if (req.body.status === 'afgehandeld') {
      patch.afgehandeld_op = nu;
      patch.afgehandeld_door = staff.user.id;
    }
  }

  if (req.body?.prioriteit !== undefined) {
    if (!PRIORITEITEN.includes(req.body.prioriteit)) return res.status(400).json({ error: 'Ongeldige prioriteit' });
    patch.prioriteit = req.body.prioriteit;
  }

  // toegewezen_aan: 'mij' → jezelf, null → vrijgeven, uuid → een collega.
  if (req.body?.toegewezen_aan !== undefined) {
    const t = req.body.toegewezen_aan;
    if (t === null) {
      patch.toegewezen_aan = null;
      patch.toegewezen_op = null;
    } else if (t === 'mij') {
      patch.toegewezen_aan = staff.user.id;
      patch.toegewezen_op = nu;
    } else if (UUID_RE.test(String(t))) {
      patch.toegewezen_aan = String(t);
      patch.toegewezen_op = nu;
    } else {
      return res.status(400).json({ error: 'Ongeldige toewijzing' });
    }
    // Oppakken betekent ook: in behandeling, tenzij er iets anders gevraagd is.
    if (patch.toegewezen_aan && patch.status === undefined) patch.status = 'in_behandeling';
  }

  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Niets te wijzigen' });

  try {
    const { data, error } = await supabaseAdmin
      .from('support_gesprekken').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Gesprek niet gevonden' });

    if (patch.status === 'afgehandeld') {
      await schrijfBericht({
        gesprekId: id,
        afzender: 'systeem',
        tekst: 'Dit gesprek is afgerond. Heb je er later nog iets over? Mail ons gerust — vermeld dan je kenmerk.',
        meta: { soort: 'afgerond', door: staff.naam },
      });
    }

    const { sessie_token_hash: _t, ip_hash: _i, ...veilig } = data;
    return res.status(200).json({ gesprek: veilig });
  } catch (e) {
    console.error('[support-gesprek-update] mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon het gesprek niet bijwerken.' });
  }
}
