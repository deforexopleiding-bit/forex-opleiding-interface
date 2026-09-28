// api/_lib/inbox-verzenden.js
//
// Eén bericht in een gesprek de deur uit doen.
//
// ── WAAROM DIT BESTAND BESTAAT ───────────────────────────────────────────────
// Alles hieronder stond in api/inbox-send.js, verweven met het lezen van een
// HTTP-verzoek. Dat werkte prima zolang er precies één manier was om iets te
// versturen: iemand drukt op Verstuur, en het gaat meteen weg.
//
// Het uitgestelde versturen (G2 op de server) voegt een tweede manier toe: een
// bericht wordt geparkeerd, en gaat dertig seconden later weg — óf vanuit het
// scherm dat nog openstaat, óf vanuit een cron als dat scherm dicht is. Drie
// aanroepers dus, en die moeten alle drie exact hetzelfde doen. Drie kopieën
// van deze logica die langzaam uit elkaar lopen is precies hoe je krijgt dat
// een bericht via de ene weg wél in de audit-log belandt en via de andere niet.
//
// ── WAT HIER NIET VERANDERT ──────────────────────────────────────────────────
// Dit is een verhuizing, geen verbouwing. De volgorde van de controles, de
// foutteksten, de statuscodes en de vorm van het antwoord zijn letterlijk
// overgenomen. Vijf schermen hangen aan /api/inbox-send (inbox-v2,
// onboarding-v2, wanbetalers-v2, events-v2 en onboarding-overzicht) en die
// kennen die vormen uit hun hoofd — een 422 die ineens een 400 wordt, is voor
// hen een andere foutmelding.
//
// Joost en de aanmaanmotor lopen hier NIET langs: die hebben hun eigen
// verzendweg (joost-send-autonomous, cron-dunning-bulk-send). Er is geen enkele
// server-side aanroeper van inbox-send. Dat is geen belofte maar iets dat je
// kunt nakijken, en er staat een test op.

import { supabaseAdmin } from '../supabase.js';
import { sendText, sendTemplate, sendMedia, getConfigStatus, MetaNotConfiguredError } from './meta-whatsapp.js';
import { renderTemplatePreview } from './render-template-preview.js';
import { unpauseRunsForConversation } from './dunning-arrangement-hooks.js';
import { gesprekkenV2Aan } from './gesprekken-vlag.js';
import { werkSleutel } from './gesprekken-werkstand.js';
import { TWENTY_FOUR_HOURS_MS, afwijzing } from './inbox-verzendopdracht.js';

// De keuring staat in _lib/inbox-verzendopdracht.js: die is zuiver en moet
// nagekeken kunnen worden zonder de databaselaag op te starten. Hier opnieuw
// uitgedeeld zodat een aanroeper aan één import genoeg heeft.
export {
  leesVerzendOpdracht,
  TWENTY_FOUR_HOURS_MS, UUID_RE, MAX_BODY, MAX_TEMPLATE_NAME, MEDIA_SOORTEN,
} from './inbox-verzendopdracht.js';

const fout = afwijzing;

/**
 * Staat Meta klaar?
 *
 * Apart, want het uitgestelde pad wil dit weten vóór het iets parkeert: een
 * bericht dertig seconden laten wachten om dan te ontdekken dat er geen
 * verbinding is, is dertig seconden verspilde hoop.
 */
export function metaKlaar() {
  const cfg = getConfigStatus();
  if (cfg.configured) return { ok: true };
  return fout(503, { error: 'Meta WhatsApp niet geconfigureerd', missing: cfg.missing });
}

/**
 * Verstuur een gekeurde opdracht.
 *
 * @param {object} opdracht  uit leesVerzendOpdracht()
 * @param {object} ctx
 * @param {string} ctx.userId            wie het stuurt (voor de audit-log)
 * @param {string|null} [ctx.ip]
 * @param {object} ctx.rechten           { finance, simone, onboarding } booleans
 * @param {boolean} [ctx.controleerVenster=true]
 * @returns {Promise<{http: number, payload: object}>}
 */
