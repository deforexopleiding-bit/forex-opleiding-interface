import { supabase, createUserClient } from './supabase.js';

const AGENT_NAMES = ['Simon', 'Leon', 'Aron'];

const FALLBACK_PROMPTS = {
  Simon: `Je bent Simon, de E-mail Agent van De Forex Opleiding. Je bent nauwkeurig, efficient en vriendelijk. Je communiceert in het Nederlands.`,
  Leon:  `Je bent Leon, de Administratief Medewerker van De Forex Opleiding. Je bent georganiseerd en precies. Je communiceert in het Nederlands.`,
  Aron:  `Je bent Aron, de Financieel Medewerker van De Forex Opleiding. Je bent analytisch en resultaatgericht. Je communiceert in het Nederlands.`,
};

// Keyword-routing per domein
const DOMAIN_MAP = {
  Simon: ['mail', 'email', 'inbox', 'leads', 'communicatie', 'bericht', 'reply', 'antwoord', 'klantvraag', 'afzender', 'opzeg', 'verzoek', 'sturen'],
  Leon:  ['administratie', 'contract', 'document', 'onboarding', 'taken', 'planning', 'medewerker', 'mentor', 'agenda', 'todo', 'intake', 'formulier'],
  Aron:  ['financieel', 'factuur', 'betaling', 'kosten', 'omzet', 'budget', 'incasso', 'mollie', 'wanbetal', 'euro', 'geld', 'inkomsten', 'uitgaven'],
};

// Collectieve woorden → alle agents reageren
const COLLECTIEVE_WOORDEN = ['jullie', 'iedereen', 'allen', 'alle drie', 'allebei', 'iemand', 'wie kan', 'wie weet'];

// Vaste responsevolgorde
const RESPONSE_ORDER = ['Simon', 'Leon', 'Aron'];

// 5-laagse agent-selectie
async function pickRelevantAgents(message, participants, apiKey) {
  const lower = message.toLowerCase();

  // Laag 1: @-mentions
  const mentions = (message.match(/@(\w+)/g) || []).map(m => m.slice(1));
  const valid = mentions.filter(n => participants.includes(n));
  if (valid.length) return valid;

  // Laag 2: Collectieve woorden → alle aanwezige agents
  if (COLLECTIEVE_WOORDEN.some(w => lower.includes(w))) return [...participants];

  // Laag 3: Naam-detectie ("waarom reageert Leon niet?")
  const named = participants.filter(n => lower.includes(n.toLowerCase()));
  if (named.length) return named;

  // Laag 4: Keyword-matching
  const keywordMatches = [];
  for (const [agent, kws] of Object.entries(DOMAIN_MAP)) {
    if (participants.includes(agent) && kws.some(kw => lower.includes(kw))) keywordMatches.push(agent);
  }
  if (keywordMatches.length) return keywordMatches;

  // Laag 5: LLM routing (Haiku, snel + goedkoop)
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 60,
        system: 'Je bent een routing-assistent. Geef ALLEEN agent-namen gescheiden door komma\'s, geen uitleg.',
        messages: [{
          role: 'user',
          content: `Aanwezige agents: ${participants.join(', ')}\nSimon = e-mail/leads/communicatie\nLeon = contracten/planning/taken/mentoren\nAron = facturen/betalingen/omzet/budget\n\nBericht: "${message}"\n\nWelke agent(s) moeten reageren?`,
        }],
      }),
    });
    const d = await resp.json();
    const text = d.content?.[0]?.text?.trim() || '';
    const suggested = text.split(/[\s,]+/).map(n => n.trim()).filter(n => participants.includes(n));
    if (suggested.length) return suggested;
  } catch (e) {
    console.error('[agent-meeting] LLM routing fout:', e.message);
  }

  // Fallback: Simon of eerste beschikbare
  if (participants.includes('Simon')) return ['Simon'];
  return participants.slice(0, 1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function agentRespond(apiKey, name, personality, agenda, transcript, trigger, mentionContext = '', externalInputs = []) {
  const context = transcript.slice(-8).map(t => `${t.speaker}: ${t.content}`).join('\n');
  let externalSection = '';
  if (externalInputs && externalInputs.length > 0) {
    externalSection = `\n\nExterne informatie:\n${externalInputs.map(i => `[${i.label}]: ${i.content}`).join('\n\n')}`;
  }
  const mentionLine = mentionContext ? `\n\n${mentionContext}` : '';
  const system = `${personality}\n\nVergadering agenda: "${agenda}".\n\nBisherige vergadering:\n${context}${externalSection}${mentionLine}\n\nReageer kort (max 2-3 zinnen) vanuit jouw expertise. Wees concreet en constructief.`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, system, messages: [{ role: 'user', content: trigger }] }),
  });
  const data = await resp.json();
  return data.content?.[0]?.text?.trim() || '...';
}

