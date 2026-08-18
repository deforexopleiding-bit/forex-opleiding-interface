// api/email-ai-regenerate.js
//
// v2 E-mail module — AI-antwoord GENEREREN. Concept-only (mens verstuurt).
//
// Dunne wrapper rondom api/_lib/anthropic-client.js. RAAKT DE PROTECTED
// JOOST-BACKEND NIET AAN — geen imports of calls naar api/joost-*.js of
// joost_config-tabel. Eigen persona-defaults hier hardcoded, eigen prompt.
//
// Body (POST):
//   { original_subject, original_body, from_name?, tone?, extra_instructions?,
//     current_draft? }
//     tone: 'vriendelijk' | 'zakelijk' | 'kort' | 'streng' (default 'vriendelijk')
//     current_draft: als aanwezig → iteratieve BIJSTELLING i.p.v. verse
//       generatie. Model krijgt 'HUIDIG CONCEPT' + 'INSTRUCTIE VAN DE
//       GEBRUIKER' en herschrijft alleen wat de instructie vraagt.
//       Zonder current_draft = huidig gedrag (verse generatie), byte-identiek.
//
// Response:
//   200 { draft_subject, draft_body, model, tokens_out }
//   400 ontbrekende input
//   401/403 auth/permission
//   500 Anthropic error
//   503 ANTHROPIC_API_KEY ontbreekt
//
// Permission: email.reply.send (spiegel van send-endpoint — wie mag reply
// versturen mag ook een AI-draft opvragen).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { anthropicMessages } from './_lib/anthropic-client.js';

const TONES = {
  vriendelijk: 'Vriendelijk, empathisch, persoonlijke aanhef en afsluiting.',
  zakelijk:    'Zakelijk, professioneel, kort en helder. Geen overbodige beleefdheden.',
  kort:        'Zo kort mogelijk. Max 3-4 zinnen. Alleen essentie.',
  streng:      'Helder en direct. Geen ruimte voor onduidelijkheid. Beleefd maar niet overdreven vriendelijk.',
};

