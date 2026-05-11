import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';

const VALID_CATEGORIES = [
  'Nieuwe Lead', 'Appointment', 'Event Aanmelding',
  'Klantvraag', 'Factuurvraag', 'Reclame', 'Overig'
];

const FALLBACK_BEDRIJFSPROFIEL = `De Forex Opleiding is een financiële trading opleiding in Nederland.
Klanten zijn mensen die forex trading willen leren.
Producten: uitlegsessies, online cursussen, 10K challenge, 7-daagse challenge.
Leads komen binnen via formulieren op de website en funnels.
Jeffrey is de eigenaar en beantwoordt persoonlijk alle klantvragen.`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractEmail(str) {
  const m = (str || '').match(/<([^>]+)>/);
  return (m ? m[1] : str).toLowerCase().trim();
}
function getDomain(email) {
  const i = (email || '').lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}
const STOPWORDS_AGENT = new Set(['de','het','een','voor','met','van','naar','die','dat','deze','dit',
  'en','of','in','op','om','aan','is','als','bij','door','over','tot','uit','the','a','an',
  'and','or','for','with','from','on','are','this','that','your']);

function extractKeywords(text) {
  return (text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS_AGENT.has(w))
    .slice(0, 6);
}
function extractBodyKeywords(text, maxWords = 10) {
  return (text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS_AGENT.has(w))
    .slice(0, maxWords);
}

// ── Harde inhoudsregels ───────────────────────────────────────────────────────
const PAYMENT_DOMAINS = ['paypal.nl', 'paypal.com', 'mollie.com', 'stripe.com'];
const HARD_RULES = [
  {
    category: 'Nieuwe Lead',
    requires_action: false,
    patterns: ['nieuwe lead', 'new lead', 'lead 001', 'lead 002', 'lead 003', 'lead 004', 'lead 005',
      'funnel', '10k challenge', '7-daagse', 'form submission', 'you have received a form',
      'lead - ', 'lead -']
  },
  {
    category: 'Appointment',
    requires_action: false,
    patterns: ['uitlegsessie ingepland', 'uitlegsessie', 'ingepland', 'nieuwe call',
      'appointment booked', 'sessie ingepland', 'call ingepland']
  },
  {
    category: 'Event Aanmelding',
    requires_action: false,
    patterns: ['event aanmelding', 'aanmelding gent', 'seminar aanmelding',
      'aanmelding seminar', 'aanmelding webinar', ' gent']
  },
  {
    category: 'Overig',
    requires_action: false,
    patterns: ['betaling ontvangen', 'factuur voldaan', 'payment confirmed',
      'je factuur werd betaald', 'werd online betaald', 'creditcard-betaling ontvangen',
      'ontvangstbewijs', 'transactiebewijs', 'your receipt', 'payment receipt',
      'je betaling is ontvangen', 'je bestelling is bevestigd']
  }
];
const OVERIG_DOMAINS = ['vimeo.com', 'youtube.com', 'linkedin.com'];

function applyHardRules(subject, from, bodySnippet) {
  const s      = (subject || '').toLowerCase();
  const b      = (bodySnippet || '').toLowerCase();
  const domain = getDomain(extractEmail(from || ''));

  for (const rule of HARD_RULES) {
    if (rule.patterns.some((p) => s.includes(p) || b.includes(p))) {
      return { category: rule.category, requires_action: rule.requires_action };
    }
  }

  if (PAYMENT_DOMAINS.includes(domain)) {
    return { category: 'Overig', requires_action: false };
  }
  if (domain === 'teamleader.eu') {
    const isPayment = ['betaald', 'payment', 'receipt', 'factuur'].some((t) => b.includes(t) || s.includes(t));
    if (isPayment) return { category: 'Overig', requires_action: false };
  }
  if (OVERIG_DOMAINS.includes(domain)) {
    return { category: 'Overig', requires_action: false };
  }

  return null;
}

// ── Re:/Fwd: detectie ────────────────────────────────────────────────────────
function isReplyOrForward(subject) {
  return /^(re|re\.|fw|fwd|antw|antwoord)\s*:/i.test((subject || '').trim());
}

