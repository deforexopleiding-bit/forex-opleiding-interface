import { supabase } from './supabase.js';

const FALLBACK_PROMPTS = {
  Simon: `Je bent Simon, de E-mail Agent van De Forex Opleiding. Je bent nauwkeurig, efficient en vriendelijk. Je communiceert in het Nederlands.`,
  Leon:  `Je bent Leon, de Administratief Medewerker van De Forex Opleiding. Je bent georganiseerd en precies. Je communiceert in het Nederlands.`,
  Aron:  `Je bent Aron, de Financieel Medewerker van De Forex Opleiding. Je bent analytisch en resultaatgericht. Je communiceert in het Nederlands.`,
};

// ── Keyword-routing per agent (alleen actief als chair de default 'Simon' is) ──
const DOMAIN_MAP = {
  Simon: ['email', 'mail', 'inbox', 'leads', 'communicatie', 'bericht'],
  Leon:  ['administratie', 'contract', 'document', 'onboarding', 'taken', 'planning'],
  Aron:  ['financieel', 'factuur', 'betaling', 'kosten', 'omzet', 'budget'],
};

// ── agentRespond — uitgebreid met mentionContext + externalInputs ──────────────
async function agentRespond(apiKey, name, personality, agenda, transcript, trigger, mentionContext = '', externalInputs = []) {
  const context = transcript.slice(-8).map(t => `${t.speaker}: ${t.content}`).join('\n');

  let externalSection = '';
  if (externalInputs && externalInputs.length > 0) {
    const inputsText = externalInputs.map(i => `[${i.label}]: ${i.content}`).join('\n\n');
    externalSection = `\n\nExterne informatie beschikbaar in deze vergadering:\n${inputsText}`;
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  // ── B7: GET history ───────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (req.query?.action === 'get_history') {
      const { data: meetings, error } = await supabase
        .from('agent_meetings')
        .select('id, title, created_at, ended_at, participants, meeting_type, status, rapport_md, rapport_generated_at')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ meetings: meetings || [] });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, meeting_id, message, participants, agenda, title, action_points,
          input_type, content, label } = req.body || {};

  try {
    // ── START ─────────────────────────────────────────────────────────────────
    if (action === 'start') {
      const { data: meeting, error } = await supabase.from('agent_meetings').insert({
        title: title || agenda, agenda, participants, transcript: [], status: 'active', created_by: 'Jeffrey',
      }).select().single();
      if (error) throw error;

      const { data: agentRows, error: agentErr } = await supabase.from('agents').select('name,personality').in('name', participants || []);
      if (agentErr) console.error('[agent-meeting] agents fetch fout:', agentErr.message);
      const pMap = Object.fromEntries((agentRows || []).map(a => [a.name, a.personality]));

      const transcript = [];

      // ── B5: Open-taken terugkoppeling ─────────────────────────────────────
      const { data: openTasks, error: tasksErr } = await supabase
        .from('taken_items')
        .select('titel, toegewezen_aan, deadline, status')
        .not('source_meeting_id', 'is', null)
        .neq('status', 'done')
        .neq('status', 'afgerond')
        .order('aangemaakt', { ascending: false })
        .limit(20);
      if (tasksErr) console.error('[agent-meeting] open tasks fout:', tasksErr.message);

      // Groepeer taken per agent (alleen deelnemers)
      const tasksByAgent = {};
      for (const t of (openTasks || [])) {
        if ((participants || []).includes(t.toegewezen_aan)) {
          (tasksByAgent[t.toegewezen_aan] ||= []).push(t);
        }
      }
      // Status-updates aan het begin van de vergadering
      for (const [name, tasks] of Object.entries(tasksByAgent)) {
        const personality = pMap[name] || FALLBACK_PROMPTS[name] || `Je bent ${name}.`;
        const tasksList = tasks.map(t => `- "${t.titel}" (deadline: ${t.deadline || 'geen'})`).join('\n');
        const trigger = `Je hebt de volgende openstaande actiepunten uit vorige vergaderingen:\n${tasksList}\n\nGeef een korte statusupdate (1-2 zinnen per punt) aan het begin van de vergadering.`;
        const statusMsg = await agentRespond(apiKey, name, personality, agenda, [], trigger);
        transcript.push({ speaker: name, content: statusMsg, timestamp: new Date().toISOString(), type: 'status_update' });
      }

      // ── Agent introducties ─────────────────────────────────────────────────
      for (const name of (participants || [])) {
        const personality = pMap[name] || FALLBACK_PROMPTS[name] || `Je bent ${name}.`;
        const intro = await agentRespond(apiKey, name, personality, agenda, [], `De vergadering start. Stel jezelf kort voor en geef aan hoe jij aan de agenda "${agenda}" kunt bijdragen.`);
        transcript.push({ speaker: name, content: intro, timestamp: new Date().toISOString(), type: 'agent' });
      }

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

      // ── B2: @-mention parsing ─────────────────────────────────────────────
      const mentionedNames = (message.match(/@(\w+)/g) || []).map(m => m.slice(1));
      const validMentions  = mentionedNames.filter(n => (meeting.participants || []).includes(n));

      let respondingAgents;
      if (validMentions.length > 0) {
        // Explicit @-mentions: only those agents respond
        respondingAgents = validMentions;
      } else {
        const chair = meeting.chair_agent || 'Simon';
        if (chair === 'Simon') {
          // Default chair: keyword-based domain routing voor extra experts
          const lowerMsg = message.toLowerCase();
          const expert = (meeting.participants || []).find(n =>
            n !== chair && (DOMAIN_MAP[n] || []).some(kw => lowerMsg.includes(kw))
          );
          respondingAgents = [...new Set([chair, expert].filter(Boolean).filter(n => (meeting.participants || []).includes(n)))];
        } else {
          // Expliciete niet-default chair: alleen de gekozen chair reageert
          // (Simon springt er niet tussendoor via keyword-matching)
          respondingAgents = (meeting.participants || []).includes(chair) ? [chair] : (meeting.participants || []);
        }
        if (!respondingAgents.length) respondingAgents = meeting.participants || [];
      }

      const newMsgs = [jeffMsg];
      for (const name of respondingAgents) {
        const personality = pMap[name] || FALLBACK_PROMPTS[name] || `Je bent ${name}.`;
        const mc = validMentions.includes(name) ? `Je bent direct aangesproken via @${name}.` : '';
        const reply = await agentRespond(apiKey, name, personality, meeting.agenda, transcript, message, mc, meeting.external_inputs || []);
        const agentMsg = { speaker: name, content: reply, timestamp: new Date().toISOString(), type: 'agent' };
        transcript.push(agentMsg);
        newMsgs.push(agentMsg);
      }

      await supabase.from('agent_meetings').update({ transcript }).eq('id', meeting_id);
      return res.status(200).json({ messages: newMsgs, transcript });
    }

    // ── END ───────────────────────────────────────────────────────────────────
    if (action === 'end') {
      const { data: meeting } = await supabase.from('agent_meetings').select('*').eq('id', meeting_id).single();
      if (!meeting) return res.status(404).json({ error: 'Vergadering niet gevonden' });

      const transcriptText = (meeting.transcript || []).map(t => `${t.speaker}: ${t.content}`).join('\n');

      // ── Stap 1: Bestaande summary + action points call ─────────────────────
      const summaryResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 1024,
          system: 'Je bent een vergadersecretaris van De Forex Opleiding. Schrijf in het Nederlands.',
          messages: [{ role: 'user', content: `Vergadering agenda: "${meeting.agenda}"\n\nTranscript:\n${transcriptText}\n\nGeef:\n1. SAMENVATTING: (3-5 zinnen)\n2. ACTIEPUNTEN:\n- [beschrijving] | [toegewezen aan] | [deadline zoals 2026-05-18]\n- [beschrijving] | [toegewezen aan] | [deadline]` }],
        }),
      });

      const summaryData = await summaryResp.json();
      const fullText = summaryData.content?.[0]?.text?.trim() || '';

      const pts = [];
      for (const line of fullText.split('\n')) {
        if (/^[-•]\s+.+\|.+\|/.test(line)) {
          const [desc, who, when] = line.replace(/^[-•]\s+/, '').split('|').map(s => s.trim());
          pts.push({ title: desc, assignee: who || 'Jeffrey', deadline: when || '', done: false });
        }
      }
      const summary = fullText.split(/ACTIEPUNTEN/i)[0].replace(/SAMENVATTING[:\s]*/i, '').trim();

      // ── B1: Tweede call — volledig Markdown rapport ────────────────────────
      const dateLabel = new Date(meeting.created_at).toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric' });
      const ptsText   = pts.map(p => `- ${p.title} | ${p.assignee} | ${p.deadline}`).join('\n') || 'Geen';

      let rapport_md = '';
      try {
        const rapportResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 2048,
            system: 'Je bent een vergadersecretaris van De Forex Opleiding. Schrijf een professioneel vergaderrapport in Markdown, in het Nederlands.',
            messages: [{ role: 'user', content: `Vergadering: "${meeting.title || meeting.agenda}"\nDatum: ${dateLabel}\nDeelnemers: ${(meeting.participants || []).join(', ')}\nAgenda: ${meeting.agenda}\n\nTranscript:\n${transcriptText}\n\nSamenvatting:\n${summary}\n\nActiepunten:\n${ptsText}\n\nSchrijf een volledig vergaderrapport met deze ## secties:\n## Aanwezig\n## Agenda\n## Samenvatting\n## Beslissingen\n## Actiepunten\n## Volgende stappen` }],
          }),
        });
        const rd = await rapportResp.json();
        rapport_md = rd.content?.[0]?.text?.trim() || '';
      } catch (rapportErr) {
        console.error('[agent-meeting] rapport genereren fout:', rapportErr.message);
      }

      // ── B1: Beslissingen extraheren en opslaan ─────────────────────────────
      if (rapport_md) {
        try {
          const beslMatch = rapport_md.match(/## Beslissingen\n([\s\S]*?)(?=\n##|$)/);
          if (beslMatch) {
            const beslLines = beslMatch[1]
              .split('\n')
              .map(l => l.trim())
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
        } catch (decExtractErr) {
          console.error('[agent-meeting] beslissingen extractie fout:', decExtractErr.message);
        }
      }

      // ── DB update met rapport_md ───────────────────────────────────────────
      const { error: updateErr } = await supabase.from('agent_meetings').update({
        summary,
        action_points:          pts,
        status:                 'ended',
        ended_at:               new Date().toISOString(),
        rapport_md:             rapport_md || null,
        rapport_generated_at:   rapport_md ? new Date().toISOString() : null,
      }).eq('id', meeting_id);
      if (updateErr) throw updateErr;

      return res.status(200).json({ summary, action_points: pts, full_text: fullText, rapport_md });
    }

    // ── APPROVE ───────────────────────────────────────────────────────────────
    if (action === 'approve') {
      const pts = action_points || [];

      // ── B4: Team members ophalen voor toewijzing ──────────────────────────
      const assigneeNames = [...new Set(pts.map(ap => ap.assignee).filter(Boolean))];
      let memberMap = {};
      if (assigneeNames.length > 0) {
        const { data: members, error: membErr } = await supabase
          .from('team_members')
          .select('id, name, type')
          .in('name', assigneeNames);
        if (membErr) console.error('[agent-meeting] team_members fetch:', membErr.message);
        memberMap = Object.fromEntries((members || []).map(m => [m.name, m]));
      }

      const tasks = pts.map(ap => {
        const member = memberMap[ap.assignee];
        return {
          id:               crypto.randomUUID(),
          titel:            ap.title,
          prioriteit:       'Normaal',
          status:           'todo',
          toegewezen_aan:   ap.assignee || 'Jeffrey',      // text, achterwaarts-compatibel
          assigned_to_type: member ? member.type : 'employee',
          assigned_to_id:   member ? member.id   : null,
          source_meeting_id: meeting_id || null,
          deadline:         ap.deadline || null,
          categorie:        'Vergadering',
          aangemaakt:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        };
      });

      if (tasks.length) {
        const { error } = await supabase.from('taken_items').insert(tasks);
        if (error) throw error;
      }
      return res.status(200).json({ ok: true, tasks_created: tasks.length });
    }

    // ── ADD EXTERNAL INPUT ────────────────────────────────────────────────────
    if (action === 'add_external_input') {
      if (!meeting_id || !input_type || !content) {
        return res.status(400).json({ error: 'meeting_id, input_type en content zijn verplicht' });
      }

      const { data: meeting, error: meetErr } = await supabase
        .from('agent_meetings')
        .select('id, external_inputs, status')
        .eq('id', meeting_id)
        .single();
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
        id:       crypto.randomUUID(),
        type:     input_type,
        label:    label || (input_type === 'url' ? content : 'Tekst input'),
        content:  extractedText,
        added_at: new Date().toISOString(),
      };

      const existing = Array.isArray(meeting.external_inputs) ? meeting.external_inputs : [];
      const updated  = [...existing, newInput];

      const { error: updErr } = await supabase
        .from('agent_meetings')
        .update({ external_inputs: updated })
        .eq('id', meeting_id);
      if (updErr) throw updErr;

      return res.status(200).json({ ok: true, external_inputs: updated });
    }

    return res.status(400).json({ error: `Onbekende actie: ${action}` });

  } catch (err) {
    console.error('[agent-meeting]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
