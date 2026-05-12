import { supabase } from './supabase.js';

const FALLBACK_PROMPTS = {
  Simon: `Je bent Simon, de E-mail Agent van De Forex Opleiding. Je bent nauwkeurig, efficient en vriendelijk. Je communiceert in het Nederlands.`,
  Leon:  `Je bent Leon, de Administratief Medewerker van De Forex Opleiding. Je bent georganiseerd en precies. Je communiceert in het Nederlands.`,
  Aron:  `Je bent Aron, de Financieel Medewerker van De Forex Opleiding. Je bent analytisch en resultaatgericht. Je communiceert in het Nederlands.`,
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth (CRON_SECRET) ────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader  = req.headers.authorization || '';
    const querySecret = req.query?.secret         || '';
    if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
      return res.status(401).json({ error: 'Unauthorized — CRON_SECRET vereist' });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // ── Stap 1: Data verzamelen ───────────────────────────────────────────────
    const [tasksResult, actionsResult, decisionsResult] = await Promise.allSettled([
      supabase.from('taken_items')
        .select('id, titel, prioriteit, toegewezen_aan, deadline, status')
        .neq('status', 'done')
        .neq('status', 'afgerond')
        .order('deadline', { ascending: true })
        .limit(30),
      supabase.from('email_actions')
        .select('id, action, set_at')
        .gte('set_at', sevenDaysAgo)
        .limit(100),
      supabase.from('decisions')
        .select('id, title, description, decided_by, decision_date')
        .gte('decision_date', sevenDaysAgo.split('T')[0])
        .eq('status', 'active')
        .order('decision_date', { ascending: false })
        .limit(10),
    ]);

    const openTasks       = tasksResult.status       === 'fulfilled' ? (tasksResult.value.data       || []) : [];
    const recentActions   = actionsResult.status     === 'fulfilled' ? (actionsResult.value.data     || []) : [];
    const recentDecisions = decisionsResult.status   === 'fulfilled' ? (decisionsResult.value.data   || []) : [];

    // ── Stap 2: Context strings per agent ─────────────────────────────────────
    const urgentTasks = openTasks.filter(t => t.prioriteit === 'Hoog' || t.prioriteit === 'Urgent');

    const tasksSummary = `Totaal open taken: ${openTasks.length}\nUrgente taken:\n${
      urgentTasks.map(t => `- ${t.titel} (${t.toegewezen_aan}, deadline: ${t.deadline || 'geen'})`).join('\n') || 'Geen'
    }`;
    const emailSummary = `E-mail acties verwerkt afgelopen 7 dagen: ${recentActions.length}`;
    const decisionsSummary = recentDecisions.length > 0
      ? `Beslissingen afgelopen week:\n${recentDecisions.map(d => `- ${d.title} (${d.decision_date})`).join('\n')}`
      : 'Geen nieuwe beslissingen deze week.';

    const STANDUP_CONTEXT = {
      Simon: emailSummary,
      Leon:  tasksSummary,
      Aron:  `${decisionsSummary}\n${urgentTasks.length > 0 ? `Urgente taken: ${urgentTasks.length}` : 'Geen urgente taken.'}`,
    };

    // ── Stap 3: Meeting row aanmaken ──────────────────────────────────────────
    const dateLabel = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const { data: meeting, error: meetingErr } = await supabase.from('agent_meetings').insert({
      title:        `Wekelijkse standup ${dateLabel}`,
      agenda:       'Wekelijkse statusbespreking',
      participants: ['Simon', 'Leon', 'Aron'],
      transcript:   [],
      status:       'active',
      created_by:   'system',
      meeting_type: 'standup',
      chair_agent:  'Simon',
    }).select().single();
    if (meetingErr) throw meetingErr;

    console.log(`[standup-weekly] Meeting aangemaakt: ${meeting.id}`);

    // ── Stap 4: Per-agent standup genereren ────────────────────────────────────
    const transcript = [];
    for (const name of ['Simon', 'Leon', 'Aron']) {
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model:      'claude-sonnet-4-6',
            max_tokens: 200,
            system:     `${FALLBACK_PROMPTS[name]}\n\nHet is maandagochtend standup. Geef een korte, zakelijke update (max 3 zinnen) gebaseerd op de beschikbare data.`,
            messages:   [{ role: 'user', content: `${STANDUP_CONTEXT[name]}\n\nGeef jouw standup update.` }],
          }),
        });
        const data    = await resp.json();
        const content = data.content?.[0]?.text?.trim() || '...';
        transcript.push({ speaker: name, content, timestamp: new Date().toISOString(), type: 'standup' });
        console.log(`[standup-weekly] ${name} update gegenereerd`);
      } catch (agentErr) {
        console.error(`[standup-weekly] ${name} fout:`, agentErr.message);
        transcript.push({
          speaker:   name,
          content:   `[Update kon niet worden gegenereerd: ${agentErr.message}]`,
          timestamp: new Date().toISOString(),
          type:      'standup',
        });
      }
    }

    // ── Stap 5: Rapport genereren ─────────────────────────────────────────────
    const transcriptText = transcript.map(t => `${t.speaker}: ${t.content}`).join('\n');
    let rapport_md = '';
    try {
      const rapportResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1024,
          system:     'Je bent een vergadersecretaris van De Forex Opleiding. Schrijf een beknopt standuprapport in Markdown, in het Nederlands.',
          messages:   [{ role: 'user', content: `Standup: "Wekelijkse standup ${dateLabel}"\nDeelnemers: Simon, Leon, Aron\n\nTranscript:\n${transcriptText}\n\nSchrijf een beknopt standuprapport met secties:\n## Aanwezig\n## Statusupdates\n## Aandachtspunten\n## Volgende acties` }],
        }),
      });
      const rd = await rapportResp.json();
      rapport_md = rd.content?.[0]?.text?.trim() || '';
    } catch (rapportErr) {
      console.error('[standup-weekly] rapport fout:', rapportErr.message);
    }

    // ── Stap 6: Meeting updaten ────────────────────────────────────────────────
    const { error: updateErr } = await supabase.from('agent_meetings').update({
      transcript,
      summary:               transcript.map(t => `${t.speaker}: ${t.content}`).join(' | '),
      action_points:         [],
      status:                'ended',
      ended_at:              new Date().toISOString(),
      rapport_md:            rapport_md || null,
      rapport_generated_at:  rapport_md ? new Date().toISOString() : null,
    }).eq('id', meeting.id);
    if (updateErr) console.error('[standup-weekly] update fout:', updateErr.message);

    console.log(`[standup-weekly] Standup voltooid: meeting_id=${meeting.id}`);
    return res.status(200).json({ ok: true, meeting_id: meeting.id, transcript, rapport_md });

  } catch (err) {
    console.error('[standup-weekly]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
