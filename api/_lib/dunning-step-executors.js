// api/_lib/dunning-step-executors.js
//
// Step-executors voor de dunning workflow engine. Elke executor neemt context
// uit de cron (supabaseAdmin, run, step, customer, openInvoices) en geeft een
// uniform resultaat terug:
//   { status, log_event, log_payload }
//
// status:
//   "ok"      — actie geslaagd, ga naar volgende stap
//   "skipped" — actie bewust overgeslagen (bv. infra ontbreekt, geen email)
//   "failed"  — actie probeerde te draaien maar viel om; cron logt + telt error
//
// Logs worden door de cron weggeschreven in dunning_run_log (of vergelijkbaar).
//
// Email-strategie (recon-aanbeveling A): Hergebruik api/mailer.js sendMail +
// wrapEmailHtml. We importeren dynamisch zodat een ontbrekende env-var (test-
// omgeving zonder IMAP_PASS_INFO) de cron niet keihard crasht — bij missende
// infra valt deze terug op een "skipped" + log_event.
//
// WhatsApp-strategie (PR A2 + auto-conversation-create):
//   Zelfde patroon als email-executor: render → dry-run/sandbox-guard → send.
//   Meta-send via _lib/meta-whatsapp.js sendTemplate (hergebruik van joost-
//   outbound-send). Meta-templates mogen naar elk nummer (ook buiten 24u en
//   zonder voorgeschiedenis) — dus als er geen whatsapp_conversation bestaat
//   voor de klant, wordt er automatisch één aangemaakt (spiegel het inbox-
//   webhook upsertConversation-patroon). Persistence-pad is verplicht want
//   whatsapp_messages.conversation_id is NOT NULL. Zonder telefoonnummer of
//   meta_template_name: nette skip. Fail-soft: Meta-fout → 'failed'-status
//   per stap, hele run klapt NIET.
//
// LEIDEND pad voor WhatsApp-aanmaningen. joost-outbound-scheduler.js +
// joost-outbound-send.js zijn een historisch parallel-pad dat expliciet UIT
// staat (feature-flags e2_outbound_cron + e2_outbound_executor default false)
// met een harde conflict-guard om dubbele-send te voorkomen. Zie de
// conflict-headers in die twee bestanden.

import { renderTemplate, pickOldestInvoice } from './dunning-template-render.js';
import { ensureInvoicePaymentLink, InvoicePaymentLinkError } from './invoice-payment-link.js';

// Placeholder-regex: matcht zowel legacy HOOFDLETTER-keys ({{NAAM}},
// {{TOTAAL_BEDRAG}}) als nieuwe dot-notation ({{klant.voornaam}},
// {{factuur.nummer}}). Alignt met de regex-varianten in
// dunning-template-render.js (hoofdletter-pass) + template-variables.js
// (dot-pass).
const DUNNING_PLACEHOLDER_RE = /\{\{([A-Z][A-Z_]*|[a-z_]+\.[a-z_]+)\}\}/g;

/**
 * Bouw de positionele Meta-template-parameters uit de template-body zelf.
 *
 * De N-de UNIEKE placeholder (in volgorde van eerste voorkomen in de body)
 * wordt de N-de positionele parameter ({{N}}) die Meta bij goedkeuring
 * heeft vastgelegd. `variables_used` (van dunning-template-render) levert
 * de gerenderde waarden. Ontbrekende waarden → lege string zodat het
 * AANTAL kloppend blijft en Meta geen #132000 gooit.
 *
 * Dedupe = "unique keys, first-occurrence order". Als de body `{{voornaam}}`
 * twee keer bevat, sturen we 1 waarde (matcht een sensible Meta-template
 * die daarvoor 1 `{{1}}`-slot heeft hergebruikt).
 *
 * Bron van waarheid: `template.body`. Op dunning_templates bestaat GEEN
 * meta_param_mapping-kolom (die zit alleen op whatsapp_meta_templates),
 * dus body-scan is de enige route naar volgorde.
 *
 * PURE — geen DB, geen HTTP; unit-testbaar.
 *
 * @param {string|null|undefined} bodyText  template.body
 * @param {object|null|undefined} variablesUsed  rendered.variables_used
 * @returns {string[]}  positionele parameters (in volgorde)
 */
export function buildMetaTemplateVariables(bodyText, variablesUsed) {
  const body = String(bodyText || '');
  const vals = (variablesUsed && typeof variablesUsed === 'object') ? variablesUsed : {};
  const seen = new Set();
  const out  = [];
  DUNNING_PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = DUNNING_PLACEHOLDER_RE.exec(body))) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const v = Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : '';
    out.push(String(v == null ? '' : v));
  }
  return out;
}

async function loadTemplate(supabaseAdmin, templateId, expectedKind) {
  if (!templateId) {
    return { error: { code: 'no_template_id', message: 'step.config.template_id ontbreekt' } };
  }
  const { data, error } = await supabaseAdmin
    .from('dunning_templates')
    .select('id, name, kind, subject, body, meta_template_name, language, is_active')
    .eq('id', templateId)
    .maybeSingle();
  if (error) {
    return { error: { code: 'template_fetch_failed', message: error.message } };
  }
  if (!data) {
    return { error: { code: 'template_not_found', message: `Template ${templateId} niet gevonden` } };
  }
  if (expectedKind && data.kind !== expectedKind) {
    return { error: { code: 'template_kind_mismatch', message: `Template kind=${data.kind} expected=${expectedKind}` } };
  }
  return { template: data };
}

/**
 * Email-step: render template, verstuur via Strato SMTP (mailer.js).
 * Bij ontbrekende infra of geen klant-email → "skipped".
 */
