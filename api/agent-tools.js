import { supabase, supabaseAdmin } from './supabase.js';
import { executeIdentifyPaymentConcerns } from './agent-tool-executor.js';

// ═══════════════════════════════════════════════════════════════════════════
// DATUM-HULPFUNCTIES
// ═══════════════════════════════════════════════════════════════════════════

function getDateRange(period) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  switch (period) {
    case 'today':
      return { from: todayStart.toISOString(), to: now.toISOString() };

    case 'yesterday': {
      const yStart = new Date(todayStart);
      yStart.setDate(yStart.getDate() - 1);
      const yEnd = new Date(todayStart);
      yEnd.setMilliseconds(-1);
      return { from: yStart.toISOString(), to: yEnd.toISOString() };
    }

    case 'this_week': {
      // Maandag als weekstart
      const dow = todayStart.getDay() || 7; // 0=zo → 7
      const mon = new Date(todayStart);
      mon.setDate(mon.getDate() - (dow - 1));
      return { from: mon.toISOString(), to: now.toISOString() };
    }

    case 'this_month': {
      const m = new Date(todayStart);
      m.setDate(1);
      return { from: m.toISOString(), to: now.toISOString() };
    }

    case 'last_7_days':
    default: {
      const w = new Date(now);
      w.setDate(w.getDate() - 7);
      return { from: w.toISOString(), to: now.toISOString() };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIES — Claude API format
// ═══════════════════════════════════════════════════════════════════════════

const TOOL_DEFINITIONS = {

  get_email_stats: {
    name: 'get_email_stats',
    description: 'Geeft statistieken over ontvangen e-mails direct uit email_messages (5000+ mails). Inclusief totaal per categorie, per mailbox, dagelijkse trend en vergelijking met vorige periode. Gebruik dit voor vragen over hoeveel mails er zijn binnengekomen, leads, factuurvragen, etc.',
    input_schema: {
      type: 'object',
      properties: {
        period_days: {
          type: 'integer',
          description: 'Aantal dagen terugkijken. Standaard: 7. Max: 90.',
        },
        mailbox: {
          type: 'string',
          enum: ['leads', 'info', 'partners', 'administratie'],
          description: 'Filter op één mailbox (optioneel — weglaten = alle mailboxen).',
        },
      },
      required: [],
    },
  },

  get_open_tasks: {
    name: 'get_open_tasks',
    description: 'Geeft de huidige open taken terug, met optionele filters op prioriteit. Gebruik dit als de gebruiker vraagt naar openstaande taken, urgente items, taken-overzicht, of taken per prioriteit.',
    input_schema: {
      type: 'object',
      properties: {
        priority: {
          type: 'string',
          enum: ['Urgent', 'Hoog', 'Normaal', 'Laag', 'all'],
          description: 'Filter op prioriteit. "all" = alle prioriteiten. Standaard: "all".',
        },
        limit: {
          type: 'integer',
          description: 'Maximum aantal taken om terug te geven. Standaard: 10.',
        },
      },
      required: [],
    },
  },

  search_emails: {
    name: 'search_emails',
    description: 'Zoekt e-mails in email_messages (5000+ mails) op onderwerp, afzender of naam. Geeft volledige context per mail: afzender, onderwerp, categorie, ontvangstdatum. Gebruik dit voor elke zoekvraag over mails.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Zoekterm — wordt vergeleken met onderwerp, afzender en naam.',
        },
        mailbox: {
          type: 'string',
          enum: ['leads', 'info', 'partners', 'administratie'],
          description: 'Filter op specifieke mailbox (optioneel).',
        },
        category: {
          type: 'string',
          description: 'Filter op categorie, bijv. "Nieuwe Lead", "Factuurvraag" (optioneel).',
        },
        since_days: {
          type: 'integer',
          description: 'Terugkijkperiode in dagen. Standaard: 30.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum aantal resultaten. Standaard: 10, max: 50.',
        },
        search_in_body: {
          type: 'boolean',
          description: 'Ook zoeken in body_text (trager). Standaard: false.',
        },
      },
      required: ['query'],
    },
  },

  get_unanswered_emails: {
    name: 'get_unanswered_emails',
    description: 'Geeft e-mails die nog niet beantwoord zijn: mails die in email_messages staan maar géén entry in email_replies hebben, uitgezonderd Reclame en Onbekend. Inclusief totaaltelling per categorie en leeftijd. Gebruik dit voor vragen over openstaande of onbeantwoorde mails.',
    input_schema: {
      type: 'object',
      properties: {
        days_old: {
          type: 'integer',
          description: 'Kijk terug dit aantal dagen. Standaard: 7.',
        },
        mailbox: {
          type: 'string',
          enum: ['leads', 'info', 'partners', 'administratie'],
          description: 'Filter op mailbox (optioneel).',
        },
        limit: {
          type: 'integer',
          description: 'Maximum aantal e-mails in de resultaten. Standaard: 20.',
        },
      },
      required: [],
    },
  },

  get_recent_corrections: {
    name: 'get_recent_corrections',
    description: 'Geeft een overzicht van recente correcties en trainingsinput — zowel categorisatie-correcties (wat Simon verkeerd heeft gecategoriseerd) als geleerde regels (wat Jeffrey Simon heeft geleerd via Train mij). Gebruik dit als de gebruiker vraagt wat Simon recent heeft bijgeleerd.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum aantal correcties per bron om terug te geven. Standaard: 10.',
        },
      },
      required: [],
    },
  },

  query_knowledge_base: {
    name: 'query_knowledge_base',
    description: 'Zoekt in de kennisbank naar relevante bedrijfsinformatie over een specifiek onderwerp. Gebruik dit als de gebruiker een vraag stelt waarvoor bedrijfskennis nodig is, zoals toon-van-stem, doelgroep, producten of prijzen.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Het onderwerp of de vraag om in de kennisbank op te zoeken.',
        },
      },
      required: ['topic'],
    },
  },

  get_email_categorization_stats: {
    name: 'get_email_categorization_stats',
    description: 'Geeft inzicht in de categorisatiekwaliteit: verdeling per categorie, gemiddelde zekerheid (category_confidence), en voorbeelden van mails met lage zekerheid (< 50). Gebruik dit als de gebruiker vraagt naar Simons accuracy of categorisatieprestaties.',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_7_days'],
          description: 'Periode waarover de statistieken worden berekend. Standaard: "last_7_days".',
        },
      },
      required: [],
    },
  },

  get_email_detail: {
    name: 'get_email_detail',
    description: 'Geeft volledige details van één specifieke e-mail op basis van ID. Gebruik dit als een ander tool een email_id heeft teruggegeven en je meer details wil, of als de gebruiker een specifieke mail wil bekijken. Geeft afzender, onderwerp, categorie, snippet (indien beschikbaar) en metadata.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: {
          type: 'string',
          description: 'UUID van de e-mail uit email_messages (formaat 8-4-4-4-12 hex, bijv. "9b0ae4c8-7f2e-4c1a-b890-1234abcd5678"). Verkrijgbaar via search_emails of get_unanswered_emails — gebruik nooit een volgnummer zoals "1".',
        },
      },
      required: ['email_id'],
    },
  },

  get_email_body: {
    name: 'get_email_body',
    description: 'Geeft de volledige berichttekst (body_text) van één e-mail op basis van ID. Gebruik dit na get_email_detail als je de inhoud van een mail moet lezen voor analyse of reply. Tekst wordt afgekapt op 8000 tekens. Als body nog niet beschikbaar is, geeft het de status terug.',
    input_schema: {
      type: 'object',
      properties: {
        email_id: {
          type: 'string',
          description: 'UUID van de e-mail uit email_messages (formaat 8-4-4-4-12 hex, bijv. "9b0ae4c8-7f2e-4c1a-b890-1234abcd5678"). Verkrijgbaar via search_emails of get_unanswered_emails — gebruik nooit een volgnummer zoals "1".',
        },
      },
      required: ['email_id'],
    },
  },

  add_knowledge_base_item: {
    name: 'add_knowledge_base_item',
    description: 'Voegt een nieuw item toe aan de kennisbank. GEBRUIK DEZE TOOL ALLEEN NA EXPLICIETE BEVESTIGING VAN DE GEBRUIKER. Toon altijd eerst een preview van wat je gaat opslaan en wacht op "ja", "doe maar", "sla op" of vergelijkbare bevestiging. Roep deze tool NOOIT aan zonder expliciete toestemming.',
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Titel van het kennisbank-item (niet leeg).',
        },
        content: {
          type: 'string',
          description: 'De daadwerkelijke inhoud of uitleg (minimaal 20, maximaal 5000 tekens).',
        },
        category: {
          type: 'string',
          enum: ['Klantvraag', 'Factuurvraag', 'Klacht', 'FAQ', 'Algemeen'],
          description: 'Categorie van het item.',
        },
        direction: {
          type: 'string',
          enum: ['inkomend', 'uitgaand', 'beide'],
          description: 'Voor inkomende of uitgaande communicatie. Standaard: "beide".',
        },
      },
      required: ['title', 'content', 'category'],
    },
  },



  // ── C2 — Simon schrijf-tools (via approval) ─────────────────────────────

  send_email_reply: {
    name: 'send_email_reply',
    description: 'Stel een e-mailreply op ter goedkeuring van Jeffrey. De tool maakt automatisch een approval-request aan — Jeffrey moet goedkeuren voordat de mail daadwerkelijk wordt verzonden. Gebruik ALLEEN als Jeffrey expliciet vraagt om een reply. Geeft { pending_approval: true, approval_id } terug.',
    input_schema: {
      type: 'object',
      properties: {
        email_id:     { type: 'string', description: 'UUID van de originele e-mail (optioneel). Formaat: 8-4-4-4-12 hex.' },
        to:           { type: 'string', description: 'Ontvanger e-mailadres.' },
        subject:      { type: 'string', description: 'Onderwerp van de reply.' },
        body:         { type: 'string', description: 'Volledige tekst van de reply.' },
        from_mailbox: { type: 'string', description: 'Verzendmailbox (optioneel).' },
      },
      required: ['body'],
    },
  },

  schedule_email_followup: {
    name: 'schedule_email_followup',
    description: 'Plan een follow-up herinnering als taak. Maakt een approval-request aan voor Jeffrey. Geeft { pending_approval: true } terug.',
    input_schema: {
      type: 'object',
      properties: {
        email_id:      { type: 'string', description: 'UUID van de e-mail (optioneel). Formaat: 8-4-4-4-12 hex.' },
        delay_hours:   { type: 'integer', description: 'Uren tot follow-up (standaard: 24).' },
        reminder_text: { type: 'string', description: 'Beschrijving van de follow-up taak.' },
      },
      required: ['reminder_text'],
    },
  },

  add_decision_to_log: {
    name: 'add_decision_to_log',
    description: 'Registreer een beslissing in het beslissingslog. Maakt een approval-request aan voor Jeffrey. Geeft { pending_approval: true } terug.',
    input_schema: {
      type: 'object',
      properties: {
        titel:            { type: 'string', description: 'Korte titel van de beslissing.' },
        beschrijving:     { type: 'string', description: 'Uitgebreide omschrijving (optioneel).' },
        onderbouwing:     { type: 'string', description: 'Waarom is deze beslissing genomen? (optioneel).' },
        betrokken_agents: {
          description: 'Agent(s) betrokken bij de beslissing.',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        meeting_id: { type: 'string', description: 'UUID van gerelateerde vergadering (optioneel).' },
      },
      required: ['titel'],
    },
  },

  create_meeting_followup: {
    name: 'create_meeting_followup',
    description: 'Maak een concept follow-up vergadering aan. Maakt een approval-request aan voor Jeffrey. Geeft { pending_approval: true } terug.',
    input_schema: {
      type: 'object',
      properties: {
        topic:              { type: 'string', description: 'Onderwerp van de follow-up vergadering.' },
        deelnemende_agents: { type: 'array', items: { type: 'string' }, description: 'Namen van deelnemende agents.' },
        voorgestelde_datum: { type: 'string', description: 'Voorgestelde datum (YYYY-MM-DD, optioneel).' },
        agenda_notities:    { type: 'string', description: 'Agenda-notities (optioneel).' },
      },
      required: ['topic'],
    },
  },

  // ── C3 — Aron tools ──────────────────────────────────────────────────────

  identify_payment_concerns: {
    name: 'identify_payment_concerns',
    description: 'Identificeer e-mails in de categorie "Factuurvraag" die mogelijk een openstaande betaling signaleren. Dit is een read-only analyse — geen goedkeuring vereist. Geeft direct een lijst van relevante e-mails terug. DISCLAIMER: gebaseerd op e-mailcategorisering, niet op Mollie of boekhouddata.',
    input_schema: {
      type: 'object',
      properties: {
        since_days:      { type: 'integer', description: 'Terugkijkperiode in dagen (standaard: 14).' },
        include_replied: { type: 'boolean', description: 'Inclusief al beantwoorde e-mails (standaard: false).' },
      },
      required: [],
    },
  },

  draft_payment_reminder: {
    name: 'draft_payment_reminder',
    description: 'Stel conceptbetalingsherinneringen op voor een lijst van e-mails. Maakt een approval-request aan — Jeffrey keurt elk concept goed voordat het wordt verzonden. Geeft { pending_approval: true } terug. DISCLAIMER: niet gebaseerd op werkelijke openstaande facturen.',
    input_schema: {
      type: 'object',
      properties: {
        email_ids:   { type: 'array', items: { type: 'string' }, description: 'Lijst van e-mail UUIDs (formaat 8-4-4-4-12 hex). Verkrijgbaar via identify_payment_concerns of search_emails.' },
        tone:        { type: 'string', enum: ['friendly', 'formal', 'urgent'], description: 'Toon (standaard: "friendly").' },
        custom_note: { type: 'string', description: 'Extra tekst die in elke herinnering wordt opgenomen (optioneel).' },
      },
      required: ['email_ids'],
    },
  },

  mark_invoice_followup: {
    name: 'mark_invoice_followup',
    description: 'Maak een follow-up taak aan voor een factuurvraag-e-mail. Maakt een approval-request aan voor Jeffrey. Geeft { pending_approval: true } terug.',
    input_schema: {
      type: 'object',
      properties: {
        email_id:      { type: 'string', description: 'UUID van de e-mail uit email_messages (formaat 8-4-4-4-12 hex). Verkrijgbaar via identify_payment_concerns of search_emails.' },
        followup_date: { type: 'string', description: 'Datum van de follow-up (YYYY-MM-DD).' },
        notes:         { type: 'string', description: 'Optionele notities.' },
      },
      required: ['email_id'],
    },
  },

  // ── C3 — Leon tools ──────────────────────────────────────────────────────

  create_task_for_contract: {
    name: 'create_task_for_contract',
    description: 'Maak een taak aan voor een contract of onboarding-proces. Maakt een approval-request aan voor Jeffrey. Geeft { pending_approval: true } terug.',
    input_schema: {
      type: 'object',
      properties: {
        task_title:       { type: 'string', description: 'Titel van de taak.' },
        contract_subject: { type: 'string', description: 'Omschrijving van het contract of proces.' },
        related_email_id: { type: 'string', description: 'UUID van de gerelateerde e-mail (optioneel). Formaat: 8-4-4-4-12 hex.' },
        deadline:         { type: 'string', description: 'Deadline (YYYY-MM-DD, optioneel).' },
        assignee_name:    { type: 'string', description: 'Naam van de toe te wijzen persoon (optioneel).' },
        notes:            { type: 'string', description: 'Aanvullende notities (optioneel).' },
      },
      required: ['task_title'],
    },
  },

  update_task_status: {
    name: 'update_task_status',
    description: 'Pas de status van een bestaande taak aan. Maakt een approval-request aan voor Jeffrey. Geeft { pending_approval: true } terug.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:    { type: 'string', description: 'UUID van de taak.' },
        new_status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'afgerond'], description: 'Nieuwe status.' },
        notes:      { type: 'string', description: 'Optionele notitie bij de statuswijziging.' },
      },
      required: ['task_id', 'new_status'],
    },
  },

  bulk_categorize_review: {
    name: 'bulk_categorize_review',
    description: 'Analyseer e-mails met lage categorisatiezekerheid en stel verbeterde categorieën voor. Maakt een approval-request aan — Jeffrey keurt elke suggestie goed voordat de categorie wordt aangepast. Geeft { pending_approval: true } terug.',
    input_schema: {
      type: 'object',
      properties: {
        confidence_threshold: { type: 'integer', description: 'Max confidence-score om op te nemen (0-100, standaard: 50).' },
        limit:                { type: 'integer', description: 'Max e-mails om te analyseren (standaard: 20).' },
      },
      required: [],
    },
  },

};

