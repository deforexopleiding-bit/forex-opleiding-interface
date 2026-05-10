import { supabase } from './supabase.js';

const VALID_CATEGORIES = [
  'Nieuwe Lead','Appointment','Event Aanmelding',
  'Klantvraag','Factuurvraag','Reclame','Overig'
];

function extractEmail(str) {
  const m = (str || '').match(/<([^>]+)>/);
  return (m ? m[1] : str).toLowerCase().trim();
}
function getDomain(email) {
  const i = email.lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    email_id,
    sender,
    subject,
    body_snippet,
    old_category,
    new_category,
    corrected_by
  } = req.body || {};

  if (!sender || !new_category) {
    return res.status(400).json({ error: 'sender en new_category zijn vereist' });
  }
  if (!VALID_CATEGORIES.includes(new_category)) {
    return res.status(400).json({ error: `Ongeldige categorie: ${new_category}` });
  }

  const senderEmail  = extractEmail(sender);
  const senderDomain = getDomain(senderEmail);

  // ── Stap 1: Sla leervoorbeeld op in learn_examples ────────────────────
  try {
    await supabase.from('learn_examples').insert({
      email_id:     email_id    || null,
      sender_email: senderEmail || null,
      subject:      subject     || null,
      body_snippet: body_snippet ? String(body_snippet).slice(0, 500) : null,
      old_category: old_category || null,
      new_category,
      corrected_by: corrected_by || null,
      corrected_at: new Date().toISOString()
    });
  } catch (err) {
    console.warn('learn_examples insert mislukt:', err.message);
  }

  // ── Stap 2: Update of maak email_patterns record ──────────────────────
  let patternCount = 0;
  let isHighConfidence = false;

  try {
    // Zoek bestaand patroon voor deze afzender
    const { data: existing } = await supabase
      .from('email_patterns')
      .select('id, times_seen, times_corrected, confidence, category')
      .eq('sender_email', senderEmail)
      .maybeSingle();

    if (existing) {
      const newCorrected = (existing.times_corrected || 0) + 1;
      // Na 3 correcties naar dezelfde categorie: confidence = 95
      const newConfidence = newCorrected >= 3 ? 95 : Math.min(90, (existing.confidence || 60) + 10);

      await supabase.from('email_patterns').update({
        category:        new_category,
        confidence:      newConfidence,
        times_corrected: newCorrected,
        last_seen:       new Date().toISOString()
      }).eq('id', existing.id);

      patternCount = (existing.times_seen || 0) + newCorrected;
      isHighConfidence = newConfidence >= 95;
    } else {
      // Nieuw patroon aanmaken op basis van correctie
      await supabase.from('email_patterns').insert({
        sender_email:    senderEmail,
        sender_domain:   senderDomain || null,
        category:        new_category,
        confidence:      70,
        times_seen:      1,
        times_corrected: 1
      });
      patternCount = 1;
    }
  } catch (err) {
    console.warn('email_patterns update mislukt:', err.message);
  }

  // ── Stap 3: Tel hoeveel learn_examples voor dit patroon ──────────────
  try {
    const { count } = await supabase
      .from('learn_examples')
      .select('id', { count: 'exact', head: true })
      .eq('sender_email', senderEmail);
    if (count != null) patternCount = count;
  } catch {}

  return res.status(200).json({
    ok: true,
    sender_email:     senderEmail,
    new_category,
    pattern_examples: patternCount,
    high_confidence:  isHighConfidence
  });
}
