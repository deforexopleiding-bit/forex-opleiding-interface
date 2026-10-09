// api/webinar-admin.js
//
// Beheer van het webinar (tab Events → Webinar).
//
// GET                     → { reeks, sessies: [{ …, aantal }] }  (4 weken terug + komende 8)
// GET ?sessie_id=<uuid>   → { sessie, aanmeldingen: [...] }
//   RBAC: events.event.view
// POST { actie, … }       RBAC: events.event.edit
//   'reeks_opslaan'  { titel?, zoom_url?, starttijd?, duur_min?, actief? }
//                    → ook komende 'geplande' sessies krijgen de nieuwe tijd/duur
//   'overslaan'      { sessie_id, notitie? } → status 'overgeslagen'; aanmelders
//                    schuiven door naar de volgende actieve week (nieuwe bevestiging via de cron)
//   'herstellen'     { sessie_id } → weer 'gepland' (doorgeschoven aanmelders blijven waar ze zijn)
//   'sessie_zoom'    { sessie_id, zoom_url|null } → afwijkende Zoom-link voor die week

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalReeks, zorgVoorSessies, slaSessieOver, nlNaarUtc, MIN } from './_lib/webinar.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: een Zoom-link normaliseren. '' → null; anders https-URL vereist. */
export function normZoom(v) {
  const s = String(v ?? '').trim();
  if (!s) return { ok: true, waarde: null };
  let u;
  try { u = new URL(s); } catch { return { ok: false, fout: 'Zoom-link is geen geldige URL' }; }
  if (u.protocol !== 'https:') return { ok: false, fout: 'Zoom-link moet met https:// beginnen' };
  return { ok: true, waarde: u.toString() };
}

/** Pure: reeks-velden valideren → { ok, patch } of { ok:false, fout }. */
export function valideerReeks(b) {
  const patch = {};
  if (b.titel !== undefined) {
    const t = String(b.titel || '').trim();
    if (!t || t.length > 120) return { ok: false, fout: 'Titel is verplicht (max 120 tekens)' };
    patch.titel = t;
  }
  if (b.zoom_url !== undefined) {
    const z = normZoom(b.zoom_url);
    if (!z.ok) return z;
    patch.zoom_url = z.waarde;
  }
  if (b.starttijd !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.starttijd))) return { ok: false, fout: 'Starttijd moet HH:MM zijn' };
    patch.starttijd = String(b.starttijd);
  }
  if (b.duur_min !== undefined) {
    const d = Number(b.duur_min);
    if (!Number.isInteger(d) || d < 15 || d > 300) return { ok: false, fout: 'Duur moet tussen 15 en 300 minuten liggen' };
    patch.duur_min = d;
  }
  if (b.actief !== undefined) patch.actief = b.actief === true;
  if (!Object.keys(patch).length) return { ok: false, fout: 'Niets om op te slaan' };
  return { ok: true, patch };
}

