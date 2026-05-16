// api/follow-up-screenshot-review.js
//
// POST endpoint dat een geüploade screenshot via Anthropic Haiku Vision
// beoordeelt en het resultaat opslaat in follow_up_screenshot_audit.
//
// Body: { appointment_id, storage_path }

import { createUserClient, supabaseAdmin } from './supabase.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

const REVIEW_PROMPT = `Je beoordeelt een screenshot van een sales-call.

Doel: vaststellen of dit een legitiem bewijs is van een verzonden voicememo of een afgeronde call. Geldige indicators:
- WhatsApp- of Zoom-interface zichtbaar
- Voicememo-bubble met audio-waveform
- Call-UI met deelnemers, timer of meeting-controls
- Conversatie-context die plausibel is voor een sales-opvolging

Ongeldig of verdacht:
- Random foto's (landschap, eten, persoonlijk)
- Lege of placeholder schermen
- Tekst-screenshots zonder messaging-app context
- Duidelijk gemanipuleerde of beeld-bewerkte content

Antwoord ALLEEN met geldige JSON, exact dit format:
{"result":"ok","reasoning":"korte uitleg (max 200 chars)"}

Gebruik result waarde "ok" als duidelijk valide, "suspicious" als twijfelachtig of onduidelijk, "missing" als duidelijk geen valide bewijs.`;

const ALLOWED_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd.' });
  }

  const { appointment_id, storage_path } = req.body || {};
  if (!appointment_id || typeof appointment_id !== 'string') {
    return res.status(400).json({ error: 'appointment_id ontbreekt.' });
  }
  if (!storage_path || typeof storage_path !== 'string') {
    return res.status(400).json({ error: 'storage_path ontbreekt.' });
  }

  if (!storage_path.startsWith(`${user.id}/`)) {
    return res.status(403).json({ error: 'Storage pad matcht niet met user.' });
  }

  const { data: appt, error: apptErr } = await supabase
    .from('follow_up_appointments')
    .select('id, owner_id')
    .eq('id', appointment_id)
    .single();
  if (apptErr || !appt) {
    return res.status(404).json({ error: 'Appointment niet gevonden of geen toegang.' });
  }

  const { data: fileBlob, error: downloadErr } = await supabaseAdmin
    .storage
    .from('follow-up-screenshots')
    .download(storage_path);
  if (downloadErr || !fileBlob) {
    console.error('[screenshot-review] download error:', downloadErr?.message);
    return res.status(500).json({ error: 'Kon screenshot niet downloaden.' });
  }

  const arrayBuffer = await fileBlob.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  const ext = storage_path.split('.').pop()?.toLowerCase() || 'png';
  const mediaType = ALLOWED_MIME[ext] || 'image/png';

  let aiResult = 'suspicious';
  let aiReasoning = 'AI-review niet beschikbaar';

  try {
    const ar = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: REVIEW_PROMPT },
          ],
        }],
      }),
    });

    if (!ar.ok) {
      const errText = await ar.text();
      console.error('[screenshot-review] anthropic error:', ar.status, errText);
      aiReasoning = `Anthropic API fout ${ar.status}`;
    } else {
      const aData = await ar.json();
      const text = aData.content?.[0]?.text?.trim() || '';
      try {
        const parsed = JSON.parse(text);
        if (['ok', 'suspicious', 'missing'].includes(parsed.result)) {
          aiResult = parsed.result;
        }
        if (typeof parsed.reasoning === 'string') {
          aiReasoning = parsed.reasoning.slice(0, 500);
        }
      } catch (parseErr) {
        console.error('[screenshot-review] JSON parse error:', parseErr.message, 'raw:', text.slice(0, 200));
        aiReasoning = 'AI-response was geen valide JSON';
      }
    }
  } catch (err) {
    console.error('[screenshot-review] exception:', err.message);
    aiReasoning = `Exception tijdens AI-review: ${err.message}`;
  }

  const { error: auditErr } = await supabaseAdmin
    .from('follow_up_screenshot_audit')
    .insert({
      sales_user_id: user.id,
      screenshot_url: storage_path,
      appointment_id,
      ai_review_result: aiResult,
      ai_review_reasoning: aiReasoning,
      admin_reviewed: false,
    });

  if (auditErr) {
    console.error('[screenshot-review] audit insert error:', auditErr.message);
  }

  await supabaseAdmin
    .from('follow_up_appointments')
    .update({ screenshot_url: storage_path })
    .eq('id', appointment_id);

  return res.status(200).json({ result: aiResult, reasoning: aiReasoning });
}