// ═══════════════════════════════════════════════════════════════════════════
// TAGS — koppeling tool → agent
// ═══════════════════════════════════════════════════════════════════════════
// Elke tool heeft tags; elke agent heeft een tag-lijst.
// getToolsForAgent geeft alle tools terug die minstens één tag
// gemeenschappelijk hebben met de agent.

const TOOL_TAGS = {
  // Read-tools
  get_email_stats:                ['email'],
  get_open_tasks:                 ['tasks'],
  search_emails:                  ['email'],
  get_unanswered_emails:          ['email'],
  get_recent_corrections:         ['email', 'learning'],
  query_knowledge_base:           ['knowledge'],
  get_email_categorization_stats: ['email', 'learning'],
  get_email_detail:               ['email'],          // Fase 3 — nieuw
  get_email_body:                 ['email'],          // Fase 2 — body-fetch
  // Schrijf-tool
  add_knowledge_base_item:        ['knowledge_write'],
  // C2 — Simon schrijf-tools
  send_email_reply:               ['email_write'],
  schedule_email_followup:        ['email_write'],
  add_decision_to_log:            ['decisions_write'],
  create_meeting_followup:        ['meetings_write'],
  // C3 — Aron tools
  identify_payment_concerns:      ['payment_read'],
  draft_payment_reminder:         ['payment_write'],
  mark_invoice_followup:          ['payment_write'],
  // C3 — Leon tools
  create_task_for_contract:       ['tasks_write'],
  update_task_status:             ['tasks_write'],
  bulk_categorize_review:         ['categorize_write'],
};

