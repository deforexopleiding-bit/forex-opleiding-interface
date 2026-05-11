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
function applyHardRules(subject, from) {
  const s      = (subject || '').toLowerCase();
  const domain = getDomain(extractEmail(from || ''));

  const leadTerms = [
    'nieuwe lead', 'new lead', 'lead 001', 'lead 002', 'lead - ', 'lead -',
    'funnel', '10k challenge', '7-daagse', 'form submission',
    'you have received a form'
  ];
  if (leadTerms.some((t) => s.includes(t))) return 'Nieuwe Lead';

  const appointTerms = ['uitlegsessie', 'ingepland', 'nieuwe call'];
  if (appointTerms.some((t) => s.includes(t))) return 'Appointment';

  const eventTerms = ['event aanmelding', ' gent', 'aanmelding seminar', 'aanmelding webinar'];
  if (eventTerms.some((t) => s.includes(t))) return 'Event Aanmelding';

  const overigDomains = ['vimeo.com', 'youtube.com', 'linkedin.com'];
  if (overigDomains.includes(domain)) return 'Overig';

  return null;
}

// ── Context ophalen uit Supabase voor AI-aanroep ───────────────────────────
async function fetchAiContext(senderEmail, senderDomain) {
  let patternsContext     = 'Geen bekende patronen.';
  let correctionsContext  = 'Geen eerdere correcties voor deze afzender.';
  let generalLearning     = 'Geen algemene leerdata beschikbaar.';

  try {
    // Eerdere correcties voor deze afzender (max 20)
    let corrQuery = supabase
      .from('learn_examples')
      .select('old_category, new_category, email_subject, corrected_at')
      .order('corrected_at', { ascending: false })
      .limit(20);

    // Kolom heet 'email_sender' in de Supabase tabel (niet 'sender_email')
    if (senderEmail) corrQuery = corrQuery.eq('email_sender', senderEmail);
    else if (senderDomain) corrQuery = corrQuery.eq('sender_domain', senderDomain);

    const { data: corrections } = await corrQuery;
    if (corrections?.length) {
      correctionsContext = corrections
        .map((c) => `- "${c.email_subject || '?'}" was "${c.old_category}" → gecorrigeerd naar "${c.new_category}"`)
        .join('\n');
    }

    // Bestaand patroon voor deze afzender
    if (senderEmail) {
      const { data: pattern } = await supabase
        .from('email_patterns')
        .select('category, confidence, times_seen, source')
        .eq('sender_email', senderEmail)
        .maybeSingle();

      if (pattern) {
        patternsContext =
          `Afzender: ${senderEmail} → ${pattern.category}` +
          ` (confidence: ${pattern.confidence}%, gezien: ${pattern.times_seen}x,` +
          ` bron: ${pattern.source || 'ai'})`;
      }
    } else if (senderDomain) {
      const { data: domainPat } = await supabase
        .from('email_patterns')
        .select('category, confidence, times_seen')
        .eq('sender_domain', senderDomain)
        .is('sender_email', null)
        .maybeSingle();

      if (domainPat) {
        patternsContext =
          `Domein: ${senderDomain} → ${domainPat.category}` +
          ` (confidence: ${domainPat.confidence}%, gezien: ${domainPat.times_seen}x)`;
      }
    }

    // Top 5 meest gecorrigeerde patronen (algemene leerdata)
    // times_corrected bestaat niet in email_patterns — gebruik confidence + times_seen
    const { data: topPatterns } = await supabase
      .from('email_patterns')
      .select('sender_domain, sender_email, category, confidence, times_seen, source')
      .gte('confidence', 70)
      .order('confidence', { ascending: false })
      .limit(5);

    if (topPatterns?.length) {
      generalLearning = topPatterns
        .map((p) =>
          `- ${p.sender_email || p.sender_domain || '?'}: ${p.category}` +
          ` (confidence: ${p.confidence}%, gezien: ${p.times_seen}x, bron: ${p.source || 'ai'})`
        )
        .join('\n');
    }
  } catch (err) {
    console.warn('AI-context ophalen mislukt:', err.message);
  }

  return { patternsContext, correctionsContext, generalLearning };
}

