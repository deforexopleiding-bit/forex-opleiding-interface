import Anthropic from '@anthropic-ai/sdk';
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

// ── Harde regels — altijd vóór Supabase en AI ──────────────────────────────
// Geeft een categorie string terug, of null als geen regel van toepassing is.
function applyHardRules(subject, from) {
  const s      = (subject || '').toLowerCase();
  const domain = getDomain(extractEmail(from || ''));

  // REGEL 1 – Nieuwe Lead (hoogste prioriteit)
  const leadTerms = [
    'nieuwe lead', 'new lead', 'lead 001', 'lead 002', 'lead - ', 'lead -',
    'funnel', '10k challenge', '7-daagse', 'form submission',
    'you have received a form'
  ];
  if (leadTerms.some((t) => s.includes(t))) return 'Nieuwe Lead';

  // REGEL 2 – Appointment
  const appointTerms = ['uitlegsessie', 'ingepland', 'nieuwe call'];
  if (appointTerms.some((t) => s.includes(t))) return 'Appointment';

  // REGEL 3 – Event Aanmelding
  const eventTerms = ['event aanmelding', ' gent', 'aanmelding seminar', 'aanmelding webinar'];
  if (eventTerms.some((t) => s.includes(t))) return 'Event Aanmelding';

  // REGEL 4 – Bekende niet-reclame domeinen → Overig
  const overigDomains = ['vimeo.com', 'youtube.com', 'linkedin.com'];
  if (overigDomains.includes(domain)) return 'Overig';

  return null; // geen harde regel van toepassing
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from, subject, bodySnippet } = req.body || {};
  if (!from && !subject) {
    return res.status(400).json({ error: 'from of subject vereist' });
  }

  const senderEmail  = extractEmail(from || '');
  const senderDomain = getDomain(senderEmail);

  // ── Stap 0: Harde regels — niet te overschrijven ──────────────────────
  const hardCategory = applyHardRules(subject, from);
  if (hardCategory) {
    return res.status(200).json({ category: hardCategory, confidence: 100, source: 'rule', reasoning: 'Harde regel' });
  }

  // ── Stap 1: check bestaande patronen in Supabase ───────────────────────
  if (senderEmail) {
    try {
      // Exacte afzender-match — hoogste prioriteit
      const { data: exact } = await supabase
        .from('email_patterns')
        .select('category, confidence, times_seen, times_corrected')
        .eq('sender_email', senderEmail)
        .gte('confidence', 80)
        .gte('times_seen', 3)
        .order('confidence', { ascending: false })
        .limit(1);

      if (exact?.length) {
        const p = exact[0];
        const source = (p.times_corrected || 0) > 0 ? 'learned' : 'pattern';
        return res.status(200).json({ category: p.category, confidence: p.confidence, source });
      }

      // Domein-match — tweede prioriteit
      if (senderDomain) {
        const { data: domain } = await supabase
          .from('email_patterns')
          .select('category, confidence, times_seen, times_corrected')
          .eq('sender_domain', senderDomain)
          .is('sender_email', null)
          .gte('confidence', 80)
          .gte('times_seen', 3)
          .order('confidence', { ascending: false })
          .limit(1);

        if (domain?.length) {
          const p = domain[0];
          const source = (p.times_corrected || 0) > 0 ? 'learned' : 'pattern';
          return res.status(200).json({ category: p.category, confidence: p.confidence, source });
        }
      }
    } catch (err) {
      console.warn('Supabase patroon lookup mislukt, val terug op AI:', err.message);
    }
  }

  // ── Stap 2: Claude Haiku analyse ──────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }

  const client = new Anthropic({ apiKey });

  const userContent = [
    'Van: '      + (from    || '—'),
    'Onderwerp: ' + (subject || '—'),
    bodySnippet  ? 'Inhoud (eerste 500 tekens):\n' + String(bodySnippet).slice(0, 500) : ''
  ].filter(Boolean).join('\n');

  const systemPrompt = `Categoriseer deze e-mail voor De Forex Opleiding in één van deze categorieën:
Nieuwe Lead, Appointment, Event Aanmelding, Klantvraag, Factuurvraag, Reclame, Overig.

- Nieuwe Lead: interesse getoond via formulier of cold bericht
- Appointment: sessie of afspraak ingepland/bevestigd
- Event Aanmelding: aanmelding voor event, seminar of webinar
- Klantvraag: bestaande klant stelt vraag
- Factuurvraag: vraag over factuur, betaling of administratie
- Reclame: marketing, nieuwsbrief, promotie, koude acquisitie, spam
- Overig: past nergens anders in

Geef terug als JSON: {"category": "...", "confidence": 0-100, "reasoning": "..."}
Confidence is hoe zeker je bent (0-100). Geef ALLEEN de JSON terug.`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }]
    });

    const raw = (response.content[0]?.text || '').trim();
    let parsed = null;
    try {
      const m = raw.match(/\{[\s\S]*?\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}

    const category   = VALID_CATEGORIES.includes(parsed?.category) ? parsed.category : 'Overig';
    const confidence = (typeof parsed?.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 100)
      ? Math.round(parsed.confidence) : 60;
    const reasoning  = String(parsed?.reasoning || '').slice(0, 300);

    // ── Stap 2b: sla AI-resultaat op in Supabase (fire-and-forget) ────────
    if (senderEmail) {
      (async () => {
        try {
          const { data: existing } = await supabase
            .from('email_patterns')
            .select('id, times_seen, confidence')
            .eq('sender_email', senderEmail)
            .maybeSingle();

          if (existing) {
            await supabase.from('email_patterns').update({
              times_seen: (existing.times_seen || 0) + 1,
              last_seen:  new Date().toISOString()
            }).eq('id', existing.id);
          } else {
            await supabase.from('email_patterns').insert({
              sender_email:  senderEmail,
              sender_domain: senderDomain || null,
              category,
              confidence,
              times_seen:      1,
              times_corrected: 0
            });
          }
        } catch (dbErr) {
          console.warn('Supabase pattern opslaan mislukt:', dbErr.message);
        }
      })();
    }

    return res.status(200).json({ category, confidence, reasoning, source: 'ai' });
  } catch (err) {
    console.error('Categorize API error:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
