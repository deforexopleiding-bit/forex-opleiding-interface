import Anthropic from '@anthropic-ai/sdk';
import { supabase, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const CLASSIFIER_VERSION = 'v1';

// Fase 2: persist classification naar email_classifications (gedeelde DB-cache).
// Fire-and-forget — geen blocking voor /api/email-agent response.
async function persistClassification(email_uid, mailbox, result) {
  if (!email_uid || !mailbox || !result) return;
  try {
    const { error } = await supabaseAdmin.from('email_classifications').upsert({
      email_uid,
      mailbox,
      category:           result.category || null,
      requires_action:    typeof result.requires_action === 'boolean' ? result.requires_action : null,
      confidence:         typeof result.confidence === 'number' ? Math.round(result.confidence) : null,
      source:             result.source || null,
      priority:           result.priority || null,
      reasoning:          result.reasoning || null,
      key_signals:        Array.isArray(result.key_signals) && result.key_signals.length ? result.key_signals : null,
      classified_at:      new Date().toISOString(),
      classifier_version: CLASSIFIER_VERSION,
    }, { onConflict: 'email_uid' });
    if (error) console.warn('[email-agent] persist mislukt:', error.message);
  } catch (err) {
    console.warn('[email-agent] persist exception:', err.message);
  }
}

const VALID_CATEGORIES = [
  'Nieuwe Lead', 'Appointment', 'Event Aanmelding',
  'Klantvragen', 'Partners', 'Betaalbevestigingen', 'Openstaande facturen', 'Aankopen/betalingen',
  'Reclame', 'Overig'
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

// ── Interne domeinen — worden NOOIT als Reclame gecategoriseerd ───────────────
const INTERNAL_DOMAINS = ['deforexopleiding.nl', 'deforexopleiding.com'];

// ── Vertrouwde afzenders — altijd correct gecategoriseerd op onderwerp ─────────
const TRUSTED_LEAD_SENDERS = new Set([
  'no-reply-forms@webflow.com',
  'noreply@send.lcmsgsndr.net',
  'info+deforexopleiding.nl@send.lcmsgsndr.net',
]);

function classifyTrustedSender(subject) {
  const s = (subject || '').toLowerCase();
  if (/uitlegsessie|ingepland|nieuwe call|appointment|sessie\s*ingepland|call\s*ingepland/i.test(s)) return 'Appointment';
  if (/event|aanmelding|gent|seminar|workshop/i.test(s)) return 'Event Aanmelding';
  return 'Nieuwe Lead'; // standaard voor webflow forms en lead mailers
}

// ── Absolute regels — altijd van toepassing, ook bij Re: en body-vragen ──────
const ABSOLUTE_RULES = [
  {
    category: 'Nieuwe Lead',
    requires_action: false,
    test: (s) => /nieuwe\s*lead|new\s*lead|lead\s*(001|002|003|004|005)|funnel|10k.challenge|7.daagse|you\s+have\s+received\s+a\s+form|lead\s+-/i.test(s),
  },
  {
    category: 'Appointment',
    requires_action: false,
    test: (s) => /uitlegsessie\s*(ingepland)?|nieuwe\s*call|appointment\s*booked|sessie\s*ingepland|call\s*ingepland/i.test(s),
  },
  {
    category: 'Event Aanmelding',
    requires_action: false,
    test: (s) => /event\s*aanmelding|aanmelding\s*gent|seminar\s*aanmelding/i.test(s),
  },
];

function applyAbsoluteRules(subject, senderDomain) {
  // Mails van intern domein die overeenkomen met lead/sessie → altijd die categorie
  const isInternal = INTERNAL_DOMAINS.some((d) => (senderDomain || '').includes(d));
  const s = subject || '';
  for (const rule of ABSOLUTE_RULES) {
    if (rule.test(s)) {
      console.log(`[email-agent] Absolute regel: "${s}" → ${rule.category}${isInternal ? ' (intern domein)' : ''}`);
      return { category: rule.category, requires_action: rule.requires_action };
    }
  }
  // Intern domein: nooit Reclame, val terug op Overig als niets matcht
  if (isInternal && /lead|funnel|aanmelding|sessie|call|event|betaling|factuur/i.test(s)) {
    return { category: 'Overig', requires_action: false };
  }
  return null;
}

// ── Harde inhoudsregels ───────────────────────────────────────────────────────
const INCOMING_PAYMENT_DOMAINS = ['mollie.com', 'stripe.com'];   // klant betaalt ons → Betaalbevestigingen
const OUTGOING_PAYMENT_DOMAINS = ['paypal.com', 'paypal.nl'];     // wij betalen (vaak) → Aankopen/betalingen
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
  // Inkomende klant-betalingen → Betaalbevestigingen (deterministisch, eenduidig)
  {
    category: 'Betaalbevestigingen',
    requires_action: false,
    patterns: ['betaling ontvangen', 'factuur voldaan', 'payment confirmed',
      'je factuur werd betaald', 'werd online betaald', 'creditcard-betaling ontvangen',
      'je betaling is ontvangen']
  },
  // Eigen uitgevoerde betalingen/bestellingen → Aankopen/betalingen (deterministisch)
  {
    category: 'Aankopen/betalingen',
    requires_action: false,
    patterns: ['je bestelling is bevestigd', 'your order is confirmed', 'order confirmation']
  }
  // Ambigue patterns ('ontvangstbewijs', 'transactiebewijs', 'your receipt',
  // 'payment receipt') bewust VERWIJDERD — die kunnen eigen aankoop óf
  // klant-bevestiging zijn; de AI beslist nu op basis van de volledige inhoud.
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

  if (INCOMING_PAYMENT_DOMAINS.includes(domain)) {
    return { category: 'Betaalbevestigingen', requires_action: false };
  }
  if (OUTGOING_PAYMENT_DOMAINS.includes(domain)) {
    return { category: 'Aankopen/betalingen', requires_action: false };
  }
  if (domain === 'teamleader.eu') {
    const isPayment = ['betaald', 'payment', 'receipt', 'factuur'].some((t) => b.includes(t) || s.includes(t));
    if (isPayment) return { category: 'Betaalbevestigingen', requires_action: false };
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

  // Nieuwe kb_items tabel (redesign 2026-05-30). Scope op simon + shared.
  // Backwards-compat: bij DB-fout / lege tabel valt 'ie terug op
  // kennisbank_items_archive (oude tabel-naam na rename).
  try {
    let { data: kbItems } = await supabase.from('kb_items')
      .select('is_profile, title, content, helpfulness_score, agents')
      .or('agents.cs.{simon},agents.cs.{shared},is_profile.eq.true')
      .order('helpfulness_score', { ascending: false })
      .limit(15);

    if (!kbItems || kbItems.length === 0) {
      // Fallback: oude tabel (archive) — kan tijdens migratie-window leeg zijn.
      const { data: legacy } = await supabase.from('kennisbank_items_archive')
        .select('type, category, title, content, helpfulness_score')
        .order('helpfulness_score', { ascending: false })
        .limit(15);
      if (legacy?.length) {
        kbItems = legacy.map(k => ({
          is_profile:        k.type === 'bedrijfsprofiel',
          title:             k.title,
          content:           k.content,
          helpfulness_score: k.helpfulness_score,
        }));
      }
    }

    if (kbItems?.length) {
      const profiel = kbItems.find((k) => k.is_profile);
      if (profiel) bedrijfsprofiel = profiel.content || FALLBACK_BEDRIJFSPROFIEL;

      const examples = kbItems
        .filter((k) => !k.is_profile)
        .map((k) => `- ${k.title || (k.content || '').slice(0, 80)}`)
        .join('\n');
      if (examples) kennisbankVoorbeelden = examples;
    }
  } catch (e) {
    console.warn('[email-agent] kb_items fetch fout:', e.message);
  }

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

  // ── Simon's geleerde inzichten ───────────────────────────────────────────────
  let simonLearnings = [];
  try {
    const { data: learnings } = await supabase
      .from('agent_learnings')
      .select('trigger_text, ideal_response')
      .eq('agent_name', 'Simon')
      .order('created_at', { ascending: false })
      .limit(10);
    simonLearnings = learnings || [];
  } catch {}

  return { bedrijfsprofiel, correctionsContext, patternContext, kennisbankVoorbeelden, simonLearnings };
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

// ── `requires_action` afleiden ───────────────────────────────────────────────
// AI-leading: gebruik de AI-beoordeling als die er is; anders fallback op categorie.
function deriveRequiresAction(category, aiValue) {
  if (typeof aiValue === 'boolean') return aiValue;
  // Fallback (trusted-sender/pattern-paden zonder AI): categorie-gebaseerd.
  return ['Klantvragen', 'Partners', 'Openstaande facturen'].includes(category);
}

// ── Centrale handler ──────────────────────────────────────────────────────────
export async function categorize({ from, subject, bodySnippet, date }) {
  const senderEmail  = extractEmail(from || '');
  const senderDomain = getDomain(senderEmail);

  // Stap 0a — Vertrouwde afzenders (hardcoded, snelste pad)
  if (TRUSTED_LEAD_SENDERS.has(senderEmail)) {
    const category = classifyTrustedSender(subject);
    console.log(`[email-agent] Trusted sender ${senderEmail} → ${category}`);
    savePattern(senderEmail, senderDomain, category, 100, false).catch(() => {});
    return {
      category,
      requires_action:      false,
      priority:             'laag',
      confidence:           100,
      source:               'trusted_sender',
      reasoning:            `Vertrouwde afzender — altijd ${category}`,
      key_signals:          ['trusted_sender'],
      suggested_reply_tone: 'niet_van_toepassing',
      is_definitely_not_spam: true,
      needs_review:         false
    };
  }

  // Stap 0b — Handmatige absolute overrides (hoogste prioriteit, altijd)
  if (senderEmail) {
    try {
      const { data: manualPat } = await supabase.from('email_patterns')
        .select('category, requires_action')
        .eq('sender_email', senderEmail)
        .eq('source', 'manual_absolute')
        .maybeSingle();
      if (manualPat) {
        console.log(`[email-agent] manual_absolute override voor ${senderEmail}: ${manualPat.category}`);
        return {
          category:             manualPat.category,
          requires_action:      manualPat.requires_action || false,
          priority:             'laag',
          confidence:           100,
          source:               'manual_override',
          reasoning:            'Handmatige override — nooit overschreven',
          key_signals:          ['manual_override'],
          suggested_reply_tone: 'niet_van_toepassing',
          is_definitely_not_spam: manualPat.category !== 'Reclame',
          needs_review:         false
        };
      }
    } catch (e) { console.warn('[email-agent] manual_absolute check fout:', e.message); }
  }

  // Stap 1a — Absolute regels (lopen altijd, ook bij Re: en body-vragen)
  const absResult = applyAbsoluteRules(subject, senderDomain);
  if (absResult) {
    return {
      category:           absResult.category,
      requires_action:    absResult.requires_action,
      priority:           'laag',
      confidence:         100,
      source:             'absolute_rule',
      reasoning:          'Absolute inhoudsregel — wordt nooit overschreven',
      key_signals:        [],
      suggested_reply_tone: 'niet_van_toepassing',
      is_definitely_not_spam: absResult.category !== 'Reclame',
      needs_review:       false
    };
  }

  // Stap 1b — Re:/Fwd: en directe vraag-check
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
      priority: cat === 'Klantvragen' ? 'normaal' : 'laag',
      confidence: 95, source: 'whitelist',
      reasoning: 'Afzender staat op whitelist',
      key_signals: ['whitelist'], suggested_reply_tone: cat === 'Klantvragen' ? 'vriendelijk' : 'niet_van_toepassing',
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
        priority: cat === 'Klantvragen' ? 'normaal' : 'laag',
        confidence: pattern.confidence, source: src,
        reasoning: `Bekend patroon (gezien: ${pattern.times_seen}x)`,
        key_signals: ['patroon gevonden'], suggested_reply_tone: cat === 'Klantvragen' ? 'vriendelijk' : 'niet_van_toepassing',
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

  const { bedrijfsprofiel, correctionsContext, patternContext, kennisbankVoorbeelden, simonLearnings } =
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
${simonLearnings.length > 0 ? `
SIMON'S GELEERDE INZICHTEN (hoog prioriteit):
${simonLearnings.map((l, i) => `${i + 1}. Context: "${l.trigger_text.slice(0, 100)}" → Inzicht: "${l.ideal_response.slice(0, 150)}"`).join('\n')}
` : ''}
KRITIEKE REGEL — INHOUD GAAT ALTIJD BOVEN ONDERWERP:
Als de mail begint met "Re:", "RE:", "Antw:" of "Fwd:", of als er een vraag in de body staat,
NEGEER dan het onderwerp voor categorisatie. Een mail met "Gent" in het onderwerp maar
een vraag in de body ("waar was het adres?") is een Klantvragen, geen Event Aanmelding.
INHOUD IS LEIDEND. Het onderwerp is slechts een hint, niet bepalend.

CATEGORIEËN — gebruik deze definities EXACT:

Nieuwe Lead: Automatische notificatie dat iemand interesse heeft getoond. Ingevuld formulier, aanmelding, lead notificatie. NOOIT actie vereist (informatief).

Appointment: Bevestiging van een ingeplande sessie, call of afspraak. NOOIT actie vereist (informatief).

Event Aanmelding: Aanmelding voor een seminar, event of workshop (informatief systeemnotificatie). NOOIT actie vereist. Gebruik NIET als de body een persoonlijke vraag bevat.

Klantvragen: Alle vragen en berichten van klanten — vragen over hun bestelling, hun factuur, of klanten die willen annuleren. Vragen over leverstatus, support-issues, wijzigingsverzoeken. Ook factuur-vragen ('waarom sta ik op X?', 'kan ik termijnen?', 'klopt deze factuur?'). ALTIJD actie vereist.

Partners: Zakelijke vragen of correspondentie van externe partijen (geen klant van De Forex Opleiding). Voorbeelden: samenwerkingsverzoeken, affiliate partners, leveranciers met vragen (niet factuur-gerelateerd), vragen van andere bedrijven of trading-scholen, B2B-correspondentie, onderhandelingen, marketing partnerships. NIET: klanten met vragen (Klantvragen), facturen die je moet betalen (Openstaande facturen), of reclame (Reclame). ALTIJD actie vereist.

Betaalbevestigingen: Inkomende betalingsbevestigingen WANNEER EEN KLANT van De Forex Opleiding heeft betaald. Mail van een betaalprovider (Mollie, Stripe, iDeal, PayPal-zakelijk) of bank dat een klant een aankoop heeft gedaan / abonnement betaald / factuur voldaan.
Keywords: 'nieuwe betaling ontvangen', 'payment received', 'betaling van [klantnaam]', 'Mollie - nieuwe betaling', 'Stripe payment', 'iDeal betaling ontvangen'.
Voorbeelden (TRUE):
- 'Nieuwe betaling van €99 — Jan Janssen heeft betaald' -> Betaalbevestigingen
- 'Mollie: payment_id mol_xxx ontvangen' -> Betaalbevestigingen
- 'Stripe charge succeeded — klant XYZ' -> Betaalbevestigingen
NIET: bevestiging van EIGEN uitgevoerde betaling (= Aankopen/betalingen). NIET: klant die over een factuur vraagt (= Klantvragen). Geen actie vereist.

Openstaande facturen: Facturen die IK moet betalen — van LEVERANCIERS, diensten, abonnementen, hosting providers, tools. Mail mét factuur als bijlage of een duidelijk verzoek tot betaling AAN MIJ.
Keywords: 'factuur bijgevoegd', 'verzoek tot betaling', 'vervaldatum', 'te betalen voor [datum]', 'betaalherinnering', 'invoice attached', 'outstanding invoice', 'betalen binnen X dagen'.
Afzenders die hier vaak vallen: Vercel, Supabase, OpenAI, Anthropic, Google Workspace, AWS, hosting-bedrijven, abonnement-diensten, marketing-tools (HighLevel etc.), accountant, telefoonbedrijven, energie, water.
Voorbeelden (TRUE):
- 'Vercel invoice attached — due 30 days' -> Openstaande facturen
- 'Factuur 2026/001 van [leverancier]' -> Openstaande facturen
- 'Betaalherinnering Hostnet' -> Openstaande facturen
NIET: jouw eigen verzonden factuur (verzonden). NIET: een vraag over een factuur (= Klantvragen). ALTIJD actie vereist.

Aankopen/betalingen: Bevestiging van EIGEN UITGEVOERDE BETALINGEN. Mails die bevestigen dat IK (of De Forex Opleiding als bedrijf) iets HEEFT BETAALD of besteld. Banktransactie-bevestigingen van uitgaande betalingen, order-bevestigingen, abonnement-verlengingen die zijn doorgegaan, receipts van diensten waar ik aan betaal.
Keywords: 'ontvangstbewijs', 'receipt', 'uw betaling van €X', 'your payment has been processed', 'order bevestiging', 'abonnement vernieuwd', 'your subscription was renewed', 'transaction confirmation', 'betaling voltooid', 'uw bestelling is verwerkt', 'afschrijving voltooid'.
Afzenders die hier vaak vallen: PayPal-bevestigingen, bank-transactiemails, SaaS-providers (na auto-renewal), e-commerce confirmations, abonnement-services, betaalplatforms (bij uitgaand).
Voorbeelden (TRUE):
- 'Ontvangstbewijs van uw recente transactie' -> Aankopen/betalingen
- 'Receipt for your payment of €19.99' -> Aankopen/betalingen
- 'Your subscription has been renewed' -> Aankopen/betalingen
- 'PayPal: u heeft €50 betaald aan [bedrijf]' -> Aankopen/betalingen
NIET: factuur die nog betaald moet worden (= Openstaande facturen). NIET: inkomende betaling van een klant (= Betaalbevestigingen). Geen actie vereist.

KRITIEK ONDERSCHEID Finance-categorieën — vraag: WIE betaalt aan WIE?
- Klant -> Mij = Betaalbevestigingen
- Leverancier -> Mij (factuur, nog te betalen) = Openstaande facturen
- Ik -> Leverancier (reeds bevestigd/uitgevoerd) = Aankopen/betalingen
Een 'ontvangstbewijs' / 'receipt' / 'transaction confirmation' van een EIGEN betaling is ALTIJD Aankopen/betalingen, NOOIT Overig.

Reclame: Ongewenste marketing, nieuwsbrieven, promoties. MINIMAAL 2 reclame-signalen vereist (zie regels). Geen actie vereist.

Overig: Alles wat niet bij de andere categorieën te plaatsen is — random correspondentie zonder duidelijk doel, miscellaneous communicatie, mails die geen vraag stellen en geen bestelling/betaling/factuur zijn. Geen actie vereist tenzij er expliciet een vraag staat.
KRITIEK NIET in Overig:
- Betaal-/transactiebevestigingen -> zie Finance-categorieën (Betaalbevestigingen / Openstaande facturen / Aankopen/betalingen)
- Automatische bevestigingen van betalingen of facturen -> zie Finance-categorieën
- Reclame/marketing -> Reclame
- Klantvragen -> Klantvragen
Wees terughoudend met Overig: alleen kiezen als de mail ECHT nergens anders bij past. Twijfel? Probeer eerst een specifieke categorie.

RECLAME REGELS — mail is ALLEEN Reclame als MINIMAAL 2 van:
1. Promotionele woorden in onderwerp (aanbieding, sale, korting, gratis, exclusief, deal)
2. Bulk-mail afzender (mailchimp, sendgrid, klaviyo, campaign monitor)
3. Body bevat uitschrijven/unsubscribe/afmelden link
4. List-Unsubscribe header aanwezig
5. Bekende reclame afzender in patronen
Bij twijfel: kies Overig.

ACTIE VEREIST (requires_action) — beoordeel dit ONAFHANKELIJK van de categorie:
Bepaal of deze mail een reactie of handeling van mij vereist.

requires_action = TRUE als:
- De mail stelt een vraag waar antwoord op verwacht wordt
- De mail vraagt om een actie (betaling, ondertekening, beslissing)
- Een klant wacht op service of antwoord
- Een factuur moet betaald worden
- Een partner/leverancier vraagt om reactie
- De mail bevat 'graag reactie', 'kun je laten weten', 'wachten op antwoord' of vergelijkbaar
- Mail bevat klacht of probleem → true + priority HOOG

requires_action = FALSE als:
- Puur informatieve mail (nieuwsbrief, notificatie, update, bevestiging)
- Reclame of marketing
- Automatische bevestiging (betaling ontvangen, order geplaatst)
- Aanmelding zonder vraag (Lead/Appointment/Event — systeem handelt af via flow)
- Mail lijkt al beantwoord (in thread)
- Geen concrete actie gevraagd

LET OP: requires_action is INDEPENDENT van categorie. Voorbeelden:
- 'Klantvragen' = meestal true, maar soms false (klant bevestigt iets, geen vraag)
- 'Overig' = meestal false, maar soms true (iemand vraagt direct iets)
- 'Reclame' = altijd false
- 'Nieuwe Lead' = false (systeem handelt af via flow)

Geef terug als JSON:
{
  "category": "Nieuwe Lead|Appointment|Event Aanmelding|Klantvragen|Partners|Betaalbevestigingen|Openstaande facturen|Aankopen/betalingen|Reclame|Overig",
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
    hasQuestion ? '⚠️ DIRECTE VRAAG GEDETECTEERD in body — categoriseer als Klantvragen tenzij de body duidelijk iets anders aangeeft.' : ''
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

  // Security H2 — RBAC-gate voor de HTTP-route. Interne callers importeren
  // categorize() rechtstreeks als functie (backfill-emails, email-reclassify,
  // reanalyze-all, sync-emails) — die raken deze handler NIET en blijven werken.
  const allowed = await requirePermission(req, 'email.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (email.module.access)' });

  const { from, subject, bodySnippet, date, uid, mailbox } = req.body || {};
  if (!from && !subject) {
    return res.status(400).json({ error: 'from of subject vereist' });
  }
  const result = await categorize({ from, subject, bodySnippet, date });

  // Fase 2: schrijf naar email_classifications zodra uid+mailbox bekend zijn.
  // Geen await — geen response-blocking. Backwards compat: oudere clients die
  // geen uid sturen krijgen alleen de response, geen DB-write.
  if (uid && mailbox) {
    persistClassification(uid, mailbox, result).catch(() => {});
  }

  return res.status(200).json(result);
}
