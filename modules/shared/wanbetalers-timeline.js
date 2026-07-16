// modules/shared/wanbetalers-timeline.js
// Gedeelde presentatie-laag voor de wanbetalers-tijdlijn. Wordt gebruikt door
// zowel modules/finance.html (caseSheet-tijdlijn-kaart) als
// modules/klanten.html (Wanbetalers-tab). Één bron van waarheid voor
// event → label + icoon, zodat beide plekken identiek ogen.
//
// Klassiek script (geen ES-module) — beide host-pagina's laden dit via
// <script src="/modules/shared/wanbetalers-timeline.js"></script>.
//
// Namespaced onder window.WanbetalersTimeline:
//   .describe(item)          → { icon, title, hidden? }
//   .isHidden(item)          → true als het item niet getoond moet worden
//   .DEFAULT_LIMIT           → 3 (initieel zichtbaar; rest via "Toon meer")

(function () {
  'use strict';

  // Event-type → { icon, title }. Volgorde: van meest specifiek (dunning_*)
  // naar generiek. Onbekende types vallen terug op nette fallback (nooit
  // rauwe key). Dit is de canonieke lijst — pas alleen hier aan.
  const TYPE_LABELS = {
    // Handmatig / directe klant-interactie
    note                    : { icon: '📝', title: 'Notitie' },
    call                    : { icon: '📞', title: 'Gebeld' },
    wa_in                   : { icon: '💬', title: 'Bericht van klant' },
    wa_out                  : { icon: '💬', title: 'Bericht verstuurd' },

    // Workflow-run (lifecycle)
    run_started             : { icon: '▶️', title: 'Aanmaningsflow gestart' },
    run_completed           : { icon: '⏹️', title: 'Aanmaningsflow afgerond' },

    // Taken (pending_actions status → item.type task_<status>)
    task_pending            : { icon: '📌', title: 'Taak aangemaakt' },
    task_approved           : { icon: '✅', title: 'Taak goedgekeurd' },
    task_rejected           : { icon: '❌', title: 'Taak afgewezen' },
    task_executed           : { icon: '✔️', title: 'Taak uitgevoerd' },
    task_failed             : { icon: '⚠️', title: 'Taak mislukt' },
    task_cancelled          : { icon: '🗑️', title: 'Taak geannuleerd' },

    // Regelingen (payment_arrangements status → arrangement_<status>)
    arrangement_voorgesteld : { icon: '🤝', title: 'Betaalafspraak voorgesteld' },
    arrangement_actief      : { icon: '🤝', title: 'Betaalafspraak actief' },
    arrangement_nagekomen   : { icon: '🤝', title: 'Betaalafspraak nagekomen' },
    arrangement_verbroken   : { icon: '🤝', title: 'Betaalafspraak verbroken' },
    arrangement_geannuleerd : { icon: '🤝', title: 'Betaalafspraak geannuleerd' },

    // Dunning-log events (item.type = 'dunning_<event_type>')
    dunning_started         : { icon: '▶️', title: 'Aanmaningsflow gestart' },
    dunning_completed       : { icon: '⏹️', title: 'Aanmaningsflow afgerond' },
    dunning_email_sent      : { icon: '📧', title: 'E-mail verstuurd' },
    dunning_whatsapp_sent   : { icon: '💬', title: 'WhatsApp verstuurd' },
    dunning_bulk_reminder_sent: { icon: '💬', title: 'Bulk-aanmaning verstuurd' },
    dunning_incasso_dossier_emailed: { icon: '📮', title: 'Incasso-dossier verstuurd' },
    dunning_incasso_pre_brief_sent : { icon: '📮', title: 'Incasso-vooraankondiging verstuurd' },
    dunning_incasso_auto_created   : { icon: '⚖️', title: 'Incasso-dossier automatisch aangemaakt' },
    dunning_joost_outbound_sent    : { icon: '🤖', title: 'Joost — bericht verstuurd' },
    dunning_run_control_start      : { icon: '▶️', title: 'Aanmaningsflow gestart' },
    dunning_run_control_stop       : { icon: '⏸️', title: 'Aanmaningsflow gepauzeerd' },
    dunning_run_control_resume     : { icon: '▶️', title: 'Aanmaningsflow hervat' },
    dunning_run_control_cancel     : { icon: '⏹️', title: 'Aanmaningsflow gestopt' },

    // Pipeline-log (item.type = 'pipeline_<entry_type>')
    pipeline_stage_change   : { icon: '🔀', title: 'Fase gewijzigd' },
    pipeline_note           : { icon: '📝', title: 'Notitie (pipeline)' },
    pipeline_auto_event     : { icon: '⚙️', title: 'Pipeline-gebeurtenis' },
    pipeline_appointment    : { icon: '📅', title: 'Afspraak' },

    // Audit (item.type = 'audit_<action.replace(\W, "_")>')
    audit_customer_created   : { icon: '👤', title: 'Klant aangemaakt' },
    audit_customer_updated   : { icon: '👤', title: 'Klantgegevens bewerkt' },
    audit_customer_archived  : { icon: '📦', title: 'Klant gearchiveerd' },
    audit_customer_unarchived: { icon: '👤', title: 'Klant heractiveerd' },
    audit_customer_anonymized: { icon: '🕵️', title: 'Klant geanonimiseerd' },
    audit_customer_note_created  : { icon: '📝', title: 'Notitie toegevoegd' },
    audit_customer_note_updated  : { icon: '📝', title: 'Notitie bewerkt' },
    audit_customer_note_archived : { icon: '🗑️', title: 'Notitie gearchiveerd' },
    audit_dunning_pipeline_set_stage: { icon: '🔀', title: 'Fase gewijzigd' },
  };

  // Event-types die we volledig verbergen — motor-mechaniek zonder klant-
  // waarde. wait/stop_step/unknown_step_type/*_skipped_* horen niet in de
  // dossier-view. `wait` is 7 dagen niets-doen; `*_skipped_*` zijn interne
  // diagnose-events (geen recipient, geen infra, sandbox-guard, etc.).
  const HIDDEN_PREFIXES = [
    'dunning_wait',
    'dunning_stop_step',
    'dunning_unknown_step_type',
    'dunning_email_skipped_',
    'dunning_whatsapp_skipped_',
    'dunning_email_send_failed',
    'dunning_email_send_exception',
    'dunning_incasso_auto_skipped_wik',
  ];

  function isHidden(it) {
    if (!it || !it.type) return false;
    const t = String(it.type);
    for (const p of HIDDEN_PREFIXES) if (t.startsWith(p)) return true;
    return false;
  }

  function describe(it) {
    if (!it) return { icon: '•', title: 'Gebeurtenis' };
    const t = String(it.type || '');
    if (TYPE_LABELS[t]) return TYPE_LABELS[t];

    // Fallbacks per familie — nooit de rauwe key tonen.
    if (t.startsWith('task_'))        return { icon: '✅', title: 'Taak' };
    if (t.startsWith('arrangement_')) return { icon: '🤝', title: 'Betaalafspraak' };
    if (t.startsWith('audit_'))       return { icon: '📋', title: 'Klant-wijziging' };
    if (t.startsWith('pipeline_'))    return { icon: '⚙️', title: 'Pipeline-gebeurtenis' };
    if (t.startsWith('dunning_'))     return { icon: '⚙️', title: 'Aanmaning-gebeurtenis' };
    return { icon: '•', title: 'Gebeurtenis' };
  }

  window.WanbetalersTimeline = {
    describe,
    isHidden,
    DEFAULT_LIMIT: 3,
  };
})();