// ── Directe vraag/actie detectie in body ─────────────────────────────────────
const QUESTION_SIGNALS = [
  'waar ', 'wanneer ', 'hoe ', 'wat ', 'kan ik', 'zou ik', 'kunt u', 'kun je',
  'graag ', 'help', 'probleem', 'klacht', 'terugbellen', ' adres', ' info ',
  'vraag', 'weet u', 'weet je', 'kunt u mij', 'zou u', 'zou je',
  'meer informatie', 'meer info', 'niet gelukt', 'werkt niet', 'begrijp niet',
  'snap niet', 'uitleg', 'kunt u mij', 'mag ik', 'is er'
];

function detectDirectQuestion(bodySnippet) {
  if (!bodySnippet) return false;
  const b = bodySnippet.toLowerCase();
  if (b.includes('?')) return true;
  return QUESTION_SIGNALS.some((w) => b.includes(w));
}

// ── Reclame-signalen tellen ───────────────────────────────────────────────────
function countReclameSignals(subject, bodySnippet) {
  let signals = 0;
  const s = (subject || '').toLowerCase();
  const b = (bodySnippet || '').toLowerCase();

  const promoTerms = ['unsubscribe', 'nieuwsbrief', 'uitschrijven', 'promotie',
    'aanbieding', 'korting', 'deals', 'sale', 'newsletter', 'abonnement',
    'gratis', 'exclusief aanbod', 'beperkte tijd', 'afmelden'];
  if (promoTerms.some((t) => s.includes(t))) signals++;

  const bulkMailHeaders = ['mailchimp', 'sendgrid', 'klaviyo', 'campaign monitor',
    'mailerlite', 'activecampaign', 'hubspot'];
  if (bulkMailHeaders.some((t) => b.includes(t))) signals++;

  if (b.includes('uitschrijven') || b.includes('unsubscribe') || b.includes('afmelden')) signals++;

  const coldOutreach = ['ik kom even langs', 'even kennismaken', 'mijn diensten',
    'zou je interesse hebben', 'ik help bedrijven', 'wij bieden aan', 'vrijblijvend gesprek',
    'ik wilde je even', 'wij hebben een oplossing'];
  if (coldOutreach.some((t) => b.includes(t) || s.includes(t))) signals++;

  const hasPersonalGreeting = /beste\s+\w|hallo\s+\w|dag\s+\w|geachte\s+\w/i.test(b);
  if (b.length > 80 && !hasPersonalGreeting) signals++;

  return signals;
}

// ── Supabase: whitelist / blacklist / patroon ─────────────────────────────────
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
  } catch (e) { console.warn('[email-agent] whitelist check fout:', e.message); }
  return { whitelisted: false };
}

async function checkBlacklist(senderEmail, senderDomain) {
  try {
    if (senderEmail) {
      const { data } = await supabase.from('email_patterns')
        .select('id')
        .eq('sender_email', senderEmail)
        .eq('source', 'blacklist')
        .maybeSingle();
      if (data) return true;
    }
    if (senderDomain) {
      const { data } = await supabase.from('email_patterns')
        .select('id')
        .eq('sender_domain', senderDomain)
        .is('sender_email', null)
        .eq('source', 'blacklist')
        .maybeSingle();
      if (data) return true;
    }
  } catch (e) { console.warn('[email-agent] blacklist check fout:', e.message); }
  return false;
}

async function lookupHighConfidencePattern(senderEmail, senderDomain, subject, bodySnippet) {
  let result = null;
  try {
    for (const [field, value] of [[senderEmail ? 'sender_email' : null, senderEmail], ['sender_domain', senderDomain]]) {
      if (!field || !value) continue;
      const query = supabase.from('email_patterns')
        .select('category, confidence, times_seen, source, requires_action')
        .gte('confidence', 85)
        .gte('times_seen', 3)
        .order('confidence', { ascending: false })
        .limit(1);

      const { data } = field === 'sender_email'
        ? await query.eq('sender_email', value)
        : await query.eq('sender_domain', value).is('sender_email', null);

      if (data?.length) {
        const p = data[0];
        if (p.category === 'Reclame') {
          if (countReclameSignals(subject, bodySnippet) >= 1) { result = p; break; }
          continue;
        }
        result = p; break;
      }
    }
  } catch (e) { console.warn('[email-agent] pattern lookup fout:', e.message); }

  // Body keyword fallback — patronen geleerd via Verplaats & Train
  if (!result) {
    const bodyKws = extractBodyKeywords(bodySnippet || '', 10);
    if (bodyKws.length >= 4) {
      try {
        const { data: bkPatterns } = await supabase.from('email_patterns')
          .select('category, confidence, times_seen, body_keywords, requires_action')
          .not('body_keywords', 'is', null)
          .gte('confidence', 75)
          .gte('times_seen', 2);
        for (const pat of (bkPatterns || [])) {
          const overlap = (pat.body_keywords || []).filter((w) => bodyKws.includes(w)).length;
          if (overlap >= 4) {
            result = { category: pat.category, confidence: pat.confidence, source: 'body_learned', requires_action: pat.requires_action };
            break;
          }
        }
      } catch (e) { console.warn('[email-agent] body_keywords lookup fout:', e.message); }
    }
  }

  return result;
}