export async function executeEmailStep({ supabaseAdmin, run, step, customer, openInvoices }) {
  const templateId = step?.config?.template_id;
  const { template, error: tplError } = await loadTemplate(supabaseAdmin, templateId, 'email');
  if (tplError) {
    return {
      status: 'skipped',
      log_event: 'email_skipped_template_error',
      log_payload: { template_id: templateId, ...tplError },
    };
  }

  const rendered = renderTemplate({
    body: template.body,
    subject: template.subject,
    customer,
    openInvoices,
  });

  const to = customer?.email;
  if (!to) {
    return {
      status: 'skipped',
      log_event: 'email_skipped_no_recipient',
      log_payload: {
        template_id: template.id,
        subject_rendered: rendered.subject,
        reason: 'Klant heeft geen email-adres',
      },
    };
  }

  // Dynamische import: bij ontbrekende IMAP_PASS_INFO valt mailer.js om bij
  // eerste sendMail-call. We vangen dat hier op als "skipped" i.p.v. "failed"
  // omdat het een infra-config issue is, geen runtime-bug per klant.
  let sendMail;
  let wrapEmailHtml;
  try {
    const mailer = await import('../mailer.js');
    sendMail = mailer.sendMail;
    wrapEmailHtml = mailer.wrapEmailHtml;
  } catch (e) {
    return {
      status: 'skipped',
      log_event: 'email_skipped_no_infra',
      log_payload: {
        template_id: template.id,
        subject_rendered: rendered.subject,
        body_rendered: rendered.body,
        to,
        reason: `mailer module load failed: ${e.message}`,
      },
    };
  }

  // ─── SANDBOX / DRY-RUN GUARDS ───────────────────────────────────────
  // 1) Als de globale dry-run vlag AAN staat → geen echte SMTP-call, wel
  //    het 'email_sent'-log-event zodat de rest van de flow (pipeline-
  //    trigger, workflow-status) normaal doorloopt.
  // 2) Als de klant is_test=true is: assert dat het doel-adres exact
  //    matcht met app_settings.dunning_sandbox_contact.email — anders
  //    abort. Zelfs zonder dry-run kan een test-mail dus nooit lekken.
  try {
    const { isDryRunEnabled, assertRecipientMatchesSandbox, buildDryRunLogPayload } =
      await import('./dunning-dry-run.js');
    if (customer?.is_test) {
      try {
        await assertRecipientMatchesSandbox({ isTest: true, actual: to, channel: 'email' });
      } catch (guardErr) {
        return {
          status: 'skipped',
          log_event: 'email_skipped_sandbox_guard',
          log_payload: { template_id: template.id, to, reason: guardErr.message },
        };
      }
    }
    if (await isDryRunEnabled()) {
      return {
        status: 'ok',
        log_event: 'email_sent',
        log_payload: {
          template_id: template.id,
          to,
          subject: rendered.subject,
          message_id: 'dry-run',
          variables_used: rendered.variables_used,
          ...buildDryRunLogPayload({
            channel: 'email',
            to,
            isTest: !!customer?.is_test,
            preview: { subject: rendered.subject, body: rendered.body.slice(0, 200) },
          }),
        },
      };
    }
  } catch (guardModuleErr) {
    // Fail-safe: als de guard-module niet laadt (bv. eerste deploy zonder
    // migratie 036), gedragen we ons alsof dry-run AAN staat en sturen NIET.
    console.warn('[dunning-executor] dry-run module niet beschikbaar → skip send', guardModuleErr?.message);
    return {
      status: 'ok',
      log_event: 'email_sent',
      log_payload: {
        template_id: template.id,
        to,
        subject: rendered.subject,
        message_id: 'dry-run-fallback',
        variables_used: rendered.variables_used,
        dry_run: true,
        fallback: 'guard_module_unavailable',
      },
    };
  }

  try {
    // Klant-facing footer: dit is een aanmaning van De Forex Opleiding zelf,
    // niet iets van de agency-tooling. Default footer ("Agency Command
    // Center — Follow-up Module") is voor interne modules; dunning-mails
    // krijgen een eigen, klant-gerichte footer.
    const html = wrapEmailHtml(
      rendered.subject,
      escapeBodyToHtml(rendered.body),
      {
        footerHtml:
          '<p style="margin:0; color:#6b7280; font-size:12px;">' +
          'De Forex Opleiding NL B.V.<br>' +
          'administratie@deforexopleiding.nl' +
          '</p>',
      },
    );
    // Verstuur vanaf administratie@ (i.p.v. default info@). Strato SMTP-
    // transport blijft op het info@-account (auth), header From: krijgt
    // administratie@. Standaard SPF/DKIM domain-alignment blijft valide
    // (envelope-sender = info@ + header-From-domein = deforexopleiding.nl).
    // Werkt zolang Strato "send-as" voor dit domein-alias toestaat.
    const result = await sendMail({
      to,
      subject: rendered.subject,
      text: rendered.body,
      html,
      from:     'administratie@deforexopleiding.nl',
      fromName: 'De Forex Opleiding',
    });
    if (!result || !result.success) {
      return {
        status: 'failed',
        log_event: 'email_send_failed',
        log_payload: {
          template_id: template.id,
          to,
          error: result?.error || 'unknown',
        },
      };
    }
    return {
      status: 'ok',
      log_event: 'email_sent',
      log_payload: {
        template_id: template.id,
        to,
        subject: rendered.subject,
        message_id: result.messageId,
        variables_used: rendered.variables_used,
      },
    };
  } catch (e) {
    return {
      status: 'failed',
      log_event: 'email_send_exception',
      log_payload: {
        template_id: template.id,
        to,
        error: e.message,
      },
    };
  }
}

function escapeBodyToHtml(text) {
  if (!text) return '';
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Behoud newlines als <br> zodat plain-text templates leesbaar blijven.
  return `<div style="white-space:pre-wrap; line-height:1.5; color:#111;">${escaped}</div>`;
}

/**
 * Normaliseer een telefoonnummer naar E.164-plus-formaat (+316...). Identiek
 * aan events-send.js / onboarding-invite.js toE164Plus (intentioneel inline
 * i.p.v. import om de helper-graph plat te houden; bestaand patroon).
 */
function toE164Plus(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length < 8) return null;
  return '+' + digits;
}

