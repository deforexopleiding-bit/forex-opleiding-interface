// api/support-instellingen.js
//
// GET   — de instellingen van de supportmodule.
// PATCH — wijzig kantooruren, widgetteksten of de bot.
//
// Alles wat je hier kunt veranderen zit al in de database (app_settings +
// de joost_config-rij voor module 'support'); dit endpoint is er zodat dat
// niet via de SQL-editor hoeft. Precies daarom is de whitelist streng: het
// is een schrijfpad naar een configuratietabel die ook Joost, Simone en Lisa
// aansturen, en één te ruime veldnaam zou daar dwars doorheen schrijven.
//
// Bot-velden die bewust NIET via dit endpoint te wijzigen zijn:
//   - model           → alleen de vaste set in joost-config-upsert.js
//   - autonomy_config → mandaat per intent; dat is een aparte beslissing
//                       met eigen gevolgen, niet iets voor een tekstveldje
//   - feature_flags   → fasering S2/S3; die zet je bewust, niet en passant

import { supabaseAdmin } from './supabase.js';
import { staffUit, verkeerdeMethode, basisHeaders } from './_lib/support-staff.js';
import { requirePermission } from './_lib/requirePermission.js';
import { naarOfficeHoursConfig, leesbareUren } from './_lib/support-beschikbaarheid.js';
import { parseOfficeHoursConfig, parseHHMM } from './_lib/dunning-office-hours.js';

const WIDGET_VELDEN = ['aan', 'titel', 'welkom', 'agenda_url', 'events_url', 'antwoord_mailbox'];

function schoonUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return /^https:\/\/[a-z0-9.-]+(\/[^\s]*)?$/i.test(s) ? s.slice(0, 300) : null;
}

