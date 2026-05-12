import { supabase } from './supabase.js';

const FALLBACK_PROMPTS = {
  Simon: `Je bent Simon, de E-mail Agent van De Forex Opleiding. Je bent nauwkeurig, efficient en vriendelijk. Je communiceert in het Nederlands.`,
  Leon:  `Je bent Leon, de Administratief Medewerker van De Forex Opleiding. Je bent georganiseerd en precies. Je communiceert in het Nederlands.`,
  Aron:  `Je bent Aron, de Financieel Medewerker van De Forex Opleiding. Je bent analytisch en resultaatgericht. Je communiceert in het Nederlands.`,
};

async function agentRespond(apiKey, name, personality, agenda, transcript, trigger) {
  const context = transcript.slice(-8).map(t => `${t.speaker}: ${t.content}`).join('\n');
  const system = `${personality}\n\nVergadering agenda: "${agenda}".\n\nBisherige vergadering:\n${context}\n\nReageer kort (max 2-3 zinnen) vanuit jouw expertise. Wees concreet en constructief.`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, system, messages: [{ role: 'user', content: trigger }] }),
  });
  const data = await resp.json();
  return data.content?.[0]?.text?.trim() || '...';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  const { action, meeting_id, message, participants, agenda, title, action_points } = req.body || {};

  try {
    // ── START MEETING ─────────────────────────────────────────────────────────
    if (action === 'start') {
      const { data: meeting, error } = await supabase.from('agent_meetings').insert({
        title: title || agenda, agenda, participants, transcript: [], status: 'active', created_by: 'Jeffrey',
      }).select().single();
      if (error) throw error;

      const { data: agentRows, error: agentErr } = await supabase.from('agents').select('name,personality').in('name', participants || []);
      if (agentErr) console.error('[agent-meeting] agents fetch fout:', agentErr.message);
      const pMap = Object.fromEntries((agentRows || []).map(a => [a.name, a.personality]));

      const transcript = [];
      for (const name of (participants || [])) {
        const personality = pMap[name] || FALLBACK_PROMPTS[name] || `Je bent ${name}.`;
        const intro = await agentRespond(apiKey, name, personality, agenda, [], `De vergadering start. Stel jezelf kort voor en geef aan hoe jij aan de agenda "${agenda}" kunt bijdragen.`);
        transcript.push({ speaker: name, content: intro, timestamp: new Date().toISOString(), type: 'agent' });
      }

      await supabase.from('agent_meetings').update({ transcript }).eq('id', meeting.id);
      return res.status(200).json({ meeting_id: meeting.id, transcript });
    }

    // ── ADD MESSAGE ───────────────────────────────────────────────────────────
    if (action === 'message') {
      const { data: meeting } = await supabase.from('agent_meetings').select('*').eq('id', meeting_id).single();
      if (!meeting) return res.status(404).json({ error: 'Vergadering niet gevonden' });

      const transcript = Array.isArray(meeting.transcript) ? meeting.transcript : [];
      const jeffMsg = { speaker: 'Jeffrey', content: message, timestamp: new Date().toISOString(), type: 'user' };
      transcript.push(jeffMsg);

      const { data: agentRows, error: agentErr2 } = await supabase.from('agents').select('name,personality').in('name', meeting.participants || []);
      if (agentErr2) console.error('[agent-meeting] agents fetch fout:', agentErr2.message);
      const pMap = Object.fromEntries((agentRows || []).map(a => [a.name, a.personality]));

      const newMsgs = [jeffMsg];
      for (const name of (meeting.participants || [])) {
        const personality = pMap[name] || FALLBACK_PROMPTS[name] || `Je bent ${name}.`;
        const reply = await agentRespond(apiKey, name, personality, meeting.agenda, transcript, message);
        const agentMsg = { speaker: name, content: reply, timestamp: new Date().toISOString(), type: 'agent' };
        transcript.push(agentMsg);
        newMsgs.push(agentMsg);
      }

      await supabase.from('agent_meetings').update({ transcript }).eq('id', meeting_id);
      return res.status(200).json({ messages: newMsgs, transcript });
    }

    // ── END MEETING ───────────────────────────────────────────────────────────
    if (action === 'end') {
      const { data: meeting } = await supabase.from('agent_meetings').select('*').eq('id', meeting_id).single();
      if (!meeting) return res.status(404).json({ error: 'Vergadering niet gevonden' });

      const transcriptText = (meeting.transcript || []).map(t => `${t.speaker}: ${t.content}`).join('\n');
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

      await supabase.from('agent_meetings').update({
        summary, action_points: pts, status: 'ended', ended_at: new Date().toISOString(),
      }).eq('id', meeting_id);

      return res.status(200).json({ summary, action_points: pts, full_text: fullText });
    }

    // ── APPROVE (create tasks) ────────────────────────────────────────────────
    if (action === 'approve') {
      const pts = action_points || [];
      const tasks = pts.map(ap => ({
        id: crypto.randomUUID(),
        titel: ap.title,
        prioriteit: 'Normaal',
        status: 'todo',
        toegewezen_aan: ap.assignee || 'Jeffrey',
        deadline: ap.deadline || null,
        categorie: 'Vergadering',
        aangemaakt: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      if (tasks.length) {
        const { error } = await supabase.from('taken_items').insert(tasks);
        if (error) throw error;
      }
      return res.status(200).json({ ok: true, tasks_created: tasks.length });
    }

    return res.status(400).json({ error: `Onbekende actie: ${action}` });
  } catch (err) {
    console.error('[agent-meeting]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
