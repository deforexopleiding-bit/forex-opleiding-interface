// api/leadsonderhoud-quiz-opslaan.js
// POST -> sla de WERK-versie van een vragenlijst op (bewerkt de website_quizzes-
// en website_quiz_questions-tabellen). Raakt de LIVE vragenlijst NIET — dat
// gebeurt pas bij Publiceren. Gate: leads.view.
//
// Body: { slug, naam, drempel, is_active,
//         vragen:[{ id?, label, options:[{label,punten,afwijzer}], active }] }
//   Volgorde van de vragen = de array-volgorde (order_index wordt afgeleid).
//   Vragen met een bestaande id worden bijgewerkt; zonder id nieuw aangemaakt;
//   vragen die niet meer in de payload staan worden verwijderd.
//
// Response: 200 { ok:true }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

// Normaliseer één optie naar exact de vorm {label, punten, afwijzer}.
function schoonOptie(o) {
  const label = String(o?.label ?? '').trim();
  const punten = Number.isFinite(Number(o?.punten)) ? Math.trunc(Number(o.punten)) : 0;
  const afwijzer = o?.afwijzer === true;
  return { label, punten, afwijzer };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.body || {};
  const slug = String(body.slug || '');
  const naam = String(body.naam ?? '').trim();
  const drempel = Number(body.drempel);
  const isActive = body.is_active !== false; // default aan
  const vragenIn = Array.isArray(body.vragen) ? body.vragen : null;

  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'slug ontbreekt of ongeldig' });
  if (!naam) return res.status(400).json({ error: 'Naam is leeg' });
  if (!Number.isFinite(drempel)) return res.status(400).json({ error: 'Drempel ontbreekt of is geen getal' });
  if (!vragenIn) return res.status(400).json({ error: 'vragen ontbreekt' });

  // Valideer + normaliseer de vragen.
  const genormaliseerd = [];
  for (let i = 0; i < vragenIn.length; i++) {
    const v = vragenIn[i] || {};
    const label = String(v.label ?? '').trim();
    if (!label) return res.status(400).json({ error: `Vraag ${i + 1}: label is leeg` });
    const opties = Array.isArray(v.options) ? v.options.map(schoonOptie) : [];
    if (!opties.length) return res.status(400).json({ error: `Vraag ${i + 1}: minstens één optie vereist` });
    if (opties.some((o) => !o.label)) return res.status(400).json({ error: `Vraag ${i + 1}: een optie heeft geen tekst` });
    genormaliseerd.push({
      id: v.id ? String(v.id) : null,
      order_index: i,
      label,
      options: opties,
      active: v.active !== false,
    });
  }

  try {
    const { data: quiz, error: qErr } = await supabaseAdmin
      .from('website_quizzes').select('id').eq('slug', slug).maybeSingle();
    if (qErr) throw qErr;
    if (!quiz) return res.status(404).json({ error: 'Vragenlijst niet gevonden' });

    // 1) Quiz-niveau bijwerken.
    const { error: updErr } = await supabaseAdmin
      .from('website_quizzes')
      .update({ naam, drempel: Math.trunc(drempel), is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', quiz.id);
    if (updErr) throw updErr;

    // 2) Huidige vraag-ids ophalen; verwijderde vragen weggooien.
    const { data: huidige } = await supabaseAdmin
      .from('website_quiz_questions').select('id').eq('quiz_id', quiz.id);
    const huidigeIds = new Set((huidige || []).map((r) => r.id));
    const behoudenIds = new Set(genormaliseerd.filter((v) => v.id).map((v) => v.id));
    const teVerwijderen = [...huidigeIds].filter((id) => !behoudenIds.has(id));
    if (teVerwijderen.length) {
      const { error: delErr } = await supabaseAdmin
        .from('website_quiz_questions').delete().in('id', teVerwijderen);
      if (delErr) throw delErr;
    }

    // 3) Vragen bijwerken (bestaande id) of aanmaken (geen/onbekende id).
    for (const v of genormaliseerd) {
      const rij = {
        quiz_id: quiz.id, order_index: v.order_index, label: v.label,
        options: v.options, active: v.active, updated_at: new Date().toISOString(),
      };
      if (v.id && huidigeIds.has(v.id)) {
        const { error } = await supabaseAdmin.from('website_quiz_questions').update(rij).eq('id', v.id);
        if (error) throw error;
      } else {
        const { error } = await supabaseAdmin.from('website_quiz_questions').insert(rij);
        if (error) throw error;
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('leadsonderhoud-quiz-opslaan mislukt:', e.message);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