export default async function handler(req, res) {
  basisHeaders(res);
  if (verkeerdeMethode(req, res, ['GET', 'PATCH'])) return;

  // Lezen mag iedereen die de module mag zien; schrijven alleen met
  // support.config.
  const staff = await staffUit(req, res, req.method === 'GET' ? 'support.module.access' : 'support.config');
  if (!staff) return;

  if (req.method === 'PATCH') {
    const fouten = [];

    // ── Kantooruren ──────────────────────────────────────────────────────
    if (req.body?.kantooruren) {
      const k = req.body.kantooruren;
      const tz = String(k.tz || 'Europe/Amsterdam');
      let tzGeldig = true;
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (_) { tzGeldig = false; }

      const dagen = Array.isArray(k.dagen)
        ? [...new Set(k.dagen.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
        : null;

      if (!tzGeldig) fouten.push('Onbekende tijdzone');
      if (!parseHHMM(k.start)) fouten.push('Starttijd moet als 09:00 geschreven worden');
      if (!parseHHMM(k.eind)) fouten.push('Eindtijd moet als 17:30 geschreven worden');
      if (!dagen || !dagen.length) fouten.push('Kies minstens één dag');

      if (!fouten.length) {
        const waarde = { tz, dagen, start: k.start, eind: k.eind };
        const { error } = await supabaseAdmin.from('app_settings').upsert({
          key: 'support_kantooruren',
          value: waarde,
          updated_at: new Date().toISOString(),
          updated_by_user_id: staff.user.id,
        }, { onConflict: 'key' });
        if (error) fouten.push('Kantooruren opslaan mislukt: ' + error.message);
      }
    }

    // ── Widget ───────────────────────────────────────────────────────────
    if (req.body?.widget && !fouten.length) {
      const { data: huidig } = await supabaseAdmin
        .from('app_settings').select('value').eq('key', 'support_widget').maybeSingle();
      const waarde = { ...(huidig?.value || {}) };

      for (const veld of WIDGET_VELDEN) {
        if (!(veld in req.body.widget)) continue;
        const v = req.body.widget[veld];
        if (veld === 'aan') waarde.aan = v === true;
        else if (veld === 'agenda_url' || veld === 'events_url') {
          const u = schoonUrl(v);
          if (v && !u) { fouten.push(`${veld} moet een https-adres zijn`); continue; }
          waarde[veld] = u;
        } else if (veld === 'antwoord_mailbox') {
          const m = String(v || '').trim().toLowerCase();
          // Alleen eigen mailboxen: een afzender buiten ons domein komt niet
          // door SPF en belandt in de spam van de klant.
          if (m && !/^[a-z0-9._-]+@deforexopleiding\.nl$/.test(m)) {
            fouten.push('Het antwoordadres moet een @deforexopleiding.nl-mailbox zijn');
            continue;
          }
          waarde.antwoord_mailbox = m || 'info@deforexopleiding.nl';
        } else {
          waarde[veld] = String(v || '').slice(0, 400);
        }
      }

      if (!fouten.length) {
        const { error } = await supabaseAdmin.from('app_settings').upsert({
          key: 'support_widget',
          value: waarde,
          updated_at: new Date().toISOString(),
          updated_by_user_id: staff.user.id,
        }, { onConflict: 'key' });
        if (error) fouten.push('Widgetinstellingen opslaan mislukt: ' + error.message);
      }
    }

    // ── Bot ──────────────────────────────────────────────────────────────
    if (req.body?.bot && !fouten.length) {
      const patch = {};
      if (req.body.bot.is_enabled !== undefined) patch.is_enabled = req.body.bot.is_enabled === true;
      if (typeof req.body.bot.persona_name === 'string') patch.persona_name = req.body.bot.persona_name.slice(0, 60);
      if (typeof req.body.bot.system_prompt_template === 'string') {
        patch.system_prompt_template = req.body.bot.system_prompt_template.slice(0, 12000);
      }
      if (req.body.bot.temperature !== undefined) {
        const t = Number(req.body.bot.temperature);
        if (!Number.isFinite(t) || t < 0 || t > 1) fouten.push('Temperatuur moet tussen 0 en 1 liggen');
        else patch.temperature = t;
      }

      if (Object.keys(patch).length && !fouten.length) {
        patch.updated_by_user_id = staff.user.id;
        patch.updated_at = new Date().toISOString();
        const { error } = await supabaseAdmin
          .from('joost_config').update(patch).eq('module', 'support');
        if (error) fouten.push('Botinstellingen opslaan mislukt: ' + error.message);
      }
    }

    if (fouten.length) return res.status(400).json({ error: fouten[0], fouten });
  }

  // ── Teruglezen (ook na een PATCH, zodat de UI de waarheid toont) ───────
  try {
    const [{ data: uren }, { data: widget }, { data: bot }] = await Promise.all([
      supabaseAdmin.from('app_settings').select('value').eq('key', 'support_kantooruren').maybeSingle(),
      supabaseAdmin.from('app_settings').select('value').eq('key', 'support_widget').maybeSingle(),
      supabaseAdmin.from('joost_config')
        .select('persona_name, system_prompt_template, model, temperature, is_enabled, feature_flags, knowledge_base')
        .eq('module', 'support').maybeSingle(),
    ]);

    const cfg = parseOfficeHoursConfig(naarOfficeHoursConfig(uren?.value));

    return res.status(200).json({
      kantooruren: uren?.value || null,
      kantooruren_label: leesbareUren(cfg),
      widget: widget?.value || null,
      bot: bot || null,
      // Echt nagevraagd, niet aangenomen: een lezer zonder support.config
      // krijgt hier false en de UI zet de velden op alleen-lezen.
      mag_wijzigen: req.method === 'PATCH' ? true : await requirePermission(req, 'support.config'),
      // Het snippet hier zodat niemand 'm hoeft over te typen.
      widget_snippet: '<script src="https://crm.deforexopleiding.nl/widget/support.js" async></script>',
    });
  } catch (e) {
    console.error('[support-instellingen] lezen mislukt:', e?.message || e);
    return res.status(500).json({ error: 'Kon de instellingen niet ophalen.' });
  }
}
