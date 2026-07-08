import { supabase, verifyAdmin } from './supabase.js';

async function probeCol(table, col) {
  try {
    const { error } = await supabase.from(table).select(col).limit(1);
    return !error;
  } catch { return false; }
}

export default async function handler(req, res) {
  // K1 — super_admin-only gate. Endpoint lekt schema-details + kan
  // test-insert doen, dus geen andere rollen toestaan.
  const admin = await verifyAdmin(req);
  if (!admin || admin.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const out = {
    timestamp: new Date().toISOString(),
    supabase_url: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.slice(0, 40) + '…' : 'MISSING',
    supabase_key: process.env.SUPABASE_ANON_KEY ? 'configured' : 'MISSING',
  };

  // ── learn_examples: probe kolommen één voor één ───────────────────────────
  const learnCols = [
    'id', 'email_sender', 'sender_email',   // naam-varianten voor de afzender
    'sender_domain', 'email_domain',
    'new_category', 'old_category',
    'subject', 'email_subject',
    'body_snippet', 'email_body', 'snippet',
    'corrected_at', 'created_at',
    'corrected_by',
    'correction_type', 'type',
    'email_id', 'mail_id',
  ];
  const learnProbes = {};
  for (const col of learnCols) {
    learnProbes[col] = await probeCol('learn_examples', col);
  }
  out.learn_examples_probe = learnProbes;

  // Count + sample rijen
  try {
    const { data, error, count } = await supabase
      .from('learn_examples')
      .select('*', { count: 'exact' })
      .limit(3);
    out.learn_examples = { ok: !error, error: error?.message || null, total_rows: count, sample: data || [] };
  } catch (e) {
    out.learn_examples = { ok: false, error: e.message };
  }

  // ── email_patterns: probe kolommen één voor één ───────────────────────────
  const patternCols = [
    'id', 'sender_email', 'email_sender',   // naam-varianten
    'sender_domain', 'email_domain',
    'category',
    'confidence', 'score',
    'times_seen', 'seen_count', 'count',
    'times_corrected', 'correction_count', 'corrected_count',
    'source', 'origin',
    'last_seen', 'updated_at',
    'last_corrected_at', 'corrected_at',
  ];
  const patternProbes = {};
  for (const col of patternCols) {
    patternProbes[col] = await probeCol('email_patterns', col);
  }
  out.email_patterns_probe = patternProbes;

  // Count + sample rijen
  try {
    const { data, error, count } = await supabase
      .from('email_patterns')
      .select('*', { count: 'exact' })
      .limit(3);
    out.email_patterns = { ok: !error, error: error?.message || null, total_rows: count, sample: data || [] };
  } catch (e) {
    out.email_patterns = { ok: false, error: e.message };
  }

  // ── Test-insert (optioneel, via ?test_insert=1) ───────────────────────────
  if (req.query.test_insert === '1') {
    try {
      const { error } = await supabase.from('learn_examples').insert({
        email_sender: 'debug@test.com',
        new_category: 'Overig',
      });
      out.test_insert_minimal = { ok: !error, error: error?.message || null };
      // Verwijder meteen
      if (!error) await supabase.from('learn_examples').delete().eq('email_sender', 'debug@test.com');
    } catch (e) {
      out.test_insert_minimal = { ok: false, error: e.message };
    }
  }

  // ── Samenvatting ─────────────────────────────────────────────────────────
  const learnExists  = Object.values(learnProbes).some(Boolean);
  const patternExists= Object.values(patternProbes).some(Boolean);

  out.summary = {
    learn_examples_exists:  learnExists,
    email_patterns_exists:  patternExists,
    learn_sender_col:       learnProbes['email_sender'] ? 'email_sender' : (learnProbes['sender_email'] ? 'sender_email' : 'UNKNOWN'),
    pattern_sender_col:     patternProbes['sender_email'] ? 'sender_email' : (patternProbes['email_sender'] ? 'email_sender' : 'UNKNOWN'),
    learn_date_col:         learnProbes['corrected_at'] ? 'corrected_at' : (learnProbes['created_at'] ? 'created_at' : 'UNKNOWN'),
    learn_missing_cols:     learnCols.filter((c) => !learnProbes[c] && !['sender_email','email_domain','email_subject','email_body','snippet','mail_id','type'].includes(c)),
    pattern_missing_cols:   patternCols.filter((c) => !patternProbes[c] && !['email_sender','email_domain','score','seen_count','count','correction_count','corrected_count','origin','updated_at'].includes(c)),
  };

  console.log('[debug-supabase] summary:', JSON.stringify(out.summary));
  return res.status(200).json(out);
}