/**
 * WhatsApp-step (PR A2 — echte send + auto-conversation-create):
 *   Zelfde flow-shape als executeEmailStep. Vereisten voor een echte send:
 *     1) template + template.meta_template_name (approved Meta-template naam);
 *     2) klant met telefoonnummer;
 *     3) whatsapp_conversation voor die klant (wordt automatisch aangemaakt
 *        als 'ie ontbreekt — Meta-templates mogen naar elk nummer, ook zonder
 *        voorgeschiedenis; de conversation is puur ons persist-pad);
 *     4) Meta credentials in env-vars.
 *   Bij missende vereisten → 'skipped' met specifiek log_event. Bij Meta-fout
 *   → 'failed' met foutcode; run-cron logt + telt maar de run klapt niet.
 *
 *   Named-variable resolve is (nog) NIET in dit pad: we sturen de POSITIONELE
 *   volgorde die joost-outbound-send óók gebruikt
 *   (NAAM|FACTUUR_NR|TOTAAL_BEDRAG|DAGEN_OVERDUE|VERVAL_DATUM), zodat de
 *   dunning-templates die vandaag geseed zijn 1:1 werken. De meta_param_mapping-
 *   route uit inbox-send-template.js is een parallel-pad voor whatsapp_meta_
 *   templates; migratie richting die richting hoort in latere PR (mapping op
 *   dunning_templates ontbreekt vandaag als kolom).
 *
 * Volgorde-keuze (BEARGUMENTEERD):
 *   De dry-run-check zit BEWUST vóór de conv-lookup+create. Reden: dry-run
 *   mag GEEN DB-write doen, dus we willen 'm laten early-returnen vóór de
 *   auto-create (dat is een INSERT). Als we conv-create eerst zouden doen
 *   zou 'ie óók moeten worden geskipt in dry-run — dan hebben we per-check
 *   een dry-run-branch nodig. Deze volgorde geeft één schone early-return
 *   in dry-run met een nette "zou verstuurd worden naar <customerPhone>"-
 *   log; de conv-lookup gebeurt alleen op het live-pad waar 'ie relevant is.
 *   De sandbox-guard blijft óók vóór dry-run — die is een safeguard tegen
 *   data-leak en werkt op customerPhone, geen conv nodig.
 *
 * Dry-run + sandbox-guard: identiek aan email-executor (zie r104-161).
 */
