// api/opvolging-agenda-doorsturen.js
//
// POST { taak_id, tekst?, soort?: 'eerste' | 'herinnering' }
//   → verstuurt NU de agendalink. Voor daglijstkaarten én leadkaarten.
//
//   SINDS PR 6 (2 okt): standaard via de goedgekeurde Meta-template
//   (agenda_doorsturen_v1 / agenda_herinnering_v1) op de lijn van de
//   afspraakberichten — zie api/_lib/opvolging-meta.js. Zolang de template
//   niet APPROVED is, of als de instelling kanaal='brug' zegt: terugval op de
//   vrije tekst via de whatsapp-web.js-brug, met een melding in het antwoord.
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
  vertaalBrugFout, waMeLink, MAX_TEKST, voornaamUit,
} from './_lib/opvolging-agenda-doorsturen.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { buildSendComponents } from './_lib/meta-template-components-builder.js';
import { logOutboundWa } from './_lib/wa-outbound-log.js';
import { telefoonNlBe } from './_lib/phone-e164.js';
import {
  TEMPLATE_NAMEN, META_SLEUTEL, kiesPad, resolveAgendaLijn, leesTemplate,
} from './_lib/opvolging-meta.js';

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

    // ── Welk pad? Standaard de goedgekeurde Meta-template; zolang die er niet
    //    is (of het kanaal op 'brug' staat) de vrije tekst via de brug. ──────
    let pad = { pad: 'brug', reden: 'kanaal_brug', melding: null };
    let template = null, phoneNumberId = null;
    if (instelling.kanaal === 'meta') {
      try {
        phoneNumberId = await resolveAgendaLijn(supabaseAdmin, instelling);
        template = await leesTemplate(supabaseAdmin, TEMPLATE_NAMEN[soort]);
      } catch (e) {
        console.warn('[opvolging-agenda-doorsturen] template/lijn lezen (soft):', e?.message || e);
      }
      pad = kiesPad({ kanaal: instelling.kanaal, template, phoneNumberId });
    }
    if (pad.pad === 'meta') {
      return await verstuurViaMeta({ res, taak, soort, template, phoneNumberId });
    }

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
      return res.status(status).json({ ...body, wa_me: waMe, tekst, kanaal: 'brug', melding: pad.melding });
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

    return res.status(200).json({ ok: true, soort, verstuurd_op: nu, status: nieuweStatus, tekst, kanaal: 'brug', melding: pad.melding });
  } catch (e) {
    console.error('[opvolging-agenda-doorsturen]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

/**
 * Het Meta-pad: de goedgekeurde template op de lijn van de afspraakberichten.
 *
 * Body {{1}} = voornaam; de URL-knop 'Kies een moment' is statisch in de
 * template, dus buildSendComponents levert alleen de body-component (en een
 * knop-component als de template ooit een URL-parameter krijgt).
 *
 * Pas na een geslaagde verzending: logOutboundWa (gesprek in de bestaande
 * gesprekkenschermen), de kaart op wacht (alleen 'eerste'), een poging
 * 'agenda_doorgestuurd'/'agenda_herinnering' en ÉÉN poging 'whatsapp' met
 * call_log_id = 'meta:<wamid>' — dat is de WhatsApp die meetelt, en de sleutel
 * waarop een latere failed-status de kaart terugvindt.
 */
async function verstuurViaMeta({ res, taak, soort, template, phoneNumberId }) {
  const voornaam = voornaamUit(taak.naam) || 'daar';
  const to = telefoonNlBe(taak.telefoon, { bron: 'opvolging-agenda-doorsturen' }) || taak.telefoon;
  const { components, warnings } = buildSendComponents({ template, bodyVariables: { 1: voornaam } });
  if (warnings && warnings.length) console.warn('[opvolging-agenda-doorsturen] template-waarschuwing:', warnings.join('; '));

  let wamid;
  try {
    ({ wamid } = await sendTemplate({
      to, templateName: template.name, languageCode: template.language || 'nl', components, phoneNumberId,
    }));
  } catch (e) {
    const code = e instanceof MetaNotConfiguredError ? 'META_NIET_GECONFIGUREERD' : 'META_FOUT';
    console.error('[opvolging-agenda-doorsturen] Meta-send:', e?.message || e);
    return res.status(code === 'META_FOUT' ? 502 : 503).json({
      code, kanaal: 'meta',
      error: 'Versturen via de Meta-lijn mislukte' + (e?.metaMessage ? ': ' + String(e.metaMessage).slice(0, 160) : '') + '. De kaart is niet veranderd.',
      wa_me: waMeLink(to, ''),
    });
  }

  const nu = new Date().toISOString();
  // Het gesprek in de bestaande schermen (fail-soft, gooit nooit).
  await logOutboundWa(supabaseAdmin, {
    toPhone: to, phoneNumberId, wamid,
    body: `WhatsApp-template '${template.name}' — ${voornaam}`,
    templateName: template.name, templateVariables: { 1: voornaam },
    source: 'opvolging-agenda-doorsturen',
  });

  let nieuweStatus = taak.status;
  if (soort === 'eerste') {
    const { data: upd, error: uErr } = await supabaseAdmin.from('opvolging_taken').update({
      status: 'wacht_inplanning', agenda_doorgestuurd_at: nu, later: false, updated_at: nu,
    }).eq('id', taak.id).eq('status', 'open').select('id, status').maybeSingle();
    if (uErr) {
      console.error('[opvolging-agenda-doorsturen] taak bijwerken (meta):', uErr.message);
      return res.status(500).json({
        code: 'VERSTUURD_MAAR_NIET_BIJGEWERKT', kanaal: 'meta',
        error: 'Het bericht is verstuurd, maar de kaart kon niet op "wacht op inplanning" gezet worden. Stuur het NIET opnieuw.',
      });
    }
    nieuweStatus = upd ? upd.status : taak.status;
  }

  try {
    const { error: pErr } = await supabaseAdmin.from('opvolging_pogingen').insert([
      {
        taak_id: taak.id,
        soort: soort === 'herinnering' ? 'agenda_herinnering' : 'agenda_doorgestuurd',
        resultaat: soort === 'herinnering' ? 'herinnering agenda gestuurd via Meta-template' : 'agenda doorgestuurd via Meta-template',
        automatisch: false, richting: 'uit', tijdstip: nu,
      },
      {
        taak_id: taak.id, soort: 'whatsapp', richting: 'uit', automatisch: true, tijdstip: nu,
        resultaat: 'WhatsApp verstuurd (template ' + template.name + ')',
        call_log_id: META_SLEUTEL + wamid,
      },
    ]);
    if (pErr) throw new Error(pErr.message);
  } catch (e) {
    console.warn('[opvolging-agenda-doorsturen] pogingen (soft):', e?.message || e);
  }

  return res.status(200).json({
    ok: true, soort, kanaal: 'meta', wamid, template: template.name,
    verstuurd_op: nu, status: nieuweStatus, tekst: null,
  });
}
