import { supabase, createUserClient } from './supabase.js';
import { getToolsForAgent, execute } from './agent-tools.js';

const FALLBACK_PROMPTS = {
  Simon: `Je bent Simon, de E-mail Agent van De Forex Opleiding. Je bent nauwkeurig, efficiënt en vriendelijk. Je beheert alle inkomende en uitgaande e-mails en leert continu van correcties. Je communiceert altijd in het Nederlands. Je hebt toegang tot actuele data via tools. Als Jeffrey je iets vraagt over de inbox of taken, gebruik dan de beschikbare tools om actuele cijfers op te halen.

ONBEANTWOORDE MAILS — EERLIJKE COMMUNICATIE:
De tool get_unanswered_emails geeft alleen mails terug die expliciet zijn gemarkeerd via de "Actie vereist" knop (confirmed_count). Mails die automatisch in de Actie vereist-tab staan via AI-categorisatie (Klantvraag, Factuurvraag, Overig) zijn NIET zichtbaar in deze data — die leven in de browser-cache. Communiceer dit verschil altijd eerlijk:
- Toon confirmed_count als het zekere getal
- Leg uit dat het werkelijke getal hoger kan zijn
- Verwijs voor het volledige beeld naar de mailmodule → Actie vereist tab
- Speculeer NIET over het totaal; zeg niet "er zijn 21 mails"

SCHRIJF-ACTIES — APPROVAL PROTOCOL:
Voor schrijf-tools (send_email_reply, schedule_email_followup, add_decision_to_log, create_meeting_followup, add_knowledge_base_item) geldt:
1. Voor add_knowledge_base_item: toon altijd eerst een preview en wacht op "ja" / "doe maar" / "sla op" voordat je de tool aanroept.
2. Voor de overige schrijf-tools: roep de tool aan — die maakt automatisch een approval-request aan. Jeffrey ziet een bevestigingskaart in de chat en moet goedkeuren voordat er iets wordt uitgevoerd.
3. Communiceer na een schrijf-tool-aanroep: "Ik heb een verzoek klaargelegd — je ziet hieronder de approval ter goedkeuring."
4. Voer NOOIT zelfstandig schrijfacties uit zonder approval van Jeffrey.`,

  Leon:  `Je bent Leon, de Administratief Medewerker van De Forex Opleiding. Je bent georganiseerd, proactief en precies. Je beheert administratieve processen, contracten en klant onboarding. Je communiceert altijd in het Nederlands. Je houdt overzicht over alle lopende processen en taken.

UITVOERINGSTOOLS & APPROVAL PROTOCOL:
Je hebt toegang tot schrijf-tools (create_task_for_contract, update_task_status, bulk_categorize_review, add_decision_to_log, create_meeting_followup). Gebruik deze ALLEEN als Jeffrey expliciet vraagt om een actie.
- De tools maken automatisch een approval-request aan — Jeffrey ziet een bevestigingskaart in de chat.
- Na aanroep communiceer je: "Ik heb een verzoek klaargelegd — je ziet hieronder de approval ter goedkeuring."
- Voer NOOIT zelfstandig schrijfacties uit zonder Jeffrey's goedkeuring.
- get_open_tasks is read-only en kan altijd worden gebruikt zonder approval.`,

  Aron:  `Je bent Aron, de Financieel Medewerker van De Forex Opleiding. Je bent analytisch, betrouwbaar en resultaatgericht. Je beheert facturen, betalingen en financiële rapporten. Je communiceert altijd in het Nederlands. Je hebt oog voor detail en signaleert financiële risico's proactief.

UITVOERINGSTOOLS & APPROVAL PROTOCOL:
Je hebt toegang tot:
- identify_payment_concerns: read-only analyse — voer direct uit en rapporteer de resultaten.
- draft_payment_reminder, mark_invoice_followup, add_decision_to_log, create_meeting_followup: schrijf-tools via approval.
Gebruik schrijf-tools ALLEEN als Jeffrey expliciet vraagt om actie. De tools maken automatisch een approval-request aan.
Na aanroep communiceer je: "Ik heb een verzoek klaargelegd — je ziet hieronder de approval ter goedkeuring."
DISCLAIMER: Alle financiële analyses zijn gebaseerd op e-mailcategorisering, NIET op werkelijke Mollie of boekhouddata. Communiceer dit altijd eerlijk.`,
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

const MAX_TOOL_ROUNDS = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const { agent_id, agent_name, message, conversation_history = [], session_id, quick_action } = req.body || {};
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });

  try {
    // ── Agent laden ──────────────────────────────────────────────────────────
    let agent = null;
    if (agent_id) {
      const { data } = await supabase.from('agents').select('*').eq('id', agent_id).single();
      agent = data;
    }
    const name       = agent?.name       || agent_name || 'Agent';
    const systemBase = agent?.personality || FALLBACK_PROMPTS[name] || `Je bent ${name}, een medewerker van De Forex Opleiding. Communiceer altijd in het Nederlands.`;

    // ── Simon: geleerde correcties in systeem-prompt ──────────────────────────
    // Statistieken worden NU via tools opgezocht — niet meer vooraf geïnjecteerd
    let contextStr = '';
    if (name === 'Simon') {
      try {
        const { data: learnings } = await supabase
          .from('agent_learnings')
          .select('trigger_text, ideal_response')
          .eq('agent_name', 'Simon')
          .order('created_at', { ascending: false })
          .limit(15);

        if (learnings?.length > 0) {
          contextStr = '\n\nGELEERDE CORRECTIES (hoog prioriteit — volg deze patronen):\n' +
            learnings.map((l, i) =>
              `${i + 1}. Situatie: "${l.trigger_text.slice(0, 120)}" → Ideaal: "${l.ideal_response.slice(0, 200)}"`
            ).join('\n');
        }
      } catch (e) {
        console.warn('[agent-chat] learnings ophalen fout:', e.message);
      }
    }

    const systemPrompt = systemBase + contextStr;
    const userMessage  = (quick_action && QUICK_ACTION_MESSAGES[quick_action]) || message || 'Hoi!';

    // ── Tools bepalen voor deze agent ─────────────────────────────────────────
    const tools     = getToolsForAgent(name);
    const hasTools  = tools.length > 0;

    // ── Berichten opbouwen ────────────────────────────────────────────────────
    let currentMessages = [
      ...conversation_history.slice(-20).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    // ── Tool-use loop (max MAX_TOOL_ROUNDS rondes) ─────────────────────────────
    let finalResponse    = '';
    const toolsUsed      = [];
    const pendingApprovals = [];   // verzamelt { pending_approval: true, ... } van schrijf-tools
    let rounds           = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const requestBody = {
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     systemPrompt,
        messages:   currentMessages,
      };
      if (hasTools) requestBody.tools = tools;

      const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body:    JSON.stringify(requestBody),
      });

      if (!claudeResp.ok) throw new Error(`Claude API: ${claudeResp.status}`);
      const claudeData = await claudeResp.json();

      // ── Geen tool-gebruik → definitief antwoord ────────────────────────────
      if (claudeData.stop_reason !== 'tool_use') {
        const textBlock = (claudeData.content || []).find(b => b.type === 'text');
        finalResponse = textBlock?.text?.trim() || 'Ik kon je vraag niet verwerken.';
        break;
      }

      // ── Tool-gebruik: uitvoeren en resultaten toevoegen ────────────────────
      const assistantContent = claudeData.content || [];
      const toolUseBlocks    = assistantContent.filter(b => b.type === 'tool_use');

      // Voeg assistant-bericht toe (met tool_use blocks) aan de conversatie
      currentMessages.push({ role: 'assistant', content: assistantContent });

      // Voer alle gevraagde tools uit
      const toolResults = [];
      for (const block of toolUseBlocks) {
        console.log(`[agent-chat] Tool-aanroep: ${block.name} |`, JSON.stringify(block.input));
        toolsUsed.push(block.name);

        try {
          const result = await execute(block.name, block.input, name);
          // Schrijf-tools geven pending_approval terug — verzamel apart
          if (result?.pending_approval) pendingApprovals.push(result);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     JSON.stringify(result),
          });
        } catch (toolErr) {
          console.error(`[agent-chat] Tool ${block.name} fout:`, toolErr.message);
          toolResults.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     JSON.stringify({ error: toolErr.message }),
            is_error:    true,
          });
        }
      }

      // Voeg tool-resultaten toe als user-bericht
      currentMessages.push({ role: 'user', content: toolResults });
    }

    // Fallback als de loop eindigde zonder definitief antwoord
    if (!finalResponse) {
      finalResponse = 'Ik heb meerdere databronnen geraadpleegd maar kon geen volledig antwoord formuleren.';
    }

    // ── Opslaan in Supabase (awaited) ──────────────────────────────────────────
    const userClient = createUserClient(req);
    const { data: { user: authUser } } = await userClient.auth.getUser();
    const userId = authUser?.id || null;

    const { error: saveErr } = await userClient.from('agent_conversations').insert([
      { agent_id: agent_id || null, agent_name: name, role: 'user',      content: userMessage, conversation_session: session_id, user_id: userId },
      { agent_id: agent_id || null, agent_name: name, role: 'assistant', content: finalResponse, conversation_session: session_id, user_id: userId },
    ]);
    if (saveErr) console.error('[agent-chat] save fout:', saveErr.message);

    return res.status(200).json({
      response:          finalResponse,
      agent_name:        name,
      tools_used:        toolsUsed,
      tool_rounds:       rounds,
      timestamp:         new Date().toISOString(),
      ...(pendingApprovals.length ? { pending_approvals: pendingApprovals } : {}),
    });

  } catch (err) {
    console.error('[agent-chat]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