export async function executeWhatsappStep({ supabaseAdmin, run, step, customer, openInvoices }) {
  const templateId = step?.config?.template_id;
  const { template, error: tplError } = await loadTemplate(supabaseAdmin, templateId, 'whatsapp');
  if (tplError) {
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_template_error',
      log_payload: { template_id: templateId, ...tplError },
    };
  }

  // ── Betaal-link pre-fetch (fail-CLOSED) ──────────────────────────────
  // renderTemplate is synchroon; template-variables.js resolveVariables
  // leest invoice.payment_url voor {{factuur.betaal_link}} maar fetcht 'em
  // NIET zelf. Wij vullen 'em VÓÓR de render via ensureInvoicePaymentLink
  // (zelfde pattern als inbox-send-template.js r375).
  //
  // Fail-CLOSED: als de body de placeholder gebruikt maar we kunnen geen
  // link ophalen, sturen we het bericht NIET — een leeg link-slot geeft
  // Meta #132000 of een kaal bericht met "…te betalen ." Skip + log
  // zodat een mens 't opvangt via Open Acties.
  const bodyStr = String(template.body || '');
  if (bodyStr.includes('{{factuur.betaal_link}}')) {
    const oudsteInvoice = pickOldestInvoice(Array.isArray(openInvoices) ? openInvoices : []);
    if (!oudsteInvoice?.id) {
      return {
        status: 'skipped',
        log_event: 'whatsapp_skipped_no_payment_link',
        log_payload: {
          template_id: template.id,
          meta_template_name: template.meta_template_name,
          reason: 'template gebruikt {{factuur.betaal_link}} maar er is geen open invoice om een link voor te fetchen',
        },
      };
    }
    try {
      const linkResult = await ensureInvoicePaymentLink(oudsteInvoice.id);
      if (linkResult && linkResult.payment_url) {
        oudsteInvoice.payment_url = linkResult.payment_url;
      } else {
        return {
          status: 'skipped',
          log_event: 'whatsapp_skipped_no_payment_link',
          log_payload: {
            template_id: template.id,
            meta_template_name: template.meta_template_name,
            invoice_id: oudsteInvoice.id,
            reason: 'ensureInvoicePaymentLink leverde geen payment_url',
          },
        };
      }
    } catch (linkErr) {
      const code = linkErr instanceof InvoicePaymentLinkError ? linkErr.code : 'UNKNOWN';
      console.warn('[dunning-executor whatsapp] payment-link fetch fail:', oudsteInvoice.id, code, linkErr?.message);
      return {
        status: 'skipped',
        log_event: 'whatsapp_skipped_no_payment_link',
        log_payload: {
          template_id: template.id,
          meta_template_name: template.meta_template_name,
          invoice_id: oudsteInvoice.id,
          reason: 'ensureInvoicePaymentLink fout: ' + code + ' — ' + (linkErr?.message || 'onbekend'),
        },
      };
    }
  }

  const rendered = renderTemplate({
    body: template.body,
    subject: template.subject,
    customer,
    openInvoices,
  });

  // Meta-template NAAM verplicht — approved template in Meta Business Manager.
  // Zonder: nette skip, Jeffrey koppelt eerst.
  if (!template.meta_template_name) {
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_no_meta_template',
      log_payload: {
        template_id: template.id,
        body_rendered: rendered.body,
        reason: 'template.meta_template_name is leeg - koppel eerst een goedgekeurde Meta-template',
      },
    };
  }

  // Supplemental customer-fetch: de dunning-engine SELECT bevat vandaag géén
  // `phone` en géén `is_test` (zie dunning-engine.js fetchCustomerOnly r770-
  // 772). Zonder deze kolommen kan de executor geen telefoonnummer bepalen en
  // faalt de is_test-sandbox-guard silently. We laten de engine byte-identiek
  // (BEHOUD-eis) en halen de missende velden hier zelf op als ze ontbreken.
  // Fail-soft: bij lookup-fout gaan we door met wat we hebben.
  let customerPhone = customer?.phone || null;
  let customerIsTest = customer?.is_test === true;
  if (customer?.id && (customerPhone === undefined || customerPhone === null || customer?.is_test === undefined)) {
    try {
      const { data: extra, error: extraErr } = await supabaseAdmin
        .from('customers')
        .select('phone, is_test')
        .eq('id', customer.id)
        .maybeSingle();
      if (extraErr) {
        console.warn('[dunning-executor whatsapp] customer supplemental fetch fail:', extraErr.message);
      } else if (extra) {
        if (!customerPhone) customerPhone = extra.phone || null;
        if (customer?.is_test === undefined) customerIsTest = extra.is_test === true;
      }
    } catch (e) {
      console.warn('[dunning-executor whatsapp] customer supplemental exception:', e?.message);
    }
  }

  // Klant-telefoon verplicht.
  if (!customerPhone) {
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_no_phone',
      log_payload: {
        template_id: template.id,
        meta_template_name: template.meta_template_name,
        body_rendered: rendered.body,
        reason: 'Klant heeft geen telefoonnummer',
      },
    };
  }

  // ─── SANDBOX / DRY-RUN GUARDS ───────────────────────────────────────
  // Geplaatst vóór de conv-lookup+create zodat dry-run géén DB-write triggert
  // (zie volgorde-argumentatie in JSDoc). Gebruikt customerPhone als to-adres
  // voor het dry-run log — geen conv-info want die is nog niet opgezocht.
  try {
    const { isDryRunEnabled, assertRecipientMatchesSandbox, buildDryRunLogPayload } =
      await import('./dunning-dry-run.js');
    if (customerIsTest) {
      try {
        await assertRecipientMatchesSandbox({ isTest: true, actual: customerPhone, channel: 'whatsapp' });
      } catch (guardErr) {
        return {
          status: 'skipped',
          log_event: 'whatsapp_skipped_sandbox_guard',
          log_payload: {
            template_id: template.id,
            meta_template_name: template.meta_template_name,
            to: customerPhone,
            reason: guardErr.message,
          },
        };
      }
    }
    if (await isDryRunEnabled()) {
      return {
        status: 'ok',
        log_event: 'whatsapp_sent',
        log_payload: {
          template_id: template.id,
          meta_template_name: template.meta_template_name,
          conversation_id: null,
          to: customerPhone,
          message_id: 'dry-run',
          meta_wamid: 'dry-run',
          variables_used: rendered.variables_used,
          ...buildDryRunLogPayload({
            channel: 'whatsapp',
            to: customerPhone,
            isTest: customerIsTest,
            preview: { body: rendered.body.slice(0, 200) },
          }),
        },
      };
    }
  } catch (guardModuleErr) {
    // Fail-safe: guard-module niet beschikbaar → gedraag ons alsof dry-run
    // AAN staat en stuur NIET. Zelfde defensieve keuze als email-executor.
    console.warn('[dunning-executor whatsapp] dry-run module niet beschikbaar → skip send', guardModuleErr?.message);
    return {
      status: 'ok',
      log_event: 'whatsapp_sent',
      log_payload: {
        template_id: template.id,
        meta_template_name: template.meta_template_name,
        conversation_id: null,
        to: customerPhone,
        message_id: 'dry-run-fallback',
        meta_wamid: 'dry-run-fallback',
        variables_used: rendered.variables_used,
        dry_run: true,
        fallback: 'guard_module_unavailable',
      },
    };
  }

  // ─── LIVE META-SEND ───────────────────────────────────────────────
  // Meta-config check → nette skip bij ontbrekende env-vars (fail-soft).
  let sendTemplate;
  let MetaNotConfiguredError;
  let getConfigStatus;
  try {
    const metaMod = await import('./meta-whatsapp.js');
    sendTemplate = metaMod.sendTemplate;
    MetaNotConfiguredError = metaMod.MetaNotConfiguredError;
    getConfigStatus = metaMod.getConfigStatus;
  } catch (e) {
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_no_meta_module',
      log_payload: {
        template_id: template.id,
        meta_template_name: template.meta_template_name,
        to: customerPhone,
        reason: `meta-whatsapp module load failed: ${e.message}`,
      },
    };
  }
  const cfgStatus = getConfigStatus();
  if (!cfgStatus.configured) {
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_no_meta_config',
      log_payload: {
        template_id: template.id,
        meta_template_name: template.meta_template_name,
        to: customerPhone,
        reason: 'Meta WhatsApp niet geconfigureerd',
        missing: cfgStatus.missing,
      },
    };
  }

  // ─── OUTBOUND phone_number_id (finance-lijn uit module-config) ─────
  // Nodig zowel voor de conv-INSERT (nieuwe conv koppelt aan deze lijn) als
  // voor de sendTemplate-call. We halen 'em VOOR de conv-lookup omdat de
  // lookup-fallback op tuple (phone_number, phone_number_id) matcht en dus
  // de finance-lijn nodig heeft.
  let outboundPnId = undefined;
  try {
    const { data: modCfg, error: modErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'finance')
      .eq('is_active', true)
      .maybeSingle();
    if (!modErr && modCfg?.phone_number_id) {
      outboundPnId = modCfg.phone_number_id;
    }
  } catch (e) {
    console.warn('[dunning-executor whatsapp] module-config exception:', e?.message);
  }

  // ─── CONVERSATION lookup + auto-create ─────────────────────────────
  // Zoek/maak een whatsapp_conversation zodat we het outbound-template kunnen
  // persistieren (whatsapp_messages.conversation_id NOT NULL). Sinds de fix
  // "actuele phone + finance-lijn" GEEN customer_id-lookup meer — die pakte
  // de meest-recente conv van de klant, die op een OUDER nummer of ANDERE
  // lijn kon staan (bv. Lisa-lijn) en zo de rest van de send saboteerde
  // (verkeerd to-nummer + verkeerde outbound-lijn).
  //
  // Twee stappen:
  //   1) SELECT op EXACT tuple (phone_number=phoneE164Plus,
  //      phone_number_id=outboundPnId). Bevestigt de finance-thread.
  //      Losse tuple-conv zonder customer_id → best-effort koppelen.
  //   2) Niet gevonden → INSERT nieuwe conv op ditzelfde tuple (spiegel
  //      webhook-insertPayload). Race-safe: 23505 unique-violation →
  //      re-SELECT.
  //
  // Effect: klanten met een oudere conv op ander nummer/lijn krijgen een
  // NIEUWE conv-rij op het correcte finance-tuple. Oude conv blijft
  // ongewijzigd (historisch archief).
  const phoneE164Plus = toE164Plus(customerPhone);
  if (!phoneE164Plus) {
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_no_phone',
      log_payload: {
        template_id: template.id,
        meta_template_name: template.meta_template_name,
        to: customerPhone,
        reason: `Telefoonnummer '${customerPhone}' kon niet naar E.164 worden genormaliseerd (te kort of geen digits)`,
      },
    };
  }
  let conv = null;
  // Stap 1: SELECT op het correcte tuple (phoneE164Plus × finance-lijn).
  if (outboundPnId) {
    try {
      const { data: convRow, error: convErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .select('id, customer_id, phone_number, phone_number_id')
        .eq('phone_number', phoneE164Plus)
        .eq('phone_number_id', outboundPnId)
        .maybeSingle();
      if (convErr) {
        console.warn('[dunning-executor whatsapp] conv tuple-lookup fail:', convErr.message);
      } else if (convRow) {
        conv = convRow;
        // Best-effort: koppel losse tuple-conv aan klant.
        if (customer?.id && !conv.customer_id) {
          try {
            await supabaseAdmin
              .from('whatsapp_conversations')
              .update({ customer_id: customer.id })
              .eq('id', conv.id)
              .is('customer_id', null);
            conv.customer_id = customer.id;
          } catch (e) {
            console.warn('[dunning-executor whatsapp] conv link fail:', e?.message);
          }
        }
      }
    } catch (e) {
      console.warn('[dunning-executor whatsapp] conv tuple exception:', e?.message);
    }
  }
  // Stap 2: INSERT nieuwe conv (auto-create) op het correcte tuple.
  if (!conv) {
    if (!outboundPnId) {
      return {
        status: 'skipped',
        log_event: 'whatsapp_skipped_no_outbound_line',
        log_payload: {
          template_id: template.id,
          meta_template_name: template.meta_template_name,
          to: phoneE164Plus,
          reason: 'Geen outbound phone_number_id: whatsapp_module_config voor module=finance ontbreekt of is_active=false',
        },
      };
    }
    const nowIso = new Date().toISOString();
    const insertPayload = {
      phone_number:         phoneE164Plus,
      phone_number_id:      outboundPnId,
      display_name:         null,
      customer_id:          customer?.id || null,
      status:               'open',
      last_message_at:      nowIso,
      last_message_preview: null,
      unread_count:         0,
      last_inbound_at:      null,
    };
    try {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('whatsapp_conversations')
        .insert(insertPayload)
        .select('id, customer_id, phone_number, phone_number_id')
        .single();
      if (insErr) {
        // Race: andere caller insertte intussen (of pre-existing rij die stap 2
        // om een of andere reden niet zag). Re-SELECT met dezelfde tuple.
        if (insErr.code === '23505') {
          const { data: again, error: againErr } = await supabaseAdmin
            .from('whatsapp_conversations')
            .select('id, customer_id, phone_number, phone_number_id')
            .eq('phone_number', phoneE164Plus)
            .eq('phone_number_id', outboundPnId)
            .maybeSingle();
          if (againErr || !again) {
            console.warn('[dunning-executor whatsapp] conv race re-select fail:', againErr?.message || 'no row');
          } else {
            conv = again;
          }
        } else {
          console.warn('[dunning-executor whatsapp] conv insert fail:', insErr.message);
        }
      } else if (inserted) {
        conv = inserted;
      }
    } catch (e) {
      console.warn('[dunning-executor whatsapp] conv insert exception:', e?.message);
    }
  }
  if (!conv) {
    // Zowel tuple-lookup als auto-insert faalden — skip fail-soft (run klapt niet).
    return {
      status: 'skipped',
      log_event: 'whatsapp_skipped_conv_create_failed',
      log_payload: {
        template_id: template.id,
        meta_template_name: template.meta_template_name,
        to: phoneE164Plus,
        outbound_phone_number_id: outboundPnId || null,
        reason: 'Kon geen whatsapp_conversation vinden of aanmaken (zie warnings hierboven)',
      },
    };
  }

  // Verzendnummer + lijn zijn autoritatief bepaald VÓÓR de conv-lookup:
  //   - sendTo         = phoneE164Plus (uit customers.phone, genormaliseerd)
  //   - phoneNumberId  = outboundPnId (finance-lijn uit whatsapp_module_config)
  // We overschrijven ze bewust NIET met conv.phone_number / .phone_number_id —
  // een oude conv op ander nummer / andere lijn mocht eerder de rest van de
  // flow saboteren (verkeerd nummer, verkeerde outbound-lijn). De conv is
  // hier puur persist-target voor whatsapp_messages.conversation_id, niet
  // de bron van het adres. Zie tuple-lookup hierboven.
  const sendTo = phoneE164Plus;

  // Positionele Meta-parameters — afgeleid uit de template-body zelf zodat
  // AANTAL en VOLGORDE matchen wat Meta bij goedkeuring vastlegde. Werkt
  // voor legacy hoofdletter-keys ({{NAAM}}, {{TOTAAL_BEDRAG}}) én nieuwe
  // dot-notation ({{klant.voornaam}}, {{klant.totaal_open}}, …). Zie
  // buildMetaTemplateVariables() bovenaan dit bestand.
  //
  // Waarom niet de oude 5-key hardcoded filter? Dat brak zodra een template
  // dot-notation gebruikte (klant.*/factuur.*) — 0 params meegestuurd terwijl
  // Meta N verwachtte → #132000 "Number of parameters does not match".
  const variables = buildMetaTemplateVariables(template.body, rendered.variables_used || {});

  let metaResult;
  try {
    metaResult = await sendTemplate({
      to:            sendTo,
      templateName:  template.meta_template_name,
      languageCode:  template.language || 'nl',
      variables,
      phoneNumberId: outboundPnId,
    });
  } catch (metaErr) {
    // MetaNotConfiguredError → skipped (config), niet failed (send-poging).
    if (metaErr instanceof MetaNotConfiguredError) {
      return {
        status: 'skipped',
        log_event: 'whatsapp_skipped_no_meta_config',
        log_payload: {
          template_id: template.id,
          meta_template_name: template.meta_template_name,
          conversation_id: conv.id,
          to: sendTo,
          reason: 'Meta WhatsApp niet geconfigureerd (runtime)',
          missing: metaErr.missing,
        },
      };
    }
    // Alle overige Meta-fouten → 'failed' met gestructureerde codes.
    // Fail-soft op executor-niveau: cron logt + telt, run gaat verder.
    return {
      status: 'failed',
      log_event: 'whatsapp_send_failed',
      log_payload: {
        template_id: template.id,
        meta_template_name: template.meta_template_name,
        conversation_id: conv.id,
        to: sendTo,
        error: metaErr?.message || 'unknown',
        meta_code: metaErr?.metaCode ?? null,
        meta_subcode: metaErr?.metaSubcode ?? null,
        meta_message: metaErr?.metaMessage ?? null,
        meta_fbtrace: metaErr?.metaFbtrace ?? null,
        http_status: metaErr?.httpStatus ?? null,
      },
    };
  }

  const wamid = metaResult?.wamid ? String(metaResult.wamid) : null;
  const sentAt = new Date().toISOString();

  // Persist in whatsapp_messages zodat de chat-history de outbound toont.
  // Fail-soft: als insert faalt is de Meta-send al gebeurd — log warning maar
  // return 'ok' zodat de workflow doorloopt (dubbele send is erger dan een
  // ontbrekende UI-row).
  const templateVarsForDb = variables.length
    ? Object.fromEntries(variables.map((v, i) => [String(i + 1), v]))
    : null;
  const previewBody = rendered.body ? String(rendered.body).slice(0, 1000) : null;
  let messageId = null;
  try {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert({
        conversation_id:    conv.id,
        direction:          'out',
        meta_wamid:         wamid,
        body:               previewBody,
        template_name:      template.meta_template_name,
        template_variables: templateVarsForDb,
        status:             'queued',
        sent_at:            sentAt,
        sent_by_user_id:    null,
      })
      .select('id')
      .single();
    if (insErr) {
      console.warn('[dunning-executor whatsapp] whatsapp_messages insert fail:', insErr.message);
    } else {
      messageId = inserted?.id || null;
    }
  } catch (e) {
    console.warn('[dunning-executor whatsapp] whatsapp_messages exception:', e?.message);
  }

  // Conversation-preview updaten (fail-soft).
  try {
    const preview = ('[template] ' + template.meta_template_name).slice(0, 120);
    await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: sentAt, last_message_preview: preview })
      .eq('id', conv.id);
  } catch (e) {
    console.warn('[dunning-executor whatsapp] conv update exception:', e?.message);
  }

  return {
    status: 'ok',
    log_event: 'whatsapp_sent',
    log_payload: {
      template_id: template.id,
      meta_template_name: template.meta_template_name,
      conversation_id: conv.id,
      to: sendTo,
      message_id: messageId,
      meta_wamid: wamid,
      variables_used: rendered.variables_used,
      phone_number_id: outboundPnId || null,
    },
  };
}

