// api/leadsonderhoud-gesprek-template.js
// POST { lead_id, template_name, language?, variables[] }
//   -> stuur een APPROVED WhatsApp-template aan de lead (buiten 24u-venster of
//      als alternatief voor vrije tekst binnen venster).
//
// v=6 FIX 5 DEEL C — buiten het 24u-venster kunnen we geen vrije tekst sturen
// (Meta-policy). Deze endpoint gebruikt sendTemplate met de leadsonderhoud-lijn
// (whatsapp_module_config waar module='leadsonderhoud') en zonder finance-fallback
// (consistent met -gesprek-antwoord).
//
// Gate: leads.view (consistent met -gesprek-antwoord / -mailantwoord — wie een
// lead-gesprek mag lezen mag ook een template versturen; RBAC-granulariteit
// gelijk aan bestaande module-scope).
//
// Body:
//   lead_id       uuid    required
//   template_name text    required — matcht whatsapp_meta_templates.name
//   language      text    optional (default 'nl')
//   variables     array   optional — positional [{{1}}, {{2}}, ...] tekst-waarden
//
// Response 200:
//   { ok:true, wamid, in_draad }   (in_draad=false → verstuurd, maar de
//                                   draad-log mislukte; staat in de Vercel-log)
//
// 2026-10-10: het gesprek werd gezocht in een ONGESORTEERDE .limit(500) van de
// lijn (>1000 gesprekken) — op een drukke lijn werd het vaak niet gevonden en
// kwam het verstuurde sjabloon niet in de draad. Nu vindLeadConv (direct op
// nummer, zoals de draad zelf sinds #1760); geen gesprek → logOutboundWa maakt
// het aan. De berichten_log-insert schreef een niet-bestaande kolom
// (meta_template) en faalde stil; nu de wamid in extern_id.
// Errors:
//   400 { error }                  — validatie
//   404 { error }                  — lead niet gevonden
//   403 { error }                  — lead niet in traject / geen rechten
//   409 { error }                  — geen WA-lijn / lead heeft geen telefoon
//   502 { error, meta_error }      — Meta API fout
//   503 { error, missing? }        — Meta niet geconfigureerd

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, trajectSlugs, vindLeadConv } from './_lib/leadsonderhoud-gesprekken.js';
import { logOutboundWa } from './_lib/wa-outbound-log.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { renderTemplatePreview } from './_lib/render-template-preview.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEMPLATE_NAME = 200;
const MAX_VAR_LEN = 1000;

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

  const body = req.body || {};
  // FASE 0 — conversation_id-pad (dormant; nog geen UI roept dit aan).
  // Autorisatie: de conv staat op de leadsonderhoud-lijn. Het lead_id-pad
  // hieronder blijft byte-voor-byte ongewijzigd (incl. traject-gate).
  const convIdT = String(body.conversation_id || '').trim();
  if (convIdT) {
    if (!UUID_RE.test(convIdT)) return res.status(400).json({ error: 'conversation_id ongeldig' });
    return sendTemplateByConversation(res, { user, convId: convIdT, body });
  }
  const leadId       = String(body.lead_id || '').trim();
  const templateName = String(body.template_name || '').trim();
  const language     = String(body.language || 'nl').trim() || 'nl';
  const rawVars      = Array.isArray(body.variables) ? body.variables : [];

  if (!UUID_RE.test(leadId))              return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
  if (!templateName)                      return res.status(400).json({ error: 'template_name vereist' });
  if (templateName.length > MAX_TEMPLATE_NAME) return res.status(400).json({ error: 'template_name te lang' });

  // Normaliseer variables naar string-array, cap per waarde.
  const variables = rawVars.map(v => String(v == null ? '' : v).slice(0, MAX_VAR_LEN));

  // Guard tegen lege template-parameters. Meta rejects met code 132001
  // ("Parameter format does not match format in the created template" /
  // "Parameter can't be empty") zodra een verplichte {{N}} als lege string
  // wordt meegestuurd. In plaats van de Meta-error terug te sturen (die
  // niet uitlegt WAT te doen), weigeren we met een leesbare 400 zodat de
  // user meteen weet welke variabele leeg was.
  const leegIdx = variables.findIndex(v => v.trim() === '');
  if (leegIdx >= 0) {
    return res.status(400).json({
      error: `Variabele #${leegIdx + 1} is leeg — vul alle variabelen in voordat je de template verstuurt.`,
      leeg_index: leegIdx,
    });
  }

  try {
    // Lead + traject-check (mirror -gesprek-antwoord).
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from('leads').select('id, telefoon_e164, traject, voornaam, achternaam').eq('id', leadId).maybeSingle();
    if (leadErr) throw leadErr;
    if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });

    const slugs = await trajectSlugs();
    if (!slugs.has((lead.traject || '').toLowerCase())) {
      return res.status(403).json({ error: 'Deze lead zit niet in een traject' });
    }

    const lijn = await haalLijn();
    if (!lijn.phoneNumberId) return res.status(409).json({ error: 'Geen WhatsApp-lijn ingesteld' });
    if (!lead.telefoon_e164) return res.status(409).json({ error: 'Deze lead heeft geen telefoonnummer' });

    // Zoek de bestaande WA-conv (voor logging + phone_number canoniek) — direct
    // op lijn + nummer, nieuwste eerst (vindLeadConv; zie kop).
    // GEEN 24u-venster-check: templates mogen ook buiten venster.
    const conv = await vindLeadConv(lijn, lead, null, { sb: supabaseAdmin, tag: '[ls-gesprek-template]' });
    // Nog geen conv: Meta accepteert alsnog een template naar een 'nieuw'
    // nummer; logOutboundWa maakt het gesprek daarna aan (zie onder).
    const toNumber = conv ? conv.phone_number : lead.telefoon_e164;
    const phoneNumberId = (conv && conv.phone_number_id) || lijn.phoneNumberId;

    let metaResult;
    try {
      metaResult = await sendTemplate({
        to: toNumber,
        templateName,
        languageCode: language,
        variables,
        phoneNumberId,
      });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({ error: 'Meta WhatsApp niet geconfigureerd', missing: metaErr.missing });
      }
      console.error('[ls-gesprek-template] Meta-fout:', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nu = new Date().toISOString();

    // Log-bubbel voor de thread: whatsapp_messages met template_name + body
    // = de gerenderde tekst. Voorheen bleef body='' → CRM-thread en lijst-
    // preview toonden "[sjabloon] naam" via leadsonderhoud-gesprek-berichten.js
    // regel 79. Nu renderen we de body via de bestaande render-template-
    // preview-helper (zelfde patroon als inbox-send-template.js), zodat de
    // gerenderde tekst persistent zichtbaar is bij page-refresh.
    //
    // De variables-array is positioneel (variables[0] = {{1}}, etc.). De
    // helper verwacht templateVariables als object { "1": val, "2": val }.
    const templateVarsMap = variables.length
      ? Object.fromEntries(variables.map((v, i) => [String(i + 1), String(v ?? '')]))
      : null;
    let renderedBody = null;
    try {
      const preview = await renderTemplatePreview({
        templateName,
        templateVariables: templateVarsMap,
        supabase: supabaseAdmin,
      });
      // source='meta_template' = geslaagde render; source='legacy_label' /
      // 'no_template_name' = fallback naar '[template] naam'. In de
      // legacy-fallback willen we body='' laten (leadsonderhoud-gesprek-
      // berichten.js regel 79 vult dan alsnog '[sjabloon] naam' — beter
      // consistent gedrag dan '[template] naam' in de rauwe body).
      if (preview && preview.source === 'meta_template' && preview.body) {
        renderedBody = preview.body;
      }
    } catch (e) {
      console.warn('[ls-gesprek-template] renderTemplatePreview soft-fail:', e?.message || e);
    }

    // Draad-log. Fail-soft (het bericht IS verstuurd), maar nooit stil: elke
    // fout wordt gelogd en in_draad=false gaat terug naar de UI.
    let inDraad = false;
    if (conv) {
      inDraad = await logInConv(conv.id, { user, wamid, templateName, templateVarsMap, renderedBody, nu, tag: 'lead' });
    } else {
      try {
        const r = await logOutboundWa(supabaseAdmin, {
          toPhone: toNumber,
          phoneNumberId,
          body: renderedBody || ('[sjabloon] ' + templateName),
          wamid,
          templateName,
          templateVariables: templateVarsMap,
          source: 'ls-gesprek-template',
        });
        inDraad = !!(r && r.ok && r.message_id);
        if (!inDraad) console.error('[ls-gesprek-template] logOutboundWa zonder bericht:', { lead: leadId, fout: r?.error || null });
      } catch (e) {
        console.error('[ls-gesprek-template] logOutboundWa faalde:', { lead: leadId, fout: e?.message || e });
      }
    }

    // berichten_log (motor-log) — spiegel wat cron-leadsonderhoud doet zodat
    // deze template-send meetelt in de leadsonderhoud-log. Alleen bestaande
    // kolommen: de wamid in extern_id (zoals api/_lib/lead-bericht.js). De
    // templatenaam staat al in whatsapp_messages.template_name.
    const { error: logErr } = await supabaseAdmin
      .from('berichten_log')
      .insert({
        lead_id: leadId,
        traject: lead.traject || null,
        soort: 'handmatig-template',
        kanaal: 'whatsapp',
        naar: toNumber,
        agent: user.email || user.id,
        status: 'ok',
        verstuurd_op: nu,
        extern_id: wamid,
      });
    if (logErr) console.error('[ls-gesprek-template] berichten_log-insert mislukt:', { lead: leadId, fout: logErr.message });

    return res.status(200).json({ ok: true, wamid, in_draad: inDraad });
  } catch (e) {
    console.error('[ls-gesprek-template] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Template versturen mislukt' });
  }
}

