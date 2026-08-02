// api/wanbetalers-sandbox-send-test-template.js
//
// POST { template_id } → stuur 1 dunning-template (mail of WhatsApp) naar de
// sandbox-test-persoon. GEBRUIKT DE ECHTE EXECUTOR-PADEN uit
// api/_lib/dunning-step-executors.js — dus als deze test slaagt, werkt de
// echte klant-verzending óók (zelfde renderTemplate, zelfde
// buildMetaTemplateVariables, zelfde assertRecipientMatchesSandbox, zelfde
// dry-run gedrag, zelfde payment-link pre-fetch).
//
// De executor-functies (executeEmailStep / executeWhatsappStep) doen zelf al:
//   • sandbox-guard (assertRecipientMatchesSandbox) — verplicht match met
//     app_settings.dunning_sandbox_contact als customer.is_test=true
//   • dry-run short-circuit (isDryRunEnabled → geen echte send, wel log-event)
//   • Meta credentials check / SMTP infra check
//
// Wij hoeven dus alleen:
//   1) sandbox-klant + test-facturen op te halen (is_test scope),
//   2) een "step-shape" object te bouwen met { config: { template_id } },
//   3) executeEmailStep of executeWhatsappStep aan te roepen (auto-detect via
//      template.kind),
//   4) resultaat door te geven aan de UI.
//
// GEEN wijziging aan productie-executor. Wij importeren 'em read-only.
//
// Super_admin only. Payload:
//   { template_id: uuid, channel?: 'auto'|'whatsapp'|'email' }
//   channel default 'auto' → volgt template.kind. Als caller channel expliciet
//   opgeeft moet 't matchen met template.kind — anders 400.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';
import { executeEmailStep, executeWhatsappStep } from './_lib/dunning-step-executors.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const templateId    = typeof body.template_id === 'string' ? body.template_id.trim() : '';
  const requestedChan = typeof body.channel === 'string' ? body.channel.trim().toLowerCase() : 'auto';
  if (!templateId) return res.status(400).json({ error: 'template_id is verplicht' });
  if (!['auto', 'whatsapp', 'email'].includes(requestedChan)) {
    return res.status(400).json({ error: `channel moet 'auto'|'whatsapp'|'email' zijn, kreeg '${requestedChan}'` });
  }

  try {
    // ── 1) Sandbox-klant met defense-in-depth is_test-check ──────────────
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen sandbox-test-persoon gevonden — seed eerst.' });
    if (customer.is_test !== true) {
      return res.status(500).json({ error: 'SANDBOX_GUARD_FAILED: sandbox-klant heeft is_test !== true.' });
    }

    // ── 2) Template ophalen (kind + basisvelden) ─────────────────────────
    const { data: tpl, error: tplErr } = await supabaseAdmin
      .from('dunning_templates')
      .select('id, name, kind, subject, meta_template_name, is_active')
      .eq('id', templateId)
      .maybeSingle();
    if (tplErr) return res.status(500).json({ error: 'template fetch: ' + tplErr.message });
    if (!tpl)   return res.status(404).json({ error: `template ${templateId} niet gevonden` });
    if (!tpl.is_active) return res.status(400).json({ error: `template '${tpl.name}' is niet actief` });
    if (!['email', 'whatsapp'].includes(tpl.kind)) {
      return res.status(400).json({ error: `template kind='${tpl.kind}' wordt niet ondersteund door dit endpoint (alleen email/whatsapp)` });
    }
    if (requestedChan !== 'auto' && requestedChan !== tpl.kind) {
      return res.status(400).json({
        error: `channel='${requestedChan}' matcht niet met template.kind='${tpl.kind}' (id=${templateId})`,
      });
    }

    // ── 3) Test-facturen van de sandbox-klant — HARDE is_test-scope ──────
    // Als er geen open test-facturen zijn, mag de send toch doorgaan (de
    // executor rendert dan een template zonder factuur-context). We loggen
    // dat expliciet in het resultaat zodat de UI 'em kan tonen.
    const { data: invRows } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, credited_amount, status, due_date, issue_date, payment_url, is_test, customer_id')
      .eq('customer_id', customer.id)
      .eq('is_test', true)
      .in('status', OPEN_STATUSES);
    const openInvoices = Array.isArray(invRows) ? invRows : [];

    // ── 4) "step-shape" object bouwen zoals de engine 'em zou geven ─────
    // De executor leest step.config.template_id — de rest van step is niet
    // gebruikt in de code-paden die wij aanroepen. run wordt alleen doorge-
    // geven aan sub-log-payloads (message_id extraction); mag null zijn.
    const stepShape = { config: { template_id: templateId } };
    const runShape  = { id: null, customer_id: customer.id };

    // ── 5) Executor aanroepen — ECHT dezelfde code als productie-cron ────
    const dryBefore = await isDryRunEnabled();
    let execResult;
    try {
      if (tpl.kind === 'email') {
        execResult = await executeEmailStep({
          supabaseAdmin,
          run:          runShape,
          step:         stepShape,
          customer,
          openInvoices,
        });
      } else {
        execResult = await executeWhatsappStep({
          supabaseAdmin,
          run:          runShape,
          step:         stepShape,
          customer,
          openInvoices,
        });
      }
    } catch (execErr) {
      return res.status(500).json({
        ok:         false,
        error:      'executor threw: ' + (execErr?.message || execErr),
        template:   { id: tpl.id, name: tpl.name, kind: tpl.kind, meta_template_name: tpl.meta_template_name },
        dry_run:    dryBefore,
      });
    }

    // ── 6) Response — expliciet succes/fail + hint ──────────────────────
    // Executor gebruikt status 'ok' / 'failed' / 'skipped'. We geven alles
    // door zodat de UI zelf kan tonen wat er gebeurde.
    const status = execResult?.status || 'unknown';
    const successful = (status === 'ok');
    const payload = execResult?.log_payload || {};
    const hint = _hintForResult(status, execResult?.log_event, payload);

    return res.status(200).json({
      ok:           successful,
      status,
      dry_run:      dryBefore,
      template:     { id: tpl.id, name: tpl.name, kind: tpl.kind, meta_template_name: tpl.meta_template_name },
      log_event:    execResult?.log_event || null,
      log_payload:  payload,
      // Convenience-velden voor de UI:
      message_id:   payload.message_id || null,
      wamid:        payload.meta_wamid || payload.wamid || null,
      to:           payload.to || null,
      subject:      payload.subject || null,
      error:        payload.error || null,
      reason:       payload.reason || null,
      hint,
      customer_id:  customer.id,
      open_invoice_count: openInvoices.length,
    });
  } catch (e) {
    console.error('[sandbox-send-test-template]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// Bouwt een korte hint voor de UI op basis van status/log_event.
// Puur voor gebruiksgemak — UI kan ook payload zelf renderen.
function _hintForResult(status, logEvent, payload) {
  if (status === 'ok') {
    if (payload?.dry_run) return 'Dry-run: template gerenderd + guard OK; geen echte send.';
    if (payload?.meta_wamid && payload.meta_wamid !== 'dry-run') return `Echt verstuurd — Meta wamid: ${payload.meta_wamid}`;
    if (payload?.message_id  && payload.message_id  !== 'dry-run') return `Echt verstuurd — SMTP message-id: ${payload.message_id}`;
    return 'Verstuurd (geen id in payload).';
  }
  if (status === 'skipped') {
    if (logEvent === 'email_skipped_sandbox_guard' || logEvent === 'whatsapp_skipped_sandbox_guard') {
      return 'Geblokkeerd door recipient-guard: doel-adres matcht niet met sandbox-contact.';
    }
    if (logEvent === 'email_skipped_no_recipient')    return 'Test-klant heeft geen e-mailadres — save eerst een e-mail in sectie 1.';
    if (logEvent === 'whatsapp_skipped_no_recipient') return 'Test-klant heeft geen telefoonnummer — save eerst een nummer in sectie 1.';
    if (logEvent === 'email_skipped_no_infra')        return 'SMTP-infra niet beschikbaar (IMAP_PASS_INFO env?).';
    if (logEvent === 'whatsapp_skipped_no_credentials') return 'Meta WhatsApp credentials ontbreken in env.';
    if (logEvent === 'whatsapp_skipped_no_payment_link') return 'Template gebruikt {{factuur.betaal_link}} maar er is geen open factuur om link voor te fetchen.';
    return `Overgeslagen: ${logEvent || 'onbekende reden'}${payload?.reason ? ' — ' + payload.reason : ''}`;
  }
  if (status === 'failed') {
    return `Fout: ${payload?.error || logEvent || 'onbekend'}`;
  }
  return `Onbekende status: ${status}`;
}