/**
 * Wait-step: pure no-op. De cron zelf bepaalt op basis van log_payload.days
 * wanneer de run weer mag draaien.
 */
export async function executeWaitStep({ run, step }) {
  return {
    status: 'ok',
    log_event: 'wait',
    log_payload: { days: step?.config?.days || 0 },
  };
}

/**
 * Task-step: maakt een echte taak aan in pending_actions (Fase 2a).
 *
 * Model-keuze: we hergebruiken de bestaande pending_actions-tabel met
 * action_type='MANUAL_FOLLOWUP' (uit api/_lib/task-types.js — categorie
 * 'arrangement', label 'Follow-up bericht'). Dat is bewust:
 *   - de tabel + het frontend Open Acties-dashboard renderen 'em al;
 *   - MANUAL_FOLLOWUP is expliciet bedoeld als "generieke follow-up
 *     die door een mens moet worden opgepakt" (zie task-types.js r47-51);
 *   - geen nieuwe migratie nodig.
 *
 * Config (step.config):
 *   title       (verplicht) — kop van de taak
 *   description (opt)       — vrije tekst
 *   assignee_role (opt)     — informatief; routing komt in later fase
 *
 * Dry-run: consistent met email/whatsapp-executor. In dry-run géén
 * pending_actions-INSERT, wel log_event='task_created' met dry_run:true
 * payload zodat de rest van de workflow-run normaal doorloopt.
 *
 * Fail-soft:
 *   config.title ontbreekt        → skipped 'task_skipped_no_title'
 *   customer.id ontbreekt         → skipped 'task_skipped_no_customer'
 *   dry-run module load faalt     → skipped 'task_skipped_no_guard' (fail-safe: geen insert)
 *   insert-fout                   → failed  'task_create_failed'
 * Een mislukte taak laat de workflow-run niet klappen — cron logt + telt.
 */
