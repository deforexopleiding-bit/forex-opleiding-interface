import { supabase } from './supabase.js';

const FALLBACK_PROMPTS = {
  Simon: `Je bent Simon, de E-mail Agent van De Forex Opleiding. Je bent nauwkeurig, efficient en vriendelijk. Je beheert alle inkomende en uitgaande e-mails en leert continu van correcties. Je communiceert altijd in het Nederlands. Je hebt toegang tot actuele inbox-data. Als Jeffrey je iets vraagt over de inbox, geef je concrete cijfers en inzichten. Als Jeffrey je vraagt een actie uit te voeren, bevestig je eerst voordat je uitvoert.`,
  Leon:  `Je bent Leon, de Administratief Medewerker van De Forex Opleiding. Je bent georganiseerd, proactief en precies. Je beheert administratieve processen, contracten en klant onboarding. Je communiceert altijd in het Nederlands. Je houdt overzicht over alle lopende processen en taken.`,
  Aron:  `Je bent Aron, de Financieel Medewerker van De Forex Opleiding. Je bent analytisch, betrouwbaar en resultaatgericht. Je beheert facturen, betalingen en financiële rapporten. Je communiceert altijd in het Nederlands. Je hebt oog voor detail en signaleert financiële risico's proactief.`,
};

const QUICK_ACTION_MESSAGES = {
  dagrapport:              'Genereer een beknopt dagrapport met de belangrijkste statistieken en inzichten van vandaag.',
  inbox_status:            'Geef me een overzicht van de huidige inbox status: hoeveel mails, categorieën, onbeantwoorde mails.',
  heranalyseer:            'Ik wil dat je alle mails opnieuw analyseert. Vraag eerst mijn bevestiging en leg uit wat dit inhoudt en hoe lang het duurt.',
  train_agent:             'Hoe kan ik jou het best trainen om beter te categoriseren? Geef concrete opties en instructies.',
  taken_overzicht:         'Geef een overzicht van alle open taken, gesorteerd op prioriteit. Markeer urgente items duidelijk.',
  openstaande_contracten:  'Zijn er openstaande contracten of onboarding processen die aandacht nodig hebben?',
  openstaande_facturen:    'Wat zijn de openstaande facturen? Geef een overzicht met bedragen en vervaldatums indien bekend.',
  betalingen:              'Geef een overzicht van recente betalingen en openstaande betalingsachterstanden.',
  rapport:                 'Genereer een samenvatting rapport van de huidige status. Gebruik markdown opmaak.',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const { agent_id, agent_name, message, conversation_history = [], session_id, quick_action } = req.body || {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  try {
    // Load agent from Supabase
    let agent = null;
    if (agent_id) {
      const { data } = await supabase.from('agents').select('*').eq('id', agent_id).single();
      agent = data;
    }
    const name       = agent?.name       || agent_name || 'Agent';
    const systemBase = agent?.personality || FALLBACK_PROMPTS[name] || `Je bent ${name}, een medewerker van De Forex Opleiding. Communiceer altijd in het Nederlands.`;

    // ── Simon: live context via directe Supabase queries (geen HTTP roundtrip) ──
    let contextStr = '';
    if (name === 'Simon') {
      try {
        const [takenRes, unresolvedRes, learningsRes] = await Promise.allSettled([
          // Open taken: status niet 'done' en niet 'afgerond'
          supabase.from('taken_items')
            .select('id', { count: 'exact', head: true })
            .neq('status', 'done')
            .neq('status', 'afgerond'),
          // Onbeantwoorde acties: email_actions zonder resolved_at
          supabase.from('email_actions')
            .select('email_id')
            .is('resolved_at', null)
            .limit(500),
          // Geleerde correcties van Simon
          supabase.from('agent_learnings')
            .select('trigger_text, ideal_response')
            .eq('agent_name', 'Simon')
            .order('created_at', { ascending: false })
            .limit(15),
        ]);

        const openTaken = takenRes.status === 'fulfilled'
          ? (takenRes.value.count ?? '?') : '?';

        const onbeantwoord = unresolvedRes.status === 'fulfilled'
          ? new Set((unresolvedRes.value.data || []).map(a => a.email_id)).size : '?';

        const learnings = learningsRes.status === 'fulfilled'
          ? (learningsRes.value.data || []) : [];

        contextStr = `\n\nACTUELE DATA (${new Date().toLocaleString('nl-NL')}):\n- Open taken: ${openTaken}\n- Onbeantwoorde acties (unresolved): ${onbeantwoord}`;

        if (learnings.length > 0) {
          contextStr += '\n\nGELEERDE CORRECTIES (hoog prioriteit — volg deze patronen):\n' +
            learnings.map((l, i) =>
              `${i + 1}. Situatie: "${l.trigger_text.slice(0, 120)}" → Ideaal: "${l.ideal_response.slice(0, 200)}"`
            ).join('\n');
        }
      } catch (e) {
        console.warn('[agent-chat] Simon context fout:', e.message);
      }
    }

    const systemPrompt = systemBase + contextStr;
    const userMessage  = (quick_action && QUICK_ACTION_MESSAGES[quick_action]) || message || 'Hoi!';

    const messages = [
      ...conversation_history.slice(-20).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body:    JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, messages }),
    });

    if (!claudeResp.ok) throw new Error(`Claude API: ${claudeResp.status}`);
    const claudeData = await claudeResp.json();
    const response   = claudeData.content?.[0]?.text?.trim() || 'Ik kon je vraag niet verwerken.';

    // ── Opslaan in Supabase (awaited — niet meer fire-and-forget) ──────────────
    const { error: saveErr } = await supabase.from('agent_conversations').insert([
      { agent_id: agent_id || null, agent_name: name, role: 'user',      content: userMessage, conversation_session: session_id },
      { agent_id: agent_id || null, agent_name: name, role: 'assistant', content: response,    conversation_session: session_id },
    ]);
    if (saveErr) console.error('[agent-chat] save fout:', saveErr.message);

    return res.status(200).json({ response, agent_name: name, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[agent-chat]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
