import { supabase } from './supabase.js';

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
      _errors.push({ query: label, error: result.error.message, code: result.error.code });
    } else {
      console.log(`[learning-report] ${label}: count=${result.count ?? (result.data?.length ?? '?')}`);
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
      aiCategorizationsRes,
    ] = await Promise.all([

      // Totaal patronen
      supabase.from('email_patterns')
        .select('id', { count: 'exact', head: true })
        .then((r) => log('total_patterns', r)),

      // Correcties deze week — kolom heet 'corrected_at' (na ALTER TABLE)
      supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .gte('corrected_at', weekAgoIso)
        .then((r) => log('corrections_this_week', r)),

      // Top 5 meest gecorrigeerde afzenders (email_patterns)
      supabase.from('email_patterns')
        .select('sender_email, sender_domain, category, confidence, times_corrected, times_seen')
        .gt('times_corrected', 0)
        .order('times_corrected', { ascending: false })
        .limit(5)
        .then((r) => log('top_corrected', r)),

      // Patronen met lage confidence (email_patterns)
      supabase.from('email_patterns')
        .select('sender_email, sender_domain, category, confidence, times_seen, times_corrected, source')
        .lt('confidence', 50)
        .order('confidence', { ascending: true })
        .limit(10)
        .then((r) => log('low_confidence', r)),

      // Nieuw geleerde patronen deze week (email_patterns)
      supabase.from('email_patterns')
        .select('id', { count: 'exact', head: true })
        .gte('last_seen', weekAgoIso)
        .then((r) => log('new_patterns_week', r)),

      // Recente correcties — kolom heet 'email_sender' (niet 'sender_email')
      supabase.from('learn_examples')
        .select('email_sender, sender_domain, old_category, new_category, subject, corrected_at, correction_type')
        .gte('corrected_at', weekAgoIso)
        .order('corrected_at', { ascending: false })
        .limit(20)
        .then((r) => log('recent_corrections', r)),

      // Totaal correcties ooit
      supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .then((r) => log('total_corrections', r)),

      // Accuracy berekening via email_patterns
      supabase.from('email_patterns')
        .select('times_seen, times_corrected')
        .limit(1000)
        .then((r) => log('ai_categorizations', r)),
    ]);

    // Accuracy berekenen
    let accuracyRate = null;
    if (!aiCategorizationsRes.error && aiCategorizationsRes.data?.length) {
      const totalSeen      = aiCategorizationsRes.data.reduce((s, p) => s + (p.times_seen || 0), 0);
      const totalCorrected = aiCategorizationsRes.data.reduce((s, p) => s + (p.times_corrected || 0), 0);
      if (totalSeen > 0) {
        accuracyRate = Math.round(((totalSeen - totalCorrected) / totalSeen) * 100);
      }
    }

    // Recente correcties: normaliseer email_sender → sender_email voor frontend
    const recentCorrections = (recentLearnedRes.data ?? []).map((c) => ({
      ...c,
      sender_email: c.email_sender ?? c.sender_email ?? null,
    }));

    const response = {
      total_patterns:         totalPatternsRes.error    ? null : (totalPatternsRes.count    ?? 0),
      corrections_this_week:  correctionsWeekRes.error  ? null : (correctionsWeekRes.count  ?? 0),
      total_corrections:      totalCorrectionsRes.error ? null : (totalCorrectionsRes.count  ?? 0),
      new_patterns_this_week: newPatternsRes.error      ? null : (newPatternsRes.count      ?? 0),
      accuracy_rate:          accuracyRate,
      top_corrected:          topCorrectedRes.data      ?? [],
      low_confidence:         lowConfRes.data           ?? [],
      recent_corrections:     recentCorrections,
    };

    if (_errors.length) {
      response._errors = _errors;
    }

    console.log('[learning-report] klaar · fouten:', _errors.length, '· patronen:', response.total_patterns, '· correcties:', response.total_corrections);
    return res.status(200).json(response);
  } catch (err) {
    console.error('Learning report crash:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