// Resolveer een assignee-naam naar type + id
// Resultaat: { name, type, id } of null
async function resolveAssignee(name) {
  if (!name) return null;
  // Agent?
  if (AGENT_NAMES.includes(name)) return { name, type: 'agent', id: name };
  // Team member (case-insensitive)
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, type')
    .ilike('name', `%${name}%`)
    .eq('is_active', true)
    .limit(1);
  if (error) {
    console.warn('[agent-meeting] team_members lookup fout:', error.message);
    return { name, type: 'employee', id: name }; // fallback
  }
  if (data?.length > 0) return { name: data[0].name, type: data[0].type, id: String(data[0].id) };
  // Onbekend: sla op als employee met naam als id
  return { name, type: 'employee', id: name };
}

// Hulpfunctie: accepteer alleen geldige UUID-strings voor uuid-kolommen
// Agents gebruiken hun naam als id (bv. 'Simon') — dat is geen UUID
function toUuidOrNull(id) {
  if (!id) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

// Maak één taak aan + taken_assignees rijen
async function createTask({ titel, beschrijving, assignees, deadline, prioriteit, source_meeting_id, categorie = 'Vergadering' }) {
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Eerste assignee voor backwards compat kolommen
  const first = assignees?.[0] || null;
  const taskRow = {
    id:                taskId,
    titel:             titel || '(naamloos)',
    omschrijving:      beschrijving || null,
    prioriteit:        prioriteit || 'Normaal',
    status:            'todo',
    toegewezen_aan:    first?.name || null,
    assigned_to_type:  first?.type || null,
    // assigned_to_id is uuid — agents hebben naam-strings (geen UUID), bewaar null voor hen
    assigned_to_id:    toUuidOrNull(first?.id),
    source_meeting_id: toUuidOrNull(source_meeting_id),
    deadline:          deadline   || null,
    categorie,
    aangemaakt:        now,
    updated_at:        now,
  };

  console.log(`[createTask] INSERT taken_items: "${taskRow.titel}", assigned_to_type=${taskRow.assigned_to_type}, source_meeting_id=${taskRow.source_meeting_id}`);
  const { error: taskErr } = await supabase.from('taken_items').insert(taskRow);
  if (taskErr) throw new Error(`taken_items insert fout: ${taskErr.message}`);

  // taken_assignees voor ALLE assignees
  if (assignees?.length > 0) {
    const assigneeRows = assignees.map(a => ({
      task_id:       taskId,
      assignee_type: a.type,
      assignee_id:   a.id,
      assignee_name: a.name,
    }));
    const { error: asgErr } = await supabase.from('taken_assignees').insert(assigneeRows);
    if (asgErr) console.error('[agent-meeting] taken_assignees insert fout:', asgErr.message);
  }

  return taskId;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const action = req.query?.action;

    // B7: vergadergeschiedenis
    if (action === 'get_history') {
      const meetingTypeFilter = req.query?.meeting_type || '';
      let q = supabase
        .from('agent_meetings')
        .select('id, title, created_at, ended_at, participants, meeting_type, status, rapport_md, rapport_generated_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (meetingTypeFilter) q = q.eq('meeting_type', meetingTypeFilter);
      const { data: meetings, error } = await q;
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ meetings: meetings || [] });
    }

    // Fase 5: taken uit meetings voor dashboard
    if (action === 'get_meeting_tasks') {
      try {
        const { data: tasks, error: tasksErr } = await supabase
          .from('taken_items')
          .select('id, titel, status, prioriteit, deadline, source_meeting_id')
          .not('source_meeting_id', 'is', null)
          .neq('status', 'done')
          .neq('status', 'afgerond')
          .order('deadline', { ascending: true, nullsFirst: false })
          .limit(15);
        if (tasksErr) throw tasksErr;

        if (!tasks?.length) return res.status(200).json({ tasks: [] });

        // Meeting titels ophalen
        const meetingIds = [...new Set(tasks.map(t => t.source_meeting_id))];
        const { data: meetings } = await supabase.from('agent_meetings').select('id, title').in('id', meetingIds);
        const meetingMap = Object.fromEntries((meetings || []).map(m => [m.id, m.title]));

        // Assignees ophalen
        const taskIds = tasks.map(t => t.id);
        const { data: assignees } = await supabase
          .from('taken_assignees')
          .select('task_id, assignee_name, assignee_type')
          .in('task_id', taskIds);
        const assigneesByTask = {};
        for (const a of (assignees || [])) {
          (assigneesByTask[a.task_id] ||= []).push(a);
        }

        const result = tasks.map(t => ({
          ...t,
          meeting_title: meetingMap[t.source_meeting_id] || 'Vergadering',
          assignees:     assigneesByTask[t.id] || [],
        }));
        return res.status(200).json({ tasks: result });
      } catch (err) {
        console.error('[agent-meeting] get_meeting_tasks fout:', err.message);
        return res.status(500).json({ error: err.message });
      }
    }

    // Beslissingen ophalen
    if (action === 'get_decisions') {
      const { data: decisions, error } = await supabase
        .from('decisions')
        .select('id, title, description, decided_by, decision_date, status, tags, meeting_id, created_at')
        .order('decision_date', { ascending: false })
        .order('id', { ascending: false })
        .limit(100);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ decisions: decisions || [] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, meeting_id, message, participants, agenda, title, action_points,
          input_type, content, label,
          titel, beschrijving, assignees: instantAssignees, deadline: instantDeadline, prioriteit: instantPrioriteit } = req.body || {};

  try {
    // ── START ─────────────────────────────────────────────────────────────────
    if (action === 'start') {
      const userClient = createUserClient(req);
      const { data: { user: authUser } } = await userClient.auth.getUser();
      const userId = authUser?.id || null;

      const { data: meeting, error } = await userClient.from('agent_meetings').insert({
        title: title || agenda, agenda, participants, transcript: [], status: 'active', created_by: 'Jeffrey', owner_id: userId,
      }).select().single();
      if (error) throw error;

      const { data: agentRows, error: agentErr } = await supabase.from('agents').select('name,personality').in('name', participants || []);
      if (agentErr) console.error('[agent-meeting] agents fetch fout:', agentErr.message);
      const pMap = Object.fromEntries((agentRows || []).map(a => [a.name, a.personality]));

      const transcript = [];

      // ── B5 (Fase 4 fix): Open-taken terugkoppeling via taken_assignees ─────
      const agentParticipants = (participants || []).filter(n => AGENT_NAMES.includes(n));
      if (agentParticipants.length > 0) {
        try {
          // Haal open taken op voor agent-deelnemers via taken_assignees
          const { data: agentAssignees, error: asgErr } = await supabase
            .from('taken_assignees')
            .select('task_id, assignee_name')
            .eq('assignee_type', 'agent')
            .in('assignee_name', agentParticipants);
          if (asgErr) console.error('[agent-meeting] taken_assignees query fout:', asgErr.message);

          if (agentAssignees?.length > 0) {
            const taskIds = [...new Set(agentAssignees.map(a => a.task_id))];
            const { data: openTasks, error: tasksErr } = await supabase
              .from('taken_items')
              .select('id, titel, deadline, status')
              .in('id', taskIds)
              .not('source_meeting_id', 'is', null)
              .neq('status', 'done')
              .neq('status', 'afgerond')
              .order('deadline', { ascending: true, nullsFirst: false })
              .limit(20);
            if (tasksErr) console.error('[agent-meeting] open tasks fout:', tasksErr.message);

            if (openTasks?.length > 0) {
              // Groepeer per agent, max 5 per agent
              const tasksByAgent = {};
              for (const a of agentAssignees) {
                const task = openTasks.find(t => t.id === a.task_id);
                if (task && !tasksByAgent[a.assignee_name]?.some(t => t.id === task.id)) {
                  (tasksByAgent[a.assignee_name] ||= []).push(task);
                }
              }

              // Taken beschikbaar als context — geen statusberichten genereren bij start
            }
          }
        } catch (b5Err) {
          console.error('[agent-meeting] B5 status update fout:', b5Err.message);
        }
      }

      // Transcript starten zonder forced introducties — agents reageren op eerste bericht
      await supabase.from('agent_meetings').update({ transcript }).eq('id', meeting.id);
      return res.status(200).json({ meeting_id: meeting.id, transcript });
    }

    // ── MESSAGE ───────────────────────────────────────────────────────────────
    if (action === 'message') {
      const { data: meeting } = await supabase.from('agent_meetings').select('*').eq('id', meeting_id).single();
      if (!meeting) return res.status(404).json({ error: 'Vergadering niet gevonden' });

      const transcript = Array.isArray(meeting.transcript) ? meeting.transcript : [];
      const jeffMsg = { speaker: 'Jeffrey', content: message, timestamp: new Date().toISOString(), type: 'user' };
      transcript.push(jeffMsg);

      const { data: agentRows, error: agentErr2 } = await supabase.from('agents').select('name,personality').in('name', meeting.participants || []);
      if (agentErr2) console.error('[agent-meeting] agents fetch fout:', agentErr2.message);
      const pMap = Object.fromEntries((agentRows || []).map(a => [a.name, a.personality]));

      // 5-laagse agent-selectie
      const participants = meeting.participants || [];
      const selected = await pickRelevantAgents(message, participants, apiKey);

      // Sorteer in vaste volgorde: Simon → Leon → Aron; onbekende agents achteraan
      const orderedAgents = [
        ...RESPONSE_ORDER.filter(n => selected.includes(n)),
        ...selected.filter(n => !RESPONSE_ORDER.includes(n)),
      ];

      const responses = [];
      for (const name of orderedAgents) {
        const personality = pMap[name] || FALLBACK_PROMPTS[name] || `Je bent ${name}.`;
        const mc = message.includes(`@${name}`) ? `Je bent direct aangesproken via @${name}.` : '';
        const reply = await agentRespond(apiKey, name, personality, meeting.agenda, transcript, message, mc, meeting.external_inputs || []);
        const agentMsg = { speaker: name, content: reply, timestamp: new Date().toISOString(), type: 'agent' };
        transcript.push(agentMsg);
        responses.push(agentMsg);
      }

      await supabase.from('agent_meetings').update({ transcript }).eq('id', meeting_id);
      return res.status(200).json({ responses, transcript });
    }

    // ── END ───────────────────────────────────────────────────────────────────
    if (action === 'end') {
      const { data: meeting } = await supabase.from('agent_meetings').select('*').eq('id', meeting_id).single();
      if (!meeting) return res.status(404).json({ error: 'Vergadering niet gevonden' });

      const transcriptText = (meeting.transcript || []).map(t => `${t.speaker}: ${t.content}`).join('\n');

      // ── Call 1: samenvatting ────────────────────────────────────────────────
      const summaryResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 512,
          system: 'Je bent een vergadersecretaris van De Forex Opleiding. Schrijf in het Nederlands.',
          messages: [{ role: 'user', content: `Vergadering: "${meeting.agenda}"\n\nTranscript:\n${transcriptText}\n\nSchrijf een samenvatting van 3-5 zinnen. Alleen de samenvatting, geen actiepunten.` }],
        }),
      });
      const summaryData = await summaryResp.json();
      const summary = summaryData.content?.[0]?.text?.trim() || '';

      // ── Call 2: actiepunten als JSON ──────────────────────────────────────
      // Gescheiden call zodat de extractie robuust is en altijd JSON produceert
      let pts = [];
      try {
        const ptsResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 1024,
            system: 'Je bent een vergadersecretaris. Extraheer actiepunten uit een meeting-transcript als JSON-array. Antwoord ALLEEN met geldige JSON, geen tekst eromheen.',
            messages: [{ role: 'user', content: `Vergadering: "${meeting.agenda}"\nDeelnemers: ${(meeting.participants || []).join(', ')}, Jeffrey\n\nTranscript:\n${transcriptText}\n\nExtraheer concrete actiepunten (dingen die gedaan moeten worden door specifieke personen, NIET besluiten of analyses).\n\nRetourneer een JSON-array:\n[\n  {\n    "titel": "korte beschrijving (max 100 tekens)",\n    "beschrijving": "extra uitleg of null",\n    "assignees": ["NaamPersoon"],\n    "deadline": "YYYY-MM-DD of null",\n    "prioriteit": "Hoog of Normaal of Laag"\n  }\n]\n\nAls er geen actiepunten zijn: retourneer []\nGebruik alleen personen die ook echt deelnemen of worden aangesproken (${(meeting.participants || []).join(', ')}, Jeffrey).` }],
          }),
        });
        const ptsData = await ptsResp.json();
        const rawText = ptsData.content?.[0]?.text?.trim() || '[]';

        // JSON extraheren (Claude kan soms ``` codefences gebruiken)
        const jsonMatch = rawText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            pts = parsed.map(p => ({
              titel:       String(p.titel || '').slice(0, 100),
              beschrijving: p.beschrijving || null,
              assignees:   Array.isArray(p.assignees) ? p.assignees.filter(Boolean) : [],
              deadline:    p.deadline && /^\d{4}-\d{2}-\d{2}$/.test(p.deadline) ? p.deadline : null,
              prioriteit:  ['Hoog', 'Normaal', 'Laag', 'Urgent'].includes(p.prioriteit) ? p.prioriteit : 'Normaal',
            }));
          }
        }
        console.log(`[agent-meeting] action_points geëxtraheerd: ${pts.length} items`);
      } catch (ptsErr) {
        console.error('[agent-meeting] action_points extractie fout:', ptsErr.message);
      }

      // ── Call 3: volledig Markdown rapport ─────────────────────────────────
      const dateLabel = new Date(meeting.created_at).toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric' });
      const ptsText   = pts.map(p => `- ${p.titel} | ${p.assignees.join(', ')} | ${p.deadline || 'geen deadline'}`).join('\n') || 'Geen';

      let rapport_md = '';
      try {
        const rapportResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 2048,
            system: 'Je bent een vergadersecretaris van De Forex Opleiding. Schrijf een professioneel vergaderrapport in Markdown, in het Nederlands.',
            messages: [{ role: 'user', content: `Vergadering: "${meeting.title || meeting.agenda}"\nDatum: ${dateLabel}\nDeelnemers: ${(meeting.participants || []).join(', ')}, Jeffrey\nAgenda: ${meeting.agenda}\n\nTranscript:\n${transcriptText}\n\nSamenvatting:\n${summary}\n\nActiepunten:\n${ptsText}\n\nSchrijf een volledig vergaderrapport met deze ## secties:\n## Aanwezig\n## Agenda\n## Samenvatting\n## Beslissingen\n## Actiepunten\n## Volgende stappen` }],
          }),
        });
        const rd = await rapportResp.json();
        rapport_md = rd.content?.[0]?.text?.trim() || '';
      } catch (rapportErr) {
        console.error('[agent-meeting] rapport genereren fout:', rapportErr.message);
      }

      // ── Beslissingen extraheren uit rapport ────────────────────────────────
      if (rapport_md) {
        try {
          const beslMatch = rapport_md.match(/## Beslissingen\n([\s\S]*?)(?=\n##|$)/);
          if (beslMatch) {
            const beslLines = beslMatch[1].split('\n').map(l => l.trim())
              .filter(l => /^[-*•]/.test(l) || (l.length > 10 && !l.startsWith('#')));
            const today = new Date().toISOString().split('T')[0];
            const decisionsToInsert = beslLines.slice(0, 10).map(l => ({
              meeting_id,
              title:         l.replace(/^[-*•]\s*/, '').slice(0, 200),
              description:   l.replace(/^[-*•]\s*/, ''),
              decided_by:    (meeting.participants || []).join(', '),
              decision_date: today,
              status:        'active',
              tags:          [],
            }));
            if (decisionsToInsert.length > 0) {
              const { error: decErr } = await supabase.from('decisions').insert(decisionsToInsert);
              if (decErr) console.error('[agent-meeting] decisions insert fout:', decErr.message);
              else console.log(`[agent-meeting] ${decisionsToInsert.length} beslissing(en) opgeslagen`);
            }
          }
        } catch (e) {
          console.error('[agent-meeting] beslissingen extractie fout:', e.message);
        }
      }

      // ── DB update ─────────────────────────────────────────────────────────
      const { error: updateErr } = await supabase.from('agent_meetings').update({
        summary,
        action_points:          pts,
        status:                 'ended',
        ended_at:               new Date().toISOString(),
        rapport_md:             rapport_md || null,
        rapport_generated_at:   rapport_md ? new Date().toISOString() : null,
      }).eq('id', meeting_id);
      if (updateErr) throw updateErr;

      return res.status(200).json({ summary, action_points: pts, rapport_md });
    }

    // ── PREVIEW TASKS ─────────────────────────────────────────────────────────
    // Geeft de actiepunten terug verrijkt met resolved assignees + opties voor dropdown
    if (action === 'preview_tasks') {
      const { data: meeting, error: mErr } = await supabase
        .from('agent_meetings').select('action_points, participants').eq('id', meeting_id).single();
      if (mErr || !meeting) return res.status(404).json({ error: 'Vergadering niet gevonden' });

      // Resolve assignees voor elk actiepunt
      const pts = Array.isArray(meeting.action_points) ? meeting.action_points : [];
      const enriched = await Promise.all(pts.map(async ap => {
        const resolved = await Promise.all((ap.assignees || []).map(name => resolveAssignee(name)));
        return { ...ap, assignees_resolved: resolved.filter(Boolean) };
      }));

      // Opties voor dropdown: agents + actieve teamleden
      const { data: teamOpts } = await supabase
        .from('team_members').select('id, name, type').eq('is_active', true).order('name');

      return res.status(200).json({
        action_points:       enriched,
        agents_options:      AGENT_NAMES.map(n => ({ id: n, name: n, type: 'agent' })),
        team_members_options: (teamOpts || []).map(m => ({ id: String(m.id), name: m.name, type: m.type })),
      });
    }

    // ── APPROVE ───────────────────────────────────────────────────────────────
    if (action === 'approve') {
      const pts = Array.isArray(action_points) ? action_points : [];

      let tasksCreated  = 0;
      let assigneesSet  = 0;
      const taskIds     = [];
      const errors      = [];

      console.log(`[approve] received ${pts.length} action_points, meeting_id=${meeting_id}`);

      for (let i = 0; i < pts.length; i++) {
        const ap = pts[i];
        console.log(`[approve] processing item ${i}: titel="${ap.titel || ap.title}", assignees=${JSON.stringify(ap.assignees)}`);

        // Resolve alle assignees — accepteer string (naam) of object { name, type, id }
        const resolvedAssignees = await Promise.all(
          (ap.assignees || []).map(a => {
            const name = typeof a === 'string' ? a : a.name;
            return resolveAssignee(name);
          })
        );
        const validAssignees = resolvedAssignees.filter(Boolean);

        if (!validAssignees.length) {
          console.warn(`[approve] item ${i} heeft 0 geldige assignees — taak wordt toch aangemaakt`);
        }

        try {
          const taskId = await createTask({
            titel:             ap.titel || ap.title || '(naamloos)',
            beschrijving:      ap.beschrijving || null,
            assignees:         validAssignees,
            deadline:          ap.deadline || null,
            prioriteit:        ap.prioriteit || 'Normaal',
            source_meeting_id: meeting_id || null,
          });
          tasksCreated++;
          assigneesSet += validAssignees.length;
          taskIds.push(taskId);
          console.log(`[approve] item ${i} aangemaakt: taskId=${taskId}, assignees=${validAssignees.length}`);
        } catch (taskErr) {
          const msg = `item ${i} ("${ap.titel || ap.title}"): ${taskErr.message}`;
          console.error('[approve] taak aanmaken fout:', msg);
          errors.push(msg);
        }
      }

      console.log(`[approve] loop complete — created=${tasksCreated}, assignees=${assigneesSet}, errors=${errors.length}`);

      return res.status(200).json({
        ok:            errors.length === 0 || tasksCreated > 0,
        tasks_created: tasksCreated,
        assignees_set: assigneesSet,
        task_ids:      taskIds,
        errors:        errors.length ? errors : undefined,
      });
    }

    // ── ADD INSTANT TASK ──────────────────────────────────────────────────────
    if (action === 'add_instant_task') {
      if (!titel) return res.status(400).json({ error: 'titel is verplicht' });

      // Resolve assignees (array van namen of objecten)
      const resolvedAssignees = await Promise.all(
        (instantAssignees || []).map(a => {
          const name = typeof a === 'string' ? a : a.name;
          return resolveAssignee(name);
        })
      );

      const taskId = await createTask({
        titel,
        beschrijving:      beschrijving || null,
        assignees:         resolvedAssignees.filter(Boolean),
        deadline:          instantDeadline || null,
        prioriteit:        instantPrioriteit || 'Normaal',
        source_meeting_id: meeting_id || null,
      });

      const names = resolvedAssignees.filter(Boolean).map(a => a.name).join(', ') || 'niemand';
      return res.status(200).json({ ok: true, task_id: taskId, message: `Taak aangemaakt, toegewezen aan ${names}` });
    }

    // ── ADD EXTERNAL INPUT ────────────────────────────────────────────────────
    if (action === 'add_external_input') {
      if (!meeting_id || !input_type || !content) {
        return res.status(400).json({ error: 'meeting_id, input_type en content zijn verplicht' });
      }
      const { data: meeting, error: meetErr } = await supabase
        .from('agent_meetings').select('id, external_inputs').eq('id', meeting_id).single();
      if (meetErr || !meeting) return res.status(404).json({ error: 'Vergadering niet gevonden' });

      let extractedText = '';
      if (input_type === 'url') {
        try {
          const pageResp = await fetch(content, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = await pageResp.text();
          extractedText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        } catch (fetchErr) {
          console.warn('[agent-meeting] URL fetch fout:', fetchErr.message);
          extractedText = `[URL kon niet worden geladen: ${content}]`;
        }
      } else {
        extractedText = String(content).slice(0, 2000);
      }

      const newInput = {
        id: crypto.randomUUID(), type: input_type,
        label: label || (input_type === 'url' ? content : 'Tekst input'),
        content: extractedText, added_at: new Date().toISOString(),
      };
      const updated = [...(Array.isArray(meeting.external_inputs) ? meeting.external_inputs : []), newInput];
      const { error: updErr } = await supabase.from('agent_meetings').update({ external_inputs: updated }).eq('id', meeting_id);
      if (updErr) throw updErr;
      return res.status(200).json({ ok: true, external_inputs: updated });
    }

    return res.status(400).json({ error: `Onbekende actie: ${action}` });

  } catch (err) {
    console.error('[agent-meeting]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
