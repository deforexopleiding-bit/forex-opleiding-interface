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
//   { ok:true, wamid }
// Errors:
//   400 { error }                  — validatie
//   404 { error }                  — lead niet gevonden
//   403 { error }                  — lead niet in traject / geen rechten
//   409 { error }                  — geen WA-lijn / lead heeft geen telefoon
//   502 { error, meta_error }      — Meta API fout
//   503 { error, missing? }        — Meta niet geconfigureerd

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { haalLijn, trajectSlugs, normNummer } from './_lib/leadsonderhoud-gesprekken.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';

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
  const leadId       = String(body.lead_id || '').trim();
  const templateName = String(body.template_name || '').trim();
  const language     = String(body.language || 'nl').trim() || 'nl';
  const rawVars      = Array.isArray(body.variables) ? body.variables : [];

  if (!UUID_RE.test(leadId))              return res.status(400).json({ error: 'lead_id ontbreekt of ongeldig' });
  if (!templateName)                      return res.status(400).json({ error: 'template_name vereist' });
  if (templateName.length > MAX_TEMPLATE_NAME) return res.status(400).json({ error: 'template_name te lang' });

  // Normaliseer variables naar string-array, cap per waarde.
  const variables = rawVars.map(v => String(v == null ? '' : v).slice(0, MAX_VAR_LEN));

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

    // Zoek een bestaande WA-conv (voor logging + phone_number canoniek).
    // GEEN 24u-venster-check: templates mogen ook buiten venster.
    const { data: convs } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, last_inbound_at')
      .eq('phone_number_id', lijn.phoneNumberId)
      .limit(500);
    const doel = normNummer(lead.telefoon_e164);
    const conv = (convs || []).find((c) => normNummer(c.phone_number) === doel) || null;
    // Als er nog geen conv bestaat: Meta accepteert alsnog een template naar
    // een 'nieuw' nummer (opt-in-templates). We loggen zonder conversation_id.
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
    // = de gerenderde tekst (als we die kunnen bouwen; anders template-naam).
    // Hier laten we de body leeg vs. gerender-tekst aan de caller — server
    // heeft geen body_text van de template ingelezen (dat vraagt een extra
    // fetch die de flow niet nodig heeft). Frontend appent optimistisch met
    // de door hem gerenderde tekst.
    if (conv) {
      try {
        await supabaseAdmin
          .from('whatsapp_messages')
          .insert({
            conversation_id: conv.id,
            direction: 'out',
            meta_wamid: wamid,
            template_name: templateName,
            body: '', // template-body is voor de user-side; de gerenderde tekst zit optimistisch in de UI
            status: 'queued',
            sent_at: nu,
            sent_by_user_id: user.id,
          });
        await supabaseAdmin
          .from('whatsapp_conversations')
          .update({ last_message_at: nu, last_message_preview: 'template: ' + templateName })
          .eq('id', conv.id);
      } catch (e) {
        console.error('[ls-gesprek-template] log-insert soft-fail:', e?.message || e);
      }
    }

    // berichten_log (motor-log) — spiegel wat cron-leadsonderhoud doet zodat
    // deze template-send meetelt in de leadsonderhoud-log.
    try {
      await supabaseAdmin
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
          meta_template: templateName,
        });
    } catch (e) {
      console.warn('[ls-gesprek-template] berichten_log soft-fail:', e?.message || e);
    }

    return res.status(200).json({ ok: true, wamid });
  } catch (e) {
    console.error('[ls-gesprek-template] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Template versturen mislukt' });
  }
}