const AGENT_TAGS = {
  Simon: ['email', 'tasks', 'knowledge', 'learning', 'knowledge_write',
          'email_write', 'decisions_write', 'meetings_write'],
  // Leon en Aron krijgen 'email' tag zodat ze search_emails en get_email_detail
  // kunnen gebruiken voor contract- en betalingscontext
  Leon:  ['email', 'tasks', 'tasks_write', 'decisions_write', 'meetings_write', 'categorize_write'],
  Aron:  ['email', 'tasks', 'payment_read', 'payment_write', 'decisions_write', 'meetings_write'],
};

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIEKE API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Geeft de tool-definities terug die relevant zijn voor een specifieke agent.
 * Gebaseerd op tag-overlap — uitbreidbaar voor toekomstige agents.
 */
export function getToolsForAgent(agentName) {
  const agentTagSet = new Set(AGENT_TAGS[agentName] || []);
  if (agentTagSet.size === 0) return [];
  return Object.values(TOOL_DEFINITIONS).filter(tool => {
    const toolTags = TOOL_TAGS[tool.name] || [];
    return toolTags.some(t => agentTagSet.has(t));
  });
}

/**
 * Voert een tool uit op basis van naam en input.
 * Voor schrijf-tools: maakt een approval-request aan en geeft { pending_approval: true } terug.
 * @param {string} toolName
 * @param {object} input
 * @param {string} agentName — naam van de aanroepende agent (voor approval-record)
 */
