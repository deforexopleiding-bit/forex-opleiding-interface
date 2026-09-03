// api/opvolging-taak-update.js
//
// POST → één taak bijwerken vanuit het scherm "Wat nu?".
//
// Body: { taak_id, actie, ... }
//   actie 'later_vandaag'   → later = true
//   actie 'verplaats'       { due }            → andere dag; zonder poging vandaag
//                                                telt dat als uitgesteld_zonder_poging
//   actie 'ingepland'       { afspraak_ref }   → status ingepland
//   actie 'agenda_gestuurd' → status wacht_inplanning + agenda_doorgestuurd_at
//   actie 'archiveer'       { archief_reden }  → status gearchiveerd (reden verplicht)
//   actie 'notitie'         { notitie }
//
// Nieuw endpoint. Schrijft uitsluitend in opvolging_taken.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const isoDag = (d) => new Date(d).toISOString().slice(0, 10);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const b = req.body || {};
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });

  const vandaag = isoDag(Date.now());
  const patch = { updated_at: new Date().toISOString() };

  try {
    const { data: taak, error: leesErr } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).single();
    if (leesErr) throw leesErr;
    if (!taak) return res.status(404).json({ error: 'Taak niet gevonden' });

    if (b.actie === 'later_vandaag') {
      patch.later = true;

    } else if (b.actie === 'verplaats') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.due || '')) return res.status(400).json({ error: 'due ontbreekt' });
      // Geteld worden alleen echte pogingen van vandaag; het doorschuiven zelf telt niet mee.
      const { count } = await supabaseAdmin
        .from('opvolging_pogingen')
        .select('id', { count: 'exact', head: true })
        .eq('taak_id', b.taak_id)
        .in('soort', ['call', 'whatsapp', 'spraakbericht'])
        .gte('tijdstip', vandaag + 'T00:00:00Z');
      if (!count) patch.uitgesteld_zonder_poging = (taak.uitgesteld_zonder_poging || 0) + 1;
      patch.due = b.due;
      patch.later = false;

    } else if (b.actie === 'ingepland') {
      patch.status = 'ingepland';
      patch.afspraak_ref = b.afspraak_ref || null;
      patch.afspraak_gevonden_at = new Date().toISOString();

    } else if (b.actie === 'agenda_gestuurd') {
      patch.status = 'wacht_inplanning';
      patch.agenda_doorgestuurd_at = new Date().toISOString();

    } else if (b.actie === 'archiveer') {
      const reden = (b.archief_reden || '').trim();
      if (!reden) return res.status(400).json({ error: 'archief_reden is verplicht' });
      patch.status = 'gearchiveerd';
      patch.archief_reden = reden;
      patch.gearchiveerd_at = new Date().toISOString();

    } else if (b.actie === 'notitie') {
      patch.notitie = b.notitie || null;

    } else {
      return res.status(400).json({ error: 'onbekende actie' });
    }

    const { data, error } = await supabaseAdmin
      .from('opvolging_taken').update(patch).eq('id', b.taak_id).select().single();
    if (error) throw error;
    return res.status(200).json({ success: true, taak: data });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Onbekende fout' });
  }
}
