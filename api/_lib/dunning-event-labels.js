// api/_lib/dunning-event-labels.js
//
// Vertaaltabel van dunning_log.event_type + andere event-bronnen naar
// gewone-taal-labels voor het klantdossier. Vrije tekst in de DB (~35
// varianten, geen enum) — deze module is de single source of truth
// voor UI-vertaling.
//
// Gebruik:
//   import { labelForDunningEvent } from './_lib/dunning-event-labels.js';
//   const { title, detail } = labelForDunningEvent(row.event_type, row.payload);
//
// Onbekende event_types krijgen een LEESBARE fallback (snake_case → "Snake case"),
// NOOIT de ruwe code. Dat is een expliciete keuze: ruwe log_events zijn implementation
// detail en horen niet in klant-facing UI.

const KNOWN = Object.freeze({
  // ── Engine-lifecycle ─────────────────────────────────────────────────────
  started:                { title: 'Aanmaan-workflow gestart' },
  completed:              { title: 'Aanmaan-workflow afgerond' },
  paused_customer_replied:{ title: 'Klant reageerde — aanmaning gepauzeerd' },
  skipped_open_action:    { title: 'Overgeslagen: er ligt nog een openstaande actie' },
  stop_step:              { title: 'Workflow-stap: stop' },
  unknown_step_type:      { title: 'Onbekend workflow-stap-type' },

  // ── Email ───────────────────────────────────────────────────────────────
  email_sent:                     { title: 'Aanmaning per e-mail verstuurd' },
  email_send_failed:              { title: 'E-mail versturen mislukt' },
  email_send_exception:           { title: 'E-mail versturen — technische fout' },
  email_skipped_no_infra:         { title: 'E-mail overgeslagen: e-mailinfra niet gekoppeld' },
  email_skipped_no_recipient:     { title: 'E-mail overgeslagen: geen e-mailadres bekend' },
  email_skipped_sandbox_guard:    { title: 'E-mail overgeslagen (sandbox-mode)' },
  email_skipped_template_error:   { title: 'E-mail overgeslagen: template-fout' },

  // ── WhatsApp ────────────────────────────────────────────────────────────
  whatsapp_sent:                        { title: 'WhatsApp-aanmaning verstuurd' },
  whatsapp_send_failed:                 { title: 'WhatsApp versturen mislukt' },
  whatsapp_skipped_no_meta_config:      { title: 'WhatsApp overgeslagen: Meta-config ontbreekt' },
  whatsapp_skipped_no_meta_module:      { title: 'WhatsApp overgeslagen: Meta-module niet actief' },
  whatsapp_skipped_no_meta_template:    { title: 'WhatsApp overgeslagen: geen goedgekeurde template' },
  whatsapp_skipped_no_phone:            { title: 'WhatsApp overgeslagen: geen telefoonnummer' },
  whatsapp_skipped_no_payment_link:     { title: 'WhatsApp overgeslagen: geen betaal-link' },
  whatsapp_skipped_no_outbound_line:    { title: 'WhatsApp overgeslagen: geen uitgaande lijn' },
  whatsapp_skipped_conv_create_failed:  { title: 'WhatsApp overgeslagen: gesprek kon niet worden aangemaakt' },
  whatsapp_skipped_sandbox_guard:       { title: 'WhatsApp overgeslagen (sandbox-mode)' },
  whatsapp_skipped_template_error:      { title: 'WhatsApp overgeslagen: template-fout' },

  // ── Task ────────────────────────────────────────────────────────────────
  task_created:              { title: 'Taak aangemaakt (workflow)' },
  task_create_failed:        { title: 'Taak-aanmaak mislukt' },
  task_skipped_no_customer:  { title: 'Taak overgeslagen: geen klant gekoppeld' },
  task_skipped_no_guard:     { title: 'Taak overgeslagen: veiligheidscheck faalde' },
  task_skipped_no_title:     { title: 'Taak overgeslagen: geen titel' },
  task_skipped_open_callback:{ title: 'Taak overgeslagen: er staat al een terugbelafspraak' },

  // ── Resume ──────────────────────────────────────────────────────────────
  dunning_resumed:                 { title: 'Aanmaan-flow hervat' },
  dunning_resume_failed:           { title: 'Aanmaan-flow hervatten mislukt' },
  dunning_resume_geen_paused_runs: { title: 'Aanmaan-flow hervatten: niets om te hervatten' },
  dunning_resume_no_customer:      { title: 'Aanmaan-flow hervatten: geen klant' },
  dunning_resume_no_guard:         { title: 'Aanmaan-flow hervatten: veiligheidscheck faalde' },

  // ── Run-control (handmatig door mens) ───────────────────────────────────
  run_control_pause:  { title: 'Aanmaan-flow handmatig gepauzeerd' },
  run_control_resume: { title: 'Aanmaan-flow handmatig hervat' },
  run_control_cancel: { title: 'Aanmaan-flow handmatig geannuleerd' },

  // ── Bulk / incasso / Joost ──────────────────────────────────────────────
  bulk_reminder_sent:      { title: 'Aanmaning verstuurd (bulk)' },
  incasso_pre_brief_sent:  { title: 'Incasso pre-brief verstuurd' },
  incasso_dossier_emailed: { title: 'Incasso-dossier per e-mail verzonden' },
  incasso_auto_created:    { title: 'Incasso-dossier automatisch aangemaakt' },
  incasso_auto_skipped_wik: { title: 'Incasso overgeslagen: WIK-check' },
  payment_refusal_flagged: { title: 'Betaal-weigering geregistreerd' },
  payment_refusal_cleared: { title: 'Betaal-weigering ingetrokken' },
  joost_outbound_sent:     { title: 'Joost verstuurde bericht (autonoom)' },
});