export async function executeTaskStep({ supabaseAdmin, run, step, customer, openInvoices }) {
  const cfg = step?.config || {};
  const rawTitle       = String(cfg.title || '').trim();
  const rawDescription = String(cfg.description || '').trim();
  const assigneeRole   = cfg.assignee_role ? String(cfg.assignee_role) : null;

  if (!rawTitle) {
    return {
      status: 'skipped',
      log_event: 'task_skipped_no_title',
      log_payload: {
        workflow_id: run?.workflow_id || null,
        step_id: step?.id || null,
        reason: 'step.config.title ontbreekt',
      },
    };
  }
  if (!customer?.id) {
    return {
      status: 'skipped',
      log_event: 'task_skipped_no_customer',
      log_payload: {
        workflow_id: run?.workflow_id || null,
        step_id: step?.id || null,
        reason: 'customer.id ontbreekt in run-context',
      },
    };
  }

  // Kies een aanleiding-factuur (eerste openstaande) — informatief in de
  // taak; niet leidend. Bewust: pending_actions.invoice_id is een FK die
  // Open Acties toont, dus we koppelen 'em zodat de admin direct de
  // context ziet. Bij geen open facturen: null.
  const firstInvoice = Array.isArray(openInvoices) && openInvoices.length
    ? openInvoices[0]
    : null;

  // ─── DRY-RUN DETECTIE (NIET blokkerend) ──────────────────────────
  // In tegenstelling tot email/whatsapp-executors doen we in dry-run
  // WEL de echte INSERT. Een taak is interne administratie (landt in
  // pending_actions -> Wanbetalers > Acties, dat testklanten server-
  // side uitfiltert via customers.is_test=false). Er gaat dus niks
  // richting de klant, en zonder INSERT is de keten workflow -> taak
  // -> badge niet testbaar.
  //
  // Wel markeren we de taak met payload.dry_run=true zodat sandbox-
  // gegenereerde rijen herkenbaar zijn (voor toekomstige selectieve
  // cleanup als CASCADE via customers-delete ooit onvoldoende blijkt).
  //
  // De log-event blijft dry_run:true tonen zodat duidelijk is dat de
  // run zelf in dry-run draaide.
  let dry = false;
  let buildDryRunLogPayload = null;
  try {
    const dryMod = await import('./dunning-dry-run.js');
    dry = await dryMod.isDryRunEnabled();
    buildDryRunLogPayload = dryMod.buildDryRunLogPayload;
  } catch (guardModuleErr) {
    // Guard-module niet beschikbaar → fail-safe: taak nog steeds NIET
    // aanmaken. Interne actie of niet, we willen bij infra-issues niets
    // stiekem doen. Consistent met email-executor (r144-161).
    console.warn('[dunning-executor task] dry-run module niet beschikbaar → skip insert', guardModuleErr?.message);
    return {
      status: 'skipped',
      log_event: 'task_skipped_no_guard',
      log_payload: {
        title:           rawTitle,
        customer_id:     customer.id,
        workflow_id:     run?.workflow_id || null,
        step_id:         step?.id || null,
        reason:          'dry-run guard module load failed: ' + (guardModuleErr?.message || 'unknown'),
        fallback:        'no_insert',
      },
    };
  }

  // ─── LIVE INSERT ──────────────────────────────────────────────────
  // Kind-derivation voor filter in Wanbetalers > Acties. Heuristiek op
  // title (moet matchen met backfill-migratie 2026-07-15-belmomenten-een-
  // bron-van-waarheid.sql). Nieuwe workflow-task-teksten die niet met
  // "Bel klant" / "Stuur WIK-14-dagenbrief" / "Stuur aangetekende brief"
  // beginnen krijgen kind='other' (fallback zodat de filter altijd werkt).
  let taskKind = 'other';
  if (/^Bel klant/i.test(rawTitle)) {
    taskKind = 'call';
  } else if (/^Stuur WIK-14-dagenbrief/i.test(rawTitle) || /^Stuur aangetekende brief/i.test(rawTitle)) {
    taskKind = 'letter';
  }

  // Skip-if-open-callback: als er voor deze klant een openstaande terugbel-
  // afspraak (kind='call', source='callback_appointment') in pending_actions
  // ligt, sla deze workflow-bel-taak over — de callback gaat voor.
  // Belangrijk: skippen mag geen duplicaat maken; workflow gaat door naar de
  // volgende step. Alleen wanneer taskKind='call' — brief/other blijven wel
  // vuren want dat is een ander soort actie.
  if (taskKind === 'call') {
    try {
      const { data: openCallback } = await supabaseAdmin
        .from('pending_actions')
        .select('id')
        .eq('customer_id', customer.id)
        .eq('action_type', 'MANUAL_FOLLOWUP')
        .in('status', ['PENDING', 'APPROVED'])
        .filter('payload->>kind', 'eq', 'call')
        .filter('payload->>source', 'eq', 'callback_appointment')
        .limit(1);
      if (Array.isArray(openCallback) && openCallback.length > 0) {
        return {
          status: 'skipped',
          log_event: 'task_skipped_open_callback',
          log_payload: {
            title:       rawTitle,
            customer_id: customer.id,
            workflow_id: run?.workflow_id || null,
            step_id:     step?.id || null,
            reason:      'Er ligt al een openstaande terugbelafspraak voor deze klant — die gaat voor.',
          },
        };
      }
    } catch (e) {
      // Fail-soft: bij lookup-fout gaan we door met de workflow-taak.
      // Duplicatie in Acties (2 bel-taken) is minder erg dan ontbrekende
      // bel-taak omdat de heuristiek-check faalde.
      console.warn('[dunning-executor task] callback-lookup fail, continue:', e?.message);
    }
  }

  // action_type='MANUAL_FOLLOWUP' zodat de taak in Open Acties (categorie
  // 'arrangement') verschijnt. arrangement_id=NULL — deze taak is
  // workflow-driven, niet arrangement-driven.
  //
  // Dry-run marker: payload.dry_run=true als de globale dry-run vlag AAN
  // stond bij aanmaak. Sandbox-gegenereerde rijen zijn zo herkenbaar
  // zonder aparte tabel of aparte source-suffix. CASCADE via customers-
  // delete blijft de primaire cleanup (sandbox-reset delete is_test-klant).
  const payload = {
    title:           rawTitle,
    description:     rawDescription || null,
    assignee_role:   assigneeRole,
    source:          'dunning_workflow',
    kind:            taskKind,
    workflow_id:     run?.workflow_id || null,
    workflow_run_id: run?.id || null,
    step_id:         step?.id || null,
    rationale:       `Taak aangemaakt door dunning-workflow-step (run ${run?.id || '?'})`,
    ...(dry ? { dry_run: true } : {}),
  };
  const insertRow = {
    customer_id:         customer.id,
    arrangement_id:      null,
    invoice_id:          firstInvoice?.id || null,
    action_type:         'MANUAL_FOLLOWUP',
    status:              'PENDING',
    proposed_by_user_id: null, // cron
    payload,
  };
  try {
    const { data, error } = await supabaseAdmin
      .from('pending_actions')
      .insert(insertRow)
      .select('id, customer_id, action_type, status, invoice_id, created_at')
      .single();
    if (error) throw new Error(error.message);
    return {
      status: 'ok',
      log_event: 'task_created',
      log_payload: {
        title:             rawTitle,
        description:       rawDescription || null,
        assignee_role:     assigneeRole,
        pending_action_id: data.id,
        customer_id:       data.customer_id,
        action_type:       data.action_type,
        invoice_id:        data.invoice_id,
        workflow_id:       run?.workflow_id || null,
        workflow_run_id:   run?.id || null,
        step_id:           step?.id || null,
        dry_run:           dry,
        ...(dry && buildDryRunLogPayload
          ? buildDryRunLogPayload({
              channel: 'task',
              to:      customer.id,
              isTest:  !!customer?.is_test,
              preview: { title: rawTitle, description: rawDescription.slice(0, 200) },
            })
          : {}),
      },
    };
  } catch (e) {
    return {
      status: 'failed',
      log_event: 'task_create_failed',
      log_payload: {
        title:       rawTitle,
        customer_id: customer.id,
        workflow_id: run?.workflow_id || null,
        step_id:     step?.id || null,
        error:       e?.message || String(e),
      },
    };
  }
}

