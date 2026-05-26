// api/_lib/email-learn.js
// Klanten/Email leerlogica — geëxtraheerd uit api/learn.js
// (Fase email-classifier-fix, commit 1).
//
// Pure verplaatsing van bestaande logica uit api/learn.js. Geen
// gedragsveranderingen. Endpoint-contract (request/response) blijft
// identiek; api/learn.js wordt een thin wrapper.
//
// Toekomstige callers (uit Optie B-plan):
//   - api/learn.js                              (huidige endpoint, thin wrapper)
//   - api/email-reclassify.js                   (gelijkschakeling reclassify ↔ Train Agent)
//   - api/email-reclassify-backfill-learnings.js (retroactieve correcties)
//
// Geen externe API-calls. Geen audit-log. Pure DB-operaties op
// learn_examples + email_patterns via injected supabase-client
// (user-aware OF admin; caller bepaalt).

// ── Constants (1-op-1 uit learn.js) ─────────────────────────────────────────

export const VALID_CATEGORIES = [
  'Nieuwe Lead','Appointment','Event Aanmelding',
  'Klantvraag','Factuurvraag','Reclame','Overig'
];

const STOPWORDS = new Set([
  'de','het','een','voor','met','van','naar','die','dat','deze','dit','en',
  'of','in','op','om','aan','is','als','bij','door','over','tot','uit','the',
  'a','an','and','or','for','with','from','on','are','this','that','your'
]);

const PAYMENT_KWS  = ['betaald','ontvangen','transactie','receipt','payment','factuur','voldaan','invoice','paid','transaction','betaling'];
const SYSTEM_SNDS  = ['noreply','no-reply','notifications','notification','mailer','donotreply'];

// ── Pure helpers (1-op-1 uit learn.js, alleen `export` toegevoegd) ─────────

export function extractEmail(str) {
  const m = (str || '').match(/<([^>]+)>/);
  return (m ? m[1] : str).toLowerCase().trim();
}

export function getDomain(email) {
  const i = (email || '').lastIndexOf('@');
  return i >= 0 ? email.slice(i + 1).toLowerCase() : '';
}