// ── Patroon bijwerken na AI-categorisatie ──────────────────────────────────
async function updatePatternAfterAi(senderEmail, senderDomain, category, confidence, learnedFromCorrections) {
  // email_patterns kolommen: id, sender_email, sender_domain, category, confidence,
  //                           times_seen, source, last_corrected_at, created_at, updated_at
  // GEEN times_corrected of last_seen
  try {
    const { data: existing } = await supabase
      .from('email_patterns')
      .select('id, times_seen, confidence, category, source')
      .eq('sender_email', senderEmail)
      .maybeSingle();

    if (existing) {
      const newTimesSeen = (existing.times_seen || 0) + 1;
      const baseConf = existing.confidence || confidence;
      const newConf  = learnedFromCorrections ? Math.min(100, baseConf + 10) : baseConf;
      const finalConf = newTimesSeen >= 5 && existing.category === category ? 100 : newConf;

      await supabase.from('email_patterns').update({
        times_seen: newTimesSeen,
        confidence: finalConf,
        source:     learnedFromCorrections ? 'ai_learned' : (existing.source || 'ai')
      }).eq('id', existing.id);
    } else if (senderEmail) {
      await supabase.from('email_patterns').insert({
        sender_email:  senderEmail,
        sender_domain: senderDomain || null,
        category,
        confidence:    learnedFromCorrections ? Math.min(100, confidence + 10) : confidence,
        times_seen:    1,
        source:        'ai'
      });
    }
  } catch (dbErr) {
    console.warn('[categorize] pattern opslaan mislukt:', dbErr.message);
  }
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

  // ── Stap 0: Harde regels ──────────────────────────────────────────────
  const hardCategory = applyHardRules(subject, from);
  if (hardCategory) {
    return res.status(200).json({
      category: hardCategory, confidence: 100, source: 'rule', reasoning: 'Harde regel'
    });
  }

  // ── Stap 1: Supabase patroon lookup (hoge confidence) ─────────────────
  if (senderEmail) {
    try {
      const { data: exact } = await supabase
        .from('email_patterns')
        .select('category, confidence, times_seen, source')
        .eq('sender_email', senderEmail)
        .gte('confidence', 80)
        .gte('times_seen', 3)
        .order('confidence', { ascending: false })
        .limit(1);

      if (exact?.length) {
        const p = exact[0];
        const src = p.source === 'manual' || p.source === 'domain_learned' ? 'learned' : 'pattern';
        return res.status(200).json({ category: p.category, confidence: p.confidence, source: src });
      }

      if (senderDomain) {
        const { data: domain } = await supabase
          .from('email_patterns')
          .select('category, confidence, times_seen, source')
          .eq('sender_domain', senderDomain)
          .is('sender_email', null)
          .gte('confidence', 80)
          .gte('times_seen', 3)
          .order('confidence', { ascending: false })
          .limit(1);

        if (domain?.length) {
          const p = domain[0];
          const src = p.source === 'manual' || p.source === 'domain_learned' ? 'learned' : 'pattern';
          return res.status(200).json({ category: p.category, confidence: p.confidence, source: src });
        }
      }
    } catch (err) {
      console.warn('Supabase patroon lookup mislukt:', err.message);
    }
  }

  // ── Stap 2: Context ophalen + Claude Haiku aanroepen ──────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }

  const { patternsContext, correctionsContext, generalLearning } =
    await fetchAiContext(senderEmail, senderDomain);

  const client = new Anthropic({ apiKey });

  const userContent = [
    'Van: '      + (from    || '—'),
    'Onderwerp: ' + (subject || '—'),
    bodySnippet  ? 'Inhoud (eerste 500 tekens):\n' + String(bodySnippet).slice(0, 500) : ''
  ].filter(Boolean).join('\n');

  const systemPrompt = `Je bent een e-mail categorisatie expert voor De Forex Opleiding.
Je leert van eerdere beslissingen en past je aan op basis van correcties.

BEDRIJFSCONTEXT:
- De Forex Opleiding is een financiële opleiding die mensen leert handelen
- Leads komen binnen via formulieren met onderwerpen als 'Nieuwe lead', 'Funnel', '10K challenge'
- Appointments zijn uitlegsessies die ingepland worden via Calendly of direct
- Klantvragen komen van bestaande klanten met echte inhoudelijke vragen
- Factuurvragen gaan over betalingen, facturen en administratie
- Reclame: koude acquisitie, nieuwsbrieven, marketing van andere bedrijven, spam

CATEGORIEËN:
- Nieuwe Lead: interesse getoond via formulier of cold bericht van potentiële klant
- Appointment: sessie of afspraak ingepland/bevestigd
- Event Aanmelding: aanmelding voor event, seminar of webinar
- Klantvraag: bestaande klant stelt vraag
- Factuurvraag: vraag over factuur, betaling of administratie
- Reclame: marketing, nieuwsbrief, promotie, koude acquisitie, spam
- Overig: past nergens anders in

GELEERDE PATRONEN UIT SUPABASE:
${patternsContext}

EERDERE CORRECTIES VOOR DEZE AFZENDER:
${correctionsContext}

ALGEMENE LEERDATA (meest gecorrigeerde patronen):
${generalLearning}

Geef terug als JSON:
{"category": "...", "confidence": 0-100, "reasoning": "...", "learned_from_corrections": true/false}

learned_from_corrections: true als je de correctiedata hebt gebruikt om je beslissing te maken.
Confidence is hoe zeker je bent (0-100). Geef ALLEEN de JSON terug.`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
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
    const learnedFromCorrections = parsed?.learned_from_corrections === true;

    // ── Stap 3: Patroon bijwerken (fire-and-forget) ─────────────────────
    if (senderEmail) {
      updatePatternAfterAi(senderEmail, senderDomain, category, confidence, learnedFromCorrections)
        .catch((e) => console.warn('Pattern update fout:', e.message));
    }

    return res.status(200).json({
      category,
      confidence,
      reasoning,
      source: learnedFromCorrections ? 'ai_learned' : 'ai',
      learned_from_corrections: learnedFromCorrections
    });
  } catch (err) {
    console.error('Categorize API error:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
