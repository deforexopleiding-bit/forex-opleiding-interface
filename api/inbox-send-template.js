// api/inbox-send-template.js
// POST → verzend een outbound WhatsApp-template via Meta Cloud API,
// specifiek voor de Inbox template-picker (C3/C4). Skipt 24h-window check
// (templates mogen altijd buiten 24u verzonden worden) en bouwt de Meta
// components-array op uit een simpel { "1": "...", "2": "..." } variables-
// object.
//
// Permission: finance.inbox.send OF events.simone.use (zelfde OR-patroon als
// inbox-send.js — events-hub template-picker hangt sinds stap 6c op dit
// endpoint zonder finance-rechten te hebben). Additief; finance-callers
// blijven byte-identiek.
//
// Body:
//   conversation_id     uuid    required
//   meta_template_id    text    optional — Meta-zijde template id (informational)
//   template_name       text    required
//   language            text    optional (default 'nl')
//   variables           object  optional — { "1": "Jeffrey", "2": "EUR 80,00" }
//                                body-placeholders {{1}}, {{2}}, ...
//   context_invoice_id  uuid    optional — bij named templates met factuur-vars
//                                (factuur.* / klant.factuur_*) gebruikt de server
//                                deze invoice-row als resolve-context.
//
// C4: send-time named variable resolution
//   Als de lokale template-row een `meta_param_mapping` heeft (jsonb, shape
//   { body: { "1": "klant.naam", "2": "factuur.bedrag_open" }, ... }), wordt
//   server-side de mapping toegepast: customer + (optionele) invoice + open
//   invoices worden opgezocht en de waarden geresolved via
//   _lib/template-variables.js. Caller-supplied `variables` worden in dat
//   geval genegeerd. Zonder mapping = legacy positioneel gedrag (variables
//   blijft autoritatief).
//
// Response: 200 { wamid, message_id, variables, warnings? }
//           400 { error } bij invalide input of ontbrekende invoice-context
//           404 { error: 'Conversation niet gevonden' }
//           502 { error, meta_error } bij Meta-API fout
//           503 { error, missing: [] } bij niet-geconfigureerde Meta
//
// NB: header- en button-variabelen worden in C3/C4 v1 nog NIET ondersteund —
// alleen mapping.body[N] wordt geresolved.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { sendTemplate, getConfigStatus, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { buildMetaVariablesFromMapping, AVAILABLE_VARIABLES } from './_lib/template-variables.js';
import { ensureInvoicePaymentLink, InvoicePaymentLinkError } from './_lib/invoice-payment-link.js';
import { getModuleContextByPhoneNumberId } from './_lib/module-context.js';
import { buildSendComponents } from './_lib/meta-template-components-builder.js';

