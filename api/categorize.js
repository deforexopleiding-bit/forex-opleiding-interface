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

// ── Harde inhoudsregels — altijd eerste check ──────────────────────────────
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

// ── Reclame-signalen tellen (minimaal 2 vereist voor harde classificatie) ──
function countReclameSignals(subject, bodySnippet) {
  let signals = 0;
  const s = (subject || '').toLowerCase();
  const b = (bodySnippet || '').toLowerCase();

  const reclameSubjectTerms = [
    'unsubscribe', 'nieuwsbrief', 'uitschrijven', 'promotie',
    'aanbieding', 'korting', 'deals', 'sale', 'newsletter',
    'abonnement', 'gratis', 'exclusief aanbod', 'beperkte tijd'
  ];
  if (reclameSubjectTerms.some((t) => s.includes(t))) signals++;

  const coldOutreach = [
    'ik kom even langs', 'even kennismaken', 'mijn diensten',
    'samenwerking', 'ik wilde je even', 'zou je interesse hebben',
    'ik help bedrijven', 'wij bieden aan', 'vrijblijvend gesprek'
  ];
  if (coldOutreach.some((t) => b.includes(t) || s.includes(t))) signals++;

  // Geen persoonlijke aanspreking in body (bij voldoende tekst)
  const hasPersonalGreeting = /beste\s+\w|hallo\s+\w|dag\s+\w|geachte\s+\w/i.test(b);
  if (b.length > 50 && !hasPersonalGreeting) signals++;

  return signals;
}

// ── Whitelist check — nooit als Reclame markeren ──────────────────────────
async function checkWhitelist(senderEmail, senderDomain) {
  try {
    if (senderEmail) {
      const { data } = await supabase.from('email_patterns')
        .select('category, confidence')
        .eq('sender_email', senderEmail)
        .eq('source', 'whitelist')
        .maybeSingle();
      if (data) return { whitelisted: true, category: data.category };
    }
    if (senderDomain) {
      const { data } = await supabase.from('email_patterns')
        .select('category, confidence')
        .eq('sender_domain', senderDomain)
        .is('sender_email', null)
        .eq('source', 'whitelist')
        .maybeSingle();
      if (data) return { whitelisted: true, category: data.category };
    }
  } catch (e) {
    console.warn('[categorize] whitelist check fout:', e.message);
  }
  return { whitelisted: false };
}

// ── Bekende reclame-domein check (hoge confidence, veel gezien) ───────────
async function checkKnownReclameDomain(senderEmail, senderDomain) {
  try {
    if (senderEmail) {
      const { data } = await supabase.from('email_patterns')
        .select('confidence, times_seen')
        .eq('sender_email', senderEmail)
        .eq('category', 'Reclame')
        .gte('confidence', 80)
        .gte('times_seen', 3)
        .maybeSingle();
      if (data) return true;
    }
    if (senderDomain) {
      const { data } = await supabase.from('email_patterns')
        .select('confidence, times_seen')
        .eq('sender_domain', senderDomain)
        .is('sender_email', null)
        .eq('category', 'Reclame')
        .gte('confidence', 80)
        .gte('times_seen', 3)
        .maybeSingle();
      if (data) return true;
    }
  } catch (e) {
    console.warn('[categorize] reclame domein check fout:', e.message);
  }
  return false;
}

// ── Context ophalen voor AI-aanroep ──────────────────────────────────────
async function fetchAiContext(senderEmail, senderDomain) {
  let patternsContext    = 'Geen bekende patronen.';
  let correctionsContext = 'Geen eerdere correcties voor deze afzender.';
  let generalLearning    = 'Geen algemene leerdata beschikbaar.';
  let kennisbankContext  = '';

  try {
    // Eerdere correcties voor deze afzender
    let corrQuery = supabase
      .from('learn_examples')
      .select('old_category, new_category, email_subject, corrected_at')
      .order('corrected_at', { ascending: false })
      .limit(20);

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

    // Top patronen als algemene leerdata
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

    // Kennisbank-items als categorisatiecontext
    const { data: kbItems } = await supabase
      .from('kennisbank_items')
      .select('category, title, content')
      .order('helpfulness_score', { ascending: false })
      .limit(8);

    if (kbItems?.length) {
      const kbByCat = {};
      for (const item of kbItems) {
        const cat = item.category || 'Overig';
        if (!kbByCat[cat]) kbByCat[cat] = [];
        kbByCat[cat].push(item.title || item.content?.slice(0, 60) || '?');
      }
      kennisbankContext = Object.entries(kbByCat)
        .map(([cat, titles]) => `- ${cat}: ${titles.join(', ')}`)
        .join('\n');
    }
  } catch (err) {
    console.warn('[categorize] AI-context ophalen mislukt:', err.message);
  }

  return { patternsContext, correctionsContext, generalLearning, kennisbankContext };
}

