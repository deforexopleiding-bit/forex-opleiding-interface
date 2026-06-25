// api/agents-config-list.js
//
// GET → één compacte view op alle agent-configs voor het Agent command
// center. Combineert in 1 call:
//   - joost_config-rijen (per module: persona_name, persona_tone, model,
//     is_enabled). Module is de discriminator (finance=Joost, events=Simone,
//     onboarding=Mila).
//   - whatsapp_module_config (per module: phone_number_id + is_active) als
//     kanaal-status indicator.
//   - Lisa (lisa_config): ALLEEN read-only persona_name + is_active uit de
//     actieve versie (is_active=true, hoogste version), gemarkeerd type='lisa'.
//
// Geen secrets, geen prompts, geen knowledge_base — die zit in
// joost-config-get?module=… (die de hub per agent inline ophaalt).
//
// Permission: admin.joost_config. Strict gate omdat de hub bedoeld is voor
// de agent-beheerders; finance.joost.view (read-only inbox-panel) is hier
// niet voldoende.
//
// Response 200:
//   { ok:true, agents: [
//       { type:'joost_config', module:'finance',    persona_name:'Joost',  persona_tone, model, is_enabled, channel:{phone_number_id, is_active}|null },
//       { type:'joost_config', module:'events',     persona_name:'Simone', … },
//       { type:'joost_config', module:'onboarding', persona_name:'Mila',   … },
//       { type:'lisa',         persona_name:'Lisa', is_active:true, version }
//   ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  try {
    // 1) joost_config — alle modules in één query.
    const { data: jc, error: jcErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, persona_name, persona_tone, model, is_enabled, updated_at')
      .order('module', { ascending: true });
    if (jcErr) throw new Error('joost_config: ' + jcErr.message);

    // 2) whatsapp_module_config — alle actieve modules.
    const { data: wmc, error: wmcErr } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('module, phone_number_id, is_active');
    if (wmcErr) {
      // Niet fataal: hub renders agents zonder kanaal-status bij faal.
      console.warn('[agents-config-list] whatsapp_module_config:', wmcErr.message);
    }
    const channelByModule = new Map();
    for (const r of (wmc || [])) {
      channelByModule.set(r.module, {
        phone_number_id: r.phone_number_id || null,
        is_active:       r.is_active === true,
      });
    }

    // 3) Lisa — actieve versie. Alleen read-only persona_name + status.
    let lisaRow = null;
    try {
      const { data: lc } = await supabaseAdmin
        .from('lisa_config')
        .select('persona_name, is_active, version, created_at')
        .eq('is_active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      lisaRow = lc || null;
    } catch (e) {
      console.warn('[agents-config-list] lisa_config:', e?.message || e);
    }

    // 3b) Lisa runtime — live_mode_enabled vlag uit singleton lisa_settings.
    // Wordt als kanaal-status getoond ('Instagram · actief/inactief'), zodat
    // Lisa-kaart consistent is met de trio (WhatsApp-channel pill). Read-only
    // boolean, geen extra PII. Bij faal: channel=null → kaart blijft werken.
    let lisaLiveMode = null;
    try {
      const { data: ls } = await supabaseAdmin
        .from('lisa_settings')
        .select('live_mode_enabled')
        .eq('id', 1)
        .maybeSingle();
      if (ls && typeof ls.live_mode_enabled === 'boolean') {
        lisaLiveMode = ls.live_mode_enabled;
      }
    } catch (e) {
      console.warn('[agents-config-list] lisa_settings:', e?.message || e);
    }

    // 4) Bouw agent-shapes.
    const agents = (jc || []).map((r) => ({
      type:         'joost_config',
      module:       r.module,
      persona_name: r.persona_name || null,
      persona_tone: r.persona_tone || null,
      model:        r.model || null,
      is_enabled:   r.is_enabled === true,
      updated_at:   r.updated_at || null,
      channel:      channelByModule.get(r.module) || null,
    }));

    agents.push({
      type:         'lisa',
      module:       null,
      persona_name: lisaRow?.persona_name || 'Lisa',
      is_active:    lisaRow?.is_active === true,
      version:      lisaRow?.version ?? null,
      created_at:   lisaRow?.created_at || null,
      // Kanaal-status (consistent met trio): label + active boolean. null bij
      // ontbreken/fout zodat de UI 'm kan tonen als neutraal '—'.
      channel:      (lisaLiveMode === null)
                      ? null
                      : { label: 'Instagram', active: lisaLiveMode === true },
    });

    return res.status(200).json({ ok: true, agents });
  } catch (e) {
    console.error('[agents-config-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