// Menselijke labels voor pending_actions.action_type (parallel aan
// wanbetalers-timeline.js maar hier apart zodat customer-dossier zelfstandig is).
const ACTION_TYPE_LABELS = Object.freeze({
  TL_INVOICE_UPDATE_DUE:      'Factuur — nieuwe vervaldag',
  TL_INVOICE_SPLIT:           'Factuur — splitsen in termijnen',
  TL_SUBSCRIPTION_PAUSE:      'Abonnement — pauzeren',
  TL_SUBSCRIPTION_STOP:       'Abonnement — stopzetten',
  TL_INVOICE_WRITEOFF:        'Factuur — kwijtschelding',
  MANUAL_VERIFY_PAYMENT:      'Betaling verifiëren',
  MANUAL_PROPOSE_ARRANGEMENT: 'Regeling voorstellen',
  MANUAL_ESCALATION:          'Escalatie',
  MANUAL_FOLLOWUP:            'Opvolgen',
});

const ARRANGEMENT_TYPE_LABELS = Object.freeze({
  UITSTEL:          'Uitstel',
  SPLITSING:        'Splitsing',
  TOEZEGGING:       'Betaalafspraak',
  ABONNEMENT_PAUZE: 'Abonnement pauze',
  ABONNEMENT_STOP:  'Abonnement stop',
  KWIJTSCHELDING:   'Kwijtschelding',
});

const ARRANGEMENT_STATUS_LABELS = Object.freeze({
  VOORGESTELD: 'voorgesteld',
  ACTIEF:      'actief',
  NAGEKOMEN:   'nagekomen',
  VERBROKEN:   'verbroken',
  GEANNULEERD: 'geannuleerd',
});

const PENDING_ACTION_STATUS_LABELS = Object.freeze({
  PENDING:   'wacht op goedkeuring',
  APPROVED:  'goedgekeurd',
  REJECTED:  'afgewezen',
  EXECUTED:  'uitgevoerd',
  FAILED:    'uitvoering mislukt',
  CANCELLED: 'geannuleerd',
});