// FASE 0 — template versturen op basis van conversation_id (geen lead). Mirror
// van het lead-pad (validatie, Meta-send, body-render, thread-logregel), maar
// de conv wordt direct op id geladen en de autorisatie is de leadsonderhoud-
// lijn. GEEN berichten_log-regel (die is lead/traject-specifiek). Dormant tot
// fase 2.
async function sendTemplateByConversation(res, { user, convId, body }) {
  const templateName = String(body.template_name || '').trim();
  const language     = String(body.language || 'nl').trim() || 'nl';
  const rawVars      = Array.isArray(body.variables) ? body.variables : [];
  if (!templateName) return res.status(400).json({ error: 'template_name vereist' });
  if (templateName.length > MAX_TEMPLATE_NAME) return res.status(400).json({ error: 'template_name te lang' });
  const variables = rawVars.map(v => String(v == null ? '' : v).slice(0, MAX_VAR_LEN));
  const leegIdx = variables.findIndex(v => v.trim() === '');
  if (leegIdx >= 0) {
    return res.status(400).json({
      error: `Variabele #${leegIdx + 1} is leeg — vul alle variabelen in voordat je de template verstuurt.`,
      leeg_index: leegIdx,
    });
  }

  try {
    const lijn = await haalLijn();
    if (!lijn.phoneNumberId) return res.status(409).json({ error: 'Geen WhatsApp-lijn ingesteld' });

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id')
      .eq('id', convId).maybeSingle();
    if (convErr) throw convErr;
    if (!conv) return res.status(404).json({ error: 'Gesprek niet gevonden' });
    if (String(conv.phone_number_id) !== String(lijn.phoneNumberId)) {
      return res.status(403).json({ error: 'Gesprek hoort niet bij de leadsonderhoud-lijn' });
    }

    let metaResult;
    try {
      metaResult = await sendTemplate({
        to: conv.phone_number, templateName, languageCode: language, variables,
        phoneNumberId: conv.phone_number_id || lijn.phoneNumberId,
      });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({ error: 'Meta WhatsApp niet geconfigureerd', missing: metaErr.missing });
      }
      console.error('[ls-gesprek-template] Meta-fout (conv):', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nu = new Date().toISOString();
    const templateVarsMap = variables.length
      ? Object.fromEntries(variables.map((v, i) => [String(i + 1), String(v ?? '')]))
      : null;
    let renderedBody = null;
    try {
      const preview = await renderTemplatePreview({ templateName, templateVariables: templateVarsMap, supabase: supabaseAdmin });
      if (preview && preview.source === 'meta_template' && preview.body) renderedBody = preview.body;
    } catch (e) {
      console.warn('[ls-gesprek-template] renderTemplatePreview soft-fail (conv):', e?.message || e);
    }

    const inDraad = await logInConv(conv.id, { user, wamid, templateName, templateVarsMap, renderedBody, nu, tag: 'conv' });

    return res.status(200).json({ ok: true, wamid, in_draad: inDraad });
  } catch (e) {
    console.error('[ls-gesprek-template] fout (conv):', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Template versturen mislukt' });
  }
}

// Uitgaand sjabloon in een bekend gesprek zetten + de lijst-preview bijwerken.
// supabase-js gooit niet bij een DB-fout maar geeft { error } terug — dus
// expliciet checken (de oude try/catch ving niets). -> true als het bericht staat.
async function logInConv(convId, { user, wamid, templateName, templateVarsMap, renderedBody, nu, tag }) {
  try {
    const { error: insErr } = await supabaseAdmin.from('whatsapp_messages').insert({
      conversation_id: convId, direction: 'out', meta_wamid: wamid,
      template_name: templateName, template_variables: templateVarsMap,
      body: renderedBody || '', status: 'queued', sent_at: nu, sent_by_user_id: user.id,
    });
    if (insErr) {
      console.error('[ls-gesprek-template] bericht in draad zetten mislukt (' + tag + '):', { conv: convId, fout: insErr.message });
      return false;
    }
    const { error: updErr } = await supabaseAdmin.from('whatsapp_conversations').update({
      last_message_at: nu,
      last_message_preview: (renderedBody || ('template: ' + templateName)).slice(0, 120),
    }).eq('id', convId);
    if (updErr) console.error('[ls-gesprek-template] gesprek-preview bijwerken mislukt (' + tag + '):', { conv: convId, fout: updErr.message });
    return true;
  } catch (e) {
    console.error('[ls-gesprek-template] draad-log faalde (' + tag + '):', { conv: convId, fout: e?.message || e });
    return false;
  }
}