export async function verstuurInGesprek(opdracht, ctx = {}) {
  const {
    convId, mode, text,
    templateName, templateLanguage, templateVariables, templateComponents,
    mediaKind, mediaLink, mediaCaption, mediaFilename,
  } = opdracht;
  const userId = ctx.userId || null;
  const ip = ctx.ip || null;
  const rechten = ctx.rechten || {};
  const hasFinanceSend = !!rechten.finance;
  const hasSimoneUse = !!rechten.simone;
  const hasOnboardingSend = !!rechten.onboarding;

  const meta = metaKlaar();
  if (!meta.ok) return { http: meta.http, payload: meta.payload };

  try {
    // Module-config: finance-WABA-lijn voor outbound routing. Bij ontbreken
    // valt sendText/sendTemplate terug op env-var (huidige gedrag) zodat
    // bestaande deploys zonder DB-config blijven werken.
    let financePnId = null;
    try {
      const { data: modCfg, error: modErr } = await supabaseAdmin
        .from('whatsapp_module_config')
        .select('phone_number_id')
        .eq('module', 'finance')
        .eq('is_active', true)
        .maybeSingle();
      if (modErr) {
        console.error('[inbox-verzenden] module-config lookup:', modErr.message);
      } else if (modCfg?.phone_number_id) {
        financePnId = modCfg.phone_number_id;
      }
    } catch (e) {
      console.error('[inbox-verzenden] module-config exception:', e.message);
    }

    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, customer_id, last_inbound_at, last_message_preview')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return { http: 404, payload: { error: 'Conversation niet gevonden' } };
    if (!conv.phone_number) return { http: 400, payload: { error: 'Conversation heeft geen phone_number' } };

    // Welke module is dit gesprek? Afgeleid uit conv.phone_number_id, zodat
    // iemand met alleen events.simone.use niet namens finance kan versturen.
    // Onbekende pnId → finance, want dat was het gedrag voordat de andere
    // modules bestonden.
    let convModule = 'finance';
    if (conv.phone_number_id) {
      try {
        const { data: convMod, error: convModErr } = await supabaseAdmin
          .from('whatsapp_module_config')
          .select('module')
          .eq('phone_number_id', conv.phone_number_id)
          .eq('is_active', true)
          .maybeSingle();
        if (convModErr) {
          console.error('[inbox-verzenden] conv-module lookup:', convModErr.message);
        } else if (convMod?.module) {
          convModule = String(convMod.module).toLowerCase();
        }
      } catch (e) {
        console.error('[inbox-verzenden] conv-module exception:', e.message);
      }
    }
    if (convModule === 'events' && !hasSimoneUse) {
      return { http: 403, payload: { error: 'Geen rechten (events.simone.use voor events-conv)' } };
    }
    if (convModule === 'onboarding' && !hasOnboardingSend) {
      return { http: 403, payload: { error: 'Geen rechten (onboarding.inbox.send voor onboarding-conv)' } };
    }
    if (convModule !== 'events' && convModule !== 'onboarding' && !hasFinanceSend) {
      return { http: 403, payload: { error: 'Geen rechten (finance.inbox.send voor finance-conv)' } };
    }

    // 24h-venster voor vrije tekst EN media (Meta-regel: elk vrij bericht
    // vereist een inbound binnen 24u).
    //
    // BELANGRIJK voor het uitgestelde pad: dit wordt bewust hier gecontroleerd
    // en niet bij het parkeren. Een venster dat bij het parkeren nog open was,
    // kan dertig seconden later dicht zijn — en dan is dit het moment waarop
    // dat blijkt, niet een half uur eerder toen het nog niet zeker was.
    if (mode === 'text' || mediaKind) {
      const t = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
      const withinWindow = t && (Date.now() - t) <= TWENTY_FOUR_HOURS_MS;
      if (!withinWindow) {
        return {
          http: 422,
          payload: {
            error: '24h_window_expired',
            message: mediaKind
              ? `Buiten 24-uurs venster — vrij ${mediaKind} versturen kan niet meer. Gebruik een approved template met een ${mediaKind}-header.`
              : 'Buiten 24-uurs venster sinds laatste inbound bericht. Gebruik een approved template.',
          },
        };
      }
    }

    // Afzendlijn: liefst de lijn waarop het gesprek binnenkwam, zodat het
    // antwoord op dezelfde plek terugkomt.
    const outboundPnId = conv.phone_number_id || financePnId || undefined;

    let metaResult;
    try {
      if (mode === 'text') {
        metaResult = await sendText({ to: conv.phone_number, body: text, phoneNumberId: outboundPnId });
      } else if (mediaKind) {
        metaResult = await sendMedia({
          to           : conv.phone_number,
          kind         : mediaKind,
          link         : mediaLink,
          caption      : mediaCaption || undefined,
          filename     : mediaFilename || undefined,
          phoneNumberId: outboundPnId,
        });
      } else {
        metaResult = await sendTemplate({
          to: conv.phone_number,
          templateName,
          languageCode: templateLanguage,
          components: templateComponents,
          phoneNumberId: outboundPnId,
        });
      }
    } catch (metaErr) {
      if (metaErr instanceof MetaNotConfiguredError) {
        return { http: 503, payload: { error: 'Meta WhatsApp niet geconfigureerd', missing: metaErr.missing } };
      }
      // Meta 131047 = venster verlopen. Onze eigen controle hierboven kijkt
      // naar conv.last_inbound_at in de DB, en die kan "open" zeggen terwijl
      // Meta's venster in werkelijkheid dicht is. Zelfde vorm teruggeven als
      // de eigen controle, zodat het scherm het niet apart hoeft af te
      // handelen; source:'meta' zodat je wél kunt zien wie het zei.
      const metaCode = Number(metaErr?.metaCode);
      if (metaCode === 131047 || metaCode === 131051 || metaCode === 131026) {
        console.warn('[inbox-verzenden] Meta re-engagement fout — vertaald naar 24h_window_expired:', {
          meta_code   : metaErr.metaCode,
          meta_subcode: metaErr.metaSubcode,
          meta_message: metaErr.metaMessage,
          fbtrace_id  : metaErr.metaFbtrace,
        });
        return {
          http: 422,
          payload: {
            error  : '24h_window_expired',
            source : 'meta',
            message: mediaKind
              ? `Meta's 24-uurs venster is verlopen (de klant heeft niet binnen 24u geantwoord). Vrij ${mediaKind} versturen kan niet meer — gebruik de Template-knop voor een goedgekeurde template met ${mediaKind}-header.`
              : 'Meta\'s 24-uurs venster is verlopen (de klant heeft niet binnen 24u geantwoord). Gebruik de Template-knop om een goedgekeurde template te sturen.',
            meta_code: metaErr.metaCode,
          },
        };
      }
      console.error('[inbox-verzenden] Meta API fout:', metaErr.message);
      return { http: 502, payload: { error: 'Meta API fout', meta_error: metaErr.message } };
    }

    const wamid = metaResult && metaResult.wamid ? String(metaResult.wamid) : null;
    const nowIso = new Date().toISOString();

    const insertRow = {
      conversation_id:    convId,
      direction:          'out',
      meta_wamid:         wamid,
      body:               mode === 'text' ? text : (mediaKind ? (mediaCaption || mediaFilename || null) : null),
      template_name:      mode === 'template' ? templateName : null,
      template_variables: mode === 'template' ? (templateVariables || null) : null,
      media_url:          mediaKind ? mediaLink : null,
      media_type:         mediaKind || null,
      status:             'queued',
      sent_at:            nowIso,
      sent_by_user_id:    userId,
    };
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .insert(insertRow)
      .select('id, meta_wamid, status, sent_at')
      .single();
    if (insErr) throw new Error('message insert: ' + insErr.message);

    // Voorbeeldtekst voor de lijst. Bij een template renderen we de echte
    // body, zodat er geen '[template] naam' in de lijst staat.
    let preview;
    if (mode === 'text') {
      preview = text.slice(0, 120);
    } else if (mediaKind) {
      preview = ('[' + mediaKind + '] ' + (mediaCaption || mediaFilename || '')).slice(0, 120);
    } else {
      const bodyComp = Array.isArray(templateComponents)
        ? templateComponents.find((c) => c?.type === 'body')
        : null;
      const bodyParams = Array.isArray(bodyComp?.parameters) ? bodyComp.parameters : [];
      const tplVars = bodyParams.length
        ? Object.fromEntries(bodyParams.map((p, i) => [String(i + 1), String(p?.text ?? '')]))
        : null;
      const rendered = await renderTemplatePreview({
        templateName,
        templateVariables: tplVars,
        supabase: supabaseAdmin,
      });
      preview = rendered.body.slice(0, 120);
    }
    const { error: updErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .update({ last_message_at: nowIso, last_message_preview: preview })
      .eq('id', convId);
    if (updErr) console.error('[inbox-verzenden] conversation update failed:', updErr.message);

    // Vanaf hier is het bericht al bij Meta. Alles wat volgt is faalzacht:
    // een fout erin verandert niets meer aan wat de klant gekregen heeft.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      mode === 'text' ? 'whatsapp.outbound_text_sent' : 'whatsapp.outbound_template_sent',
        entity_type: 'whatsapp_message',
        entity_id:   inserted.id,
        after_json:  {
          conversation_id: convId,
          phone_number:    conv.phone_number,
          mode,
          meta_wamid:      wamid,
          template_name:   mode === 'template' ? templateName : null,
        },
        ip_address:  ip,
      });
    } catch (auditErr) {
      console.error('[inbox-verzenden] audit insert exception:', auditErr.message);
    }

    // Ons antwoord ontpauzeert de aanmaan-run en zet de herinneringsteller
    // terug. De cron begint pas opnieuw bij een NIEUWE klant-inbound.
    try {
      const r = await unpauseRunsForConversation(convId);
      if (r && !r.ok && r.error) {
        console.warn('[inbox-verzenden] unpause soft-fail:', r.error);
      }
    } catch (unpauseErr) {
      console.warn('[inbox-verzenden] unpause exception (fail-soft):', unpauseErr?.message || unpauseErr);
    }

    // G5 — dit gesprek wacht nu op de KLANT. Zonder dit blijft het filter
    // "wacht op ons" gesprekken tonen die je net beantwoord hebt. 'geregeld'
    // en een lopende belofte laten we staan: dat zijn standen die een mens
    // bewust gekozen heeft.
    if (gesprekkenV2Aan()) {
      try {
        const sleutel = werkSleutel(convId);
        if (sleutel) {
          const { error: wFout } = await supabaseAdmin
            .from('iris_gesprekken')
            .update({ status: 'wacht_op_klant', bijgewerkt_op: new Date().toISOString() })
            .eq('extern_uniek', sleutel)
            .in('status', ['nieuw', 'wacht_op_ons']);
          if (wFout) console.warn('[inbox-verzenden] werkstand niet bijgewerkt:', wFout.message);
        }
      } catch (wEx) {
        console.warn('[inbox-verzenden] werkstand uitzondering (faalzacht):', wEx?.message || wEx);
      }
    }

    return {
      http: 200,
      payload: { success: true, message_id: inserted.id, meta_wamid: wamid },
    };
  } catch (e) {
    console.error('[inbox-verzenden]', e.message);
    return { http: 500, payload: { error: e.message } };
  }
}