const MEDIA_HEADER_TYPES = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
const RUNTIME_MEDIA_KINDS = new Set(['image', 'video', 'document']);
const URL_HTTPS_RE = /^https:\/\/[^\s]{8,2048}$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEMPLATE_NAME = 200;
const MAX_LANG = 16;
const MAX_VAR_VALUE = 1024; // per-parameter veiligheidskap

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  // FIX 3 — additief: events.simone.use ook accepteren (parallel met inbox-send.js).
  // Finance-callers met finance.inbox.send blijven byte-identiek werken
  // doordat we het bestaande pad als eerste evalueren.
  // B1 — onboarding.inbox.send als 3e additieve OR.
  const hasFinanceSend    = await requirePermission(req, 'finance.inbox.send');
  const hasSimoneUse      = hasFinanceSend ? true : await requirePermission(req, 'events.simone.use');
  const hasOnboardingSend = (hasFinanceSend || hasSimoneUse)
    ? true : await requirePermission(req, 'onboarding.inbox.send');
  if (!hasFinanceSend && !hasSimoneUse && !hasOnboardingSend) {
    return res.status(403).json({ error: 'Geen rechten (finance.inbox.send, events.simone.use of onboarding.inbox.send)' });
  }

  // Body parsing
  const body = req.body || {};
  const convId = String(body.conversation_id || '').trim();
  const metaTemplateId = body.meta_template_id != null
    ? String(body.meta_template_id).trim()
    : '';
  const templateName = String(body.template_name || '').trim();
  const language = String(body.language || 'nl').trim().toLowerCase() || 'nl';
  const variablesIn = body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables)
    ? body.variables
    : {};
  const contextInvoiceId = body.context_invoice_id != null
    ? String(body.context_invoice_id).trim()
    : '';
  // Events-hub: optionele attendee-context voor templates die attendee.*
  // of event.* vars gebruiken (keuze-link / event-titel / -datum etc.).
  // Wordt geresolved naar context.attendee + context.event en doorgegeven
  // aan buildMetaVariablesFromMapping. Geen extra RBAC nodig — sales/events
  // permissions zitten al in de auth-gate hierboven.
  const contextEventAttendeeId = body.context_event_attendee_id != null
    ? String(body.context_event_attendee_id).trim()
    : '';
  // Fase A: runtime media voor IMAGE/VIDEO/DOCUMENT headers. Object met
  //   { kind: 'image'|'video'|'document', link: '<https-url>', filename? }
  const runtimeMediaIn = (body.runtime_media && typeof body.runtime_media === 'object' && !Array.isArray(body.runtime_media))
    ? body.runtime_media
    : null;
  // Fase A: optionele per-button URL-params override:
  //   { "<button-index>": { "<param-idx>": "<value>" } }
  const runtimeButtonParamsIn = (body.runtime_button_params && typeof body.runtime_button_params === 'object'
    && !Array.isArray(body.runtime_button_params))
    ? body.runtime_button_params
    : null;

  // Validatie
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!UUID_RE.test(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  if (!templateName) return res.status(400).json({ error: 'template_name vereist' });
  if (templateName.length > MAX_TEMPLATE_NAME) {
    return res.status(400).json({ error: `template_name max ${MAX_TEMPLATE_NAME} chars` });
  }
  if (language.length > MAX_LANG) {
    return res.status(400).json({ error: `language max ${MAX_LANG} chars` });
  }
  if (contextInvoiceId && !UUID_RE.test(contextInvoiceId)) {
    return res.status(400).json({ error: 'context_invoice_id moet geldige uuid zijn' });
  }
  if (contextEventAttendeeId && !UUID_RE.test(contextEventAttendeeId)) {
    return res.status(400).json({ error: 'context_event_attendee_id moet geldige uuid zijn' });
  }
  if (runtimeMediaIn) {
    const kind = String(runtimeMediaIn.kind || '').toLowerCase().trim();
    const link = String(runtimeMediaIn.link || '').trim();
    if (!RUNTIME_MEDIA_KINDS.has(kind)) {
      return res.status(400).json({ error: `runtime_media.kind moet image|video|document zijn (kreeg '${kind}')` });
    }
    if (!URL_HTTPS_RE.test(link)) {
      return res.status(400).json({ error: 'runtime_media.link moet een geldige https-URL zijn' });
    }
  }

  // Meta-config check
  const cfg = getConfigStatus();
  if (!cfg.configured) {
    return res.status(503).json({
      error: 'Meta WhatsApp niet geconfigureerd',
      missing: cfg.missing,
    });
  }

  try {
    // Conversation ophalen — voor phone_number + outbound-lijn keuze
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, customer_id, attendee_id, last_message_preview')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });
    if (!conv.phone_number) return res.status(400).json({ error: 'Conversation heeft geen phone_number' });

    // Persistente attendee-koppeling vult de context als er geen expliciete
    // context_event_attendee_id is meegegeven. Expliciete waarde uit body
    // wint altijd (operator-override).
    let effectiveAttendeeId = contextEventAttendeeId;
    if (!effectiveAttendeeId && conv.attendee_id) {
      effectiveAttendeeId = conv.attendee_id;
    }

    // Module-config fallback voor afzendlijn — gelijk aan inbox-send.js
    let financePnId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('phone_number_id, business_account_id')
        .eq('module', 'finance')
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[inbox-send-template] module-config lookup:', modErr.message);
      } else if (modCfg?.phone_number_id) {
        financePnId = modCfg.phone_number_id;
      }
    } catch (e) {
      console.error('[inbox-send-template] module-config exception:', e.message);
    }

    // Lokale template lookup — combineert status-guard (409 bij niet-APPROVED)
    // EN ophalen van meta_param_mapping (C4 named-vars resolver).
    let templateRow = null;
    try {
      const { data: tmplRow, error: tmplErr } = await supabaseAdmin
        .from('whatsapp_meta_templates')
        .select('id, status, body_text, meta_param_mapping, header_type, header_content')
        .eq('name', templateName)
        .eq('language', language)
        .maybeSingle();
      if (tmplErr) {
        console.error('[inbox-send-template] template lookup:', tmplErr.message);
      } else if (!tmplRow) {
        console.warn(`[inbox-send-template] geen lokale template-row voor name=${templateName} language=${language} (continue, Meta is autoritatief)`);
      } else {
        templateRow = tmplRow;
        if (tmplRow.status && tmplRow.status !== 'APPROVED') {
          return res.status(409).json({
            error: 'Template status is niet APPROVED — gebruik admin -> WhatsApp Templates -> Sync met Meta',
            status: tmplRow.status,
          });
        }
      }
    } catch (e) {
      console.error('[inbox-send-template] template lookup exception:', e.message);
    }

    // ─── C4: server-side resolve van named variabelen ───────────────────────
    // Mapping shape: { body: { "1": "klant.naam", "2": "factuur.bedrag_open" }, ... }
    // Backward-compat: zonder mapping = caller-supplied `variables` (positioneel).
    const mappingFull = templateRow && templateRow.meta_param_mapping
      && typeof templateRow.meta_param_mapping === 'object'
      ? templateRow.meta_param_mapping
      : null;
    const bodyMapping = mappingFull && mappingFull.body
      && typeof mappingFull.body === 'object' && !Array.isArray(mappingFull.body)
      ? mappingFull.body
      : null;

    let resolvedVariables = {}; // { "1": "value", "2": "value" }
    const resolveWarnings = [];
    let resolveMode = 'caller_supplied'; // info-veld voor audit

    if (bodyMapping) {
      // Bouw resolve-context op basis van welke keys de mapping eist.
      const requiredKeys = Object.values(bodyMapping).filter(k => typeof k === 'string');
      const knownKeys = new Set(AVAILABLE_VARIABLES.map(v => v.key));
      const needsCustomer = requiredKeys.some(k => k && (k.startsWith('klant.') && knownKeys.has(k)));
      const needsInvoice = requiredKeys.some(k => k && k.startsWith('factuur.'));
      const needsInvoices = requiredKeys.some(k => k === 'klant.factuur_lijst' || k === 'klant.totaal_open' || k === 'klant.aantal_open');
      const needsBetaalLink = requiredKeys.includes('factuur.betaal_link');
      const needsAfdeling = requiredKeys.some(k => k && k.startsWith('afdeling.'));
      // Events-hub: attendee/event-variabelen vereisen een context_event_attendee_id.
      const needsAttendee  = requiredKeys.some(k => k && k.startsWith('attendee.'));
      const needsEvent     = requiredKeys.some(k => k && k.startsWith('event.'));
      const needsChoiceLink = requiredKeys.includes('attendee.keuze_link');

      // Customer lookup — rijker dan inbox-conversation-context (incl. address_*).
      let customer = null;
      if (needsCustomer || needsInvoice || needsInvoices) {
        try {
          if (conv.customer_id) {
            const { data: cust, error: custErr } = await supabaseAdmin
              .from('customers')
              .select('id, is_company, company_name, first_name, last_name, email, phone, address_street, address_number, address_postal, address_city')
              .eq('id', conv.customer_id)
              .maybeSingle();
            if (custErr) console.error('[inbox-send-template] customer lookup:', custErr.message);
            else customer = cust || null;
          } else if (conv.phone_number) {
            const { data: cust, error: custErr } = await supabaseAdmin
              .from('customers')
              .select('id, is_company, company_name, first_name, last_name, email, phone, address_street, address_number, address_postal, address_city')
              .eq('phone', conv.phone_number)
              .maybeSingle();
            if (custErr) console.error('[inbox-send-template] customer phone-lookup:', custErr.message);
            else customer = cust || null;
          }
        } catch (e) {
          console.error('[inbox-send-template] customer lookup exception:', e.message);
        }
      }

      // Invoice context: context_invoice_id wint; anders oudste open invoice
      // van customer.
      let invoice = null;
      let openInvoices = [];
      if (needsInvoice || needsInvoices) {
        if (contextInvoiceId) {
          try {
            const { data: inv, error: invErr } = await supabaseAdmin
              .from('invoices')
              .select('id, customer_id, tl_invoice_id, invoice_number, amount_total, amount_paid, vat_amount, issue_date, due_date, paid_date, status, payment_url, payment_url_fetched_at')
              .eq('id', contextInvoiceId)
              .maybeSingle();
            if (invErr) console.error('[inbox-send-template] invoice lookup:', invErr.message);
            else invoice = inv || null;
          } catch (e) {
            console.error('[inbox-send-template] invoice lookup exception:', e.message);
          }
          if (!invoice) {
            return res.status(400).json({ error: 'context_invoice_id verwijst niet naar bestaande invoice' });
          }
        } else if (customer && customer.id) {
          try {
            const { data: invs, error: invsErr } = await supabaseAdmin
              .from('invoices')
              .select('id, customer_id, tl_invoice_id, invoice_number, amount_total, amount_paid, vat_amount, issue_date, due_date, paid_date, status, payment_url, payment_url_fetched_at')
              .eq('customer_id', customer.id)
              .in('status', ['open', 'partially_paid', 'overdue'])
              .order('due_date', { ascending: true })
              .limit(25);
            if (invsErr) {
              console.error('[inbox-send-template] open-invoices lookup:', invsErr.message);
            } else {
              openInvoices = invs || [];
              invoice = openInvoices[0] || null;
            }
          } catch (e) {
            console.error('[inbox-send-template] open-invoices exception:', e.message);
          }
        }
        if (needsInvoice && !invoice) {
          // factuur.* gevraagd maar geen invoice gevonden → niet hard breken;
          // resolver vult lege strings in. Wel een warning loggen.
          resolveWarnings.push('Geen invoice-context voor factuur.* variabele(n)');
        }
      }

      // Lazy TL-fetch voor invoice.betaal_link (Route A: real-time + cache).
      // C4.5: hergebruik de shared helper ensureInvoicePaymentLink (zelfde
      // cache+probe-flow als finance-invoice-payment-link endpoint). Fail-soft:
      // bij elke error → console.warn + resolver vult lege string.
      if (needsBetaalLink) {
        if (!contextInvoiceId && !invoice) {
          return res.status(400).json({
            error: 'Geen invoice context gegeven; sleutel invoice.betaal_link kan niet worden ge-resolved',
          });
        }
        if (invoice) {
          try {
            const linkResult = await ensureInvoicePaymentLink(invoice.id, { userId: user.id });
            if (linkResult && linkResult.payment_url) {
              invoice.payment_url = linkResult.payment_url; // gebruikt door resolver
            } else {
              console.warn('[inbox-send-template] ensureInvoicePaymentLink: geen url voor invoice', invoice.id);
              resolveWarnings.push('TL betaal-link niet beschikbaar voor invoice ' + invoice.id);
            }
          } catch (e) {
            const code = e instanceof InvoicePaymentLinkError ? e.code : 'UNKNOWN';
            console.warn('[inbox-send-template] ensureInvoicePaymentLink fail invoice=' + invoice.id + ' code=' + code + ' reason=' + e.message);
            resolveWarnings.push('Fout bij ophalen TL betaal-link (' + code + '): ' + e.message);
          }
        }
      }

      // Afdeling-context: lookup whatsapp_module_config voor de zendende lijn.
      // Prioriteit: conv.phone_number_id (gezet door webhook op inbound-time)
      // is autoritatief — sinds de multi-line fix (#192, unique op
      // (phone_number, phone_number_id)) is dat per definitie de juiste lijn,
      // ongeacht of dat finance of events is. `financePnId` blijft als
      // backwards-compat-fallback voor zeer oude conv-rijen zonder
      // phone_number_id (in productie geen rijen meer). Bij geen match:
      // null → resolver vult afdeling.* met lege strings + console.warn.
      let moduleContext = null;
      if (needsAfdeling) {
        try {
          moduleContext = await getModuleContextByPhoneNumberId(
            supabaseAdmin,
            conv.phone_number_id || financePnId || null,
          );
          if (!moduleContext) {
            resolveWarnings.push('Geen module-context gevonden voor afdeling.* variabele(n)');
          }
        } catch (e) {
          console.error('[inbox-send-template] module-context lookup exception:', e.message);
          resolveWarnings.push('Fout bij ophalen module-context: ' + e.message);
        }
      }

      // Events-hub: attendee + event context laden als de mapping ze gebruikt.
      // - context_event_attendee_id is verplicht zodra een attendee.* of
      //   event.* key in de body-mapping staat (anders kunnen we niet
      //   eenduidig kiezen welke deelnemer/event we serveren).
      // - attendee.keuze_link vereist een geldig choice_token op de rij;
      //   anders 400 met een nette tekst zodat de UI 'm kan tonen.
      let attendee = null;
      let event    = null;
      if (needsAttendee || needsEvent) {
        if (!effectiveAttendeeId) {
          return res.status(400).json({
            error: 'Deze template gebruikt aanwezige- of event-variabelen. Selecteer eerst een aanwezige (context_event_attendee_id ontbreekt).',
            code : 'EVENT_ATTENDEE_REQUIRED',
          });
        }
        try {
          const { data: att, error: attErr } = await supabaseAdmin
            .from('event_attendees')
            .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id')
            .eq('id', effectiveAttendeeId)
            .maybeSingle();
          if (attErr) console.error('[inbox-send-template] attendee lookup:', attErr.message);
          else attendee = att || null;
        } catch (e) {
          console.error('[inbox-send-template] attendee lookup exception:', e.message);
        }
        if (!attendee) {
          return res.status(400).json({
            error: 'context_event_attendee_id verwijst niet naar bestaande aanwezige',
            code : 'EVENT_ATTENDEE_NOT_FOUND',
          });
        }
        // Binding-check: de meegegeven aanwezige moet aan deze conversatie
        // gekoppeld zijn via exact dezelfde match-logica als de UI-resolver
        // _evResolveAttendeeCandidatesForConv in modules/events.html:
        //   1. event_attendees.customer_id = conv.customer_id, of
        //   2. event_attendees.phone       = conv.phone_number
        // Allebei strict equality (PostgREST .eq → SQL =), geen
        // phone-normalisatie. Hiermee accepteert de backend exact dezelfde
        // selecties als de UI aanbiedt (geen valse 400's), en geen poging
        // om "een willekeurige attendee-id mee te smokkelen op een vreemde
        // conversation".
        const linkedByCustomer = !!(conv.customer_id && attendee.customer_id && attendee.customer_id === conv.customer_id);
        const linkedByPhone    = !!(attendee.phone && conv.phone_number && attendee.phone === conv.phone_number);
        if (!linkedByCustomer && !linkedByPhone) {
          return res.status(400).json({
            error: 'Deze aanwezige hoort niet bij deze conversatie.',
            code : 'EVENT_ATTENDEE_NOT_LINKED',
          });
        }
        if (needsChoiceLink && !attendee.choice_token) {
          return res.status(400).json({
            error: 'Deze aanwezige heeft geen keuze-link beschikbaar. Genereer eerst een choice-token of kies een andere aanwezige.',
            code : 'ATTENDEE_CHOICE_TOKEN_MISSING',
          });
        }
        if ((needsEvent || needsAttendee) && attendee.event_id) {
          try {
            const { data: ev, error: evErr } = await supabaseAdmin
              .from('events')
              .select('id, title, starts_at, ends_at, status, location, niveau')
              .eq('id', attendee.event_id)
              .maybeSingle();
            if (evErr) console.error('[inbox-send-template] event lookup:', evErr.message);
            else event = ev || null;
          } catch (e) {
            console.error('[inbox-send-template] event lookup exception:', e.message);
          }
          if (needsEvent && !event) {
            resolveWarnings.push('Geen event-row gevonden voor attendee ' + attendee.id);
          }
        }
      }

      // Resolve mapping → { "1": value, "2": value }
      const ctx = { customer, invoice, openInvoices, moduleContext, attendee, event };
      resolvedVariables = buildMetaVariablesFromMapping(bodyMapping, ctx);
      resolveMode = 'server_resolved';

      // Warning voor onbekende keys.
      for (const [pos, key] of Object.entries(bodyMapping)) {
        if (key && !knownKeys.has(key)) {
          resolveWarnings.push(`Onbekende variabele-key in mapping[${pos}]: ${key}`);
        }
      }
    } else {
      // Legacy: caller leverde de variables direct.
      const callerKeys = Object.keys(variablesIn)
        .filter(k => /^\d+$/.test(k));
      for (const k of callerKeys) {
        resolvedVariables[k] = String(variablesIn[k] ?? '');
      }
    }

    // Build Meta components-array via Fase A builder. De builder kent:
    //   - HEADER (IMAGE/VIDEO/DOCUMENT) als runtime_media meegegeven
    //   - BODY met text-parameters (zoals de oude inline-logica)
    //   - BUTTON (URL met url_params) als meta_param_mapping.buttons er staat
    //
    // Backward-compat: body-only templates (header_type=NONE, geen
    // button-url-params) produceren EXACT 1 body-component met text-params,
    // identiek aan de oude code. Geen wijziging in observable behaviour
    // voor finance/Joost-flows.
    const sortedKeys = Object.keys(resolvedVariables)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b));
    const cappedBodyVariables = Object.fromEntries(
      sortedKeys.map(k => [k, String(resolvedVariables[k] ?? '').slice(0, MAX_VAR_VALUE)])
    );

    // Guard: template heeft media-header maar caller stuurde geen runtime_media -> 400.
    if (templateRow && MEDIA_HEADER_TYPES.has(String(templateRow.header_type || '').toUpperCase())) {
      if (!runtimeMediaIn) {
        return res.status(400).json({
          error: 'Template heeft een ' + templateRow.header_type + '-header maar geen runtime_media meegegeven.',
          code : 'RUNTIME_MEDIA_REQUIRED',
        });
      }
      const expected = String(templateRow.header_type).toLowerCase();
      const got      = String(runtimeMediaIn.kind || '').toLowerCase();
      if (expected !== got) {
        return res.status(400).json({
          error: `Template-header verwacht kind='${expected}' maar runtime_media.kind='${got}'.`,
          code : 'RUNTIME_MEDIA_KIND_MISMATCH',
        });
      }
    }

    const { components, warnings: buildWarnings } = buildSendComponents({
      template      : templateRow,
      bodyVariables : cappedBodyVariables,
      runtimeMedia  : runtimeMediaIn ? {
        type    : String(runtimeMediaIn.kind || '').toLowerCase(),
        link    : String(runtimeMediaIn.link || '').trim(),
        filename: runtimeMediaIn.filename || undefined,
      } : null,
      runtimeButtonParams: runtimeButtonParamsIn,
    });
    if (Array.isArray(buildWarnings) && buildWarnings.length > 0) {
      console.warn('[inbox-send-template] component-build warnings:', buildWarnings.join(' | '));
    }

    // Afzendlijn-keuze: prefer conversation.phone_number_id; fallback op
    // module-config; uiteindelijk env-var via getConfig default.
    const outboundPnId = conv.phone_number_id || financePnId || undefined;

    // Meta send via shared helper (hergebruikt auth/error-handling).
    let metaResult;
    try {
      metaResult = await sendTemplate({
        to: conv.phone_number,
        templateName,
        languageCode: language,
        components: components.length ? components : null,
        phoneNumberId: outboundPnId,
      });
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return res.status(503).json({
          error: 'Meta WhatsApp niet geconfigureerd',
          missing: metaErr.missing,
        });
      }
      console.error('[inbox-send-template] Meta API fout:', metaErr.message);
      return res.status(502).json({ error: 'Meta API fout', meta_error: metaErr.message });
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nowIso = new Date().toISOString();

    // Persist outbound template-message.
    // Schema-realiteit (2026-06-07-whatsapp-inbox-foundation.sql): geen
    // expliciete 'type'-kolom, geen 'meta_payload'. Template-encoding is
    // impliciet via template_name != NULL. status default 'queued'; webhook
    // delivery-events promoten later naar sent/delivered/read.
    const templateVarsForDb = sortedKeys.length
      ? Object.fromEntries(sortedKeys.map(k => [k, String(resolvedVariables[k] ?? '')]))
      : null;

    // Build textual preview body voor chat-history readability: vervang
    // {{N}} in template body_text met de resolved values. Fail-soft: als
    // we geen body_text hebben, laat body NULL (huidige gedrag).
    let previewBody = null;
    if (templateRow && templateRow.body_text && sortedKeys.length) {
      let rendered = String(templateRow.body_text);
      for (const k of sortedKeys) {
        const re = new RegExp(`\\{\\{${k}\\}\\}`, 'g');
        rendered = rendered.replace(re, String(resolvedVariables[k] ?? ''));
      }
      previewBody = rendered;
    }

    const insertRow = {
      conversation_id:    convId,
      direction:          'out',
      meta_wamid:         wamid,
      body:               previewBody,
      template_name:      templateName,
      template_variables: templateVarsForDb,
      status:             'queued',
      sent_at:            nowIso,
      sent_by_user_id:    user.id,
    };
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert(insertRow)
      .select('id, meta_wamid, status, sent_at')
      .single();
    if (insErr) throw new Error('message insert: ' + insErr.message);

    // Conversation last_message_at + preview (fail-soft).
    const preview = ('[template] ' + templateName).slice(0, 120);
    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nowIso, last_message_preview: preview })
      .eq('id', convId);
    if (updErr) console.error('[inbox-send-template] conversation update failed:', updErr.message);

    // Audit log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'whatsapp.send_template',
        entity_type: 'whatsapp_message',
        entity_id:   inserted.id,
        after_json:  {
          conversation_id:    convId,
          phone_number:       conv.phone_number,
          phone_number_id:    outboundPnId || null,
          template_name:      templateName,
          meta_template_id:   metaTemplateId || null,
          language,
          variables:          templateVarsForDb,
          meta_wamid:         wamid,
          resolve_mode:       resolveMode,
          context_invoice_id: contextInvoiceId || null,
          context_event_attendee_id: effectiveAttendeeId || null,
          resolve_warnings:   resolveWarnings.length ? resolveWarnings : null,
        },
        ip_address: getClientIp(req),
      });
    } catch (auditErr) {
      console.error('[inbox-send-template] audit insert exception:', auditErr.message);
    }

    return res.status(200).json({
      wamid,
      message_id: inserted.id,
      variables: templateVarsForDb,
      warnings: resolveWarnings.length ? resolveWarnings : undefined,
    });
  } catch (e) {
    console.error('[inbox-send-template]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
