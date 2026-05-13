import { supabase } from './supabase.js';
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
    description: 'Geeft statistieken over e-mail activiteit per categorie voor een bepaalde periode. Gebruik dit als de gebruiker vraagt hoeveel leads, appointments, klantvragen, antwoorden of andere e-mail categorieën er zijn binnengekomen of verwerkt in de inbox.',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_7_days'],
          description: 'De periode waarover statistieken gewenst zijn',
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optioneel: filter op specifieke categorieën (bv. ["Nieuwe Lead", "Klantvraag"]). Weglaten = alle categorieën.',
        },
      },
      required: ['period'],
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
    description: 'Zoekt specifieke e-mails op basis van zoekterm, afzender of onderwerp. Gebruik dit als de gebruiker een specifieke mail wil terugvinden of details wil over recente mails met een bepaald onderwerp of afzender.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Zoekterm — wordt vergeleken met onderwerp, afzender en berichtinhoud.',
        },
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'this_month', 'last_7_days'],
          description: 'Periode om in te zoeken. Standaard: "last_7_days".',
        },
        limit: {
          type: 'integer',
          description: 'Maximum aantal resultaten. Standaard: 5.',
        },
      },
      required: ['query'],
    },
  },

  get_unanswered_emails: {
    name: 'get_unanswered_emails',
    description: 'Geeft e-mails die actie vereisen maar nog onbeantwoord of onopgelost zijn. Gebruik dit als de gebruiker vraagt welke mails nog open staan, onbeantwoord zijn, of aandacht nodig hebben.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum aantal e-mails om terug te geven. Standaard: 10.',
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
    description: 'Geeft inzicht in hoe goed Simon e-mails categoriseert: verwerkte mails, aantal correcties, categorieverdeling en lage-zekerheid patronen. Gebruik dit als de gebruiker vraagt naar Simons prestaties, accuracy of trainingsvoortgang.',
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
        email_id:     { type: 'string', description: 'ID van de originele e-mail (optioneel).' },
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
        email_id:      { type: 'string', description: 'ID van de e-mail (optioneel).' },
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
        email_ids:   { type: 'array', items: { type: 'string' }, description: 'Lijst van e-mail IDs.' },
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
        email_id:      { type: 'string', description: 'ID van de e-mail.' },
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
        related_email_id: { type: 'string', description: 'Gerelateerde e-mail ID (optioneel).' },
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
  // Bestaande read-tools
  get_email_stats:                ['email'],
  get_open_tasks:                 ['tasks'],
  search_emails:                  ['email'],
  get_unanswered_emails:          ['email'],
  get_recent_corrections:         ['email', 'learning'],
  query_knowledge_base:           ['knowledge'],
  get_email_categorization_stats: ['email', 'learning'],
  // Bestaande schrijf-tool
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
  Leon:  ['tasks', 'tasks_write', 'decisions_write', 'meetings_write', 'categorize_write'],
  Aron:  ['tasks', 'payment_read', 'payment_write', 'decisions_write', 'meetings_write'],
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
    // ── Bestaande read-tools ────────────────────────────────────────────────
    case 'get_email_stats':                return executeGetEmailStats(i);
    case 'get_open_tasks':                 return executeGetOpenTasks(i);
    case 'search_emails':                  return executeSearchEmails(i);
    case 'get_unanswered_emails':          return executeGetUnansweredEmails(i);
    case 'get_recent_corrections':         return executeGetRecentCorrections(i);
    case 'query_knowledge_base':           return executeQueryKnowledgeBase(i);
    case 'get_email_categorization_stats': return executeGetEmailCategorizationStats(i);
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
      const { data: emails } = await supabase.from('email_messages')
        .select('id, from_address, subject, body_snippet, category, confidence')
        .lt('confidence', threshold)
        .not('category', 'is', null)
        .order('received_at', { ascending: false })
        .limit(lim);
      if (!emails?.length) {
        return { ok: true, message: `Geen e-mails gevonden met confidence < ${threshold}.`, count: 0 };
      }
      const previewItems = emails.map(e => ({
        email_id:      String(e.id),
        subject:       e.subject || '(geen onderwerp)',
        from_address:  e.from_address || '(onbekend)',
        current_cat:   e.category,
        confidence:    e.confidence,
        snippet:       e.body_snippet?.slice(0, 100) || '',
        suggested_cat: suggestCategory(e.subject || '', e.body_snippet || '', e.category),
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

async function executeGetEmailStats({ period = 'last_7_days', categories = [] }) {
  const { from, to } = getDateRange(period);

  const [actionsRes, patternsRes] = await Promise.allSettled([
    supabase
      .from('email_actions')
      .select('action, value, set_at')
      .gte('set_at', from)
      .lte('set_at', to),
    supabase
      .from('email_patterns')
      .select('category, times_seen')
      .order('times_seen', { ascending: false })
      .limit(100),
  ]);

  const rows     = actionsRes.status     === 'fulfilled' ? (actionsRes.value.data     || []) : [];
  const patterns = patternsRes.status === 'fulfilled' ? (patternsRes.value.data || []) : [];

  // ── Periode-acties ────────────────────────────────────────────────────────
  const byAction      = {};
  const recategorized = {};
  for (const a of rows) {
    byAction[a.action] = (byAction[a.action] || 0) + 1;
    if (a.action === 'recategorize' && a.value) {
      recategorized[a.value] = (recategorized[a.value] || 0) + 1;
    }
  }

  // ── Historische patronen per categorie ────────────────────────────────────
  const byCategory = {};
  for (const p of patterns) {
    if (!p.category) continue;
    byCategory[p.category] = (byCategory[p.category] || 0) + (p.times_seen || 0);
  }

  // Optioneel filteren op gevraagde categorieën
  const filteredPatterns = (categories || []).length > 0
    ? Object.fromEntries(Object.entries(byCategory).filter(([k]) => categories.includes(k)))
    : byCategory;

  return {
    period,
    date_range: { from: from.slice(0, 16), to: to.slice(0, 16) },

    period_actions: {
      description: `Acties uitgevoerd in de gevraagde periode (${period})`,
      note: 'Dit zijn handmatige acties (replies sturen, hercategoriseren, markeren, etc.) — NIET het totaal aantal binnengekomen mails per categorie.',
      total:     rows.length,
      by_action: byAction,
      manually_recategorized_to: recategorized,
    },

    historical_patterns: {
      description: 'Bekende afzender-patronen (alle tijd, geen periode-filter)',
      note: 'Dit is het totaal aantal keren dat een patroon door AI of handmatig is herkend, historisch verzameld. Niet beperkt tot de gevraagde periode.',
      by_category: filteredPatterns,
    },

    limitation: 'Categorie-toewijzingen worden niet per mail in Supabase opgeslagen — AI-categorisaties leven alleen in de browser-cache. Voor exacte aantallen per dag is een schema-uitbreiding nodig (email_categorizations tabel).',
  };
}

async function executeSearchEmails({ query, period = 'last_7_days', limit = 5 }) {
  const { from, to } = getDateRange(period);
  const term = `%${query}%`;
  const lim  = Math.min(Math.max(parseInt(limit) || 5, 1), 20);

  // ── BEPERKING ──────────────────────────────────────────────────────────────
  // De live inbox leeft in IMAP, niet in Supabase. Nieuw ontvangen mails
  // die nog niet beantwoord of gecorrigeerd zijn staan in géén tabel.
  // Zoekopdrachten in de live inbox zijn daardoor niet ondersteund vanuit
  // deze tool. De twee beschikbare proxy-bronnen zijn:
  //   1. email_replies  = mails die zijn beantwoord via de reply-composer
  //   2. learn_examples = mails die handmatig zijn gecorrigeerd (Verplaats & Train)
  // ──────────────────────────────────────────────────────────────────────────

  const [repliesRes, examplesRes] = await Promise.allSettled([
    supabase.from('email_replies')
      .select('email_id, email_subject, to_address, from_address, sent_at')
      .or(`email_subject.ilike.${term},to_address.ilike.${term},from_address.ilike.${term}`)
      .gte('sent_at', from).lte('sent_at', to)
      .order('sent_at', { ascending: false }).limit(lim),
    supabase.from('learn_examples')
      .select('email_id, sender_domain, body_snippet, old_category, created_at')
      .or(`body_snippet.ilike.${term},sender_domain.ilike.${term}`)
      .gte('created_at', from).lte('created_at', to)
      .order('created_at', { ascending: false }).limit(lim),
  ]);

  const replies  = repliesRes.status  === 'fulfilled' ? (repliesRes.value.data  || []) : [];
  const examples = examplesRes.status === 'fulfilled' ? (examplesRes.value.data || []) : [];

  const verzonden = replies.map(r  => ({
    bron: 'beantwoord',
    email_id: r.email_id,
    onderwerp: r.email_subject,
    van: r.from_address,
    datum: r.sent_at,
  }));
  const gecorrigeerd = examples.map(e => ({
    bron: 'gecorrigeerd',
    email_id: e.email_id,
    domein: e.sender_domain,
    preview: e.body_snippet?.slice(0, 100) || null,
    categorie: e.old_category,
    datum: e.created_at,
  }));

  const alles = [...verzonden, ...gecorrigeerd].slice(0, lim);

  return {
    query,
    period,
    live_inbox_doorzoekbaar: false,
    beperking: 'De live inbox leeft in IMAP en is niet opgeslagen in Supabase. Alleen mails die zijn beantwoord of handmatig gecorrigeerd zijn doorzoekbaar. Als je naar een specifieke recente mail zoekt die nog open staat, kan ik die niet vinden via deze tool — maar ik kan je helpen hem te vinden via de Actie vereist-tab in de e-mailmodule.',
    gevonden_in_database: alles.length,
    resultaten: alles,
    bronnen_doorzocht: [
      'email_replies (beantwoorde mails)',
      'learn_examples (handmatig gecorrigeerde mails)',
    ],
  };
}

async function executeGetUnansweredEmails({ limit = 10 }) {
  const lim = Math.min(Math.max(parseInt(limit) || 10, 1), 30);

  // Haal alle relevante acties op in één query
  const { data: allActions } = await supabase
    .from('email_actions')
    .select('email_id, action, set_at')
    .in('action', ['mark-action', 'no-action', 'reply_sent'])
    .order('set_at', { ascending: false })
    .limit(500);

  const rows = allActions || [];

  // Per email_id: bepaal de definitieve toestand (nieuwste actie wint)
  const latestAction = {};
  for (const r of rows) {
    if (!latestAction[r.email_id]) latestAction[r.email_id] = r; // rijen zijn DESC, dus eerste = nieuwste
  }

  // Bevestigd open: ooit mark-action=true, meest recente actie is NIET no-action/reply_sent
  const RESOLVED = new Set(['no-action', 'reply_sent']);
  const confirmed = Object.values(latestAction)
    .filter(r => r.action === 'mark-action' && !RESOLVED.has(r.action));

  // Verrijken met domain/preview uit learn_examples
  const confirmedIds = confirmed.map(r => r.email_id);
  let infoMap = {};
  if (confirmedIds.length > 0) {
    const { data: info } = await supabase
      .from('learn_examples')
      .select('email_id, sender_domain, body_snippet')
      .in('email_id', confirmedIds);
    infoMap = Object.fromEntries((info || []).map(e => [e.email_id, e]));
  }

  return {
    confirmed_count: confirmed.length,
    confirmed_emails: confirmed.slice(0, lim).map(r => ({
      email_id:         r.email_id,
      sender_domain:    infoMap[r.email_id]?.sender_domain || '(onbekend)',
      preview:          infoMap[r.email_id]?.body_snippet?.slice(0, 100) || null,
      openstaand_sinds: r.set_at,
    })),
    limitation: 'Dit toont alleen mails die expliciet zijn gemarkeerd via de "Actie vereist" knop. AI-gecategoriseerde mails in actie-categorieën (Klantvraag, Factuurvraag, Overig) kunnen niet centraal worden opgevraagd zonder een email_categorizations tabel (staat op de architectuur-roadmap als [A1]).',
    suggested_action: 'Voor het complete beeld: open de mailmodule → Actie vereist tab. De UI toont alle gecategoriseerde + gemarkeerde mails.',
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

async function executeQueryKnowledgeBase({ topic }) {
  const term = `%${topic}%`;
  const { data, error } = await supabase
    .from('kennisbank_items')
    .select('type, title, category, content, helpfulness_score, times_used')
    .or(`title.ilike.${term},content.ilike.${term}`)
    .order('helpfulness_score', { ascending: false, nullsFirst: false })
    .limit(5);

  if (error) throw new Error('kennisbank_items query fout: ' + error.message);

  return {
    topic,
    count: (data || []).length,
    results: (data || []).map(item => ({
      title:             item.title,
      type:              item.type,
      category:          item.category,
      content:           item.content?.slice(0, 300) || '',
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

  const { data, error } = await supabase
    .from('kennisbank_items')
    .insert({
      type:              'item',
      title:             t,
      content:           c,
      category:          category || 'Algemeen',
      direction:         direction || 'beide',
      helpfulness_score: 50,
      auto_generated:    true,
      note:              'Aangemaakt door AI agent Simon',
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

async function executeGetEmailCategorizationStats({ period = 'last_7_days' }) {
  const { from, to } = getDateRange(period);

  const [corrRes, patternsRes] = await Promise.allSettled([
    supabase.from('learn_examples')
      .select('old_category, correction_type, created_at')
      .gte('created_at', from).lte('created_at', to),
    supabase.from('email_patterns')
      .select('sender_domain, category, confidence, times_seen, source')
      .order('times_seen', { ascending: false }).limit(50),
  ]);

  const corrections = corrRes.status     === 'fulfilled' ? (corrRes.value.data     || []) : [];
  const patterns    = patternsRes.status === 'fulfilled' ? (patternsRes.value.data || []) : [];

  const categoryDist = {};
  for (const p of patterns) {
    categoryDist[p.category] = (categoryDist[p.category] || 0) + (p.times_seen || 0);
  }

  const lowConf = patterns
    .filter(p => (p.confidence || 100) < 70)
    .slice(0, 5)
    .map(p => ({ domein: p.sender_domain, categorie: p.category, confidence: p.confidence }));

  const corrTypes = {};
  for (const c of corrections) {
    const key = c.correction_type || 'onbekend';
    corrTypes[key] = (corrTypes[key] || 0) + 1;
  }

  return {
    period,
    date_range: { from: from.slice(0, 16), to: to.slice(0, 16) },
    correcties_in_periode:    corrections.length,
    correctie_types:          corrTypes,
    totaal_patronen:          patterns.length,
    categorie_distributie:    categoryDist,
    lage_confidence_patronen: lowConf,
  };
}

async function executeGetOpenTasks({ priority = 'all', limit = 10 }) {
  let query = supabase
    .from('taken_items')
    .select('titel, omschrijving, notities, prioriteit, status, deadline, toegewezen_aan, categorie')
    .neq('status', 'done')
    .neq('status', 'afgerond')
    .limit(Math.min(Math.max(parseInt(limit) || 10, 1), 50));

  if (priority !== 'all') {
    query = query.eq('prioriteit', priority);
  }

  // Sortering: deadline vroegst eerst, dan op aangemaakt
  // (geen priority-sort via Supabase JS in één call — doe in JS)
  const { data, error } = await query;
  if (error) throw new Error('taken_items query fout: ' + error.message);

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
      toegewezen_aan: t.toegewezen_aan || 'Jeffrey',
      categorie:      t.categorie     || null,
    }));

  return {
    count:  tasks.length,
    filter: { priority, limit: Math.min(parseInt(limit) || 10, 50) },
    tasks,
  };
}