// ── Kennisbank + correcties context ─────────────────────────────────────────
async function buildAiContext(senderEmail, senderDomain) {
  let bedrijfsprofiel    = FALLBACK_BEDRIJFSPROFIEL;
  let correctionsContext = 'Geen eerdere correcties.';
  let patternContext     = 'Geen bekende patronen.';
  let kennisbankVoorbeelden = '';

  try {
    const { data: kbItems } = await supabase.from('kennisbank_items')
      .select('type, category, title, content, helpfulness_score')
      .order('helpfulness_score', { ascending: false })
      .limit(15);

    if (kbItems?.length) {
      const profiel = kbItems.find((k) => k.type === 'bedrijfsprofiel');
      if (profiel) bedrijfsprofiel = profiel.content || FALLBACK_BEDRIJFSPROFIEL;

      const examples = kbItems
        .filter((k) => k.type !== 'bedrijfsprofiel')
        .map((k) => `- [${k.category || k.type}] ${k.title || (k.content || '').slice(0, 80)}`)
        .join('\n');
      if (examples) kennisbankVoorbeelden = examples;
    }
  } catch {}

  try {
    let corrQuery = supabase.from('learn_examples')
      .select('old_category, new_category, email_subject, corrected_at')
      .order('corrected_at', { ascending: false })
      .limit(10);
    if (senderEmail) corrQuery = corrQuery.eq('email_sender', senderEmail);
    else if (senderDomain) corrQuery = corrQuery.eq('sender_domain', senderDomain);
    const { data: corr } = await corrQuery;
    if (corr?.length) {
      correctionsContext = corr
        .map((c) => `- "${c.email_subject || '?'}" → gecorrigeerd van "${c.old_category}" naar "${c.new_category}"`)
        .join('\n');
    }
  } catch {}

  try {
    const ref = senderEmail || senderDomain;
    const field = senderEmail ? 'sender_email' : 'sender_domain';
    if (ref) {
      const { data: pat } = await supabase.from('email_patterns')
        .select('category, confidence, times_seen, source')
        .eq(field, ref)
        .order('confidence', { ascending: false })
        .limit(3);
      if (pat?.length) {
        patternContext = pat
          .map((p) => `- ${p.category} (confidence: ${p.confidence}%, gezien: ${p.times_seen}x, bron: ${p.source})`)
          .join('\n');
      }
    }
  } catch {}

  return { bedrijfsprofiel, correctionsContext, patternContext, kennisbankVoorbeelden };
}

// ── Patroon opslaan na AI-analyse ─────────────────────────────────────────────
async function savePattern(senderEmail, senderDomain, category, confidence, learnedFromCorrections) {
  if (!senderEmail) return;
  try {
    const { data: existing } = await supabase.from('email_patterns')
      .select('id, times_seen, confidence, category, source')
      .eq('sender_email', senderEmail)
      .maybeSingle();

    if (existing) {
      const newSeen = (existing.times_seen || 0) + 1;
      const newConf = learnedFromCorrections
        ? Math.min(100, (existing.confidence || confidence) + 10)
        : (existing.confidence || confidence);
      const finalConf = newSeen >= 5 && existing.category === category ? 100 : newConf;
      await supabase.from('email_patterns').update({
        times_seen: newSeen,
        confidence: finalConf,
        source: learnedFromCorrections ? 'ai_learned' : (existing.source || 'ai')
      }).eq('id', existing.id);
    } else {
      await supabase.from('email_patterns').insert({
        sender_email:  senderEmail,
        sender_domain: senderDomain || null,
        category,
        confidence:    learnedFromCorrections ? Math.min(100, confidence + 10) : confidence,
        times_seen:    1,
        source:        'ai'
      });
    }
  } catch (e) { console.warn('[email-agent] pattern opslaan fout:', e.message); }
}

