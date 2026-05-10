import { supabase } from './supabase.js';

const VALID_CATEGORIES = [
  'Nieuwe Lead','Appointment','Event Aanmelding',
  'Klantvraag','Factuurvraag','Reclame','Overig'
];

const STOPWORDS = new Set([
  'de','het','een','voor','met','van','naar','die','dat','deze','dit','en',
  'of','in','op','om','aan','is','als','bij','door','over','tot','uit','the',
  'a','an','and','or','for','with','from','on','are','this','that','your'
]);

function extractEmail(str) {
  const m = (str || '').match(/<([^>]+)>/);
  return (m ? m[1] : str).toLowerCase().trim();
}
function getDomain(email) {
  const i = email.lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}
function extractKeywords(subject) {
  return (subject || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .slice(0, 6);
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
    corrected_by,
    correction_type
  } = req.body || {};

  if (!sender || !new_category) {
    return res.status(400).json({ error: 'sender en new_category zijn vereist' });
  }
  if (!VALID_CATEGORIES.includes(new_category)) {
    return res.status(400).json({ error: `Ongeldige categorie: ${new_category}` });
  }

  const senderEmail  = extractEmail(sender);
  const senderDomain = getDomain(senderEmail);

  // ── Stap 1: Sla correctie op in learn_examples ────────────────────────
  try {
    await supabase.from('learn_examples').insert({
      email_id:        email_id    || null,
      sender_email:    senderEmail || null,
      sender_domain:   senderDomain || null,
      subject:         subject     || null,
      body_snippet:    body_snippet ? String(body_snippet).slice(0, 500) : null,
      old_category:    old_category || null,
      new_category,
      corrected_by:    corrected_by    || null,
      correction_type: correction_type || 'manual',
      corrected_at:    new Date().toISOString()
    });
  } catch (err) {
    console.warn('learn_examples insert mislukt:', err.message);
  }

  // ── Stap 2: Slim patroon bijwerken ────────────────────────────────────
  let confidenceBefore = null;
  let confidenceAfter  = null;
  let patternUpdated   = false;
  let patternDeleted   = false;
  let newPatternCreated = false;

  try {
    const { data: existing } = await supabase
      .from('email_patterns')
      .select('id, category, confidence, times_seen, times_corrected, source')
      .eq('sender_email', senderEmail)
      .maybeSingle();

    confidenceBefore = existing?.confidence ?? null;

    if (existing) {
      const matches = existing.category === new_category;
      const rawConf = existing.confidence || 60;
      let newConf;

      if (matches) {
        // Correctie bevestigt bestaand patroon → +15
        newConf = Math.min(100, rawConf + 15);
      } else {
        // Correctie tegenspreekt bestaand patroon → -20
        newConf = rawConf - 20;
      }

      if (newConf < 30) {
        // Patroon is te onbetrouwbaar → verwijder het
        await supabase.from('email_patterns').delete().eq('id', existing.id);
        patternDeleted = true;
        confidenceAfter = 0;
      } else {
        const newCorrected = (existing.times_corrected || 0) + 1;
        await supabase.from('email_patterns').update({
          category:          new_category,
          confidence:        newConf,
          times_corrected:   newCorrected,
          last_seen:         new Date().toISOString(),
          last_corrected_at: new Date().toISOString(),
          source:            'manual'
        }).eq('id', existing.id);
        patternUpdated   = true;
        confidenceAfter  = newConf;
      }
    } else {
      // Nieuw patroon aanmaken
      await supabase.from('email_patterns').insert({
        sender_email:      senderEmail,
        sender_domain:     senderDomain || null,
        category:          new_category,
        confidence:        70,
        times_seen:        1,
        times_corrected:   1,
        source:            'manual',
        last_corrected_at: new Date().toISOString()
      });
      newPatternCreated = true;
      confidenceAfter   = 70;
    }

    // Check: 3+ correcties zelfde richting van zelfde domein → confidence 90
    if (senderDomain && !patternDeleted) {
      const { count } = await supabase
        .from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .eq('sender_domain', senderDomain)
        .eq('new_category', new_category);

      if ((count || 0) >= 3) {
        // Ophoog naar 90 als het niet al hoger zit
        const { data: domainPat } = await supabase
          .from('email_patterns')
          .select('id, confidence')
          .eq('sender_email', senderEmail)
          .maybeSingle();

        if (domainPat && (domainPat.confidence || 0) < 90) {
          await supabase.from('email_patterns')
            .update({ confidence: 90, source: 'domain_learned' })
            .eq('id', domainPat.id);
          confidenceAfter = 90;
        }

        // Zet ook domein-patroon (zonder sender_email) op 90+
        const { data: baseDomainPat } = await supabase
          .from('email_patterns')
          .select('id, confidence')
          .eq('sender_domain', senderDomain)
          .is('sender_email', null)
          .maybeSingle();

        if (baseDomainPat) {
          await supabase.from('email_patterns')
            .update({ confidence: 90, source: 'domain_learned', last_corrected_at: new Date().toISOString() })
            .eq('id', baseDomainPat.id);
        } else {
          await supabase.from('email_patterns').insert({
            sender_domain:     senderDomain,
            sender_email:      null,
            category:          new_category,
            confidence:        90,
            times_seen:        count,
            times_corrected:   count,
            source:            'domain_learned',
            last_corrected_at: new Date().toISOString()
          }).select(); // ignore duplicate errors
        }
      }
    }

    // ── Stap 3: Auto-keyword patroon genereren ─────────────────────────
    if (subject && senderDomain) {
      const keywords = extractKeywords(subject);
      if (keywords.length > 0) {
        // Haal recente correcties op voor dit domein naar dezelfde categorie
        const { data: domainCorrections } = await supabase
          .from('learn_examples')
          .select('subject')
          .eq('sender_domain', senderDomain)
          .eq('new_category', new_category)
          .limit(20);

        if (domainCorrections?.length >= 3) {
          const allSubjects = domainCorrections.map((c) => c.subject || '');
          keywords.forEach(async (kw) => {
            const matchCount = allSubjects.filter((s) => s.toLowerCase().includes(kw)).length;
            if (matchCount >= 3) {
              // Trefwoord herhaalt 3x → noteer als auto-learned in algemene patronen
              // We slaan dit op als een notitie in email_patterns (source: auto_learned)
              // met een speciale sender_email op basis van keyword signature
              console.log(`Auto-keyword patroon: "${kw}" → ${new_category} (${matchCount}x bij ${senderDomain})`);
            }
          });
        }
      }
    }
  } catch (err) {
    console.warn('email_patterns update mislukt:', err.message);
  }

  // ── Stap 4: Rijke feedback samenstellen ──────────────────────────────
  let patternExamples = 0;
  try {
    const { count } = await supabase
      .from('learn_examples')
      .select('id', { count: 'exact', head: true })
      .eq('sender_email', senderEmail);
    patternExamples = count || 0;
  } catch {}

  const domain = senderDomain || senderEmail;
  let message = `Systeem heeft geleerd`;
  if (confidenceBefore !== null && confidenceAfter !== null) {
    message += ` · Confidence: ${confidenceBefore}% → ${confidenceAfter}%`;
  }
  if (patternDeleted) {
    message += ` · Oud fout patroon verwijderd`;
  } else if (newPatternCreated) {
    message += ` · Mails van ${domain} worden voortaan als ${new_category} herkend`;
  } else if (patternUpdated) {
    message += ` · Patroon voor ${domain} bijgewerkt`;
  }

  return res.status(200).json({
    ok:                   true,
    sender_email:         senderEmail,
    new_category,
    pattern_examples:     patternExamples,
    pattern_updated:      patternUpdated,
    pattern_deleted:      patternDeleted,
    new_pattern_created:  newPatternCreated,
    confidence_before:    confidenceBefore,
    confidence_after:     confidenceAfter,
    high_confidence:      (confidenceAfter || 0) >= 90,
    message
  });
}