async function telAanmeldingen(sessieIds) {
  const uit = {};
  for (const id of sessieIds) {
    const { count, error } = await supabaseAdmin.from('webinar_aanmeldingen')
      .select('id', { count: 'exact', head: true }).eq('sessie_id', id).eq('is_test', false);
    if (error) console.error('[webinar-admin] tellen mislukt', id, error.message);
    uit[id] = count || 0;
  }
  return uit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  try {
    if (req.method === 'GET') {
      if (!(await requirePermission(req, 'events.event.view'))) return res.status(403).json({ error: 'Geen rechten (events.event.view)' });
      const reeks = await haalReeks(supabaseAdmin);
      if (!reeks) return res.status(200).json({ reeks: null, sessies: [], migratie_nodig: true });

      const sessieId = req.query?.sessie_id;
      if (sessieId) {
        if (!UUID_RE.test(String(sessieId))) return res.status(400).json({ error: 'Ongeldige sessie_id' });
        const { data: sessie, error: sErr } = await supabaseAdmin.from('webinar_sessies').select('*').eq('id', sessieId).maybeSingle();
        if (sErr) throw new Error(sErr.message);
        if (!sessie) return res.status(404).json({ error: 'Sessie niet gevonden' });
        const { data: aanm, error: aErr } = await supabaseAdmin.from('webinar_aanmeldingen')
          .select('id, voornaam, email, telefoon, bron, lead_id, is_test, aangemeld_op, verplaatst_van_sessie_id, bevestiging_op, reminder_dag_op, reminder_uur_op, live_op, berichten')
          .eq('sessie_id', sessieId).order('aangemeld_op', { ascending: false }).limit(1000);
        if (aErr) throw new Error(aErr.message);
        return res.status(200).json({ sessie, aanmeldingen: aanm || [] });
      }

      try { await zorgVoorSessies(supabaseAdmin, reeks); } catch (e) { console.error('[webinar-admin] sessies aanvullen:', e?.message || e); }
      const vanaf = new Date(Date.now() - 28 * 24 * 60 * MIN).toISOString();
      const { data: sessies, error } = await supabaseAdmin.from('webinar_sessies').select('*')
        .eq('reeks_id', reeks.id).gte('starts_at', vanaf).order('starts_at', { ascending: true }).limit(12);
      if (error) throw new Error(error.message);
      const tellingen = await telAanmeldingen((sessies || []).map((s) => s.id));
      return res.status(200).json({
        reeks,
        sessies: (sessies || []).map((s) => ({ ...s, aantal: tellingen[s.id] || 0 })),
      });
    }

    if (req.method === 'POST') {
      if (!(await requirePermission(req, 'events.event.edit'))) return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      const reeks = await haalReeks(supabaseAdmin);
      if (!reeks) return res.status(409).json({ error: 'Webinar-tabellen ontbreken — draai de migratie 2026-10-09-webinar-fase1.sql' });

      if (b.actie === 'reeks_opslaan') {
        const v = valideerReeks(b);
        if (!v.ok) return res.status(400).json({ error: v.fout });
        const nu = new Date().toISOString();
        const { data: nieuw, error } = await supabaseAdmin.from('webinar_reeksen').update({ ...v.patch, updated_at: nu }).eq('id', reeks.id).select('*').single();
        if (error) throw new Error(error.message);
        // Tijd of duur gewijzigd → komende geplande sessies meeschuiven (NL-wandklok, DST-correct).
        let bijgewerkt = 0;
        if (v.patch.starttijd !== undefined || v.patch.duur_min !== undefined) {
          const { data: komend, error: kErr } = await supabaseAdmin.from('webinar_sessies').select('id, datum')
            .eq('reeks_id', reeks.id).eq('status', 'gepland').gt('starts_at', nu);
          if (kErr) throw new Error(kErr.message);
          for (const s of komend || []) {
            try {
              const start = nlNaarUtc(s.datum, String(nieuw.starttijd).slice(0, 5));
              const { error: uErr } = await supabaseAdmin.from('webinar_sessies').update({
                starts_at: start.toISOString(), ends_at: new Date(start.getTime() + nieuw.duur_min * MIN).toISOString(), updated_at: nu,
              }).eq('id', s.id);
              if (uErr) throw new Error(uErr.message);
              bijgewerkt++;
            } catch (e) { console.error('[webinar-admin] sessie bijwerken mislukt', s.id, e?.message || e); }
          }
        }
        return res.status(200).json({ ok: true, reeks: nieuw, sessies_bijgewerkt: bijgewerkt });
      }

      if (!UUID_RE.test(String(b.sessie_id || ''))) return res.status(400).json({ error: 'sessie_id ontbreekt of is ongeldig' });

      if (b.actie === 'overslaan') {
        const r = await slaSessieOver(supabaseAdmin, { sessieId: b.sessie_id, doorUserId: user.id, notitie: String(b.notitie || '').trim().slice(0, 300) || null });
        if (r.fout === 'NIET_GEVONDEN') return res.status(404).json({ error: 'Sessie niet gevonden' });
        if (r.fout === 'AL_BEGONNEN') return res.status(409).json({ error: 'Deze webinar is al begonnen of voorbij' });
        return res.status(200).json({
          ok: true, verplaatst: r.verplaatst, vervallen: r.vervallen, waarschuwing: r.waarschuwing || null,
          doel: r.doel ? { id: r.doel.id, starts_at: r.doel.starts_at } : null,
        });
      }

      if (b.actie === 'herstellen') {
        const { data, error } = await supabaseAdmin.from('webinar_sessies')
          .update({ status: 'gepland', overgeslagen_op: null, overgeslagen_door: null, updated_at: new Date().toISOString() })
          .eq('id', b.sessie_id).eq('reeks_id', reeks.id).select('id, starts_at, status');
        if (error) throw new Error(error.message);
        if (!data?.length) return res.status(404).json({ error: 'Sessie niet gevonden' });
        return res.status(200).json({ ok: true, sessie: data[0] });
      }

      if (b.actie === 'sessie_zoom') {
        const z = normZoom(b.zoom_url);
        if (!z.ok) return res.status(400).json({ error: z.fout });
        const { data, error } = await supabaseAdmin.from('webinar_sessies')
          .update({ zoom_url: z.waarde, updated_at: new Date().toISOString() })
          .eq('id', b.sessie_id).eq('reeks_id', reeks.id).select('id, zoom_url');
        if (error) throw new Error(error.message);
        if (!data?.length) return res.status(404).json({ error: 'Sessie niet gevonden' });
        return res.status(200).json({ ok: true, sessie: data[0] });
      }

      return res.status(400).json({ error: 'Onbekende actie' });
    }

    return res.status(405).json({ error: 'GET of POST' });
  } catch (e) {
    console.error('[webinar-admin] fout:', e?.message || e);
    return res.status(500).json({ error: 'Webinar-beheer mislukt' });
  }
}
