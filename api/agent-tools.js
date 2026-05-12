import { supabase } from './supabase.js';

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

};

// ═══════════════════════════════════════════════════════════════════════════
// TAGS — koppeling tool → agent
// ═══════════════════════════════════════════════════════════════════════════
// Elke tool heeft tags; elke agent heeft een tag-lijst.
// getToolsForAgent geeft alle tools terug die minstens één tag
// gemeenschappelijk hebben met de agent.

const TOOL_TAGS = {
  get_email_stats:                ['email'],
  get_open_tasks:                 ['tasks'],
  search_emails:                  ['email'],
  get_unanswered_emails:          ['email'],
  get_recent_corrections:         ['email', 'learning'],
  query_knowledge_base:           ['knowledge'],
  get_email_categorization_stats: ['email', 'learning'],
};

const AGENT_TAGS = {
  Simon: ['email', 'tasks', 'knowledge', 'learning'],
  Leon:  ['tasks'],
  Aron:  ['tasks'],
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
 * Logt de aanroep voor debugging.
 */
export async function execute(toolName, input) {
  console.log(`[agent-tools] execute: ${toolName} |`, JSON.stringify(input));
  switch (toolName) {
    case 'get_email_stats':                  return executeGetEmailStats(input || {});
    case 'get_open_tasks':                   return executeGetOpenTasks(input || {});
    case 'search_emails':                    return executeSearchEmails(input || {});
    case 'get_unanswered_emails':            return executeGetUnansweredEmails(input || {});
    case 'get_recent_corrections':           return executeGetRecentCorrections(input || {});
    case 'query_knowledge_base':             return executeQueryKnowledgeBase(input || {});
    case 'get_email_categorization_stats':   return executeGetEmailCategorizationStats(input || {});
    default:
      throw new Error(`Onbekende tool: "${toolName}"`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATIES
// ═══════════════════════════════════════════════════════════════════════════

async function executeGetEmailStats({ period = 'last_7_days', categories = [] }) {
  const { from, to } = getDateRange(period);

  const { data: actions, error } = await supabase
    .from('email_actions')
    .select('action, value, set_at')
    .gte('set_at', from)
    .lte('set_at', to);

  if (error) throw new Error('email_actions query fout: ' + error.message);

  const rows = actions || [];
  const byActionType = {};
  const byCategory   = {};

  for (const a of rows) {
    byActionType[a.action] = (byActionType[a.action] || 0) + 1;
    // Categorieën komen van 'recategorize' acties (value = nieuwe categorie)
    if (a.action === 'recategorize' && a.value) {
      byCategory[a.value] = (byCategory[a.value] || 0) + 1;
    }
  }

  // Optioneel filteren op gevraagde categorieën
  const filteredCategories = (categories || []).length > 0
    ? Object.fromEntries(Object.entries(byCategory).filter(([k]) => categories.includes(k)))
    : byCategory;

  return {
    period,
    date_range: { from: from.slice(0, 16), to: to.slice(0, 16) },
    total_actions:    rows.length,
    by_action_type:   byActionType,
    by_category:      filteredCategories,
    note: 'Categorieën zijn gebaseerd op handmatige hercategorisaties in email_actions. Niet-gecategoriseerde e-mails (enkel AI-verwerkt) staan hier niet in.',
  };
}

async function executeSearchEmails({ query, period = 'last_7_days', limit = 5 }) {
  const { from, to } = getDateRange(period);
  const term = `%${query}%`;
  const lim  = Math.min(Math.max(parseInt(limit) || 5, 1), 20);

  // Emails zijn niet in Supabase — zoek in twee proxy-tabellen:
  // 1. email_replies  = verzonden replies (email_id, email_subject, to_address, from_address, sent_at)
  // 2. learn_examples = gecorrigeerde inkomende mails (email_id, sender_domain, body_snippet, old_category, created_at)
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

  const results = [
    ...replies.map(r  => ({ source: 'verzonden_reply', email_id: r.email_id, subject: r.email_subject, afzender: r.from_address, datum: r.sent_at })),
    ...examples.map(e => ({ source: 'inkomend', email_id: e.email_id, domein: e.sender_domain, preview: e.body_snippet?.slice(0, 100) || null, categorie: e.old_category, datum: e.created_at })),
  ];

  return {
    query, period,
    total: results.length,
    results: results.slice(0, lim),
    note: 'Gecombineerd uit verzonden replies + gecorrigeerde inkomende mails. Live inbox niet doorzoekbaar via Supabase.',
  };
}

async function executeGetUnansweredEmails({ limit = 10 }) {
  const lim = Math.min(Math.max(parseInt(limit) || 10, 1), 30);

  // Stap 1: emails die actie vereisen
  const { data: actionRequired } = await supabase
    .from('email_actions')
    .select('email_id, set_at')
    .eq('action', 'requires_action').eq('value', 'true')
    .order('set_at', { ascending: false }).limit(50);

  if (!actionRequired?.length) {
    return { count: 0, emails: [], note: 'Geen e-mails gevonden die actie vereisen.' };
  }

  const emailIds = actionRequired.map(a => a.email_id);

  // Stap 2: welke zijn al beantwoord + verrijkingsinfo
  const [repliedRes, infoRes] = await Promise.allSettled([
    supabase.from('email_actions').select('email_id').eq('action', 'reply_sent').in('email_id', emailIds),
    supabase.from('learn_examples').select('email_id, sender_domain, body_snippet').in('email_id', emailIds),
  ]);

  const repliedIds = new Set((repliedRes.status  === 'fulfilled' ? repliedRes.value.data  || [] : []).map(r => r.email_id));
  const infoMap    = Object.fromEntries((infoRes.status === 'fulfilled' ? infoRes.value.data || [] : []).map(e => [e.email_id, e]));
  const unanswered = actionRequired.filter(a => !repliedIds.has(a.email_id));

  return {
    count: unanswered.length,
    emails: unanswered.slice(0, lim).map(a => ({
      email_id:         a.email_id,
      sender_domain:    infoMap[a.email_id]?.sender_domain || '(onbekend)',
      preview:          infoMap[a.email_id]?.body_snippet?.slice(0, 100) || null,
      openstaand_sinds: a.set_at,
    })),
    note: 'Gebaseerd op email_actions (requires_action=true) minus verzonden replies.',
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
    .select('titel, prioriteit, status, deadline, toegewezen_aan, categorie')
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
      prioriteit:     t.prioriteit,
      status:         t.status,
      deadline:       t.deadline || null,
      toegewezen_aan: t.toegewezen_aan || 'Jeffrey',
      categorie:      t.categorie || null,
    }));

  return {
    count:  tasks.length,
    filter: { priority, limit: Math.min(parseInt(limit) || 10, 50) },
    tasks,
  };
}