/**
 * Resume-dunning-step (Fase 2b): zet alle gepauzeerde runs van de klant
 * weer op 'active'. Bedoeld voor workflows met trigger_conditions
 * arrangement_breached=true — de klant is de betaalafspraak niet nagekomen,
 * dus de aanmaan-flow moet weer draaien.
 *
 * Design-keuze:
 *   - Hervat ALLE paused runs van de klant (niet alleen die door dit
 *     specifieke arrangement zijn gepauzeerd). Reden: als een klant meerdere
 *     opeenvolgende afspraken heeft gemaakt en telkens breekt, is 'de meest
 *     recente breach' de trigger — alle paused runs zijn achterhaald.
 *   - Reset paused_by_arrangement_id.
 *   - next_action_at = nu → de eerstvolgende engine-tick pakt 'em op.
 *
 * Dry-run: consistent met email/whatsapp/task-executor. In dry-run géén
 * status-flip; wel log_event='dunning_resumed' met dry_run:true payload.
 *
 * Fail-soft:
 *   - customer.id ontbreekt        → skipped 'dunning_resume_no_customer'
 *   - guard module load faalt      → skipped 'dunning_resume_no_guard' (fail-safe)
 *   - geen paused runs             → skipped 'dunning_resume_geen_paused_runs'
 *   - UPDATE-fout                  → failed  'dunning_resume_failed'
 */
