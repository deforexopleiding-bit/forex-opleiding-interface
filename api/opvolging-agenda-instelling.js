// api/opvolging-agenda-instelling.js
//
// De agendalink en de twee berichten achter 'Agenda doorsturen'.
//
//   GET  → { instelling: { agenda_link, bericht, herinnering }, mag_bewerken }
//          Voor iedereen met de module: het venster toont de tekst vooraf.
//   POST { agenda_link, bericht, herinnering, kanaal, module, phone_number_id }
//        → alleen manager / super_admin. kanaal 'meta' (standaard) of 'brug';
//        module = whatsapp_module_config.module van de Meta-lijn.
//          Regels: link begint met https://, {link} staat in elke tekst.
//
// Leest en schrijft app_settings 'opvolging_agenda_doorsturen'.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { INSTELLING_KEY, leesInstelling, valideerInstelling } from './_lib/opvolging-agenda-doorsturen.js';
import { actieveLijnen, leesTemplate, resolveAgendaLijn, templateGoedgekeurd, TEMPLATE_NAMEN } from './_lib/opvolging-meta.js';

/** Lijnen + templatestatus voor het scherm. Fail-soft: een leesfout is een melding, geen 500. */
async function metaStand(instelling) {
  const uit = { lijnen: [], lijn_actief: null, templates: {}, meta_fout: null };
  try {
    uit.lijnen = await actieveLijnen(supabaseAdmin);
    uit.lijn_actief = await resolveAgendaLijn(supabaseAdmin, instelling);
    for (const [soort, naam] of Object.entries(TEMPLATE_NAMEN)) {
      const t = await leesTemplate(supabaseAdmin, naam);
      uit.templates[soort] = { naam, status: t ? t.status : 'ONTBREEKT', goedgekeurd: templateGoedgekeurd(t) };
    }
  } catch (e) {
    uit.meta_fout = String(e?.message || e).slice(0, 160);
  }
  return uit;
}

export const BEWERK_ROLLEN = ['super_admin', 'manager'];

async function rolVan(userId) {
  const { data } = await supabaseAdmin.from('profiles').select('role, is_active').eq('id', userId).maybeSingle();
  return data && data.is_active !== false ? data.role : null;
}

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
  if (!(await requirePermission(req, 'opvolging.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });
  }

  try {
    const rol = await rolVan(user.id);
    const magBewerken = BEWERK_ROLLEN.includes(rol);

    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin
        .from('app_settings').select('value, updated_at').eq('key', INSTELLING_KEY).maybeSingle();
      if (error) throw new Error(error.message);
      const v = leesInstelling(data && data.value);
      return res.status(200).json({
        instelling: v, mag_bewerken: magBewerken, updated_at: data ? data.updated_at : null,
        ...(await metaStand(v)),
      });
    }

    if (!magBewerken) return res.status(403).json({ error: 'Alleen een manager of super_admin kan de agendalink aanpassen.' });
    const b = req.body || {};
    const fout = valideerInstelling(b);
    if (fout) return res.status(400).json({ error: fout });
    const value = {
      agenda_link: String(b.agenda_link || '').trim() || null,
      bericht: String(b.bericht),
      herinnering: String(b.herinnering),
      kanaal: b.kanaal === 'brug' ? 'brug' : 'meta',
      module: String(b.module || 'leadsonderhoud').trim(),
      phone_number_id: b.phone_number_id ? String(b.phone_number_id).trim() : null,
    };
    const nu = new Date().toISOString();
    const { data: bestaand, error: lErr } = await supabaseAdmin
      .from('app_settings').select('key').eq('key', INSTELLING_KEY).maybeSingle();
    if (lErr) throw new Error(lErr.message);
    const { error } = bestaand
      ? await supabaseAdmin.from('app_settings').update({ value, updated_at: nu }).eq('key', INSTELLING_KEY)
      : await supabaseAdmin.from('app_settings').insert({ key: INSTELLING_KEY, value, updated_at: nu });
    if (error) throw new Error(error.message);
    const v = leesInstelling(value);
    return res.status(200).json({ ok: true, instelling: v, ...(await metaStand(v)) });
  } catch (e) {
    console.error('[opvolging-agenda-instelling]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
