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
  const i = (email || '').lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}
function extractKeywords(subject) {
  return (subject || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .slice(0, 6);
}

// ── Propagatie: bepaal welke mails vergelijkbaar zijn ────────────────────────
function computePropagation(emailList, senderEmail, senderDomain, subject, emailId) {
  if (!Array.isArray(emailList) || emailList.length === 0) {
    return { groupA: [], groupB: [], groupC: [] };
  }

  const correctedWords = extractKeywords(subject);

  // Groep A — exacte afzender match (auto-update)
  const groupA = emailList.filter(
    (e) => e.sender_email && e.sender_email === senderEmail && e.uid !== emailId
  );

  // Groep B — zelfde domein + >= 2 overlappende onderwerp-woorden (auto-update)
  const groupAUids = new Set(groupA.map((e) => e.uid));
  const groupB = senderDomain
    ? emailList.filter((e) => {
        if (!e.sender_domain || e.sender_domain !== senderDomain) return false;
        if (e.uid === emailId || groupAUids.has(e.uid)) return false;
        const overlap = extractKeywords(e.subject || '').filter((w) => correctedWords.includes(w));
        return overlap.length >= 2;
      })
    : [];

  // Groep C — alleen zelfde domein, ander onderwerp (vraag bevestiging)
  const groupBUids = new Set(groupB.map((e) => e.uid));
  const groupC = senderDomain
    ? emailList.filter((e) => {
        if (!e.sender_domain || e.sender_domain !== senderDomain) return false;
        if (e.uid === emailId || groupAUids.has(e.uid) || groupBUids.has(e.uid)) return false;
        return true;
      })
    : [];

  return { groupA, groupB, groupC };
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
    correction_type,
    old_requires_action,
    new_requires_action,
    email_list             // Nieuw: voor propagatie
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
  const learnRow = { email_sender: senderEmail || null, new_category };
  if (email_id)                      learnRow.email_id             = email_id;
  if (senderDomain)                  learnRow.sender_domain        = senderDomain;
  if (subject)                       learnRow.email_subject        = subject;
  if (body_snippet)                  learnRow.body_snippet         = String(body_snippet).slice(0, 500);
  if (old_category)                  learnRow.old_category         = old_category;
  if (corrected_by)                  learnRow.corrected_by         = corrected_by;
  if (old_requires_action != null)   learnRow.old_requires_action  = old_requires_action;
  if (new_requires_action != null)   learnRow.new_requires_action  = new_requires_action;
  learnRow.correction_type = correction_type || 'manual';
  learnRow.corrected_at    = new Date().toISOString();

  let learnExampleId = null;
  try {
    const { data: inserted, error } = await supabase.from('learn_examples').insert(learnRow).select('id').single();
    if (error) {
      console.warn('[learn] Volledige insert mislukt, probeer minimale insert:', error.message);
      const { data: ins2, error: err2 } = await supabase.from('learn_examples').insert({
        email_sender: senderEmail || null, new_category,
      }).select('id').single();
      if (err2) console.error('[learn] Minimale insert ook mislukt:', err2.message);
      else { learnExampleId = ins2?.id || null; }
    } else {
      learnExampleId = inserted?.id || null;
      console.log('[learn] learn_examples insert OK voor', senderEmail, '· id:', learnExampleId);
    }
  } catch (err) {
    console.error('[learn] learn_examples insert crash:', err.message);
  }

  // ── Stap 2: not_spam specifieke logica ────────────────────────────────
  if (correction_type === 'not_spam' && senderDomain) {
    try {
      const { data: reclamePat } = await supabase.from('email_patterns')
        .select('id, confidence, source')
        .eq('sender_email', senderEmail)
        .eq('category', 'Reclame')
        .maybeSingle();

      if (reclamePat) {
        const newConf = (reclamePat.confidence || 70) - 30;
        if (newConf < 20) {
          await supabase.from('email_patterns').delete().eq('id', reclamePat.id);
          console.log(`[learn] Reclame-patroon verwijderd voor ${senderEmail}`);
        } else {
          await supabase.from('email_patterns')
            .update({ confidence: newConf, last_corrected_at: new Date().toISOString() })
            .eq('id', reclamePat.id);
          console.log(`[learn] Reclame-confidence verlaagd naar ${newConf} voor ${senderEmail}`);
        }
      }

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
          await supabase.from('email_patterns').update({ confidence: newConf }).eq('id', domainReclamePat.id);
        }
      }

      const { count: notSpamCount } = await supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .eq('sender_domain', senderDomain)
        .eq('correction_type', 'not_spam');

      if ((notSpamCount || 0) >= 3) {
        const { error: wlErr } = await supabase.from('email_patterns').upsert({
          sender_domain: senderDomain, sender_email: null,
          category: new_category, confidence: 95, times_seen: notSpamCount,
          source: 'whitelist', last_corrected_at: new Date().toISOString()
        }, { onConflict: 'sender_domain' });
        if (wlErr) console.warn('[learn] Whitelist upsert fout:', wlErr.message);
        else console.log(`[learn] Whitelist aangemaakt voor ${senderDomain} na ${notSpamCount}x not_spam`);
      }
    } catch (err) {
      console.error('[learn] not_spam logica crash:', err.message);
    }
  }

  // ── Stap 3: Patroon bijwerken in email_patterns ───────────────────────
  let confidenceBefore  = null;
  let confidenceAfter   = null;
  let patternUpdated    = false;
  let patternDeleted    = false;
  let newPatternCreated = false;

  try {
    const { data: existing } = await supabase.from('email_patterns')
      .select('id, category, confidence, times_seen, source')
      .eq('sender_email', senderEmail)
      .maybeSingle();

    confidenceBefore = existing?.confidence ?? null;

    if (existing) {
      const matches = existing.category === new_category;
      const rawConf = existing.confidence || 60;
      let newConf   = matches ? Math.min(100, rawConf + 20) : rawConf - 25;

      // Domein-historiek: 3x dezelfde correctie → 95, 5x → 100
      if (senderDomain && !matches) {
        const { count: sameCorrections } = await supabase.from('learn_examples')
          .select('id', { count: 'exact', head: true })
          .eq('sender_domain', senderDomain)
          .eq('new_category', new_category);

        if ((sameCorrections || 0) >= 5) {
          newConf = 100;
          console.log(`[learn] 5x zelfde correctie voor ${senderDomain} → confidence 100 (harde regel)`);
        } else if ((sameCorrections || 0) >= 3) {
          newConf = Math.max(newConf, 95);
          console.log(`[learn] 3x zelfde correctie voor ${senderDomain} → confidence 95`);
        }
      }

      if (newConf < 25) {
        await supabase.from('email_patterns').delete().eq('id', existing.id);
        patternDeleted = true; confidenceAfter = 0;
      } else {
        await supabase.from('email_patterns').update({
          category: new_category, confidence: newConf,
          last_corrected_at: new Date().toISOString(), source: 'manual'
        }).eq('id', existing.id);
        patternUpdated = true; confidenceAfter = newConf;
      }
    } else if (correction_type !== 'not_spam') {
      await supabase.from('email_patterns').insert({
        sender_email: senderEmail, sender_domain: senderDomain || null,
        category: new_category, confidence: 70, times_seen: 1,
        source: 'manual', last_corrected_at: new Date().toISOString()
      });
      newPatternCreated = true; confidenceAfter = 70;
    }

    // 3+ correcties zelfde domein → domein-patroon confidence 90
    if (senderDomain && !patternDeleted && correction_type !== 'not_spam') {
      const { count } = await supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .eq('sender_domain', senderDomain).eq('new_category', new_category);

      if ((count || 0) >= 3) {
        const { data: basePat } = await supabase.from('email_patterns')
          .select('id, confidence')
          .eq('sender_domain', senderDomain).is('sender_email', null).maybeSingle();

        if (basePat) {
          if ((basePat.confidence || 0) < 90) {
            await supabase.from('email_patterns')
              .update({ confidence: 90, source: 'domain_learned', last_corrected_at: new Date().toISOString() })
              .eq('id', basePat.id);
          }
        } else {
          await supabase.from('email_patterns').insert({
            sender_domain: senderDomain, sender_email: null,
            category: new_category, confidence: 90, times_seen: count || 3,
            source: 'domain_learned', last_corrected_at: new Date().toISOString()
          });
        }
        if (!confidenceAfter || confidenceAfter < 90) confidenceAfter = 90;
      }
    }
  } catch (err) {
    console.error('[learn] email_patterns update crash:', err.message);
  }

  // ── Stap 4: Propagatie berekenen ────────────────────────────────────────
  const { groupA, groupB, groupC } = computePropagation(
    email_list, senderEmail, senderDomain, subject || '', email_id
  );

  const propagatedAutomatically = groupA.length + groupB.length;
  const needsConfirmation = groupC.map((e) => ({
    uid:     e.uid,
    from:    e.sender_email || e.sender_domain || '?',
    subject: e.subject || ''
  }));

  if (propagatedAutomatically > 0) {
    console.log(`[learn] Propagatie: ${groupA.length} exacte + ${groupB.length} domein+subject = ${propagatedAutomatically} auto-updates`);
  }
  if (needsConfirmation.length > 0) {
    console.log(`[learn] Bevestiging nodig voor ${needsConfirmation.length} mails van domein ${senderDomain}`);
  }

  // ── Stap 5: Feedback bericht ────────────────────────────────────────────
  let patternExamples = 0;
  try {
    const { count } = await supabase.from('learn_examples')
      .select('id', { count: 'exact', head: true }).eq('email_sender', senderEmail);
    patternExamples = count || 0;
  } catch {}

  const domain = senderDomain || senderEmail;
  let message = 'Systeem heeft geleerd';
  if (correction_type === 'not_spam') {
    message = `Niet-reclame melding opgeslagen voor ${domain}`;
  } else if (confidenceBefore !== null && confidenceAfter !== null) {
    message += ` · Confidence: ${confidenceBefore}% → ${confidenceAfter}%`;
  }
  if (patternDeleted)    message += ' · Oud fout patroon verwijderd';
  else if (newPatternCreated) message += ` · Mails van ${domain} worden voortaan als ${new_category} herkend`;
  else if (patternUpdated)    message += ` · Patroon voor ${domain} bijgewerkt`;
  if (propagatedAutomatically > 0) message += ` · ${propagatedAutomatically} vergelijkbare mails bijgewerkt`;

  return res.status(200).json({
    ok:                    true,
    sender_email:          senderEmail,
    new_category,
    learn_example_id:      learnExampleId,
    pattern_examples:      patternExamples,
    pattern_updated:       patternUpdated,
    pattern_deleted:       patternDeleted,
    new_pattern_created:   newPatternCreated,
    confidence_before:     confidenceBefore,
    confidence_after:      confidenceAfter,
    high_confidence:       (confidenceAfter || 0) >= 90,
    correction_type:       correction_type || 'manual',
    propagated_automatically: propagatedAutomatically,
    propagated_uids:       [...groupA, ...groupB].map((e) => e.uid),
    needs_confirmation:    needsConfirmation,
    message
  });
}
