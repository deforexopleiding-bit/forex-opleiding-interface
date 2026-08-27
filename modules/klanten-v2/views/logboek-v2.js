// modules/klanten-v2/views/logboek-v2.js
//
// Fase F — Logboek (activiteit-/auditlog). DATA-KOPPELING 2026-08-13.
// Dormant — QA via ?v2preview=logboek. Rol super_admin/admin/manager
// (perm audit.log.view op de endpoints).
//
// Endpoints:
//   GET /api/activity-log-list?user_id=&role=&module=&success=&q=&from=&to=&page=&page_size=
//   GET /api/activity-users-list  (users-dropdown pre-fetch)

(function () {
  if (!window.DFO) { console.error('[logboek-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[logboek-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const PAGE_SIZE = 50;
  const _live = {
    activity: { loading: false, error: null, data: null, params: '', page: 1 },
    users:    { loading: false, error: null, data: null },
  };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[logboek-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  function _presetRange(p) {
    const now = new Date();
    const to = now.toISOString();
    const d = new Date(now);
    if (p === 'd') d.setHours(0, 0, 0, 0);
    else if (p === 'w') d.setDate(d.getDate() - 7);
    else if (p === 'm') d.setMonth(d.getMonth() - 1);
    else return { from: '', to: '' };
    return { from: d.toISOString(), to };
  }

  function _buildParams(page) {
    const p = F('t', 'w');
    const uid = F('user', '');
    const role = F('role', '');
    const mod = F('module', '');
    const succ = F('success', '');
    const q = F('q', '');
    const rng = _presetRange(p);
    const parts = ['page=' + (page || 1), 'page_size=' + PAGE_SIZE];
    if (uid) parts.push('user_id=' + encodeURIComponent(uid));
    if (role) parts.push('role=' + encodeURIComponent(role));
    if (mod) parts.push('module=' + encodeURIComponent(mod));
    if (succ) parts.push('success=' + encodeURIComponent(succ));
    if (q) parts.push('q=' + encodeURIComponent(q));
    if (rng.from) parts.push('from=' + encodeURIComponent(rng.from));
    if (rng.to) parts.push('to=' + encodeURIComponent(rng.to));
    return parts.join('&');
  }

  async function fetchActivity() {
    const st = _live.activity;
    const params = _buildParams(st.page);
    if (st.loading && st.params === params) return;
    st.loading = true; st.error = null; st.params = params; st.data = null;
    const j = await tryFetch('activity', '/api/activity-log-list?' + params);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { rows: asArr(j?.rows), total: Number(j?.total || 0), page: Number(j?.page || 1), page_size: Number(j?.page_size || PAGE_SIZE) };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchUsers() {
    const st = _live.users;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('users', '/api/activity-users-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.users);
    if (window.DFO?.render) window.DFO.render();
  }

  window.__logRetry = (b) => {
    if (b === 'activity') { _live.activity.data = null; _live.activity.error = null; fetchActivity(); }
    if (b === 'users')    { _live.users.data = null; _live.users.error = null; fetchUsers(); }
    if (window.DFO?.render) window.DFO.render();
  };
  window.__logFilter = (k, v) => { _live.activity.page = 1; _live.activity.data = null; window.DFO.setF(k, v); };
  window.__logPage = (n) => { _live.activity.page = Math.max(1, Number(n) || 1); _live.activity.data = null; if (window.DFO?.render) window.DFO.render(); };

  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon gegevens niet ophalen: ${esc(msg)}</span>
    <button class="btn btn-ghost btn-sm" onclick="__logRetry('${block}')">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:8px;background:var(--surface-2);border-radius:4px;width:80%"></div></div></div></div>`;
  const rollePill = (r) => H.pill(r === 'super_admin' ? 'violet' : r === 'admin' || r === 'manager' ? 'accent' : r === 'sales' ? 'emerald' : 'teal', r || '—', 1);

  // ── Action-key vertaler (2026-08-13) ──────────────────────────────────
  // Vertaalt technische action-keys uit activity_log naar leesbare NL-zin.
  //
  // Bronnen: de logger schrijft twee soorten action-strings:
  //   1) permission-keys van requirePermission — meestal patroon
  //      <module>.<subject>.<verb>: 'finance.tasks.view', 'auth.login',
  //      'dashboard.module.access', 'finance.dunning.view'.
  //   2) expliciete logActivity-calls met snake_case of dot-notation:
  //      'create_user', 'update_user_email', 'mentor_profile_create',
  //      'moved_in', 'joost.autonomy_decision', 'finance_dunning.run_step_manual_move',
  //      'pending_action.approved', 'event_attendee.deleted'.
  //
  // Aanpak: 1) exact-match override eerst, 2) fallback pattern-match op
  // laatste segment (verb) + module-prefix, 3) laatst een generieke
  // "Onbekende actie" met de rauwe key. Ruwe key blijft in title-tooltip
  // + kleine grijze sub-tekst.

  const VERB_NL = {
    view: 'bekeken', access: 'geopend', list: 'bekeken', get: 'bekeken', detail: 'bekeken',
    create: 'aangemaakt', created: 'aangemaakt', add: 'toegevoegd', new: 'aangemaakt',
    update: 'gewijzigd', updated: 'gewijzigd', edit: 'gewijzigd', patch: 'gewijzigd', save: 'opgeslagen',
    delete: 'verwijderd', deleted: 'verwijderd', remove: 'verwijderd', archive: 'gearchiveerd',
    restore: 'hersteld', reactivate: 'gereactiveerd', deactivate: 'gedeactiveerd',
    login: 'ingelogd', logout: 'uitgelogd', signup: 'geregistreerd',
    export: 'geëxporteerd', import: 'geïmporteerd', download: 'gedownload', upload: 'geüpload',
    send: 'verstuurd', sent: 'verstuurd', resend: 'opnieuw verstuurd',
    approve: 'goedgekeurd', approved: 'goedgekeurd',
    reject: 'afgewezen', rejected: 'afgewezen',
    cancel: 'geannuleerd', cancelled: 'geannuleerd',
    run: 'uitgevoerd', executed: 'uitgevoerd', trigger: 'gestart', start: 'gestart',
    retry: 'opnieuw geprobeerd', refresh: 'ververst', sync: 'gesynchroniseerd',
    publish: 'gepubliceerd', unpublish: 'depubliceerd', close: 'gesloten', open: 'geopend',
    pause: 'gepauzeerd', resume: 'hervat', toggle: 'omgeschakeld',
    move: 'verplaatst', moved: 'verplaatst', assign: 'toegewezen', unassign: 'losgekoppeld',
    mark: 'gemarkeerd', marked: 'gemarkeerd', register: 'geregistreerd', bypass: 'omzeild',
    subscribe: 'geabonneerd', unsubscribe: 'uitgeschreven',
    query: 'bevraagd',
  };
  // Subject-vertalingen. Underscore-tussenwoord komt hier ook in voor.
  const SUBJECT_NL = {
    module: 'module', dashboard: 'dashboard', tasks: 'taken', task: 'taak',
    invoice: 'factuur', invoices: 'facturen', dunning: 'aanmaningen',
    customer: 'klant', customers: 'klanten',
    arrangement: 'betalingsregeling', arrangements: 'betalingsregelingen',
    pending_action: 'actiepunt', pending_actions: 'actiepunten',
    template: 'template', templates: 'templates',
    workflow: 'workflow', workflows: 'workflows',
    payout: 'uitbetaling', payouts: 'uitbetalingen',
    settings: 'instellingen', config: 'configuratie',
    user: 'gebruiker', users: 'gebruikers',
    role: 'rol', roles: 'rollen', permission: 'recht',
    event: 'event', events: 'events', event_attendee: 'deelnemer', attendee: 'deelnemer', attendees: 'deelnemers',
    mentor: 'mentor', mentors: 'mentoren', mentor_profile: 'mentor-profiel',
    onboarding: 'onboarding', invite: 'uitnodiging',
    email: 'e-mail', emails: 'e-mails',
    inbox: 'inbox', conversation: 'gesprek',
    ticket: 'ticket', tickets: 'tickets',
    lead: 'lead', leads: 'leads',
    quote: 'offerte', quotation: 'offerte', deal: 'deal',
    signups_auto_close_hours: 'auto-sluit-venster',
    reservation_fee: 'reserverings-vergoeding',
    autonomy_decision: 'autonomie-beslissing',
    outbound_scheduler: 'planning uitgaand',
    outbound_send: 'uitgaand bericht',
    message_sent_autonomously: 'autonoom bericht verstuurd',
    outcome_marked: 'uitkomst gemarkeerd',
    config_updated: 'configuratie gewijzigd',
    breach_check: 'breach-check',
    breach_check_state_change: 'breach-status gewijzigd',
    dispute_resolved: 'dispuut opgelost',
    customer_closed_manually: 'klant handmatig gesloten',
    customer_marked_bewind: 'klant onder bewind gemeld',
    customer_marked_disputed: 'klant als dispuut gemarkeerd',
    run_step_manual_move: 'stap handmatig verplaatst',
    skip_step: 'stap overgeslagen',
    register_payment: 'betaling geregistreerd',
    impersonate: 'impersonatie',
    app_settings: 'app-instelling',
    webhook_subscribe: 'webhook-abonnement',
  };
  // Module-prefix in leesbare naam (om "Finance — aanmaningen bekeken" te bouwen).
  const MOD_NL = {
    finance: 'Finance', finance_dunning: 'Wanbetalers', finance_invoice: 'Facturen',
    sales: 'Sales', klanten: 'Klanten', klant: 'Klanten',
    events: 'Events', event: 'Events', event_attendee: 'Event-deelnemers',
    onboarding: 'Onboarding', mentor: 'Mentoren', mentor_profile: 'Mentoren',
    dashboard: 'Dashboard', auth: '',  // auth.login → gewoon "Ingelogd"
    admin: 'Admin', users: 'Admin', user: 'Admin', role: 'Admin',
    app_settings: 'Instellingen', app: 'Instellingen',
    joost: 'Joost (Wanbetalers)', simone: 'Simone (Events)', mila: 'Mila (Onboarding)', lisa: 'Lisa',
    ai_manager: 'AI Manager',
    tickets: 'Tickets', ticket: 'Tickets',
    followup: 'Follow-up', 'follow-up': 'Follow-up',
    taken: 'Taken', task: 'Taken',
    email: 'E-mail', inbox: 'Inbox',
    pending_action: 'Actiepunten', pending_actions: 'Actiepunten',
    cron: 'Achtergrondtaak',
    whatsapp: 'WhatsApp', wa: 'WhatsApp',
  };
  // Exact-match overrides voor keys die niet netjes patroon-match zijn.
  const ACTION_OVERRIDE = {
    'auth.login': 'Ingelogd',
    'auth.logout': 'Uitgelogd',
    'dashboard.module.access': 'Dashboard geopend',
    'create_user': 'Gebruiker aangemaakt',
    'update_user': 'Gebruiker gewijzigd',
    'update_user_email': 'E-mailadres van gebruiker gewijzigd',
    'update_user_password': 'Wachtwoord van gebruiker gewijzigd',
    'deactivate_user': 'Gebruiker gedeactiveerd',
    'resend_invite': 'Uitnodiging opnieuw verstuurd',
    'mentor_profile_create': 'Mentor-profiel aangemaakt',
    'mentor_profile_reactivate': 'Mentor-profiel gereactiveerd',
    'archive': 'Gearchiveerd',
    'created': 'Aangemaakt',
    'deleted': 'Verwijderd',
    'moved_in': 'Verplaatst naar (in)',
    'moved_out': 'Verplaatst uit',
    'status_changed': 'Status gewijzigd',
    'tag_added': 'Tag toegevoegd',
    'tag_removed': 'Tag verwijderd',
    'retry': 'Opnieuw geprobeerd',
    'sales.reservation_fee.bypass': 'Sales — reserverings-vergoeding omzeild',
    'admin.impersonate.start': 'Admin — impersonatie gestart',
    'ai_manager.query': 'AI Manager bevraagd',
    'whatsapp.webhook_subscribe': 'WhatsApp — webhook-abonnement',
    'cron.arrangements_breach_check_run': 'Achtergrondtaak — breach-check uitgevoerd',
    'app_settings.update': 'App-instelling gewijzigd',
    'events.signups_auto_close_hours.update': 'Events — auto-sluit-venster gewijzigd',
    'finance.arrangement.proposed': 'Betalingsregeling voorgesteld',
    'finance.arrangement.cancelled': 'Betalingsregeling geannuleerd',
    'finance.arrangement.breach_check_state_change': 'Betalingsregeling — breach-status gewijzigd',
    'finance_invoice.register_payment': 'Betaling geregistreerd',
    'invoice.create': 'Factuur aangemaakt',
    'finance_dunning.customer_closed_manually': 'Wanbetalers — klant handmatig gesloten',
    'finance_dunning.customer_marked_bewind': 'Wanbetalers — klant onder bewind gemeld',
    'finance_dunning.customer_marked_disputed': 'Wanbetalers — klant als dispuut gemarkeerd',
    'finance_dunning.dispute_resolved': 'Wanbetalers — dispuut opgelost',
    'finance_dunning.run_step_manual_move': 'Wanbetalers — stap handmatig verplaatst',
    'finance_dunning_run.skip_step': 'Wanbetalers — stap overgeslagen',
    'finance_dunning_template.delete': 'Wanbetalers-template verwijderd',
    'finance_dunning_workflow.delete': 'Wanbetalers-workflow verwijderd',
    'finance_dunning_workflow.toggle': 'Wanbetalers-workflow aan/uit',
    'pending_action.approved': 'Actiepunt goedgekeurd',
    'pending_action.rejected': 'Actiepunt afgewezen',
    'pending_action.restored': 'Actiepunt hersteld',
    'pending_action.manually_not_executed': 'Actiepunt handmatig als niet-uitgevoerd gemarkeerd',
    'joost.autonomy_decision': 'Joost — autonomie-beslissing gelogd',
    'joost.config_updated': 'Joost — configuratie gewijzigd',
    'joost.message_sent_autonomously': 'Joost — bericht autonoom verstuurd',
    'joost.outbound_scheduler_refused': 'Joost — geplande zending geweigerd',
    'joost.outbound_scheduler_run': 'Joost — uitgaand-scheduler uitgevoerd',
    'joost.outbound_send_blocked': 'Joost — uitgaand bericht geblokkeerd',
    'joost.outbound_send_executed': 'Joost — uitgaand bericht verstuurd',
    'joost.outcome_marked': 'Joost — uitkomst gemarkeerd',
    'simone.autonomy_decision': 'Simone — autonomie-beslissing gelogd',
    'onboarding.invite.sent': 'Onboarding — uitnodiging verstuurd',
    'event_attendee.deleted': 'Event-deelnemer verwijderd',
  };

  function _humanizeAction(key) {
    if (!key) return { label: '—', raw: '' };
    const raw = String(key);
    // 1) Exact-match
    if (ACTION_OVERRIDE[raw]) return { label: ACTION_OVERRIDE[raw], raw };
    // 2) Pattern-match: <module>.<subject>.<verb> of <module>.<verb>
    const parts = raw.split('.');
    let modLabel = '';
    let subjLabel = '';
    let verbLabel = '';
    if (parts.length >= 2) {
      // Eerste segment = module-hint. Kan snake_case zijn (finance_dunning).
      const modKey = parts[0].toLowerCase();
      modLabel = MOD_NL[modKey] || '';
      // Laatste segment = verb. Kan snake_case zijn (register_payment).
      const lastKey = parts[parts.length - 1].toLowerCase();
      verbLabel = VERB_NL[lastKey] || '';
      // Middensegment(en) = subject.
      if (parts.length >= 3) {
        const subjKey = parts.slice(1, -1).join('.').toLowerCase();
        subjLabel = SUBJECT_NL[subjKey] || subjKey.replace(/_/g, ' ');
      } else if (!verbLabel) {
        // 2-parts: pattern is <module>.<subject> (bv. 'app_settings.update')
        subjLabel = SUBJECT_NL[lastKey] || lastKey.replace(/_/g, ' ');
      }
      if (modLabel && subjLabel && verbLabel) {
        return { label: modLabel + ' — ' + _capFirst(subjLabel) + ' ' + verbLabel, raw };
      }
      if (modLabel && verbLabel && !subjLabel) {
        return { label: modLabel + ' — ' + _capFirst(verbLabel), raw };
      }
      if (modLabel && subjLabel && !verbLabel) {
        return { label: modLabel + ' — ' + _capFirst(subjLabel), raw };
      }
    }
    // 3) Snake_case single-word (bv. 'archive', 'retry'): probeer verb-map
    const singleVerb = VERB_NL[raw.toLowerCase()];
    if (singleVerb) return { label: _capFirst(singleVerb), raw };
    // 4) Fallback: humanize snake/dot naar spaties + capitalize
    const soft = raw.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();
    return { label: _capFirst(soft), raw };
  }
  function _capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function _fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function _fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function _relTime(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const diff = Date.now() - t;
    if (diff < 60000) return 'nu';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min geleden';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' uur geleden';
    return Math.floor(diff / 86400000) + ' dag geleden';
  }

  // ── VIEW: Activiteit ──────────────────────────────────────────────────
  function activiteitView() {
    if (!_live.users.data && !_live.users.loading && !_live.users.error) queueMicrotask(fetchUsers);
    if (!_live.activity.data && !_live.activity.loading && !_live.activity.error) queueMicrotask(fetchActivity);
    if (_live.activity.error && !_live.activity.data) return errBlk('activity', _live.activity.error);
    if (_live.activity.loading && !_live.activity.data) return skel();
    const users = asArr(_live.users.data);
    const rows = asArr(_live.activity.data?.rows);
    const total = Number(_live.activity.data?.total || 0);
    const page = Number(_live.activity.data?.page || 1);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return `${H.toolbar([
      H.chips('t', [{ l: 'Deze week', v: 'w' }, { l: 'Vandaag', v: 'd' }, { l: 'Deze maand', v: 'm' }, { l: 'Alles', v: 'all' }], F('t', 'w')),
      `<select class="filter-sel" onchange="__logFilter('user', this.value)">
        <option value="">Alle gebruikers</option>
        ${users.map((u) => `<option value="${esc(u.user_id)}" ${F('user','')===u.user_id?'selected':''}>${esc(u.user_email || u.user_id.slice(0,8))}</option>`).join('')}
      </select>`,
      `<select class="filter-sel" onchange="__logFilter('role', this.value)">
        <option value="">Alle rollen</option>
        ${['super_admin','admin','manager','sales','mentor','administratie','viewer'].map((r) => `<option value="${r}" ${F('role','')===r?'selected':''}>${r}</option>`).join('')}
      </select>`,
      `<select class="filter-sel" onchange="__logFilter('success', this.value)">
        <option value="">Alle resultaten</option>
        <option value="true"  ${F('success','')==='true'?'selected':''}>Gelukt</option>
        <option value="false" ${F('success','')==='false'?'selected':''}>Geweigerd</option>
      </select>`,
      H.search('Zoek op actie of e-mail…'),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__logRetry('activity')">${svg(I.refresh || I.check2)}Vernieuwen</button></div>`,
    ])}
    ${rows.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen activiteit</div><div class="empty-s">Geen rijen voldoen aan de filter.</div></div>`
      : H.table(
          [{ l: 'Tijd' }, { l: 'Gebruiker' }, { l: 'Rol', cls: 'optional' }, { l: 'Module', cls: 'optional' }, { l: 'Actie' }, { l: 'Methode', cls: 'optional' }, { l: 'Resultaat' }, { l: 'IP', cls: 'optional' }],
          rows.map((r) => {
            const act = _humanizeAction(r.action);
            return [
              `<span class="mono" style="color:var(--text-3);font-size:12px" title="${esc(r.created_at)}">${esc(_fmtTime(r.created_at))}</span>`,
              `<span class="cell-main">${esc(r.user_email || '—')}</span>`,
              rollePill(r.user_role),
              `<span style="font-size:12.5px;color:var(--text-2)">${esc(r.module || '—')}</span>`,
              `<div title="${esc(act.raw)}"><div style="font-size:12.5px;line-height:1.35">${esc(act.label)}</div><div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:1px">${esc(act.raw)}</div></div>`,
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(r.method || '')}</span>`,
              H.pill(r.success ? 'ok' : 'danger', (r.success ? 'ok ' : 'fout ') + (r.status_code || '?')),
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(r.ip || '—')}</span>`,
            ];
          })
        )}
    <div style="padding:12px 20px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--text-2);flex-wrap:wrap">
      <span>${total > 0 ? ((page - 1) * PAGE_SIZE + 1) + '–' + Math.min(page * PAGE_SIZE, total) + ' van ' + total : '0 rijen'}</span>
      ${totalPages > 1 ? `<div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="__logPage(${page - 1})">← Vorige</button>
        <span class="mono" style="padding:0 8px;align-self:center">${page} / ${totalPages}</span>
        <button class="btn btn-ghost btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="__logPage(${page + 1})">Volgende →</button>
      </div>` : ''}
    </div>`;
  }

  // ── VIEW: Per gebruiker ───────────────────────────────────────────────
  function perGebruikerView() {
    if (!_live.users.data && !_live.users.loading && !_live.users.error) queueMicrotask(fetchUsers);
    if (_live.users.error && !_live.users.data) return errBlk('users', _live.users.error);
    if (_live.users.loading && !_live.users.data) return skel();
    const users = asArr(_live.users.data);
    const q = (F('q', '') || '').toLowerCase();
    const rows = users.filter((u) => !q || String(u.user_email || '').toLowerCase().includes(q));
    return `${H.toolbar([H.search('Zoek gebruiker…')])}
    ${rows.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen gebruikers</div></div>`
      : H.table(
          [{ l: 'Gebruiker' }, { l: 'Rol' }, { l: 'Laatst ingelogd', cls: 'optional' }, { l: 'Laatst actief' }, { l: 'IP', cls: 'optional' }, { l: 'Acties', cls: 'r' }],
          rows.map((u) => [
            `<div class="row-avatar">${H.av(u.user_email || '—', 28)}<span class="cell-main">${esc(u.user_email || '—')}</span></div>`,
            rollePill(u.user_role),
            `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDateTime(u.last_login_at))}</span>`,
            `<span style="font-size:12.5px">${esc(_relTime(u.last_activity_at))}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(u.last_ip || '—')}</span>`,
            `<span class="mono">${Number(u.action_count || 0)}</span>`,
          ])
        )}`;
  }

  // ══════════════════════════════════════════════════════════════════
  // #logboek-v1 · Tijdlijn-subview (unified stream: activity + call + snapshot)
  // Super_admin-only via server-side gate + client-side UI-lock.
  // ══════════════════════════════════════════════════════════════════

  const _tl = {
    loading: false, error: null, data: null, page: 1,
    filter: {
      streams: ['activity', 'call', 'snapshot'],
      user_id: null, q: '',
      from: null, to: null,
      include_views: false,   // default: alleen echte writes; toggle om page-views te tonen
    },
    totals: { activity: 0, call: 0, snapshot: 0 },
    _qTimer: null,
  };

  function _tlIsSuperAdmin() {
    try {
      const role = window.DFO?.S?.role || window.KV_V2?.role || null;
      return role === 'super_admin';
    } catch (_) { return false; }
  }

  async function _tlFetch() {
    if (_tl.loading) return;
    _tl.loading = true; _tl.error = null;
    if (window.DFO?.render) window.DFO.render();
    const params = new URLSearchParams();
    params.set('streams', _tl.filter.streams.join(','));
    params.set('page', String(_tl.page));
    params.set('page_size', '50');
    if (_tl.filter.user_id) params.set('user_id', _tl.filter.user_id);
    if (_tl.filter.q)       params.set('q', _tl.filter.q);
    if (_tl.filter.from)    params.set('from', _tl.filter.from);
    if (_tl.filter.to)      params.set('to', _tl.filter.to);
    if (_tl.filter.include_views) params.set('include_views', 'true');
    const j = await tryFetch('logboek-stream', '/api/logboek-stream-list?' + params.toString(), 12000);
    _tl.loading = false;
    if (!j || j.__error || j.error) { _tl.error = j?.__error || j?.error || 'onbekend'; }
    else { _tl.data = j; _tl.totals = j.totals_hint || _tl.totals; }
    if (window.DFO?.render) window.DFO.render();
  }

  window.__tlToggleStream = (s) => {
    const cur = _tl.filter.streams;
    if (cur.includes(s)) _tl.filter.streams = cur.filter(x => x !== s);
    else _tl.filter.streams = cur.concat(s);
    if (_tl.filter.streams.length === 0) _tl.filter.streams = ['activity','call','snapshot'];
    _tl.page = 1; _tl.data = null; _tlFetch();
  };
  window.__tlSetQ = (v) => {
    clearTimeout(_tl._qTimer);
    _tl._qTimer = setTimeout(() => {
      _tl.filter.q = String(v || '').trim();
      _tl.page = 1; _tl.data = null; _tlFetch();
    }, 400);
  };
  window.__tlPage = (delta) => {
    _tl.page = Math.max(1, _tl.page + delta);
    _tl.data = null; _tlFetch();
  };
  window.__tlToggleViews = (checked) => {
    _tl.filter.include_views = !!checked;
    _tl.page = 1; _tl.data = null; _tlFetch();
  };
  window.__tlOpenSnapshot = (id) => {
    const item = asArr(_tl.data?.items).find(i => i.stream === 'snapshot' && i.id === id);
    if (item) _openSnapshotModal(item);
  };

  function _openSnapshotModal(item) {
    const existing = document.getElementById('tlSnapshotModal');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = 'tlSnapshotModal';
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,23,33,.85);padding:20px';
    root.addEventListener('click', (e) => { if (e.target === root) root.remove(); });
    const escKey = (e) => { if (e.key === 'Escape') { root.remove(); document.removeEventListener('keydown', escKey); } };
    document.addEventListener('keydown', escKey);
    root.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:96vw;max-height:96vh;overflow:hidden;display:flex;flex-direction:column">'
      + '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px">'
        + '<div style="font-size:13px;color:var(--text-2)">'
          + '<b>' + esc(item.action_hint || '') + '</b> · '
          + esc(new Date(item.ts).toLocaleString('nl-NL'))
          + ' · ' + esc(item.user_email || item.user_id || '')
          + ' · ' + esc(item.view_title || item.view_url || '')
        + '</div>'
        + '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'tlSnapshotModal\').remove()">✕</button>'
      + '</div>'
      + '<div style="overflow:auto;padding:12px;background:#111;flex:1">'
        + (item.signed_url
            ? '<img src="' + esc(item.signed_url) + '" style="display:block;max-width:100%;max-height:82vh;margin:0 auto" alt="snapshot" />'
            : '<div style="color:#eee;padding:20px;text-align:center">Signed URL niet beschikbaar</div>')
      + '</div>'
      + '<div style="padding:8px 16px;border-top:1px solid var(--border);font-size:11px;color:var(--text-3)">'
        + 'Iframes (email-body, embeds) blijven zwart in deze opname · TTL ' + (item.signed_url_ttl_seconds || 300) + 's'
      + '</div>'
    + '</div>';
    document.body.appendChild(root);
  }

  function tijdlijnView() {
    if (!_tlIsSuperAdmin()) {
      return '<div style="padding:40px;text-align:center;color:var(--text-3)">'
           + '<div style="font-size:14px">🔒 Tijdlijn is super_admin-only.</div>'
           + '</div>';
    }
    if (!_tl.data && !_tl.loading && !_tl.error) queueMicrotask(_tlFetch);
    if (_tl.loading) return '<div style="padding:40px;text-align:center">Laden…</div>';
    if (_tl.error) return '<div style="padding:16px;color:var(--rose)">' + esc(_tl.error) + '</div>';
    const items = asArr(_tl.data?.items);
    const t = _tl.totals || {};
    const isOn = (s) => _tl.filter.streams.includes(s);
    const chipStyle = (on) => 'display:flex;gap:5px;align-items:center;font-size:12.5px;padding:5px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:' + (on ? 'var(--brand-soft,#E2F1F5)' : 'var(--surface)');

    return '<div style="padding:16px 20px">'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">'
        + '<label style="' + chipStyle(isOn('activity')) + '">'
          + '<input type="checkbox" ' + (isOn('activity') ? 'checked' : '') + ' onchange="window.__tlToggleStream(\'activity\')" />'
          + 'Activity <span style="color:var(--text-3);font-family:monospace">' + (t.activity || 0) + '</span>'
        + '</label>'
        + '<label style="' + chipStyle(isOn('call')) + '">'
          + '<input type="checkbox" ' + (isOn('call') ? 'checked' : '') + ' onchange="window.__tlToggleStream(\'call\')" />'
          + '📞 Calls <span style="color:var(--text-3);font-family:monospace">' + (t.call || 0) + '</span>'
        + '</label>'
        + '<label style="' + chipStyle(isOn('snapshot')) + '">'
          + '<input type="checkbox" ' + (isOn('snapshot') ? 'checked' : '') + ' onchange="window.__tlToggleStream(\'snapshot\')" />'
          + '🖼 Snapshots <span style="color:var(--text-3);font-family:monospace">' + (t.snapshot || 0) + '</span>'
        + '</label>'
        + '<input type="search" placeholder="Zoek action / module / hint …" value="' + esc(_tl.filter.q) + '"'
          + ' oninput="window.__tlSetQ(this.value)"'
          + ' style="flex:1;min-width:200px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12.5px" />'
        + '<label style="' + chipStyle(_tl.filter.include_views) + '" title="Toon ook page-views / GET-navigatie in de activity-stream">'
          + '<input type="checkbox" ' + (_tl.filter.include_views ? 'checked' : '') + ' onchange="window.__tlToggleViews(this.checked)" />'
          + '👁 Weergaven tonen'
        + '</label>'
      + '</div>'
      + '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--surface)">'
      + (items.length === 0
          ? '<div style="padding:20px;color:var(--text-3);text-align:center">Geen resultaten in dit filter</div>'
          : items.map(_tlRenderRow).join(''))
      + '</div>'
      + '<div style="display:flex;justify-content:center;gap:10px;margin-top:14px">'
        + '<button class="btn btn-ghost btn-sm" ' + (_tl.page <= 1 ? 'disabled' : '') + ' onclick="window.__tlPage(-1)">← Vorige</button>'
        + '<span style="font-size:12px;color:var(--text-3);align-self:center">Pagina ' + _tl.page + '</span>'
        + '<button class="btn btn-ghost btn-sm" ' + (_tl.data?.has_more ? '' : 'disabled') + ' onclick="window.__tlPage(1)">Volgende →</button>'
      + '</div>'
      + '</div>';
  }

  function _tlRenderRow(it) {
    const ts = new Date(it.ts).toLocaleString('nl-NL');
    const bundled = Array.isArray(it.bundled_with) && it.bundled_with.some(x => String(x).startsWith('snapshot:'));
    const bg = it.stream === 'activity' ? 'transparent'
             : it.stream === 'call'     ? 'var(--brand-soft,#E2F1F5)'
             : /* snapshot */             'var(--gold-soft,#F9EFD4)';
    const icon = it.stream === 'activity' ? '•'
               : it.stream === 'call'     ? '📞'
               : /* snapshot */              '🖼';
    let core = '';
    if (it.stream === 'activity') {
      core = '<b>' + esc(it.action || '') + '</b>' + (bundled ? ' 🖼' : '')
           + ' <span style="color:var(--text-3);margin-left:8px">' + esc(it.module || '—') + '</span>'
           + ' <span style="color:var(--text-3);margin-left:8px;font-family:monospace;font-size:11px">' + esc(it.method || '') + ' ' + (it.status_code || '') + '</span>';
    } else if (it.stream === 'call') {
      const durMin = it.duration_sec == null ? '' : ('~' + Math.floor(it.duration_sec / 60) + 'm ' + (it.duration_sec % 60) + 's');
      core = '<b>Belt ' + esc(it.to_number || '?') + '</b>'
           + ' <span style="color:var(--text-3);margin-left:8px">' + esc(String(it.line || '').toUpperCase()) + ' · ' + esc(it.outcome_hint || '?') + ' · ' + esc(durMin) + '</span>'
           + (it.meta_source ? ' <span style="color:var(--text-3);margin-left:8px;font-size:11px">' + esc(it.meta_source) + '</span>' : '');
    } else {
      core = '<b onclick="window.__tlOpenSnapshot(\'' + esc(it.id) + '\')" style="cursor:pointer;text-decoration:underline">Snapshot: ' + esc(it.action_hint || '?') + '</b>'
           + ' <span style="color:var(--text-3);margin-left:8px">' + esc(it.view_title || it.view_url || '') + '</span>'
           + ' <span style="color:var(--text-3);margin-left:8px;font-size:11px">' + (it.size_kb || '?') + 'KB</span>';
    }
    return '<div style="padding:8px 12px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:150px 24px 1fr 160px;gap:8px;font-size:12.5px;background:' + bg + '">'
         + '<div style="color:var(--text-3);font-family:monospace">' + esc(ts) + '</div>'
         + '<div style="text-align:center">' + icon + '</div>'
         + '<div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + core + '</div>'
         + '<div style="color:var(--text-3);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(it.actor_name || it.user_email || it.user_id || '') + '</div>'
       + '</div>';
  }

  window.DFO.VIEWS['logboek/Tijdlijn']       = tijdlijnView;
  window.DFO.VIEWS['logboek/Activiteit']    = activiteitView;
  window.DFO.VIEWS['logboek/Per gebruiker'] = perGebruikerView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('logboek');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('logboek');
  console.debug('[logboek-v2] data-ronde geregistreerd (dormant)');
})();
