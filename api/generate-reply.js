import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';

const SYSTEM_PROMPT = `Je bent de e-mailassistent van De Forex Opleiding.
Je schrijft vriendelijke, persoonlijke e-mails in het Nederlands.
Je reageert ALTIJD specifiek op wat de klant heeft geschreven — nooit een generiek antwoord.
Je gebruikt de kennisbank voorbeelden als leidraad voor toon en stijl.
Bedrijfsregel: incasso- of administratiekosten mogen altijd worden kwijtgescholden als een klant daarom vraagt.
Maximaal 150 woorden tenzij de situatie meer vereist.
Schrijf alsof je Jeffrey zelf bent — warm, direct en persoonlijk.
De handtekening wordt automatisch toegevoegd — schrijf GEEN eigen ondertekening of afsluiting.
Schrijf alleen de e-mailtekst: begin direct met de aanhef (bijv. "Beste [naam],") en eindig na de laatste inhoudszin.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is niet geconfigureerd. Voeg deze toe aan Vercel → Settings → Environment Variables.'
    });
  }

  const { email, kennisbankContext: frontendKb, learningExamples: frontendEx, auto_save_reply } = req.body || {};

  if (!email) {
    return res.status(400).json({ error: 'email ontbreekt in request body' });
  }

  const client = new Anthropic({ apiKey });

  // ── Server-side kennisbank ophalen uit Supabase ───────────────────────────
  let serverKbItems = [];
  let serverLearnEx = [];
  let kennisbankUsed = 0;
  let learningExamplesUsed = 0;

  try {
    // Haal meest helpfulle kennisbank-items op (gesorteerd op helpfulness_score)
    const { data: kbItems } = await supabase
      .from('kennisbank_items')
      .select('title, category, content, question, answer, helpfulness_score, times_helpful')
      .order('helpfulness_score', { ascending: false })
      .limit(10);
    serverKbItems = kbItems || [];
    kennisbankUsed = serverKbItems.length;
    console.log(`[generate-reply] kennisbank: ${kennisbankUsed} items geladen`);

    // Haal recente correcties op voor de categorie van deze e-mail
    if (email?.category) {
      const { data: learnEx } = await supabase
        .from('learn_examples')
        .select('email_subject, new_category, corrected_at, body_snippet')
        .eq('new_category', email.category)
        .order('corrected_at', { ascending: false })
        .limit(5);
      serverLearnEx = learnEx || [];
      learningExamplesUsed = serverLearnEx.length;
    }
  } catch (e) {
    console.warn('[generate-reply] kennisbank fetch fout:', e.message);
  }

  // ── Prompt opbouwen ───────────────────────────────────────────────────────
  const parts = [];

  // Bedrijfsprofiel (server-side kennisbank heeft prioriteit, anders frontend fallback)
  const kbProfile = frontendKb?.profile || '';
  if (kbProfile) {
    parts.push(`## Bedrijfsprofiel\n${kbProfile}`);
  }

  // Kennisbank-items: server-side eerst, dan frontend-fallback als server leeg is
  const effectiveKbItems = serverKbItems.length > 0 ? serverKbItems : (frontendKb?.items || []);
  if (effectiveKbItems.length > 0) {
    const itemText = effectiveKbItems
      .map((item) => {
        const lines = [];
        if (item.title) lines.push(`### ${item.title}`);
        if (item.category) lines.push(`Categorie: ${item.category}`);
        if (item.content) lines.push(item.content);
        if (item.question && item.answer) {
          lines.push(`V: ${item.question}\nA: ${item.answer}`);
        }
        return lines.join('\n');
      })
      .join('\n\n');
    parts.push(`## Kennisbank\n${itemText}`);
  }

  // Leervoorbeelden: server-side recent voor deze categorie
  const effectiveLearnEx = serverLearnEx.length > 0 ? serverLearnEx : (frontendEx || []);
  if (effectiveLearnEx.length > 0) {
    const recent = effectiveLearnEx.slice(-5);
    const exText = recent
      .map((ex) => {
        if (ex.userVersion) {
          // Frontend-formaat
          return `Categorie: ${ex.category}\nOnderwerp: ${ex.originalEmail?.subject || '—'}\nGoedgekeurd antwoord:\n${ex.userVersion}`;
        }
        // Server-formaat (learn_examples)
        return `Categorie: ${ex.new_category}\nOnderwerp: ${ex.email_subject || '—'}\nBody-fragment: ${ex.body_snippet || '—'}`;
      })
      .join('\n\n---\n\n');
    parts.push(`## Eerdere goedgekeurde antwoorden (schrijfstijl leidraad)\n${exText}`);
  }

  // De te beantwoorden e-mail
  const emailSection = [
    '## Te beantwoorden e-mail',
    `Van: ${email.from || email.fromAddress || 'Onbekend'}`,
    `Aan: ${email.mailbox || '—'}`,
    `Onderwerp: ${email.subject || '(geen onderwerp)'}`,
    `Categorie: ${email.category || 'Overig'}`,
    '',
    email.body ? `Inhoud:\n${email.body}` : '(Geen e-mailinhoud beschikbaar — baseer het antwoord op het onderwerp en de categorie.)'
  ].join('\n');
  parts.push(emailSection);

  const userMessage = parts.join('\n\n') +
    '\n\nSchrijf een passend antwoord op deze e-mail.';

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    });

    const reply = response.content[0]?.text?.trim() || '';

    // ── Auto-save goede replies naar kennisbank ───────────────────────────
    if (auto_save_reply && reply && email?.subject) {
      supabase.from('kennisbank_items').insert({
        title:           `Auto: ${String(email.subject).slice(0, 60)}`,
        category:        email.category || 'Overig',
        content:         reply,
        auto_generated:  true,
        source_email_id: email.uid || null,
        times_used:      1,
        helpfulness_score: 50,
      })
        .then(({ error }) => {
          if (error) console.warn('[generate-reply] auto-save kennisbank fout:', error.message);
          else console.log('[generate-reply] Reply auto-opgeslagen in kennisbank');
        });
    }

    return res.status(200).json({
      reply,
      kennisbank_used:        kennisbankUsed,
      learning_examples_used: learningExamplesUsed
    });
  } catch (err) {
    console.error('Anthropic API error:', err);
    return res.status(500).json({
      error: `AI-generatie mislukt: ${err.message || 'onbekende fout'}`
    });
  }
}
