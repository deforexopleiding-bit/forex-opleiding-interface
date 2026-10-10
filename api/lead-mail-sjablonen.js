// api/lead-mail-sjablonen.js
//
// Bibliotheek van e-mailsjablonen voor "Stuur bericht" (fase 1).
// Tabel: lead_mail_sjablonen (docs/sql-migrations/2026-10-09-lead-mail-sjablonen.sql).
//
// GET              → { sjablonen:[{ id, naam, onderwerp, html, aangemaakt, bijgewerkt }] }
// POST { id?, naam, onderwerp, html } → nieuw of bijwerken (html wordt opgeschoond)
// DELETE ?id=<uuid>
// RBAC: leads.view. Tabel ontbreekt → 409 met de migratienaam.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { schoonHtml, onbekendeVariabelen } from './_lib/lead-bericht.js';
import { htmlNaarTekst } from './_lib/mail-shell-lead.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABEL = 'lead_mail_sjablonen';
const MIGRATIE = '2026-10-09-lead-mail-sjablonen.sql';
const ontbreekt = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(String(e.message || '')));

/** Pure validatie → { ok, rij } of { ok:false, fout }. */
export function valideerSjabloon(b) {
  const naam = String(b?.naam || '').trim();
  if (!naam || naam.length > 120) return { ok: false, fout: 'Naam is verplicht (max 120 tekens).' };
  const onderwerp = String(b?.onderwerp || '').trim();
  if (!onderwerp || onderwerp.length > 200) return { ok: false, fout: 'Onderwerp is verplicht (max 200 tekens).' };
  const html = schoonHtml(b?.html);
  if (!htmlNaarTekst(html).trim()) return { ok: false, fout: 'De inhoud is leeg.' };
  if (html.length > 50000) return { ok: false, fout: 'De inhoud is te lang.' };
  const onbekend = onbekendeVariabelen(onderwerp + ' ' + html);
  if (onbekend.length) return { ok: false, fout: `Onbekende variabele(n): ${onbekend.map((x) => '{{' + x + '}}').join(', ')}.` };
  return { ok: true, rij: { naam, onderwerp, html } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabaseAdmin.from(TABEL)
        .select('id, naam, onderwerp, html, aangemaakt, bijgewerkt').order('naam', { ascending: true }).limit(500);
      if (error) {
        if (ontbreekt(error)) return res.status(409).json({ error: `Sjablonen-tabel ontbreekt — draai ${MIGRATIE}`, code: 'MIGRATIE_NODIG' });
        throw error;
      }
      return res.status(200).json({ sjablonen: data || [] });
    }

    if (req.method === 'POST') {
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const v = valideerSjabloon(b);
      if (!v.ok) return res.status(400).json({ error: v.fout });
      const nu = new Date().toISOString();
      if (b.id) {
        if (!UUID_RE.test(String(b.id))) return res.status(400).json({ error: 'Ongeldig id' });
        const { data, error } = await supabaseAdmin.from(TABEL)
          .update({ ...v.rij, bijgewerkt: nu, bijgewerkt_door: user.id }).eq('id', b.id).select('*');
        if (error) {
          if (ontbreekt(error)) return res.status(409).json({ error: `Sjablonen-tabel ontbreekt — draai ${MIGRATIE}`, code: 'MIGRATIE_NODIG' });
          throw error;
        }
        if (!data?.length) return res.status(404).json({ error: 'Sjabloon niet gevonden' });
        return res.status(200).json({ ok: true, sjabloon: data[0] });
      }
      const { data, error } = await supabaseAdmin.from(TABEL)
        .insert({ ...v.rij, aangemaakt_door: user.id, bijgewerkt_door: user.id }).select('*').single();
      if (error) {
        if (ontbreekt(error)) return res.status(409).json({ error: `Sjablonen-tabel ontbreekt — draai ${MIGRATIE}`, code: 'MIGRATIE_NODIG' });
        throw error;
      }
      return res.status(200).json({ ok: true, sjabloon: data });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Ongeldig id' });
      const { data, error } = await supabaseAdmin.from(TABEL).delete().eq('id', id).select('id');
      if (error) {
        if (ontbreekt(error)) return res.status(409).json({ error: `Sjablonen-tabel ontbreekt — draai ${MIGRATIE}`, code: 'MIGRATIE_NODIG' });
        throw error;
      }
      if (!data?.length) return res.status(404).json({ error: 'Sjabloon niet gevonden' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'GET, POST of DELETE' });
  } catch (e) {
    console.error('[lead-mail-sjablonen] fout:', e?.message || e);
    return res.status(500).json({ error: 'Sjablonen bewerken mislukt' });
  }
}
