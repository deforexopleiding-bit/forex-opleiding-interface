import { supabase } from './supabase.js';

// Werkelijke kolomnamen (geverifieerd via Supabase diagnose):
// learn_examples : id, email_id, email_sender, sender_domain, email_subject,
//                  body_snippet, old_category, new_category, corrected_by,
//                  correction_type, corrected_at
// email_patterns : id, sender_email, sender_domain, category, confidence,
//                  times_seen, source, last_corrected_at, created_at, updated_at

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoIso = weekAgo.toISOString();

  const _errors = [];

  function log(label, result) {
    if (result.error) {
      console.error(`[learning-report] ${label} fout:`, result.error.message);
      _errors.push({ query: label, error: result.error.message });
    } else {
      console.log(`[learning-report] ${label}: ${result.count ?? result.data?.length ?? '?'}`);
    }
    return result;
  }

  try {
    const [
      totalPatternsRes,
      correctionsWeekRes,
      topCorrectedRes,
      lowConfRes,
      newPatternsRes,
      recentLearnedRes,
      totalCorrectionsRes,
    ] = await Promise.all([

      // Totaal patronen
      supabase.from('email_patterns')
        .select('id', { count: 'exact', head: true })
        .then((r) => log('total_patterns', r)),

      // Correcties deze week — corrected_at bestaat in learn_examples
      supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .gte('corrected_at', weekAgoIso)
        .then((r) => log('corrections_this_week', r)),

      // Top 5 afzenders in learn_examples met meeste correcties
      // (times_corrected bestaat NIET in email_patterns — gebruik learn_examples)
      supabase.from('learn_examples')
        .select('email_sender, sender_domain, new_category')
        .order('corrected_at', { ascending: false })
        .limit(200)
        .then((r) => log('top_corrected_raw', r)),

      // Patronen met lage confidence — geen times_corrected, alleen confidence + times_seen
      supabase.from('email_patterns')
        .select('sender_email, sender_domain, category, confidence, times_seen, source')
        .lt('confidence', 50)
        .order('confidence', { ascending: true })
        .limit(10)
        .then((r) => log('low_confidence', r)),

      // Nieuw geleerde patronen deze week — created_at bestaat in email_patterns
      supabase.from('email_patterns')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', weekAgoIso)
        .then((r) => log('new_patterns_week', r)),

      // Recente correcties — email_subject (niet subject), email_sender (niet sender_email)
      // correction_type weggelaten — kolom bestaat mogelijk nog niet
      supabase.from('learn_examples')
        .select('email_sender, sender_domain, old_category, new_category, email_subject, corrected_at')
        .gte('corrected_at', weekAgoIso)
        .order('corrected_at', { ascending: false })
        .limit(20)
        .then((r) => log('recent_corrections', r)),

      // Totaal correcties ooit
      supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .then((r) => log('total_corrections', r)),
    ]);

    // Top gecorrigeerde afzenders berekenen vanuit learn_examples
    // (want times_corrected bestaat niet in email_patterns)
    let topCorrected = [];
    if (!topCorrectedRes.error && topCorrectedRes.data?.length) {
      const counts = {};
      for (const row of topCorrectedRes.data) {
        const key = row.email_sender || row.sender_domain || '?';
        if (!counts[key]) counts[key] = { email_sender: row.email_sender, sender_domain: row.sender_domain, new_category: row.new_category, count: 0 };
        counts[key].count++;
      }
      topCorrected = Object.values(counts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((p) => ({
          sender_email:    p.email_sender,
          sender_domain:   p.sender_domain,
          category:        p.new_category,
          times_corrected: p.count,
          confidence:      null,
        }));
    }

    // Accuracy: niet berekend (times_corrected ontbreekt in email_patterns)
    // Toon percentage correcties t.o.v. patronen als proxy
    const totalPatterns    = totalPatternsRes.error  ? null : (totalPatternsRes.count  ?? 0);
    const totalCorrections = totalCorrectionsRes.error? null : (totalCorrectionsRes.count ?? 0);
    let accuracyRate = null;
    if (totalPatterns > 0 && totalCorrections !== null) {
      // Hoe meer patronen t.o.v. correcties, hoe beter het systeem leert
      // Dit is een grove proxy — 0 correcties op N patronen = 100% nauwkeurig
      const corrPerPattern = totalCorrections / totalPatterns;
      accuracyRate = Math.max(0, Math.round((1 - Math.min(1, corrPerPattern / 3)) * 100));
    }

    // Normaliseer recente correcties voor de frontend
    const recentCorrections = (recentLearnedRes.data ?? []).map((c) => ({
      sender_email:  c.email_sender,
      sender_domain: c.sender_domain,
      old_category:  c.old_category,
      new_category:  c.new_category,
      subject:       c.email_subject,
      corrected_at:  c.corrected_at,
      correction_type: c.correction_type,
    }));

    const response = {
      total_patterns:         totalPatternsRes.error    ? null : (totalPatternsRes.count    ?? 0),
      corrections_this_week:  correctionsWeekRes.error  ? null : (correctionsWeekRes.count  ?? 0),
      total_corrections:      totalCorrectionsRes.error ? null : (totalCorrectionsRes.count  ?? 0),
      new_patterns_this_week: newPatternsRes.error      ? null : (newPatternsRes.count      ?? 0),
      accuracy_rate:          accuracyRate,
      top_corrected:          topCorrected,
      low_confidence:         lowConfRes.data           ?? [],
      recent_corrections:     recentCorrections,
    };

    if (_errors.length) response._errors = _errors;

    console.log('[learning-report] klaar · fouten:', _errors.length, '· patronen:', response.total_patterns, '· correcties:', response.total_corrections);
    return res.status(200).json(response);
  } catch (err) {
    console.error('Learning report crash:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
