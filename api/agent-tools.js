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

};

// ═══════════════════════════════════════════════════════════════════════════
// TAGS — koppeling tool → agent
// ═══════════════════════════════════════════════════════════════════════════
// Elke tool heeft tags; elke agent heeft een tag-lijst.
// getToolsForAgent geeft alle tools terug die minstens één tag
// gemeenschappelijk hebben met de agent.

const TOOL_TAGS = {
  get_email_stats: ['email'],
  get_open_tasks:  ['tasks'],
};

const AGENT_TAGS = {
  Simon: ['email', 'tasks'],
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
    case 'get_email_stats': return executeGetEmailStats(input || {});
    case 'get_open_tasks':  return executeGetOpenTasks(input || {});
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