const SYSTEM_PROMPT = `Je bent een assistent die e-mail-concepten schrijft namens De Forex Opleiding NL B.V.
Je schrijft in het Nederlands, tenzij de originele mail duidelijk in een andere taal is.
Je genereert een CONCEPT dat een mens gaat reviewen en aanpassen voor verzending.

Belangrijke regels:
- Verzin geen feiten, cijfers of afspraken die niet in de context staan.
- Doe geen beloftes over doorlooptijden, kortingen of afspraken tenzij expliciet gevraagd.
- Als de mail onduidelijk is: stel een verhelderingsvraag i.p.v. gokken.
- Sluit af met een neutrale groet (bv. "Met vriendelijke groet, De Forex Opleiding") — de mens
  vult de eigen naam in.
- Geen handtekening genereren (die wordt server-side toegevoegd).
- Geen quote-blok van originele mail (het mail-client-programma doet dat).`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.reply.send'))) {
    return res.status(403).json({ error: 'Geen rechten (email.reply.send)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const originalSubject = typeof body.original_subject === 'string' ? body.original_subject.trim() : '';
  const originalBody    = typeof body.original_body    === 'string' ? body.original_body.trim()    : '';
  const fromName        = typeof body.from_name        === 'string' ? body.from_name.trim().slice(0, 200) : '';
  const tone            = TONES[body.tone] ? body.tone : 'vriendelijk';
  const extra           = typeof body.extra_instructions === 'string'
    ? body.extra_instructions.trim().slice(0, 500) : '';
  // Ruime cap voor current_draft (4000 chars) — een e-mail-concept blijft
  // ruim binnen dat budget, maar het houdt spoof-callers uit token-bloat.
  const currentDraft    = typeof body.current_draft === 'string'
    ? body.current_draft.trim().slice(0, 4000) : '';

  if (!originalSubject && !originalBody) {
    return res.status(400).json({ error: 'original_subject of original_body vereist' });
  }

  // Tool-use structured output — dwingt subject+body-terugkeer af.
  const draftTool = {
    name: 'produce_email_draft',
    description: 'Lever een concept-antwoord voor een inkomende e-mail. Subject korter dan 120 tekens, body als plaintext (geen HTML).',
    input_schema: {
      type: 'object',
      properties: {
        draft_subject: { type: 'string', description: 'Antwoord-onderwerp (meestal "Re: <origineel>" of nieuwe strekking).' },
        draft_body:    { type: 'string', description: 'Volledige plaintext body van het concept. Nederlandse taal tenzij origineel anders. Geen handtekening.' },
      },
      required: ['draft_subject', 'draft_body'],
    },
  };

  // Twee prompt-varianten:
  //   1. current_draft aanwezig → iteratieve BIJSTELLING. Model krijgt het
  //      lopende concept + de gebruiker-instructie, en herschrijft alleen
  //      wat de instructie vraagt. Behoudt taal + toon van het huidige
  //      concept (voorkomt drift bij meerdere ronden).
  //   2. current_draft leeg → verse generatie (huidig gedrag, byte-identiek).
  const userMessage = currentDraft
    ? (
        `TOON: ${TONES[tone]}\n\n` +
        (fromName ? `AFZENDER: ${fromName}\n` : '') +
        `ORIGINEEL ONDERWERP: ${originalSubject || '(leeg)'}\n\n` +
        `ORIGINELE BODY:\n${originalBody || '(leeg)'}\n\n` +
        `HUIDIG CONCEPT:\n${currentDraft}\n\n` +
        `INSTRUCTIE VAN DE GEBRUIKER: ${extra || '(geen extra instructie — polish alleen wat evident kan)'}\n\n` +
        `Herschrijf het concept volgens de instructie; behoud wat goed is, ` +
        `verander alleen wat de instructie vraagt. Gebruik dezelfde taal als het origineel. ` +
        `Behoud de bestaande aanspreekvorm (u of je) consistent in het hele bericht, ` +
        `tenzij de instructie expliciet vraagt die te veranderen. ` +
        `Geef het herschreven concept terug via de tool "produce_email_draft".`
      )
    : (
        `TOON: ${TONES[tone]}\n\n` +
        (fromName ? `AFZENDER: ${fromName}\n` : '') +
        `ORIGINEEL ONDERWERP: ${originalSubject || '(leeg)'}\n\n` +
        `ORIGINELE BODY:\n${originalBody || '(leeg)'}\n\n` +
        (extra ? `EXTRA INSTRUCTIES VAN DE GEBRUIKER: ${extra}\n\n` : '') +
        `Geef een concept-antwoord terug via de tool "produce_email_draft".`
      );

  try {
    const result = await anthropicMessages({
      system:      SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userMessage }],
      max_tokens:  1500,
      temperature: 0.5,
      tools:       [draftTool],
      tool_choice: { type: 'tool', name: 'produce_email_draft' },
    });

    const toolBlock = Array.isArray(result?.content)
      ? result.content.find((b) => b?.type === 'tool_use' && b?.name === 'produce_email_draft')
      : null;
    if (!toolBlock?.input?.draft_body) {
      return res.status(500).json({ error: 'Model gaf geen bruikbaar concept terug' });
    }
    return res.status(200).json({
      draft_subject: String(toolBlock.input.draft_subject || '').slice(0, 200),
      draft_body:    String(toolBlock.input.draft_body    || ''),
      model:         result?.model || null,
      tokens_out:    result?.usage?.output_tokens || null,
    });
  } catch (e) {
    if (e?.code === 'ANTHROPIC_KEY_MISSING') {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
    }
    console.error('[email-ai-regenerate]', e?.code || 'error', e?.message);
    return res.status(500).json({ error: e?.message || 'AI-generatie mislukt', code: e?.code || null });
  }
}
