// api/opvolging-agenda-doorsturen.js
//
// POST { taak_id, tekst?, soort?: 'eerste' | 'herinnering' }
//   → verstuurt NU via de gekoppelde WhatsApp-lijn (de brug) een bericht met de
//     agendalink. Voor daglijstkaarten én leadkaarten.
//
//   eerste       — pas bij een GESLAAGDE verzending: status wacht_inplanning,
//                  agenda_doorgestuurd_at = nu, poging 'agenda_doorgestuurd'.
//                  Start de 48-uurklok (cron-opvolging-wacht-check).
//   herinnering  — alleen op wacht_inplanning; poging 'agenda_herinnering';
//                  agenda_doorgestuurd_at blijft staan (de 48 uur lopen door);
//                  max 1 per 24 uur per kaart.
//
// Antwoorden:
//   200 { ok, verstuurd_op, status, tekst }
//   202 { code: 'BRUG_KENT_NUMMER_NOG_NIET', opnieuw_over_sec } — kaart < 6 min
//       oud en de brug kent het nummer nog niet; het scherm probeert opnieuw.
//   409 { code: 'GEEN_AGENDALINK' } — er is NIETS verstuurd en NIETS veranderd.
//   4xx/5xx met code NIET_VERBONDEN / NIET_TOEGESTAAN / LANDCODE_ONBEKEND / …
//       — de kaart blijft zoals hij was. Altijd met `wa_me` als terugval.
//
// ÉÉN WHATSAPP, NIET TWEE. Het bericht zelf wordt door de webhook gelogd als
// whatsapp-poging zodra de brug meldt dat het vertrok. De poging die hier
// geschreven wordt heeft soort 'agenda_doorgestuurd' (of 'agenda_herinnering'),
// en die soorten tellen in telPogingen() NIET als WhatsApp. Zie de test.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { brugFetch } from './_lib/whatsapp-brug-client.js';
import { normaliseerNummer } from './_lib/whatsapp-brug-nummers.js';
import { brugLeadlijstVerversen } from './_lib/opvolging-brug-ververs.js';
import {
  INSTELLING_KEY, leesInstelling, beslisDoorsturen, bouwAgendaBericht,
  vertaalBrugFout, waMeLink, MAX_TEKST,
} from './_lib/opvolging-agenda-doorsturen.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'opvolging.whatsapp.sturen'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.whatsapp.sturen)' });
  }
  if (!(await requirePermission(req, 'opvolging.taak.afronden'))) {
    return res.status(403).json({ error: 'Geen rechten (opvolging.taak.afronden)' });
  }

  const b = req.body || {};
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });
  const soort = b.soort === 'herinnering' ? 'herinnering' : 'eerste';
  if (typeof b.tekst === 'string' && b.tekst.length > MAX_TEKST) {
    return res.status(400).json({ error: `tekst is langer dan ${MAX_TEKST} tekens` });
  }

  try {
    const { data: instRij, error: iErr } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', INSTELLING_KEY).maybeSingle();
    if (iErr) throw new Error('instelling lezen: ' + iErr.message);
    const instelling = leesInstelling(instRij && instRij.value);

    const { data: taak, error: tErr } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).maybeSingle();
    if (tErr) throw new Error('taak lezen: ' + tErr.message);

    let laatsteHerinnering = null;
    if (taak && soort === 'herinnering') {
      const { data: h, error: hErr } = await supabaseAdmin
        .from('opvolging_pogingen').select('tijdstip')
        .eq('taak_id', taak.id).eq('soort', 'agenda_herinnering')
        .order('tijdstip', { ascending: false }).limit(1);
      if (hErr) throw new Error('herinneringen lezen: ' + hErr.message);
      laatsteHerinnering = h && h[0] ? h[0].tijdstip : null;
    }

    const nuMs = Date.now();
    const besluit = beslisDoorsturen({ taak, soort, instelling, laatsteHerinnering, nuMs });
    if (!besluit.ok) return res.status(besluit.status).json({ code: besluit.code, error: besluit.error });

    const tekst = bouwAgendaBericht({
      sjabloon: soort === 'herinnering' ? instelling.herinnering : instelling.bericht,
      tekst: b.tekst, naam: taak.naam, link: instelling.agenda_link,
    });
    const nummer = normaliseerNummer(taak.telefoon);
    const waMe = waMeLink(nummer, tekst);

    // Eerst de brug laten verversen (een nieuwe kaart kent hij anders pas over
    // maximaal vijf minuten). 404 = de brug is nog niet bijgewerkt: negeren.
    await brugLeadlijstVerversen();

    try {
      await brugFetch('/send', { method: 'POST', body: { nummer, tekst } });
    } catch (e) {
      const { status, body } = vertaalBrugFout(e, { taakAangemaaktMs: Date.parse(taak.created_at || ''), nuMs });
      if (e?.oorzaak) console.warn('[opvolging-agenda-doorsturen]', e.code, e.oorzaak);
      return res.status(status).json({ ...body, wa_me: waMe, tekst });
    }

    // ── Pas NA een geslaagde verzending de kaart bijwerken ───────────────
    const nu = new Date().toISOString();
    let nieuweStatus = taak.status;
    if (soort === 'eerste') {
      const { data: upd, error: uErr } = await supabaseAdmin.from('opvolging_taken').update({
        status: 'wacht_inplanning', agenda_doorgestuurd_at: nu, later: false, updated_at: nu,
      }).eq('id', taak.id).eq('status', 'open').select('id, status').maybeSingle();
      if (uErr) {
        // Het bericht IS verstuurd. Dat moet het scherm weten, anders stuurt
        // Dave het een tweede keer.
        console.error('[opvolging-agenda-doorsturen] taak bijwerken:', uErr.message);
        return res.status(500).json({
          code: 'VERSTUURD_MAAR_NIET_BIJGEWERKT',
          error: 'Het bericht is verstuurd, maar de kaart kon niet op "wacht op inplanning" gezet worden. Stuur het NIET opnieuw.',
        });
      }
      nieuweStatus = upd ? upd.status : taak.status;
    }

    // De historiek. Fail-soft: het bericht is de hoofdzaak.
    try {
      const { error: pErr } = await supabaseAdmin.from('opvolging_pogingen').insert({
        taak_id: taak.id,
        soort: soort === 'herinnering' ? 'agenda_herinnering' : 'agenda_doorgestuurd',
        resultaat: soort === 'herinnering' ? 'herinnering agenda gestuurd via WhatsApp' : 'agenda doorgestuurd via WhatsApp',
        automatisch: false,
        richting: 'uit',
        tijdstip: nu,
      });
      if (pErr) throw new Error(pErr.message);
    } catch (e) {
      console.warn('[opvolging-agenda-doorsturen] poging (soft):', e?.message || e);
    }

    return res.status(200).json({ ok: true, soort, verstuurd_op: nu, status: nieuweStatus, tekst });
  } catch (e) {
    console.error('[opvolging-agenda-doorsturen]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
