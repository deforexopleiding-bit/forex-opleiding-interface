import { supabase } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoIso = weekAgo.toISOString();

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
      supabase.from('email_patterns').select('id', { count: 'exact', head: true }),

      // Correcties deze week
      supabase.from('learn_examples')
        .select('id', { count: 'exact', head: true })
        .gte('corrected_at', weekAgoIso),

      // Top 5 meest gecorrigeerde afzenders
      supabase.from('email_patterns')
        .select('sender_email, sender_domain, category, confidence, times_corrected, times_seen')
        .gt('times_corrected', 0)
        .order('times_corrected', { ascending: false })
        .limit(5),

      // Patronen met lage confidence (< 50) — vragen aandacht
      supabase.from('email_patterns')
        .select('sender_email, sender_domain, category, confidence, times_seen, times_corrected, source')
        .lt('confidence', 50)
        .order('confidence', { ascending: true })
        .limit(10),

      // Nieuw geleerde patronen deze week
      supabase.from('email_patterns')
        .select('id', { count: 'exact', head: true })
        .gte('last_seen', weekAgoIso),

      // Recent geleerde patronen (details)
      supabase.from('learn_examples')
        .select('sender_email, sender_domain, old_category, new_category, subject, corrected_at, correction_type')
        .gte('corrected_at', weekAgoIso)
        .order('corrected_at', { ascending: false })
        .limit(20),

      // Totaal correcties ooit
      supabase.from('learn_examples').select('id', { count: 'exact', head: true }),

      // Mails gecategoriseerd door AI (times_seen) vs gecorrigeerd (times_corrected)
      supabase.from('email_patterns')
        .select('times_seen, times_corrected')
        .limit(1000),
    ]);

    // Accuracy berekenen: hoeveel % werd correct gecategoriseerd zonder correctie
    let accuracyRate = null;
    if (aiCategorizationsRes.data?.length) {
      const totalSeen      = aiCategorizationsRes.data.reduce((s, p) => s + (p.times_seen || 0), 0);
      const totalCorrected = aiCategorizationsRes.data.reduce((s, p) => s + (p.times_corrected || 0), 0);
      if (totalSeen > 0) {
        accuracyRate = Math.round(((totalSeen - totalCorrected) / totalSeen) * 100);
      }
    }

    return res.status(200).json({
      total_patterns:       totalPatternsRes.count   ?? 0,
      corrections_this_week: correctionsWeekRes.count ?? 0,
      total_corrections:    totalCorrectionsRes.count ?? 0,
      new_patterns_this_week: newPatternsRes.count   ?? 0,
      accuracy_rate:        accuracyRate,
      top_corrected:        topCorrectedRes.data     ?? [],
      low_confidence:       lowConfRes.data          ?? [],
      recent_corrections:   recentLearnedRes.data    ?? [],
    });
  } catch (err) {
    console.error('Learning report error:', err);
    return res.status(500).json({ error: err.message || 'Onbekende fout' });
  }
}