export async function executeResumeDunningStep({ supabaseAdmin, run, step, customer }) {
  if (!customer?.id) {
    return {
      status: 'skipped',
      log_event: 'dunning_resume_no_customer',
      log_payload: {
        workflow_id: run?.workflow_id || null,
        step_id:     step?.id || null,
        reason:      'customer.id ontbreekt in run-context',
      },
    };
  }

  // ─── DRY-RUN DETECTIE (NIET blokkerend) ──────────────────────────
  // Status paused -> active is interne administratie (geen klantcommu-
  // nicatie). Consistent met cron-arrangements-breach-check (#757) die
  // status-flips in dry-run ook gewoon doet. Zonder deze flip is de
  // keten "arrangement verbroken -> workflow hervat" niet testbaar.
  let dry = false;
  let buildDryRunLogPayload = null;
  try {
    const dryMod = await import('./dunning-dry-run.js');
    dry = await dryMod.isDryRunEnabled();
    buildDryRunLogPayload = dryMod.buildDryRunLogPayload;
  } catch (guardModuleErr) {
    // Guard-module niet beschikbaar → status niet flippen. Consistent
    // met email-executor: bij infra-issues niets stiekem doen.
    console.warn('[dunning-executor resume] dry-run module niet beschikbaar → skip', guardModuleErr?.message);
    return {
      status: 'skipped',
      log_event: 'dunning_resume_no_guard',
      log_payload: {
        customer_id: customer.id,
        workflow_id: run?.workflow_id || null,
        step_id:     step?.id || null,
        reason:      'dry-run guard module load failed: ' + (guardModuleErr?.message || 'unknown'),
        fallback:    'no_resume',
      },
    };
  }

  // ─── LIVE (ook in dry-run) ────────────────────────────────────────
  try {
    const { resumeAllPausedRunsForCustomer } = await import('./dunning-arrangement-hooks.js');
    const res = await resumeAllPausedRunsForCustomer(customer.id);
    if (!res?.ok) {
      return {
        status: 'failed',
        log_event: 'dunning_resume_failed',
        log_payload: {
          customer_id: customer.id,
          workflow_id: run?.workflow_id || null,
          step_id:     step?.id || null,
          error:       res?.error || 'unknown',
        },
      };
    }
    const count = res.resumed_count || 0;
    if (count === 0) {
      return {
        status: 'skipped',
        log_event: 'dunning_resume_geen_paused_runs',
        log_payload: {
          customer_id: customer.id,
          workflow_id: run?.workflow_id || null,
          step_id:     step?.id || null,
          reason:      'Geen paused runs voor deze klant',
        },
      };
    }
    return {
      status: 'ok',
      log_event: 'dunning_resumed',
      log_payload: {
        customer_id:     customer.id,
        workflow_id:     run?.workflow_id || null,
        workflow_run_id: run?.id || null,
        step_id:         step?.id || null,
        resumed_count:   count,
        dry_run:         dry,
        ...(dry && buildDryRunLogPayload
          ? buildDryRunLogPayload({
              channel: 'resume_dunning',
              to:      customer.id,
              isTest:  !!customer?.is_test,
              preview: { resumed_count: count },
            })
          : {}),
      },
    };
  } catch (e) {
    return {
      status: 'failed',
      log_event: 'dunning_resume_failed',
      log_payload: {
        customer_id: customer.id,
        workflow_id: run?.workflow_id || null,
        step_id:     step?.id || null,
        error:       e?.message || String(e),
      },
    };
  }
}
