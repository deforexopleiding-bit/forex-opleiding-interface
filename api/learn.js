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
  const learnRow = {
    email_sender:    senderEmail  || null,
    new_category,
  };
  if (email_id)        learnRow.email_id        = email_id;
  if (senderDomain)    learnRow.sender_domain   = senderDomain;
  if (subject)         learnRow.email_subject   = subject;
  if (body_snippet)    learnRow.body_snippet    = String(body_snippet).slice(0, 500);
  if (old_category)    learnRow.old_category    = old_category;
  if (corrected_by)    learnRow.corrected_by    = corrected_by;
  learnRow.correction_type = correction_type || 'manual';
  learnRow.corrected_at    = new Date().toISOString();

  try {
    const { error } = await supabase.from('learn_examples').insert(learnRow);
    if (error) {
      console.warn('[learn] Volledige insert mislukt, probeer minimale insert:', error.message);
      const { error: err2 } = await supabase.from('learn_examples').insert({
        email_sender: senderEmail || null,
        new_category,
      });
      if (err2) console.error('[learn] Minimale insert ook mislukt:', err2.message);
      else console.log('[learn] Minimale insert gelukt voor', senderEmail);
    } else {
      console.log('[learn] learn_examples insert OK voor', senderEmail);
    }
  } catch (err) {
    console.error('[learn] learn_examples insert crash:', err.message);
  }

  // ── Stap 2: not_spam specifieke logica ────────────────────────────────
  if (correction_type === 'not_spam' && senderDomain) {
    try {
      // Verlaag confidence van reclame-patroon voor deze afzender
      const { data: reclamePat } = await supabase.from('email_patterns')
        .select('id, confidence, source')
        .eq('sender_email', senderEmail)
        .eq('category', 'Reclame')
        .maybeSingle();

      if (reclamePat) {
        const newConf = (reclamePat.confidence || 70) - 30;
        if (newConf < 20) {
          await supabase.from('email_patterns').delete().eq('id', reclamePat.id);
          console.log(`[learn] Reclame-patroon verwijderd voor ${senderEmail} (confidence te laag na not_spam)`);
        } else {
          await supabase.from('email_patterns')
            .update({ confidence: newConf, last_corrected_at: new Date().toISOString() })
            .eq('id', reclamePat.id);
          console.log(`[learn] Reclame-confidence verlaagd naar ${newConf} voor ${senderEmail}`);
        }
      }

      // Verlaag ook domein-level reclame-patroon
      const { data: domainReclamePat } = await supabase.from('email_patterns')
        .select('id, confidence')
        .eq('sender_domain', senderDomain)
        .is('sender_email', null)
        .eq('category', 'Reclame')
        .maybeSingle();

      if (domainReclamePat) {
        const newConf = (domainReclamePat.confidence || 70) - 20;
        if (newConf < 20) {
          await supabase.from('email_patterns').delete().eq('id', domainReclamePat.id);
        } else {
          await supabase.from('email_patterns')
            .update({ confidence: newConf })
            .eq('id', domainReclamePat.id);
        }
      }

      // Tel not_spam correcties voor dit domein
      const { count: notSpamCount } = await supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .eq('sender_domain', senderDomain)
        .eq('correction_type', 'not_spam');

      // Na 3x not_spam voor hetzelfde domein: whitelist entry aanmaken
      if ((notSpamCount || 0) >= 3) {
        const { error: wlErr } = await supabase.from('email_patterns').upsert({
          sender_domain:     senderDomain,
          sender_email:      null,
          category:          new_category,
          confidence:        95,
          times_seen:        notSpamCount,
          source:            'whitelist',
          last_corrected_at: new Date().toISOString()
        }, { onConflict: 'sender_domain' });

        if (wlErr) console.warn('[learn] Whitelist upsert fout:', wlErr.message);
        else console.log(`[learn] Whitelist aangemaakt voor domein ${senderDomain} na ${notSpamCount}x not_spam`);
      }
    } catch (err) {
      console.error('[learn] not_spam logica crash:', err.message);
    }
  }

  // ── Stap 3: Slim patroon bijwerken in email_patterns ──────────────────
  let confidenceBefore = null;
  let confidenceAfter  = null;
  let patternUpdated   = false;
  let patternDeleted   = false;
  let newPatternCreated = false;

  try {
    const { data: existing, error: lookupErr } = await supabase
      .from('email_patterns')
      .select('id, category, confidence, times_seen, source')
      .eq('sender_email', senderEmail)
      .maybeSingle();

    if (lookupErr) console.warn('[learn] email_patterns lookup fout:', lookupErr.message);

    confidenceBefore = existing?.confidence ?? null;

    if (existing) {
      const matches = existing.category === new_category;
      const rawConf = existing.confidence || 60;
      const newConf = matches ? Math.min(100, rawConf + 15) : rawConf - 20;

      if (newConf < 30) {
        await supabase.from('email_patterns').delete().eq('id', existing.id);
        patternDeleted  = true;
        confidenceAfter = 0;
      } else {
        const { error: updErr } = await supabase.from('email_patterns').update({
          category:          new_category,
          confidence:        newConf,
          last_corrected_at: new Date().toISOString(),
          source:            'manual'
        }).eq('id', existing.id);
        if (updErr) console.warn('[learn] email_patterns update fout:', updErr.message);
        patternUpdated  = true;
        confidenceAfter = newConf;
      }
    } else if (correction_type !== 'not_spam') {
      // Nieuw patroon aanmaken (niet bij not_spam — dan willen we juist geen reclame-patroon)
      const { error: insErr } = await supabase.from('email_patterns').insert({
        sender_email:      senderEmail,
        sender_domain:     senderDomain || null,
        category:          new_category,
        confidence:        70,
        times_seen:        1,
        source:            'manual',
        last_corrected_at: new Date().toISOString()
      });
      if (insErr) console.warn('[learn] email_patterns insert fout:', insErr.message);
      else { newPatternCreated = true; confidenceAfter = 70; }
    }

    // Check: 3+ correcties zelfde domein → confidence 90
    if (senderDomain && !patternDeleted && correction_type !== 'not_spam') {
      const { count } = await supabase
        .from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .eq('sender_domain', senderDomain)
        .eq('new_category', new_category);

      if ((count || 0) >= 3) {
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
            times_seen:        count || 3,
            source:            'domain_learned',
            last_corrected_at: new Date().toISOString()
          });
        }
      }
    }

    // Auto-keyword logging
    if (subject && senderDomain) {
      const keywords = extractKeywords(subject);
      if (keywords.length > 0) {
        const { data: domainCorrections } = await supabase
          .from('learn_examples')
          .select('email_subject')
          .eq('sender_domain', senderDomain)
          .eq('new_category', new_category)
          .limit(20);

        if (domainCorrections?.length >= 3) {
          const allSubjects = domainCorrections.map((c) => c.email_subject || '');
          for (const kw of keywords) {
            const matchCount = allSubjects.filter((s) => s.toLowerCase().includes(kw)).length;
            if (matchCount >= 3) {
              console.log(`[learn] Auto-keyword patroon: "${kw}" → ${new_category} (${matchCount}x bij ${senderDomain})`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[learn] email_patterns update crash:', err.message);
  }

  // ── Stap 4: Rijke feedback ────────────────────────────────────────────
  let patternExamples = 0;
  try {
    const { count } = await supabase
      .from('learn_examples')
      .select('id', { count: 'exact', head: true })
      .eq('email_sender', senderEmail);
    patternExamples = count || 0;
  } catch {}

  const domain = senderDomain || senderEmail;
  let message = `Systeem heeft geleerd`;
  if (correction_type === 'not_spam') {
    message = `Niet-reclame melding opgeslagen voor ${domain}`;
  } else if (confidenceBefore !== null && confidenceAfter !== null) {
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
    correction_type:      correction_type || 'manual',
    message
  });
}