// snake_case_key of UPPER_SNAKE → "Snake case key" (voor onbekende event-types).
// Alles lowercase-en na spatie-vervanging zodat UPPER_SNAKE ook leesbaar wordt
// ("NEW_ACTION_TYPE" → "New action type", niet "NEW ACTION TYPE").
function humanize(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Onbekend event';
  const spaced = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// dunning_log.event_type + payload → { title, detail? }.
// - title: 1-regel-samenvatting voor de tijdlijn-rij.
// - detail: optionele lange tekst (bv. wachttijd in dagen, aantal geblokkeerde acties).
function labelForDunningEvent(eventType, payload) {
  const known = KNOWN[eventType];
  const base = known ? { ...known } : { title: humanize(eventType) };

  // Wait-event: payload heeft geen 'wait' key meer in KNOWN — we behandelen
  // 'em hier zodat "wacht N dagen" leesbaar wordt.
  if (eventType === 'wait') {
    const secs = Number(payload?.seconds);
    if (Number.isFinite(secs) && secs > 0) {
      const days = Math.round(secs / 86400);
      if (days >= 1) return { title: `Wachtperiode van ${days} ${days === 1 ? 'dag' : 'dagen'}` };
    }
    return { title: 'Wachtperiode' };
  }

  // skipped_open_action: toon aantal geblokkeerde acties + typen.
  if (eventType === 'skipped_open_action' && payload) {
    const count = Number(payload.count) || 0;
    const types = Array.isArray(payload.action_types) ? payload.action_types : [];
    const readable = types
      .map((t) => ACTION_TYPE_LABELS[t] || humanize(t))
      .filter(Boolean)
      .join(', ');
    if (count > 0 || readable) {
      base.detail = readable
        ? `${count || readable.split(',').length} openstaande actie(s): ${readable}`
        : `${count} openstaande actie(s)`;
    }
    return base;
  }

  // paused_customer_replied: kanaal in payload zetten in detail.
  if (eventType === 'paused_customer_replied' && payload?.channel) {
    base.detail = 'Reageerde via ' + humanize(payload.channel).toLowerCase();
    return base;
  }

  // completed: reason (paid / step_missing / manual).
  if (eventType === 'completed' && payload?.reason) {
    const REASON_LBL = {
      paid: 'reden: klant heeft betaald',
      step_missing: 'reden: workflow-stap ontbreekt',
      manual: 'reden: handmatig',
    };
    base.detail = REASON_LBL[payload.reason] || `reden: ${humanize(payload.reason)}`;
    return base;
  }

  // run_control_*: user_id vermelden in detail (UI toont via actor-lookup).
  if (String(eventType || '').startsWith('run_control_') && payload?.before_status) {
    base.detail = `${humanize(payload.before_status).toLowerCase()} → ${humanize(payload.after_status || '').toLowerCase()}`;
    return base;
  }

  return base;
}

// pending_actions state-transition → menselijke tijdlijn-titel.
function labelForPendingActionEvent(actionType, transitionKind) {
  const typeLbl = ACTION_TYPE_LABELS[actionType] || humanize(actionType);
  const TRANSITION = {
    created:  'aangemaakt',
    approved: 'goedgekeurd',
    rejected: 'afgewezen',
    executed: 'uitgevoerd',
    failed:   'uitvoering mislukt',
    cancelled:'geannuleerd',
  };
  const verb = TRANSITION[transitionKind] || humanize(transitionKind).toLowerCase();
  return { title: `Actie ${verb}: ${typeLbl}` };
}

// payment_arrangements state-transition → menselijke tijdlijn-titel.
function labelForArrangementEvent(arrangementType, statusTransition) {
  const typeLbl = ARRANGEMENT_TYPE_LABELS[arrangementType] || humanize(arrangementType);
  const statusLbl = ARRANGEMENT_STATUS_LABELS[statusTransition]
    || humanize(statusTransition).toLowerCase();
  return { title: `Regeling ${statusLbl}: ${typeLbl}` };
}

export {
  KNOWN as DUNNING_EVENT_LABELS,
  ACTION_TYPE_LABELS,
  ARRANGEMENT_TYPE_LABELS,
  ARRANGEMENT_STATUS_LABELS,
  PENDING_ACTION_STATUS_LABELS,
  humanize,
  labelForDunningEvent,
  labelForPendingActionEvent,
  labelForArrangementEvent,
};