export function extractKeywords(subject) {
  return (subject || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .slice(0, 6);
}

export function extractBodyKeywords(text, maxWords = 10) {
  return (text || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .slice(0, maxWords);
}

// ── Propagatie ────────────────────────────────────────────────────────────────
export function computePropagation(emailList, senderEmail, senderDomain, subject, bodySnippet, emailId, reason) {
  if (!Array.isArray(emailList) || emailList.length === 0) {
    return { groupA: [], groupB: [], groupC_auto: [], groupC_confirm: [], groupD: [] };
  }

  const correctedWords   = extractKeywords(subject);
  const correctedBodyKws = extractBodyKeywords(bodySnippet, 10);

  // Groep A — exacte afzender (auto)
  const groupA = emailList.filter(
    (e) => e.sender_email && e.sender_email === senderEmail && e.uid !== emailId
  );
  const groupAUids = new Set(groupA.map((e) => e.uid));

  // Groep B — zelfde domein + >= 2 onderwerp-woorden (auto)
  const groupB = senderDomain
    ? emailList.filter((e) => {
        if (!e.sender_domain || e.sender_domain !== senderDomain) return false;
        if (e.uid === emailId || groupAUids.has(e.uid)) return false;
        return extractKeywords(e.subject || '').filter((w) => correctedWords.includes(w)).length >= 2;
      })
    : [];
  const groupBUids = new Set(groupB.map((e) => e.uid));

  // Groep C — zelfde domein + body-keyword overlap (auto >= 4, bevestiging >= 2)
  const groupC_auto = (senderDomain && correctedBodyKws.length >= 2)
    ? emailList.filter((e) => {
        if (!e.sender_domain || e.sender_domain !== senderDomain) return false;
        if (e.uid === emailId || groupAUids.has(e.uid) || groupBUids.has(e.uid)) return false;
        return extractBodyKeywords(e.body_snippet || '', 10).filter((w) => correctedBodyKws.includes(w)).length >= 4;
      })
    : [];
  const groupC_auto_Uids = new Set(groupC_auto.map((e) => e.uid));

  const groupC_confirm = (senderDomain && correctedBodyKws.length >= 2)
    ? emailList.filter((e) => {
        if (!e.sender_domain || e.sender_domain !== senderDomain) return false;
        if (e.uid === emailId || groupAUids.has(e.uid) || groupBUids.has(e.uid) || groupC_auto_Uids.has(e.uid)) return false;
        const overlap = extractBodyKeywords(e.body_snippet || '', 10).filter((w) => correctedBodyKws.includes(w)).length;
        return overlap >= 2;
      })
    : [];

  // Groep D — reden-gebaseerd (alle mails, ongeacht domein)
  const usedUids = new Set([
    emailId,
    ...groupAUids, ...groupBUids, ...groupC_auto_Uids,
    ...groupC_confirm.map((e) => e.uid)
  ]);
  const groupD = [];
  if (reason?.includes('Betaalbevestiging')) {
    for (const e of emailList) {
      if (usedUids.has(e.uid)) continue;
      const body = (e.body_snippet || '').toLowerCase();
      if (PAYMENT_KWS.filter((w) => body.includes(w)).length >= 2) {
        groupD.push(e); usedUids.add(e.uid);
      }
    }
  }
  if (reason?.includes('Systeemmail')) {
    for (const e of emailList) {
      if (usedUids.has(e.uid)) continue;
      const sender = (e.sender_email || '').toLowerCase();
      if (SYSTEM_SNDS.some((k) => sender.includes(k))) {
        groupD.push(e); usedUids.add(e.uid);
      }
    }
  }

  return { groupA, groupB, groupC_auto, groupC_confirm, groupD };
}

// ── Main entry: applyLearning() ────────────────────────────────────────────

/**
 * Voer de complete leerlogica uit voor één e-mail-correctie.
 *
 * Geëxtraheerd uit api/learn.js handler-body. 1-op-1 verplaatsing van de
 * 5-staps DB-flow:
 *   1) INSERT learn_examples (correctie-geschiedenis)
 *   2) not_spam-specifieke logica (Reclame-confidence verlagen + whitelist na 3x)
 *   3) UPDATE/INSERT email_patterns met confidence-boost (match +20, mismatch -25,
 *      delete bij <25, nieuwe sender = 70, 3+ correcties domein = 90 domain_learned)
 *   3b) manual_absolute permanente override (confidence 100, times_seen 999)
 *   4) Propagatie berekenen (groepen A/B/C_auto/C_confirm/D)
 *   5) Feedback bericht opbouwen
 *
 * Errors:
 *   - Bij ongeldige input (missing sender/new_category, invalid category):
 *     throw new Error met `.statusCode = 400`. Caller (wrapper) vertaalt
 *     naar HTTP 400.
 *   - DB-fouten worden intern gevangen (console.warn/error) en breken het
 *     proces niet; flow gaat door waar mogelijk (bestaand gedrag).
 *
 * @param {object} opts
 * @param {object} opts.supabase                  — geïnjecteerde Supabase-client
 * @param {string} [opts.email_id]
 * @param {string} opts.sender                    — raw "Name <email>" of "email"
 * @param {string} [opts.subject]
 * @param {string} [opts.body_snippet]
 * @param {string} [opts.old_category]
 * @param {string} opts.new_category              — verplicht, moet in VALID_CATEGORIES
 * @param {string} [opts.corrected_by]
 * @param {string} [opts.correction_type='manual']
 * @param {boolean|null} [opts.old_requires_action]
 * @param {boolean|null} [opts.new_requires_action]
 * @param {string} [opts.reason]
 * @param {Array}  [opts.email_list]
 * @returns {Promise<object>} response-payload identiek aan bestaande learn-endpoint
 */
export async function applyLearning(opts) {
  const {
    supabase,
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
    reason,
    email_list,
  } = opts || {};

  if (!sender || !new_category) {
    const e = new Error('sender en new_category zijn vereist');
    e.statusCode = 400;
    throw e;
  }
  if (!VALID_CATEGORIES.includes(new_category)) {
    const e = new Error(`Ongeldige categorie: ${new_category}`);
    e.statusCode = 400;
    throw e;
  }

  const senderEmail  = extractEmail(sender);
  const senderDomain = getDomain(senderEmail);
  const bodyKws      = extractBodyKeywords(body_snippet, 10);

  // ── Stap 1: Sla correctie op in learn_examples ────────────────────────
  const learnRow = { email_sender: senderEmail || null, new_category };
  if (email_id)                      learnRow.email_id                 = email_id;
  if (senderDomain)                  learnRow.sender_domain            = senderDomain;
  if (subject)                       learnRow.email_subject            = subject;
  if (body_snippet)                  learnRow.body_snippet             = String(body_snippet).slice(0, 500);
  if (old_category)                  learnRow.old_category             = old_category;
  if (corrected_by)                  learnRow.corrected_by             = corrected_by;
  if (old_requires_action != null)   learnRow.old_requires_action      = old_requires_action;
  if (new_requires_action != null)   learnRow.new_requires_action      = new_requires_action;
  if (reason)                        learnRow.reason                   = String(reason).slice(0, 200);
  if (bodyKws.length)                learnRow.body_keywords            = bodyKws;
  if (new_requires_action != null)   learnRow.requires_action_corrected = new_requires_action;
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

  const patternExtras = {
    ...(reason && { reason: String(reason).slice(0, 200) }),
    ...(bodyKws.length && { body_keywords: bodyKws }),
    ...(new_requires_action != null && { requires_action: new_requires_action }),
  };

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

      if (senderDomain && !matches) {
        const { count: sameCorrections } = await supabase.from('learn_examples')
          .select('id', { count: 'exact', head: true })
          .eq('sender_domain', senderDomain)
          .eq('new_category', new_category);

        if ((sameCorrections || 0) >= 5) {
          newConf = 100;
        } else if ((sameCorrections || 0) >= 3) {
          newConf = Math.max(newConf, 95);
        }
      }

      if (newConf < 25) {
        await supabase.from('email_patterns').delete().eq('id', existing.id);
        patternDeleted = true; confidenceAfter = 0;
      } else {
        await supabase.from('email_patterns').update({
          category: new_category, confidence: newConf,
          last_corrected_at: new Date().toISOString(), source: 'manual',
          ...patternExtras
        }).eq('id', existing.id);
        patternUpdated = true; confidenceAfter = newConf;
      }
    } else if (correction_type !== 'not_spam') {
      await supabase.from('email_patterns').insert({
        sender_email: senderEmail, sender_domain: senderDomain || null,
        category: new_category, confidence: 70, times_seen: 1,
        source: 'manual', last_corrected_at: new Date().toISOString(),
        ...patternExtras
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

  // ── Stap 3b: manual_absolute — permanente override met hoogste prioriteit ─
  if (correction_type === 'manual_absolute' && senderEmail) {
    try {
      const { data: pat } = await supabase.from('email_patterns')
        .select('id').eq('sender_email', senderEmail).maybeSingle();
      const now = new Date().toISOString();
      if (pat) {
        await supabase.from('email_patterns').update({
          category: new_category, confidence: 100, times_seen: 999,
          source: 'manual_absolute', last_corrected_at: now,
          ...patternExtras
        }).eq('id', pat.id);
      } else {
        await supabase.from('email_patterns').insert({
          sender_email: senderEmail, sender_domain: senderDomain || null,
          category: new_category, confidence: 100, times_seen: 999,
          source: 'manual_absolute', last_corrected_at: now,
          ...patternExtras
        });
      }
      confidenceAfter = 100;
      console.log(`[learn] manual_absolute patroon opgeslagen voor ${senderEmail} → ${new_category}`);
    } catch (e) {
      console.warn('[learn] manual_absolute upsert fout:', e.message);
    }
  }

  // ── Stap 4: Propagatie berekenen ────────────────────────────────────────
  const { groupA, groupB, groupC_auto, groupC_confirm, groupD } = computePropagation(
    email_list, senderEmail, senderDomain, subject || '', body_snippet || '', email_id, reason || ''
  );

  const propagatedAutomatically = groupA.length + groupB.length + groupC_auto.length + groupD.length;
  const propagatedUids          = [...groupA, ...groupB, ...groupC_auto, ...groupD].map((e) => e.uid);
  const needsConfirmation       = groupC_confirm.map((e) => ({
    uid:     e.uid,
    from:    e.sender_email || e.sender_domain || '?',
    subject: e.subject || ''
  }));

  if (propagatedAutomatically > 0) {
    console.log(`[learn] Propagatie: A=${groupA.length} B=${groupB.length} C_auto=${groupC_auto.length} D=${groupD.length} = ${propagatedAutomatically} auto`);
  }
  if (needsConfirmation.length > 0) {
    console.log(`[learn] Bevestiging nodig voor ${needsConfirmation.length} mails`);
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
  if (patternDeleted)          message += ' · Oud fout patroon verwijderd';
  else if (newPatternCreated)  message += ` · Mails van ${domain} worden voortaan als ${new_category} herkend`;
  else if (patternUpdated)     message += ` · Patroon voor ${domain} bijgewerkt`;
  if (propagatedAutomatically > 0) message += ` · ${propagatedAutomatically} vergelijkbare mails bijgewerkt`;

  return {
    ok:                       true,
    sender_email:             senderEmail,
    new_category,
    learn_example_id:         learnExampleId,
    pattern_examples:         patternExamples,
    pattern_updated:          patternUpdated,
    pattern_deleted:          patternDeleted,
    new_pattern_created:      newPatternCreated,
    confidence_before:        confidenceBefore,
    confidence_after:         confidenceAfter,
    high_confidence:          (confidenceAfter || 0) >= 90,
    correction_type:          correction_type || 'manual',
    propagated_automatically: propagatedAutomatically,
    propagated_uids:          propagatedUids,
    needs_confirmation:       needsConfirmation,
    message
  };
}