// ── `requires_action` afleiden van categorie (als AI het niet geeft) ─────────
function deriveRequiresAction(category, aiValue) {
  if (aiValue !== undefined && aiValue !== null) return !!aiValue;
  if (category === 'Klantvraag' || category === 'Factuurvraag') return true;
  return false;
}

// ── Centrale handler ──────────────────────────────────────────────────────────
export async function categorize({ from, subject, bodySnippet, date }) {
  const senderEmail  = extractEmail(from || '');
  const senderDomain = getDomain(senderEmail);

  // Stap 1 — Re:/Fwd: en directe vraag-check
  // Re: mails en mails met een vraag in de body gaan ALTIJD naar AI — nooit harde regels
  const isReply     = isReplyOrForward(subject);
  const hasQuestion = detectDirectQuestion(bodySnippet);

  if (isReply) {
    console.log(`[email-agent] Re:/Fwd: onderwerp "${subject}" — harde regels overgeslagen, volledige AI analyse`);
  } else if (hasQuestion) {
    console.log(`[email-agent] Directe vraag gedetecteerd in body — harde regels overgeslagen voor "${subject}"`);
  }

  // Stap 2 — Harde regels (ALLEEN als geen Re: en geen directe vraag in body)
  if (!isReply && !hasQuestion) {
    const hard = applyHardRules(subject, from, bodySnippet);
    if (hard) {
      return {
        category:           hard.category,
        requires_action:    hard.requires_action,
        priority:           'laag',
        confidence:         95,
        source:             'rule',
        reasoning:          'Harde inhoudsregel',
        key_signals:        [],
        suggested_reply_tone: 'niet_van_toepassing',
        is_definitely_not_spam: hard.category !== 'Reclame',
        needs_review:       false
      };
    }
  }

  // Stap 3 — Blacklist
  const isBlacklisted = await checkBlacklist(senderEmail, senderDomain);
  if (isBlacklisted) {
    return {
      category: 'Reclame', requires_action: false, priority: 'laag',
      confidence: 95, source: 'blacklist', reasoning: 'Afzender staat op blacklist',
      key_signals: ['blacklist'], suggested_reply_tone: 'niet_van_toepassing',
      is_definitely_not_spam: false, needs_review: false
    };
  }

  // Stap 4 — Whitelist
  const { whitelisted, category: wlCat } = await checkWhitelist(senderEmail, senderDomain);
  if (whitelisted) {
    const cat = wlCat || 'Overig';
    return {
      category: cat, requires_action: deriveRequiresAction(cat, null),
      priority: cat === 'Klantvraag' ? 'normaal' : 'laag',
      confidence: 95, source: 'whitelist',
      reasoning: 'Afzender staat op whitelist',
      key_signals: ['whitelist'], suggested_reply_tone: cat === 'Klantvraag' ? 'vriendelijk' : 'niet_van_toepassing',
      is_definitely_not_spam: true, needs_review: false
    };
  }

  // Stap 5 — Hoge-confidence patroon (overgeslagen voor Re: mails — inhoud is leidend)
  if (!isReply) {
    const pattern = await lookupHighConfidencePattern(senderEmail, senderDomain, subject, bodySnippet);
    if (pattern) {
      const src = ['manual', 'domain_learned', 'hardcoded'].includes(pattern.source) ? 'learned' : 'pattern';
      const cat = pattern.category;
      return {
        category: cat, requires_action: deriveRequiresAction(cat, null),
        priority: cat === 'Klantvraag' || cat === 'Factuurvraag' ? 'normaal' : 'laag',
        confidence: pattern.confidence, source: src,
        reasoning: `Bekend patroon (gezien: ${pattern.times_seen}x)`,
        key_signals: ['patroon gevonden'], suggested_reply_tone: cat === 'Klantvraag' ? 'vriendelijk' : 'niet_van_toepassing',
        is_definitely_not_spam: cat !== 'Reclame', needs_review: false
      };
    }
  }

  // Stap 6 — Volledige AI-analyse
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { category: 'Overig', requires_action: false, priority: 'laag', confidence: 50,
      source: 'fallback', reasoning: 'ANTHROPIC_API_KEY ontbreekt', key_signals: [],
      suggested_reply_tone: 'niet_van_toepassing', is_definitely_not_spam: false, needs_review: true };
  }

  const { bedrijfsprofiel, correctionsContext, patternContext, kennisbankVoorbeelden } =
    await buildAiContext(senderEmail, senderDomain);

  const client = new Anthropic({ apiKey });

  const systemPrompt = `Je bent de intelligente e-mail classificatie agent van De Forex Opleiding, een financiële trading opleiding in Nederland.

JOUW TAAK:
1. Lees de VOLLEDIGE inhoud van de e-mail
2. Begrijp de intentie van de afzender
3. Beslis welke categorie van toepassing is
4. Beslis of er actie vereist is van Jeffrey

BEDRIJFSCONTEXT:
${bedrijfsprofiel}

${kennisbankVoorbeelden ? `VOORBEELDEN UIT KENNISBANK:\n${kennisbankVoorbeelden}\n` : ''}

EERDERE BESLISSINGEN VOOR DEZE AFZENDER (hoogste prioriteit — volg dit):
${correctionsContext}

BEKENDE PATRONEN:
${patternContext}

KRITIEKE REGEL — INHOUD GAAT ALTIJD BOVEN ONDERWERP:
Als de mail begint met "Re:", "RE:", "Antw:" of "Fwd:", of als er een vraag in de body staat,
NEGEER dan het onderwerp voor categorisatie. Een mail met "Gent" in het onderwerp maar
een vraag in de body ("waar was het adres?") is een Klantvraag, geen Event Aanmelding.
INHOUD IS LEIDEND. Het onderwerp is slechts een hint, niet bepalend.

CATEGORIEËN — gebruik deze definities EXACT:

Nieuwe Lead: Automatische notificatie dat iemand interesse heeft getoond. Ingevuld formulier, aanmelding, lead notificatie. NOOIT actie vereist (informatief).

Appointment: Bevestiging van een ingeplande sessie, call of afspraak. NOOIT actie vereist (informatief).

Event Aanmelding: Aanmelding voor een seminar, event of workshop (informatief systeemnotificatie). NOOIT actie vereist. Gebruik NIET als de body een persoonlijke vraag bevat.

Klantvraag: Een BESTAANDE klant stelt een vraag of heeft een probleem. Vraagt om uitleg, heeft een klacht, wil iets weten. ALTIJD actie vereist.

Factuurvraag: Vraag over een factuur, betaling, kosten of betalingsregeling. Betwist factuur, kwijtschelding, betalingsregeling. ALTIJD actie vereist.

Reclame: Ongewenste marketing, nieuwsbrieven, promoties. MINIMAAL 2 reclame-signalen vereist (zie regels). Geen actie vereist.

Overig: Betalingsbevestigingen, systeemnotificaties, automatische bevestigingen, alles wat nergens past. Geen actie vereist tenzij er expliciet een vraag staat.

RECLAME REGELS — mail is ALLEEN Reclame als MINIMAAL 2 van:
1. Promotionele woorden in onderwerp (aanbieding, sale, korting, gratis, exclusief, deal)
2. Bulk-mail afzender (mailchimp, sendgrid, klaviyo, campaign monitor)
3. Body bevat uitschrijven/unsubscribe/afmelden link
4. List-Unsubscribe header aanwezig
5. Bekende reclame afzender in patronen
Bij twijfel: kies Overig.

ACTIE VEREIST REGELS:
- Klantvraag → ALTIJD true
- Factuurvraag → ALTIJD true
- Mail bevat directe vraag aan Jeffrey → true
- Mail bevat klacht of probleem → true + priority HOOG
- Bevestigingen, notificaties, leads → ALTIJD false

Geef terug als JSON:
{
  "category": "Nieuwe Lead|Appointment|Event Aanmelding|Klantvraag|Factuurvraag|Reclame|Overig",
  "requires_action": true|false,
  "priority": "laag|normaal|hoog|urgent",
  "confidence": 0-100,
  "reasoning": "max 200 tekens NL",
  "key_signals": ["max 3 concrete signalen"],
  "suggested_reply_tone": "vriendelijk|formeel|urgent|niet_van_toepassing",
  "is_definitely_not_spam": true|false,
  "auto_propagate_to_similar": true|false
}
Geef ALLEEN de JSON terug.`;

  const contextFlags = [
    isReply     ? '⚠️ DIT IS EEN REPLY/FWD — negeer onderwerp voor categorisatie, analyseer ALLEEN de body.' : '',
    hasQuestion ? '⚠️ DIRECTE VRAAG GEDETECTEERD in body — categoriseer als Klantvraag tenzij de body duidelijk iets anders aangeeft.' : ''
  ].filter(Boolean).join('\n');

  const userContent = [
    contextFlags,
    'Van: ' + (from || '—'),
    'Onderwerp: ' + (subject || '—'),
    date ? 'Datum: ' + date : '',
    bodySnippet ? 'Inhoud (eerste 1500 tekens):\n' + String(bodySnippet).slice(0, 1500) : ''
  ].filter(Boolean).join('\n');

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userContent }]
    });

    const raw = (response.content[0]?.text || '').trim();
    let parsed = null;
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}

    let category         = VALID_CATEGORIES.includes(parsed?.category) ? parsed.category : 'Overig';
    const confidence     = typeof parsed?.confidence === 'number' ? Math.min(100, Math.max(0, Math.round(parsed.confidence))) : 60;
    const reasoning      = String(parsed?.reasoning || '').slice(0, 300);
    const keySignals     = Array.isArray(parsed?.key_signals) ? parsed.key_signals.slice(0, 3) : [];
    const isNotSpam      = parsed?.is_definitely_not_spam === true;
    const learnedFromCorr = parsed?.auto_propagate_to_similar !== false;
    const replyTone      = ['vriendelijk','formeel','urgent','niet_van_toepassing'].includes(parsed?.suggested_reply_tone)
      ? parsed.suggested_reply_tone : 'niet_van_toepassing';
    const priority       = ['laag','normaal','hoog','urgent'].includes(parsed?.priority) ? parsed.priority : 'laag';

    // Reclame-drempel: val terug op Overig bij weinig signalen
    if (category === 'Reclame') {
      const signals = countReclameSignals(subject, bodySnippet);
      if (signals < 1 && confidence < 80) {
        category = 'Overig';
        console.log(`[email-agent] AI zei Reclame maar ${signals} signalen + ${confidence}% conf — teruggevallen op Overig`);
      }
    }

    const requiresAction = deriveRequiresAction(category, parsed?.requires_action);

    // Stap 7 — Patroon opslaan + auto-whitelist
    savePattern(senderEmail, senderDomain, category, confidence, learnedFromCorr)
      .catch(() => {});

    if (isNotSpam && category !== 'Reclame' && senderEmail) {
      supabase.from('email_patterns').upsert({
        sender_email: senderEmail, sender_domain: senderDomain || null,
        category, confidence: 90, times_seen: 1, source: 'whitelist',
        last_corrected_at: new Date().toISOString()
      }, { onConflict: 'sender_email' }).then(({ error }) => {
        if (!error) console.log(`[email-agent] Auto-whitelist: ${senderEmail} (${category})`);
      });
    }

    return {
      category, requires_action: requiresAction, priority, confidence,
      source: learnedFromCorr ? 'ai_learned' : 'ai',
      reasoning, key_signals: keySignals, suggested_reply_tone: replyTone,
      is_definitely_not_spam: isNotSpam,
      needs_review: confidence < 70
    };
  } catch (err) {
    console.error('[email-agent] AI fout:', err.message);
    return {
      category: 'Overig', requires_action: false, priority: 'laag',
      confidence: 40, source: 'error', reasoning: 'AI analyse mislukt: ' + err.message,
      key_signals: [], suggested_reply_tone: 'niet_van_toepassing',
      is_definitely_not_spam: false, needs_review: true
    };
  }
}

// ── HTTP handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { from, subject, bodySnippet, date } = req.body || {};
  if (!from && !subject) {
    return res.status(400).json({ error: 'from of subject vereist' });
  }
  const result = await categorize({ from, subject, bodySnippet, date });
  return res.status(200).json(result);
}
