import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const { agent_id, agent_name, report_type = 'dagrapport' } = req.body || {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  try {
    let agent = null;
    if (agent_id) {
      const { data } = await supabase.from('agents').select('*').eq('id', agent_id).single();
      agent = data;
    }
    const name = agent?.name || agent_name || 'Agent';

    // Gather context data
    let dataCtx = `Huidige datum: ${new Date().toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}`;

    if (name === 'Simon') {
      try {
        const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000';
        const r = await fetch(`${baseUrl}/api/dashboard-stats`);
        if (r.ok) {
          const s = await r.json();
          dataCtx += `\nOpen taken: ${s.tasks?.total || 0} (urgent: ${s.tasks?.urgent || 0})`;
          dataCtx += `\nOnbeantwoorde mails: ${s.unanswered?.count || 0}`;
        }
      } catch {}
      const { data: learns } = await supabase.from('learn_examples').select('old_category,created_at').order('created_at', { ascending: false }).limit(20);
      if (learns?.length) dataCtx += `\nRecente trainingen: ${learns.length} correcties`;
    }

    if (name === 'Leon') {
      const { data: tasks } = await supabase.from('taken_items').select('titel,prioriteit,status,deadline').neq('status','done').limit(20);
      if (tasks?.length) dataCtx += `\nOpen taken:\n` + tasks.slice(0,10).map(t => `- [${t.prioriteit}] ${t.titel}${t.deadline ? ' (deadline: '+t.deadline+')' : ''}`).join('\n');
    }

    if (name === 'Aron') {
      const { data: tasks } = await supabase.from('taken_items').select('titel,prioriteit,status,categorie').eq('categorie','Financieel').neq('status','done').limit(10);
      if (tasks?.length) dataCtx += `\nFinanciële taken:\n` + tasks.map(t => `- ${t.titel}`).join('\n');
    }

    const prompts = {
      dagrapport:  `Genereer als ${name} een beknopt dagrapport voor De Forex Opleiding. Gebruik markdown met kopjes (##). Max 300 woorden. Data:\n${dataCtx}`,
      weekrapport: `Genereer als ${name} een weekrapport voor De Forex Opleiding. Gebruik markdown met kopjes (##). Max 500 woorden. Data:\n${dataCtx}`,
      status:      `Geef als ${name} een korte statusupdate in 5-8 regels. Data:\n${dataCtx}`,
    };

    const prompt = prompts[report_type] || prompts.dagrapport;
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    });

    if (!claudeResp.ok) throw new Error(`Claude API: ${claudeResp.status}`);
    const data = await claudeResp.json();
    const report = data.content?.[0]?.text?.trim() || '';
    return res.status(200).json({ report, agent_name: name, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error('[agent-report]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
