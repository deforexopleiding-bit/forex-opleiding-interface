import { supabase } from './supabase.js';

export default async function handler(req, res) {
  const out = {
    timestamp: new Date().toISOString(),
    supabase_url: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 40) + '…' : 'MISSING',
    supabase_key: process.env.SUPABASE_ANON_KEY ? 'configured' : 'MISSING',
  };

  // ── learn_examples: count + sample + column check ────────────────────────
  try {
    const { data, error, count } = await supabase
      .from('learn_examples')
      .select('*', { count: 'exact' })
      .order('corrected_at', { ascending: false })
      .limit(5);
    out.learn_examples = {
      ok: !error,
      error: error?.message || null,
      total_rows: count,
      columns: data?.length ? Object.keys(data[0]) : [],
      recent: data || [],
    };
  } catch (e) {
    out.learn_examples = { ok: false, error: e.message };
  }

  // ── email_patterns: count + sample ──────────────────────────────────────
  try {
    const { data, error, count } = await supabase
      .from('email_patterns')
      .select('*', { count: 'exact' })
      .order('confidence', { ascending: false })
      .limit(5);
    out.email_patterns = {
      ok: !error,
      error: error?.message || null,
      total_rows: count,
      columns: data?.length ? Object.keys(data[0]) : [],
      recent: data || [],
    };
  } catch (e) {
    out.email_patterns = { ok: false, error: e.message };
  }

  // ── Controleer specifieke kolommen die learn.js gebruikt ─────────────────
  const learnCols = 'id,email_id,sender_email,sender_domain,subject,body_snippet,old_category,new_category,corrected_by,correction_type,corrected_at';
  try {
    const { error } = await supabase.from('learn_examples').select(learnCols).limit(1);
    out.learn_examples_cols = { ok: !error, error: error?.message || null, tested: learnCols.split(',') };
  } catch (e) {
    out.learn_examples_cols = { ok: false, error: e.message };
  }

  const patternCols = 'id,sender_email,sender_domain,category,confidence,times_seen,times_corrected,source,last_corrected_at,last_seen';
  try {
    const { error } = await supabase.from('email_patterns').select(patternCols).limit(1);
    out.email_patterns_cols = { ok: !error, error: error?.message || null, tested: patternCols.split(',') };
  } catch (e) {
    out.email_patterns_cols = { ok: false, error: e.message };
  }

  // ── Probeer een test-insert in learn_examples ─────────────────────────────
  if (req.query.test_insert === '1') {
    try {
      const { error } = await supabase.from('learn_examples').insert({
        email_id: 'debug-test',
        sender_email: 'debug@test.com',
        sender_domain: 'test.com',
        subject: 'Debug test',
        body_snippet: 'Test',
        old_category: 'Overig',
        new_category: 'Overig',
        corrected_by: 'debug',
        correction_type: 'debug',
        corrected_at: new Date().toISOString(),
      });
      out.test_insert = { ok: !error, error: error?.message || null };
      // Verwijder de test-rij meteen
      if (!error) {
        await supabase.from('learn_examples').delete().eq('email_id', 'debug-test');
      }
    } catch (e) {
      out.test_insert = { ok: false, error: e.message };
    }
  }

  return res.status(200).json(out);
}