export async function execute(toolName, input, agentName = 'system') {
  console.log(`[agent-tools] execute: ${toolName} | agent: ${agentName} |`, JSON.stringify(input));
  const i = input || {};
  switch (toolName) {
    // ── Read-tools ──────────────────────────────────────────────────────────
    case 'get_email_stats':                return executeGetEmailStats(i);
    case 'get_open_tasks':                 return executeGetOpenTasks(i);
    case 'search_emails':                  return executeSearchEmails(i);
    case 'get_unanswered_emails':          return executeGetUnansweredEmails(i);
    case 'get_recent_corrections':         return executeGetRecentCorrections(i);
    case 'query_knowledge_base':           return executeQueryKnowledgeBase(i);
    case 'get_email_categorization_stats': return executeGetEmailCategorizationStats(i);
    case 'get_email_detail':               return executeGetEmailDetail(i);       // Fase 3
    case 'get_email_body':                 return executeGetEmailBody(i);         // Fase 2
    // ── Bestaande schrijf-tool (al met eigen bevestigingsprotocol in system prompt) ──
    case 'add_knowledge_base_item':        return executeAddKnowledgeBaseItem(i);

    // ── C2 — Simon schrijf-tools (via approval) ─────────────────────────────
    case 'send_email_reply': {
      const { to, subject, body } = i;
      const title = subject ? `Reply: ${subject}` : (to ? `Reply naar ${to}` : 'E-mailreply');
      return createApprovalRequest(agentName, 'send_email_reply', title,
        `Concept reply${to ? ' naar ' + to : ''}`, [i], 24);
    }
    case 'schedule_email_followup': {
      const { reminder_text, delay_hours = 24 } = i;
      return createApprovalRequest(agentName, 'schedule_email_followup',
        `Follow-up: ${reminder_text}`, `Herinnering over ${delay_hours}u`, [i], 48);
    }
    case 'add_decision_to_log': {
      const { titel } = i;
      return createApprovalRequest(agentName, 'add_decision_to_log',
        `Beslissing: ${titel}`, i.beschrijving || null, [i], 168);
    }
    case 'create_meeting_followup': {
      const { topic } = i;
      return createApprovalRequest(agentName, 'create_meeting_followup',
        `Follow-up vergadering: ${topic}`, i.agenda_notities || null, [i], 168);
    }

    // ── C3 — Aron read-tool (direct uitvoeren) ───────────────────────────────
    case 'identify_payment_concerns':
      return executeIdentifyPaymentConcerns(i);

    // ── C3 — Aron schrijf-tools ──────────────────────────────────────────────
    case 'draft_payment_reminder': {
      const { email_ids, tone = 'friendly', custom_note } = i;
      const ids = Array.isArray(email_ids) ? email_ids : [email_ids].filter(Boolean);
      if (!ids.length) return { ok: false, error: 'Geen email_ids opgegeven.' };
      // Haal e-mailinfo op voor de concepten
      const { data: emails } = await supabase.from('email_messages')
        .select('id, from_address, from_name, subject').in('id', ids);
      const emailMap = Object.fromEntries((emails || []).map(e => [String(e.id), e]));
      const previewItems = ids.map(eid => {
        const email = emailMap[String(eid)] || {};
        const body = buildReminderBody(email.from_name, tone, custom_note);
        return {
          email_id: eid,
          to:       email.from_address || null,
          subject:  `Re: ${email.subject || 'Openstaande factuur'}`,
          body,
          tone,
        };
      });
      const title = `Betalingsherinneringen (${previewItems.length} mail${previewItems.length > 1 ? 's' : ''})`;
      return createApprovalRequest(agentName, 'send_email_reply', title,
        `Toon: ${tone} — concepten voor goedkeuring`, previewItems, 48);
    }
    case 'mark_invoice_followup': {
      const { email_id, followup_date, notes } = i;
      const title = `Factuur follow-up${followup_date ? ' voor ' + followup_date : ''}`;
      return createApprovalRequest(agentName, 'mark_invoice_followup', title,
        notes || `Follow-up voor e-mail #${email_id}`, [i], 72);
    }

    // ── C3 — Leon schrijf-tools ──────────────────────────────────────────────
    case 'create_task_for_contract': {
      const { task_title } = i;
      return createApprovalRequest(agentName, 'create_task_for_contract',
        `Taak: ${task_title}`, i.contract_subject || null, [i], 168);
    }
    case 'update_task_status': {
      const { task_id, new_status } = i;
      return createApprovalRequest(agentName, 'update_task_status',
        `Status → ${new_status}`, `Taak ${task_id}`, [i], 48);
    }
    case 'bulk_categorize_review': {
      const threshold = Math.min(Math.max(parseInt(i.confidence_threshold) || 50, 0), 100);
      const lim       = Math.min(Math.max(parseInt(i.limit) || 20, 1), 50);
      // email_messages werkelijke kolomnamen: snippet, category_confidence, date_received
      const { data: emails } = await supabase.from('email_messages')
        .select('id, from_address, subject, snippet, category, category_confidence')
        .lt('category_confidence', threshold)
        .not('category', 'is', null)
        .order('date_received', { ascending: false })
        .limit(lim);
      if (!emails?.length) {
        return { ok: true, message: `Geen e-mails gevonden met category_confidence < ${threshold}.`, count: 0 };
      }
      const previewItems = emails.map(e => ({
        email_id:      String(e.id),
        subject:       e.subject || '(geen onderwerp)',
        from_address:  e.from_address || '(onbekend)',
        current_cat:   e.category,
        confidence:    e.category_confidence,
        snippet:       e.snippet?.slice(0, 100) || '',
        suggested_cat: suggestCategory(e.subject || '', e.snippet || '', e.category),
      }));
      const title = `Categorisatie-review (${previewItems.length} mails, confidence < ${threshold})`;
      return createApprovalRequest(agentName, 'bulk_categorize_review', title,
        'Stel verbeterde categorieën voor ter goedkeuring', previewItems, 168);
    }

    default:
      throw new Error(`Onbekende tool: "${toolName}"`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Maakt een approval-record aan in agent_approval_queue en geeft het
 * pending_approval token terug zodat agent-chat.js het kan doorsturen.
 */
async function createApprovalRequest(agentName, actionType, title, description, previewData, expiresHours = 168) {
  const expiresAt = new Date(Date.now() + expiresHours * 3600000).toISOString();
  const { data, error } = await supabase.from('agent_approval_queue').insert({
    agent_name:   agentName,
    action:       actionType,
    payload:      { title, preview_data: previewData || [] },
    description:  description || null,
    requested_by: 'agent',
    status:       'pending',
    created_at:   new Date().toISOString(),
    expires_at:   expiresAt,
  }).select('id').single();

  if (error) throw new Error(`Approval aanmaken mislukt: ${error.message}`);

  console.log(`[agent-tools] approval aangemaakt: ${data.id} (${agentName}/${actionType})`);
  return {
    pending_approval: true,
    approval_id:      data.id,
    action_type:      actionType,
    title,
    description,
    preview:          previewData,
  };
}

/**
 * Bouw een betalingsherinnering-tekst op basis van toon en naam.
 */
function buildReminderBody(fromName, tone, customNote) {
  const aanhef = fromName ? `Geachte ${fromName},` : 'Geachte relatie,';
  let body;
  if (tone === 'urgent') {
    body = `Wij verzoeken u dringend de openstaande betaling zo spoedig mogelijk te voldoen.`;
  } else if (tone === 'formal') {
    body = `Wij verwijzen u beleefd naar de openstaande factuur waarvoor wij nog geen betaling hebben ontvangen.`;
  } else {
    body = `Wij hopen dat alles goed met u gaat. Hierbij een vriendelijke herinnering omtrent de openstaande factuur.`;
  }
  return [aanhef, '', body, customNote ? customNote : '', '', 'Met vriendelijke groet,', 'De Forex Opleiding']
    .filter(line => line !== undefined).join('\n').trim();
}

/**
 * Eenvoudige heuristiek voor e-mailcategoriesuggessties.
 */
function suggestCategory(subject, snippet, currentCat) {
  const text = (subject + ' ' + snippet).toLowerCase();
  if (/factuur|betaling|invoice|payment|rekening/.test(text)) return 'Factuurvraag';
  if (/klacht|probleem|issue|complaint|ontevreden/.test(text)) return 'Klacht';
  if (/lead|interesse|aanmeld|info aanvraag/.test(text))       return 'Nieuwe Lead';
  if (/afspraak|appointment|gesprek|bellen/.test(text))         return 'Afspraakaanvraag';
  if (/vraag|hulp|ondersteuning|support/.test(text))            return 'Klantvraag';
  return currentCat || 'Klantvraag';
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATIES
// ═══════════════════════════════════════════════════════════════════════════
//
// email_messages werkelijk schema (bron: sync-emails.js / backfill-emails.js)
// ─────────────────────────────────────────────────────────────────────────
// id (bigint auto) | mailbox (text) | imap_uid (bigint)
// from_address (text) | from_name (text) | subject (text)
// date_received (timestamptz)   ← LET OP: NIET received_at
// snippet (text, nullable)      ← LET OP: NIET body_snippet (nu null voor alle mails)
// category (text) | requires_action (bool)
// category_confidence (int 0-100) ← LET OP: NIET confidence
// category_reason (text) | is_read (bool)
// Indexen: (mailbox, date_received DESC), (category)
// ─────────────────────────────────────────────────────────────────────────
// db-migrate.js CREATE TABLE gebruikt oudere namen (received_at, body_snippet,
// confidence, ai_source) — die definitie is verouderd t.o.v. de live tabel.

async function executeGetEmailStats({ period_days, mailbox } = {}) {
  // Fase 3: directe query op email_messages
  const days  = Math.min(Math.max(parseInt(period_days) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const prevSince = new Date(Date.now() - days * 2 * 86400000).toISOString();

  let qCurr = supabase
    .from('email_messages')
    .select('id, category, mailbox, date_received')
    .gte('date_received', since)
    .limit(2000);
  if (mailbox) qCurr = qCurr.eq('mailbox', mailbox);

  let qPrev = supabase
    .from('email_messages')
    .select('id')
    .gte('date_received', prevSince)
    .lt('date_received', since)
    .limit(2000);
  if (mailbox) qPrev = qPrev.eq('mailbox', mailbox);

  const [currRes, prevRes] = await Promise.allSettled([qCurr, qPrev]);
  const current = currRes.status === 'fulfilled' ? (currRes.value.data || []) : [];
  const prev    = prevRes.status === 'fulfilled' ? (prevRes.value.data || []) : [];

  // Aggregaten
  const byCategory = {};
  const byMailbox  = {};
  const byDay      = {};

  for (const m of current) {
    const cat = m.category || 'Onbekend';
    byCategory[cat]    = (byCategory[cat]    || 0) + 1;
    byMailbox[m.mailbox] = (byMailbox[m.mailbox] || 0) + 1;
    const day = (m.date_received || '').slice(0, 10);
    if (day) byDay[day] = (byDay[day] || 0) + 1;
  }

  const daily_trend = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  const prevCount = prev.length;
  const currCount = current.length;
  const pctChange = prevCount > 0
    ? Math.round(((currCount - prevCount) / prevCount) * 100)
    : null;

  console.log(`[agent-tools] get_email_stats: ${currCount} mails in ${days}d, prev=${prevCount}`);

  return {
    period_days: days,
    date_from:   since.slice(0, 10),
    mailbox_filter: mailbox || 'alle',
    total_received: currCount,
    by_category:  byCategory,
    by_mailbox:   byMailbox,
    daily_trend,
    comparison_to_previous_period: {
      previous_count: prevCount,
      current_count:  currCount,
      change_pct:     pctChange,
      direction:      pctChange === null ? 'onbekend'
                    : pctChange > 0 ? 'stijging'
                    : pctChange < 0 ? 'daling'
                    : 'gelijk',
    },
  };
}

async function executeSearchEmails({ query, mailbox, category, since_days = 30, limit = 10, search_in_body = false } = {}) {
  // Fase 3: directe query op email_messages (5000+ mails)
  const lim   = Math.min(Math.max(parseInt(limit) || 10, 1), 50);
  const days  = Math.min(Math.max(parseInt(since_days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const term  = `%${query}%`;

  const orFilter = search_in_body
    ? `subject.ilike.${term},from_address.ilike.${term},from_name.ilike.${term},body_text.ilike.${term}`
    : `subject.ilike.${term},from_address.ilike.${term},from_name.ilike.${term}`;

  let q = supabase
    .from('email_messages')
    .select('id, mailbox, from_address, from_name, subject, snippet, date_received, category, category_confidence, requires_action')
    .or(orFilter)
    .gte('date_received', since)
    .order('date_received', { ascending: false })
    .limit(lim);

  if (mailbox)  q = q.eq('mailbox', mailbox);
  if (category) q = q.eq('category', category);

  const { data, error } = await q;
  if (error) throw new Error('email_messages search fout: ' + error.message);

  console.log(`[agent-tools] search_emails: query="${query}" → ${(data||[]).length} resultaten`);

  return {
    query,
    period_days:  days,
    mailbox_filter: mailbox  || 'alle',
    category_filter: category || 'alle',
    count:        (data || []).length,
    results:      (data || []).map(m => ({
      id:                   m.id,
      mailbox:              m.mailbox,
      sender:               m.from_address,
      sender_name:          m.from_name,
      subject:              m.subject,
      received_at:          m.date_received,
      category:             m.category,
      category_confidence:  m.category_confidence,
      requires_action:      m.requires_action,
      snippet:              m.snippet || null,
    })),
    search_in_body,
    note: search_in_body
      ? 'body_text is beschikbaar voor mails die al backfilled zijn.'
      : 'Gebruik search_in_body:true om ook in de berichttekst te zoeken (trager).',
  };
}

async function executeGetUnansweredEmails({ days_old = 7, mailbox, limit = 20 } = {}) {
  // Fase 3: directe query op email_messages + cross-check met email_replies
  const lim   = Math.min(Math.max(parseInt(limit) || 20, 1), 50);
  const days  = Math.min(Math.max(parseInt(days_old) || 7, 1), 90);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  // Stap 1: haal kandidaten op — geen Reclame, geen Onbekend, geen Spam
  const SKIP_CATS = ['Reclame', 'Onbekend', 'Spam', 'Nieuwsbrief'];

  let q = supabase
    .from('email_messages')
    .select('id, mailbox, from_address, from_name, subject, date_received, category, category_confidence, requires_action')
    .not('category', 'in', `(${SKIP_CATS.join(',')})`)
    .not('category', 'is', null)
    .gte('date_received', since)
    .order('date_received', { ascending: true })  // oudste eerst = meest urgent
    .limit(lim * 4);                               // ruimere pool voor reply-filter

  if (mailbox) q = q.eq('mailbox', mailbox);

  const { data: candidates, error } = await q;
  if (error) throw new Error('email_messages query fout: ' + error.message);

  // Stap 2: cross-check met email_replies (beantwoorde mails uitsluiten)
  const ids = (candidates || []).map(m => String(m.id));
  let repliedIds = new Set();
  if (ids.length > 0) {
    const { data: replied } = await supabase
      .from('email_replies')
      .select('email_id')
      .in('email_id', ids);
    repliedIds = new Set((replied || []).map(r => String(r.email_id)));
  }

  const unanswered = (candidates || []).filter(m => !repliedIds.has(String(m.id)));

  // Aggregaten
  const byCategory = {};
  for (const m of unanswered) {
    const cat = m.category || 'Onbekend';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  const oldest = unanswered[0];
  const oldestDays = oldest
    ? Math.floor((Date.now() - new Date(oldest.date_received).getTime()) / 86400000)
    : 0;

  console.log(`[agent-tools] get_unanswered_emails: ${unanswered.length} open van ${(candidates||[]).length} kandidaten`);

  return {
    total_count:     unanswered.length,
    period_days:     days,
    mailbox_filter:  mailbox || 'alle',
    by_category:     byCategory,
    oldest_age_days: oldestDays,
    emails:          unanswered.slice(0, lim).map(m => ({
      id:                  m.id,
      mailbox:             m.mailbox,
      sender:              m.from_address,
      sender_name:         m.from_name,
      subject:             m.subject,
      received_at:         m.date_received,
      category:            m.category,
      category_confidence: m.category_confidence,
      requires_action:     m.requires_action,
    })),
    note: 'Onbeantwoord = geen entry in email_replies. Reclame, Onbekend, Spam en Nieuwsbrief zijn uitgesloten.',
  };
}

async function executeGetRecentCorrections({ limit = 10 }) {
  const lim = Math.min(Math.max(parseInt(limit) || 10, 1), 30);

  const [corrRes, learnRes] = await Promise.allSettled([
    supabase.from('learn_examples')
      .select('email_id, sender_domain, old_category, correction_type, created_at')
      .order('created_at', { ascending: false }).limit(lim),
    supabase.from('agent_learnings')
      .select('trigger_text, ideal_response, created_at')
      .eq('agent_name', 'Simon')
      .order('created_at', { ascending: false }).limit(lim),
  ]);

  const corrections = corrRes.status  === 'fulfilled' ? (corrRes.value.data  || []) : [];
  const learnings   = learnRes.status === 'fulfilled' ? (learnRes.value.data || []) : [];

  return {
    categorisatie_correcties: corrections.map(c => ({
      email_id:      c.email_id,
      domein:        c.sender_domain,
      oud_categorie: c.old_category,
      type:          c.correction_type,
      op:            c.created_at,
    })),
    training_inputs: learnings.map(l => ({
      context: l.trigger_text.slice(0, 120),
      ideaal:  l.ideal_response.slice(0, 200),
      op:      l.created_at,
    })),
  };
}

async function executeQueryKnowledgeBase({ topic, agent }) {
  // Nieuwe kb_items tabel. Scope optioneel per agent.
  const term = `%${topic}%`;
  const agentClause = (agent && ['simon','lisa','leon','aron'].includes(agent))
    ? `agents.cs.{${agent}}` : null;
  let q = supabase
    .from('kb_items')
    .select('title, content, question, answer, agents, is_profile, helpfulness_score, times_used')
    .or(`title.ilike.${term},content.ilike.${term},question.ilike.${term},answer.ilike.${term}`)
    .order('helpfulness_score', { ascending: false, nullsFirst: false })
    .limit(5);
  if (agentClause) q = q.or(`${agentClause},agents.cs.{shared},is_profile.eq.true`);

  const { data, error } = await q;
  if (error) throw new Error('kb_items query fout: ' + error.message);

  return {
    topic,
    agent: agent || null,
    count: (data || []).length,
    results: (data || []).map(item => ({
      title:             item.title,
      agents:            item.agents,
      is_profile:        item.is_profile,
      content:           (item.content || item.answer || '')?.slice(0, 300),
      helpfulness_score: item.helpfulness_score,
    })),
  };
}

async function executeAddKnowledgeBaseItem({ title, content, category, direction = 'beide' }) {
  // Validatie
  const t = title?.trim()   || '';
  const c = content?.trim() || '';
  if (!t)          return { ok: false, error: 'Titel mag niet leeg zijn.' };
  if (c.length < 20)  return { ok: false, error: 'Inhoud moet minimaal 20 tekens bevatten.' };
  if (c.length > 5000) return { ok: false, error: 'Inhoud mag maximaal 5000 tekens bevatten.' };

  // Nieuwe kb_items tabel. Default: gedeeld met alle agents ('shared').
  const { data, error } = await supabase
    .from('kb_items')
    .insert({
      title:             t,
      content:           c,
      agents:            ['shared'],
      helpfulness_score: 50,
      auto_generated:    true,
    })
    .select('id')
    .single();

  if (error) return { ok: false, error: 'Opslaan mislukt: ' + error.message };

  return {
    ok:      true,
    id:      data.id,
    message: `Toegevoegd aan kennisbank: "${t}"`,
  };
}

async function executeGetEmailCategorizationStats({ period = 'last_7_days' } = {}) {
  // Fase 3: directe query op email_messages voor category + category_confidence
  const { from, to } = getDateRange(period);

  const [msgsRes, corrRes] = await Promise.allSettled([
    supabase.from('email_messages')
      .select('id, category, category_confidence')
      .gte('date_received', from)
      .lte('date_received', to)
      .limit(2000),
    supabase.from('learn_examples')
      .select('old_category, correction_type, created_at')
      .gte('created_at', from)
      .lte('created_at', to),
  ]);

  const msgs        = msgsRes.status === 'fulfilled' ? (msgsRes.value.data || []) : [];
  const corrections = corrRes.status === 'fulfilled' ? (corrRes.value.data || []) : [];

  const byCategory     = {};
  let   totalConf      = 0;
  let   lowConfCount   = 0;
  const lowConfExamples = [];

  for (const m of msgs) {
    const cat  = m.category || 'Onbekend';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    const conf = m.category_confidence ?? 0;
    totalConf += conf;
    if (conf < 50) {
      lowConfCount++;
      if (lowConfExamples.length < 5) {
        lowConfExamples.push({ id: m.id, category: cat, confidence: conf });
      }
    }
  }

  const corrTypes = {};
  for (const c of corrections) {
    const key = c.correction_type || 'onbekend';
    corrTypes[key] = (corrTypes[key] || 0) + 1;
  }

  console.log(`[agent-tools] get_email_categorization_stats: ${msgs.length} mails, lowConf=${lowConfCount}`);

  return {
    period,
    date_range:            { from: from.slice(0, 16), to: to.slice(0, 16) },
    total:                 msgs.length,
    by_category:           byCategory,
    average_confidence:    msgs.length ? Math.round(totalConf / msgs.length) : 0,
    low_confidence_count:  lowConfCount,
    low_confidence_examples: lowConfExamples,
    correcties_in_periode: corrections.length,
    correctie_types:       corrTypes,
    note:                  'category_confidence is integer 0-100. Grenswaarde lage zekerheid: < 50.',
  };
}

function isValidUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

async function executeGetEmailDetail({ email_id } = {}) {
  if (!email_id) return { error: 'email_id is verplicht' };
  if (!isValidUuid(email_id)) return { error: `email_id '${email_id}' is geen geldige UUID. Gebruik search_emails of get_unanswered_emails om actuele IDs op te halen — geen volgnummers zoals "1".` };

  const { data, error } = await supabase
    .from('email_messages')
    .select('id, mailbox, imap_uid, from_address, from_name, subject, date_received, snippet, body_text, body_fetched_at, category, category_confidence, category_reason, requires_action, is_read')
    .eq('id', email_id)
    .maybeSingle();

  if (error) throw new Error('email_messages detail-query fout: ' + error.message);
  if (!data)  return { error: `E-mail #${email_id} niet gevonden in email_messages` };

  console.log(`[agent-tools] get_email_detail: id=${email_id} → ${data.subject}`);

  return {
    id:                  data.id,
    mailbox:             data.mailbox,
    imap_uid:            data.imap_uid,
    sender:              data.from_address,
    sender_name:         data.from_name,
    subject:             data.subject,
    received_at:         data.date_received,
    category:            data.category,
    category_confidence: data.category_confidence,
    category_reason:     data.category_reason,
    requires_action:     data.requires_action,
    is_read:             data.is_read,
    snippet:             data.snippet || null,
    body_preview:        data.body_text?.slice(0, 500) || data.snippet?.slice(0, 300) || null,
    body_available:      !!data.body_fetched_at,
    note: data.body_fetched_at
      ? null
      : 'Body nog niet opgehaald — gebruik get_email_body voor actuele status of wacht tot backfill klaar is.',
  };
}

async function executeGetEmailBody({ email_id } = {}) {
  if (!email_id) return { error: 'email_id is verplicht' };
  if (!isValidUuid(email_id)) return { error: `email_id '${email_id}' is geen geldige UUID. Gebruik search_emails of get_unanswered_emails om actuele IDs op te halen — geen volgnummers zoals "1".` };

  const { data, error } = await supabase
    .from('email_messages')
    .select('id, subject, body_text, body_fetched_at, body_truncated, body_fetch_error')
    .eq('id', email_id)
    .maybeSingle();

  if (error) throw new Error('body-query fout: ' + error.message);
  if (!data)  return { error: `E-mail #${email_id} niet gevonden in email_messages` };

  const text = data.body_text?.slice(0, 8000) || null;
  console.log(`[agent-tools] get_email_body: id=${email_id} → ${text ? text.length + ' tekens' : 'geen body'}`);

  return {
    id:           data.id,
    subject:      data.subject,
    body_text:    text,
    truncated:    (text?.length ?? 0) >= 8000,
    body_fetched: !!data.body_fetched_at,
    note: !data.body_fetched_at
      ? (data.body_fetch_error
          ? `Body-fetch fout: ${data.body_fetch_error}`
          : 'Body nog niet opgehaald — backfill-cron loopt nog. Probeer later opnieuw.')
      : null,
  };
}

async function executeGetOpenTasks({ priority = 'all', limit = 10 }) {
  let query = supabaseAdmin
    .from('taken_items')
    .select('titel, omschrijving, notities, prioriteit, status, deadline, assigned_to_id, categorie')
    .eq('status', 'todo')
    .limit(Math.min(Math.max(parseInt(limit) || 10, 1), 50));

  if (priority !== 'all') {
    query = query.eq('prioriteit', priority);
  }

  // Sortering: deadline vroegst eerst, dan op aangemaakt
  // (geen priority-sort via Supabase JS in één call — doe in JS)
  const { data, error } = await query;
  if (error) throw new Error('taken_items query fout: ' + error.message);

  // Name-enrich assignees voor LLM-context.
  const ids = [...new Set((data || []).map(t => t.assigned_to_id).filter(Boolean))];
  let nameMap = {};
  if (ids.length) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles').select('id, full_name, email').in('id', ids);
    for (const p of profiles || []) nameMap[p.id] = p.full_name || p.email || null;
  }

  const PRIO_ORDER = { Urgent: 0, Hoog: 1, Normaal: 2, Laag: 3 };
  const tasks = (data || [])
    .sort((a, b) => {
      const pd = (PRIO_ORDER[a.prioriteit] ?? 2) - (PRIO_ORDER[b.prioriteit] ?? 2);
      if (pd !== 0) return pd;
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline) - new Date(b.deadline);
    })
    .map(t => ({
      titel:          t.titel,
      omschrijving:   t.omschrijving  || null,
      notities:       t.notities      || null,
      prioriteit:     t.prioriteit,
      status:         t.status,
      deadline:       t.deadline      || null,
      toegewezen_aan: t.assigned_to_id ? (nameMap[t.assigned_to_id] || 'Onbekend') : 'Niemand',
      categorie:      t.categorie     || null,
    }));

  return {
    count:  tasks.length,
    filter: { priority, limit: Math.min(parseInt(limit) || 10, 50) },
    tasks,
  };
}
