// api/leadsonderhoud-stap-opslaan.js
// POST -> maakt een stap aan (geen id) of werkt hem bij (met id).
// Bron: onderhoud_stappen. Whitelist-patroon; de aanleiding komt uit de vaste
// lijst van zes (geen losse SQL). Gate: leads.view.
//
// Body: { id?, traject_id, soort, naam, kanaal, aanleiding, waarde?, weekdag?,
//         tijdstip?, score_min?, score_max?, alleen_zonder_gesprek?,
//         alleen_ingelogd?, alleen_verlengd?, herhaalbaar?, urgentie?, volgorde?, actief? }
// Response: { stap }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const AANLEIDINGEN = ['na_start', 'dag_van_periode', 'dagen_voor_einde', 'na_einde', 'geen_activiteit', 'vast_moment'];
const KANALEN = ['mail', 'whatsapp'];

// Zet een waarde om naar een geheel getal of null (voor optionele numerieke velden).
function getalOfNull(v) {
  if (v === '' || v == null) return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const b = req.body || {};
  if (!b.traject_id) return res.status(400).json({ error: 'traject_id ontbreekt' });
  const soort = (b.soort || '').trim();
  if (!soort) return res.status(400).json({ error: 'Soort is verplicht' });
  const kanaal = String(b.kanaal || '');
  if (!KANALEN.includes(kanaal)) return res.status(400).json({ error: 'Ongeldig kanaal (mail of whatsapp)' });
  const aanleiding = String(b.aanleiding || '');
  if (!AANLEIDINGEN.includes(aanleiding)) return res.status(400).json({ error: 'Ongeldige aanleiding' });

  const velden = {
    traject_id: b.traject_id,
    soort,
    naam: b.naam != null ? String(b.naam) : null,
    kanaal,
    aanleiding,
    waarde: getalOfNull(b.waarde),
    weekdag: getalOfNull(b.weekdag),
    tijdstip: b.tijdstip ? String(b.tijdstip) : null,
    score_min: getalOfNull(b.score_min),
    score_max: getalOfNull(b.score_max),
    alleen_zonder_gesprek: b.alleen_zonder_gesprek === true,
    alleen_ingelogd: b.alleen_ingelogd === true ? true : (b.alleen_ingelogd === false ? false : null),
    alleen_verlengd: b.alleen_verlengd === true ? true : (b.alleen_verlengd === false ? false : null),
    herhaalbaar: b.herhaalbaar === true,
    urgentie: getalOfNull(b.urgentie) ?? 3,
    volgorde: getalOfNull(b.volgorde) ?? 1,
    actief: b.actief !== false,
  };

  try {
    let rij;
    if (b.id) {
      const { data, error } = await supabaseAdmin
        .from('onderhoud_stappen').update(velden).eq('id', b.id).select().single();
      if (error) throw error;
      rij = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('onderhoud_stappen').insert(velden).select().single();
      if (error) throw error;
      rij = data;
    }
    return res.status(200).json({ stap: rij });
  } catch (e) {
    console.error('stap-opslaan mislukt:', e.message);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
