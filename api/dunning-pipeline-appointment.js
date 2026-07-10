// api/dunning-pipeline-appointment.js
// POST — twee modi:
//   1) CREATE: { customer_id, title, due_at, note? } → nieuwe afspraak.
//   2) COMPLETE: { appointment_id, status: 'done'|'missed', note? } →
//      status-flip + completed_at.
// Permission: finance.dunning.execute.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { ensurePipelineCustomer, addLogEntry } from './_lib/dunning-pipeline.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_COMPLETE = ['done', 'missed'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  // COMPLETE-modus.
  if (body.appointment_id) {
    const aid = String(body.appointment_id).trim();
    const st  = String(body.status || '').trim().toLowerCase();
    if (!UUID_RE.test(aid))          return res.status(400).json({ error: 'appointment_id (uuid) ongeldig' });
    if (!VALID_COMPLETE.includes(st)) return res.status(400).json({ error: `status verwacht ${VALID_COMPLETE.join('|')}` });
    try {
      const { data: appt } = await supabaseAdmin
        .from('dunning_pipeline_appointments')
        .select('id, customer_id, title, status')
        .eq('id', aid).maybeSingle();
      if (!appt) return res.status(404).json({ error: 'Afspraak niet gevonden' });
      if (appt.status !== 'open') return res.status(409).json({ error: `Al ${appt.status}`, code: 'INVALID_STATUS' });

      const nowIso = new Date().toISOString();
      const { error: uErr } = await supabaseAdmin
        .from('dunning_pipeline_appointments')
        .update({ status: st, completed_at: nowIso, note: body.note ? String(body.note).slice(0, 4000) : null })
        .eq('id', aid);
      if (uErr) throw new Error(uErr.message);
      await addLogEntry(appt.customer_id, 'appointment',
        `Afspraak ${st === 'done' ? 'afgerond' : 'gemist'}: ${appt.title}`,
        { appointment_id: aid, status: st }, user.id);
      return res.status(200).json({ ok: true, appointment_id: aid, status: st });
    } catch (e) {
      console.error('[dunning-pipeline-appointment complete]', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  // CREATE-modus.
  const cid   = body.customer_id ? String(body.customer_id).trim() : null;
  const title = body.title ? String(body.title).trim().slice(0, 200) : '';
  const due   = body.due_at ? String(body.due_at).trim() : null;
  const note  = body.note ? String(body.note).slice(0, 4000) : null;
  if (!cid || !UUID_RE.test(cid)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!title) return res.status(400).json({ error: 'title vereist' });
  if (!due || Number.isNaN(new Date(due).getTime())) return res.status(400).json({ error: 'due_at (ISO datum) vereist' });

  try {
    await ensurePipelineCustomer(cid);
    const { data: inserted, error: iErr } = await supabaseAdmin
      .from('dunning_pipeline_appointments')
      .insert({ customer_id: cid, title, due_at: new Date(due).toISOString(), note, created_by: user.id })
      .select('id, title, due_at, status')
      .single();
    if (iErr) throw new Error(iErr.message);
    await addLogEntry(cid, 'appointment', `Afspraak ingepland: ${title}`,
      { appointment_id: inserted.id, due_at: inserted.due_at }, user.id);
    return res.status(200).json({ ok: true, appointment: inserted });
  } catch (e) {
    console.error('[dunning-pipeline-appointment create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