// ── Patroon bijwerken na AI-categorisatie ────────────────────────────────
async function updatePatternAfterAi(senderEmail, senderDomain, category, confidence, learnedFromCorrections) {
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

  // ── Stap 1: Harde inhoudsregels ────────────────────────────────────────
  const hardCategory = applyHardRules(subject, from);
  if (hardCategory) {
    return res.status(200).json({
      category: hardCategory, confidence: 100, source: 'rule', reasoning: 'Harde regel'
    });
  }

  // ── Stap 2: Whitelist check — nooit als Reclame markeren ───────────────
  const { whitelisted, category: whitelistCat } = await checkWhitelist(senderEmail, senderDomain);
  if (whitelisted) {
    return res.status(200).json({
      category: whitelistCat || 'Overig',
      confidence: 95,
      source: 'whitelist',
      reasoning: 'Afzender staat op whitelist — nooit reclame'
    });
  }

  // ── Stap 3: Supabase patroon lookup (hoge confidence) ──────────────────
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
        // Reclame-patroon: vereis ook minimaal 1 content-signaal voor zekerheid
        if (p.category === 'Reclame') {
          const signals = countReclameSignals(subject, bodySnippet);
          if (signals >= 1) {
            const src = p.source === 'manual' || p.source === 'domain_learned' ? 'learned' : 'pattern';
            return res.status(200).json({ category: p.category, confidence: p.confidence, source: src });
          }
          console.log(`[categorize] Reclame-patroon voor ${senderEmail} maar 0 content-signalen — AI ingeschakeld`);
        } else {
          const src = p.source === 'manual' || p.source === 'domain_learned' ? 'learned' : 'pattern';
          return res.status(200).json({ category: p.category, confidence: p.confidence, source: src });
        }
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
          if (p.category === 'Reclame') {
            const signals = countReclameSignals(subject, bodySnippet);
            if (signals >= 1) {
              const src = p.source === 'manual' || p.source === 'domain_learned' ? 'learned' : 'pattern';
              return res.status(200).json({ category: p.category, confidence: p.confidence, source: src });
            }
          } else {
            const src = p.source === 'manual' || p.source === 'domain_learned' ? 'learned' : 'pattern';
            return res.status(200).json({ category: p.category, confidence: p.confidence, source: src });
          }
        }
      }
    } catch (err) {
      console.warn('[categorize] Supabase patroon lookup mislukt:', err.message);
    }
  }

  // ── Stap 4: Bekende reclame-domein + content-signalen check ────────────
  const isKnownReclame = await checkKnownReclameDomain(senderEmail, senderDomain);
  if (isKnownReclame) {
    const signals = countReclameSignals(subject, bodySnippet);
    if (signals >= 1) {
      return res.status(200).json({
        category: 'Reclame',
        confidence: 85,
        source: 'pattern',
        reasoning: `Bekend reclame-domein + ${signals} content-signaal(en)`
      });
    }
  }

  // ── Stap 5: Volledige AI analyse ────────────────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }

  const { patternsContext, correctionsContext, generalLearning, kennisbankContext } =
    await fetchAiContext(senderEmail, senderDomain);

  const client = new Anthropic({ apiKey });

  const userContent = [
    'Van: '       + (from    || '—'),
    'Onderwerp: ' + (subject || '—'),
    bodySnippet   ? 'Inhoud (eerste 500 tekens):\n' + String(bodySnippet).slice(0, 500) : ''
  ].filter(Boolean).join('\n');

  const systemPrompt = `Je bent een e-mail categorisatie expert voor De Forex Opleiding.
Je leert van eerdere beslissingen en past je aan op basis van correcties.
Analyseer de INHOUD van de e-mail als eerste — niet alleen de afzender.

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
- Reclame: marketing, nieuwsbrief, promotie, koude acquisitie, spam (MINIMAAL 2 signalen vereist!)
- Overig: past nergens anders in

RECLAME-DREMPEL: markeer als Reclame ALLEEN als er minimaal 2 van deze signalen zijn:
1. Reclame-termen in onderwerp (nieuwsbrief, aanbieding, unsubscribe, korting, deals)
2. Koude acquisitie taal in inhoud (ik kom even langs, mijn diensten, samenwerking aanbieden)
3. Geen persoonlijke aanspreking (geen "Beste [naam]" of "Hallo [naam]")
4. Afzender staat als Reclame gemarkeerd in systeem
Bij twijfel: kies Overig, niet Reclame.

GELEERDE PATRONEN UIT SUPABASE:
${patternsContext}

EERDERE CORRECTIES VOOR DEZE AFZENDER:
${correctionsContext}

ALGEMENE LEERDATA:
${generalLearning}

${kennisbankContext ? `KENNISBANK CATEGORIEËN:\n${kennisbankContext}\n` : ''}
Geef terug als JSON:
{"category":"...","confidence":0-100,"reasoning":"...","key_signals":["..."],"learned_from_corrections":true/false,"is_definitely_not_spam":true/false}

key_signals: lijst van maximaal 3 concrete signalen die je beslissing bepalen.
is_definitely_not_spam: true als je zeker weet dat dit GEEN reclame/spam is (bijv. persoonlijke klant, bekende afzender, inhoudelijke vraag).
Geef ALLEEN de JSON terug.`;

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }]
    });

    const raw = (response.content[0]?.text || '').trim();
    let parsed = null;
    try {
      const m = raw.match(/\{[\s\S]*?\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}

    let category   = VALID_CATEGORIES.includes(parsed?.category) ? parsed.category : 'Overig';
    const confidence = (typeof parsed?.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 100)
      ? Math.round(parsed.confidence) : 60;
    const reasoning  = String(parsed?.reasoning || '').slice(0, 300);
    const learnedFromCorrections = parsed?.learned_from_corrections === true;
    const isDefinitelyNotSpam    = parsed?.is_definitely_not_spam === true;
    const keySignals             = Array.isArray(parsed?.key_signals) ? parsed.key_signals.slice(0, 3) : [];

    // Reclame-drempel: val terug op Overig bij weinig signalen + lage confidence
    if (category === 'Reclame') {
      const signals = countReclameSignals(subject, bodySnippet);
      if (signals < 1 && confidence < 80) {
        category = 'Overig';
        console.log(`[categorize] AI zei Reclame maar ${signals} signalen + confidence ${confidence} — teruggevallen op Overig`);
      }
    }

    // ── Stap 6: Patroon bijwerken + auto-whitelist ──────────────────────
    if (senderEmail) {
      updatePatternAfterAi(senderEmail, senderDomain, category, confidence, learnedFromCorrections)
        .catch((e) => console.warn('[categorize] Pattern update fout:', e.message));

      // Auto-whitelist als AI zeker weet dat het geen spam is
      if (isDefinitelyNotSpam && category !== 'Reclame') {
        supabase.from('email_patterns').upsert({
          sender_email:      senderEmail,
          sender_domain:     senderDomain || null,
          category,
          confidence:        90,
          times_seen:        1,
          source:            'whitelist',
          last_corrected_at: new Date().toISOString()
        }, { onConflict: 'sender_email' })
          .then(({ error }) => {
            if (error) console.warn('[categorize] whitelist upsert fout:', error.message);
            else console.log(`[categorize] Auto-whitelist aangemaakt voor ${senderEmail} (${category})`);
          });
      }
    }

    return res.status(200).json({
      category,
      confidence,
      reasoning,
      key_signals:              keySignals,
      source:                   learnedFromCorrections ? 'ai_learned' : 'ai',
      learned_from_corrections: learnedFromCorrections,
      is_definitely_not_spam:   isDefinitelyNotSpam
    });
  } catch (err) {
    console.error('[categorize] API error:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
