// api/lab-opvolging-instellingen.js
//
// Leadsonderhoud › Templates › Trial-opvolging. De opvolgmotor van elke
// trial-lead (api/cron-lab-opvolging.js) in één scherm:
//
// GET  → { live, noodstop, stappen: [{ stap, label, wanneer, whatsapp_stap,
//          mail: { standaard: { onderwerp, html }, eigen: <onderhoud_sjablonen-rij>|null },
//          whatsapp: { voorgesteld_template, eigen: <rij>|null, goedgekeurd: bool|null } }],
//          variabelen, wa_lijn_ok }
// POST { live: true|false } → zet app_settings 'lab_opvolging_live'.
//
// De teksten zelf bewaar je met de bestaande /api/leadsonderhoud-sjabloon-opslaan
// (traject_slug 'the-lab', soort = de stap, kanaal mail|whatsapp). Een eigen
// mailtekst wint van de standaardtekst; het WhatsApp-template gaat pas uit als
// Meta het goedkeurde.
//
// Gate: leads.view (zelfde als de rest van Leadsonderhoud).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { instelWaarde } from './_lib/leadsonderhoud-sjabloon.js';
import { STAPPEN, STAP_INFO, WA_STAPPEN, WA_TEMPLATE_NAMEN, standaardMail, SJABLOON_VARIABELEN } from './_lib/lab-opvolging.js';
import { knop } from './_lib/lab-berichten.js';
import { haalLijn } from './_lib/leadsonderhoud-gesprekken.js';
import { goedgekeurdeTemplatesOpLijn } from './_lib/meta-whatsapp.js';
import { LAB_SLUG } from './_lib/lab-config.js';

const SLEUTEL = 'lab_opvolging_live';
const aanUit = (v) => ['1', 'true', 'aan', 'on', 'ja'].includes(String(v ?? '').trim().toLowerCase());

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  const noodstop = aanUit(process.env.LEADSONDERHOUD_UIT);

  if (req.method === 'POST') {
    const live = (req.body || {}).live === true;
    const { error } = await supabaseAdmin.from('app_settings')
      .upsert({ key: SLEUTEL, value: live ? 'true' : 'false', updated_by_user_id: user.id }, { onConflict: 'key' });
    if (error) {
      console.error('[lab-opvolging-instellingen] opslaan:', error.message);
      return res.status(500).json({ error: 'Opslaan mislukt' });
    }
    return res.status(200).json({ ok: true, live, noodstop });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET of POST' });

  const [{ data: inst }, { data: rijen, error: se }] = await Promise.all([
    supabaseAdmin.from('app_settings').select('value').eq('key', SLEUTEL).maybeSingle(),
    supabaseAdmin.from('onderhoud_sjablonen')
      .select('id, traject_slug, soort, kanaal, onderwerp, html, tekst, meta_template, variabele_volgorde, score_min, score_max, actief')
      .eq('traject_slug', LAB_SLUG),
  ]);
  if (se) console.warn('[lab-opvolging-instellingen] sjablonen (soft):', se.message);

  // Welke WhatsApp-templates keurde Meta al goed op de leadlijn? Fail-soft.
  let goedgekeurd = null;
  let waLijnOk = false;
  try {
    const lijn = await haalLijn();
    if (lijn?.phoneNumberId) {
      waLijnOk = true;
      const live = await goedgekeurdeTemplatesOpLijn(lijn.phoneNumberId);
      if (live?.ok) goedgekeurd = new Set((live.templates || []).map((t) => t.name));
    }
  } catch (e) {
    console.warn('[lab-opvolging-instellingen] templates op de lijn (soft):', e?.message || e);
  }

  const eigenVan = (stap, kanaal) => (rijen || []).find((r) => r.soort === stap && r.kanaal === kanaal) || null;
  const voorbeeld = { voornaam: 'Lien', link: 'https://lms.deforexopleiding.nl/the-lab/start/?s=…', knop, product: 'minicursus', eersteVideoMin: 6 };
  const stappen = ['welkom', ...STAPPEN].map((stap) => {
    const waEigen = eigenVan(stap, 'whatsapp');
    const waNaam = waEigen?.meta_template || WA_TEMPLATE_NAMEN[stap] || null;
    return {
      stap,
      label: stap === 'welkom' ? 'Dag 0 · welkom' : STAP_INFO[stap].label,
      wanneer: stap === 'welkom'
        ? 'Meteen bij de aanmelding. De welkomstmail per belofte staat in code (api/_lib/lab-berichten.js → WELKOM_BELOFTE); WhatsApp enkel als de lead niet via de WhatsApp-gate kwam.'
        : STAP_INFO[stap].wanneer,
      whatsapp_stap: stap === 'welkom' || WA_STAPPEN.has(stap),
      mail: stap === 'welkom' ? null : { standaard: standaardMail(stap, voorbeeld), eigen: eigenVan(stap, 'mail') },
      whatsapp: (stap === 'welkom' || WA_STAPPEN.has(stap))
        ? { voorgesteld_template: WA_TEMPLATE_NAMEN[stap] || null, eigen: waEigen, goedgekeurd: goedgekeurd && waNaam ? goedgekeurd.has(waNaam) : null }
        : null,
    };
  });

  return res.status(200).json({
    ok: true, live: aanUit(instelWaarde(inst)), noodstop, wa_lijn_ok: waLijnOk,
    variabelen: SJABLOON_VARIABELEN, stappen,
  });
}
