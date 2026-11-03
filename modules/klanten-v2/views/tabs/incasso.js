// modules/klanten-v2/views/tabs/incasso.js
//
// INCASSOSTATUS van de klant (PR 3 mentorcommissie, 3 nov 2026).
// Eén status: actief · bij incasso · incasso-regeling · afgesloten (betaald
// of oninbaar), met datum, reden, wie en historiek. Aanpassen en opheffen hier.
// Signalen (incassodossier, wanbetalers-pipeline, onboarding) zijn alleen
// voorstellen; er wordt nooit automatisch een status gezet.
// Gevolg voor de mentorcommissie (api/_lib/klant-incassostatus.js):
//   bij incasso → staat stil · regeling → echte betalingen tellen weer ·
//   afgesloten betaald → alles telt · afgesloten oninbaar → niets meer.
// API: GET/POST /api/klant-incassostatus. Niet zichtbaar voor mentoren.

const K = () => window.KV;
let st = null;

const UITLEG = {
  actief: 'Geen incasso. De commissie loopt op betaalde facturen.',
  bij_incasso: 'Commissie staat stil: betalingen vanaf deze datum tellen (nog) niet.',
  incasso_regeling: 'Er is een regeling: echte betalingen tellen weer, op wat effectief bij ons binnenkomt.',
  afgesloten: 'Afgesloten: betaald = alles telt; oninbaar = er komt niets meer bij.',
};
const KLEUR = { actief: 'var(--emerald)', bij_incasso: 'var(--rose)', incasso_regeling: 'var(--amber)', afgesloten: 'var(--text-3)' };
const vandaag = () => new Date().toISOString().slice(0, 10);
const fmt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('-') : '—');

async function laad(rootEl) {
  st.loading = true; st.error = null; render(rootEl);
  try {
    st.data = await K().authedJson(`/api/klant-incassostatus?customer_id=${encodeURIComponent(st.customerId)}`);
  } catch (e) { st.error = e?.message || 'Laden mislukt'; }
  st.loading = false; render(rootEl);
}

function formHtml() {
  const f = st.form;
  return `
    <div class="ds-card" style="padding:14px 16px;margin-top:12px">
      <div style="font-weight:600;font-size:13px;margin-bottom:8px">Status wijzigen</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        <label class="kv-edit-field"><span style="font-size:11.5px;color:var(--text-3)">Nieuwe status</span>
          <select data-ki="status">
            ${[['bij_incasso', 'Bij incasso'], ['incasso_regeling', 'Incasso-regeling'], ['afgesloten', 'Afgesloten'], ['actief', 'Actief (opheffen)']]
              .map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
        ${f.status === 'afgesloten' ? `<label class="kv-edit-field"><span style="font-size:11.5px;color:var(--text-3)">Afgesloten als</span>
          <select data-ki="afgesloten_als"><option value="">— kies —</option>
            <option value="betaald" ${f.afgesloten_als === 'betaald' ? 'selected' : ''}>Betaald</option>
            <option value="oninbaar" ${f.afgesloten_als === 'oninbaar' ? 'selected' : ''}>Oninbaar</option></select></label>` : ''}
        ${f.status !== 'actief' ? `<label class="kv-edit-field"><span style="font-size:11.5px;color:var(--text-3)">Vanaf</span>
          <input type="date" data-ki="sinds" value="${K().esc(f.sinds || '')}"></label>` : ''}
        <label class="kv-edit-field" style="grid-column:1/-1"><span style="font-size:11.5px;color:var(--text-3)">Reden (verplicht; niet zichtbaar voor mentoren)</span>
          <input type="text" data-ki="reden" maxlength="500" value="${K().esc(f.reden || '')}" placeholder="bv. dossier naar bureau op 12-10"></label>
      </div>
      <div style="font-size:11.5px;color:var(--text-3);margin-top:6px">${K().esc(UITLEG[f.status] || '')}</div>
      ${st.formError ? `<div class="kv-edit-banner" style="margin-top:8px">${K().esc(st.formError)}</div>` : ''}
      <div style="margin-top:10px;display:flex;gap:8px">
        <button type="button" class="ds-btn ds-btn-primary ds-btn-sm" data-ki-save ${st.saving ? 'disabled' : ''}>${st.saving ? 'Bezig…' : 'Opslaan'}</button>
      </div>
    </div>`;
}

function render(rootEl) {
  if (st.loading && !st.data) { rootEl.innerHTML = '<div class="ds-empty" style="padding:32px 20px"><div class="ds-empty-s">Incassostatus laden…</div></div>'; return; }
  if (st.error) { rootEl.innerHTML = `<div class="ds-empty" style="padding:32px 20px"><div class="ds-empty-t">Kon de incassostatus niet laden</div><div class="ds-empty-s">${K().esc(st.error)}</div></div>`; return; }
  const d = st.data || {};
  const s = d.status || { status: 'actief', label: 'Actief' };
  const kleur = KLEUR[s.status] || 'var(--text-2)';
  const migratie = d.kolommen === false
    ? '<div class="kv-edit-banner" style="margin-bottom:10px">Migratie 2026-11-03-klant-incassostatus.sql is nog niet gedraaid: enkel "bij incasso" en opheffen werken.</div>' : '';
  const voorstellen = (d.voorstellen || []).length ? `
    <div class="ds-card" style="padding:12px 16px;margin-top:12px;border-color:var(--amber)">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">Voorstellen uit andere signalen (niet automatisch)</div>
      ${(d.voorstellen || []).map((v, i) => `<div style="display:flex;gap:10px;align-items:center;font-size:12.5px;padding:3px 0">
        <span style="flex:1">${K().esc(v.bron)}${v.sinds ? ' · sinds ' + fmt(v.sinds) : ''} → <b>${K().esc(v.voorstel)}</b></span>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-ki-voorstel="${i}">Overnemen in formulier</button></div>`).join('')}
    </div>` : '';
  const hist = (d.historiek || []).length ? `
    <div class="ds-tbl-wrap" style="margin-top:12px"><table class="ds-tbl">
      <thead><tr><th>Status</th><th>Vanaf</th><th>Reden</th><th>Gezet door</th><th>Tot</th><th>Beëindigd</th></tr></thead>
      <tbody>${(d.historiek || []).map((h) => `<tr>
        <td><b style="color:${KLEUR[h.status] || 'inherit'}">${K().esc(h.label)}</b>${h.bron === 'voorstel' ? ' <span style="font-size:11px;color:var(--text-3)">(voorstel)</span>' : ''}</td>
        <td>${fmt(h.sinds)}</td><td>${K().esc(h.reden || '—')}</td>
        <td>${K().esc(h.gezet_door || '—')}<div style="font-size:11px;color:var(--text-3)">${fmt(h.gezet_op)}</div></td>
        <td>${h.tot ? fmt(h.tot) : '<span style="color:var(--emerald)">huidig</span>'}</td>
        <td>${K().esc(h.beeindigd_reden || '—')}${h.beeindigd_door ? `<div style="font-size:11px;color:var(--text-3)">${K().esc(h.beeindigd_door)}</div>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div style="font-size:12px;color:var(--text-3);margin-top:12px">Nog geen historiek.</div>';
  rootEl.innerHTML = `
    <div style="max-width:980px">
      ${migratie}
      <div class="ds-card" style="padding:14px 16px">
        <div style="font-size:11.5px;color:var(--text-3)">Incassostatus</div>
        <div style="font-size:20px;font-weight:700;color:${kleur}">${K().esc(s.label || s.status)}</div>
        <div style="font-size:12.5px;color:var(--text-2);margin-top:2px">${s.sinds ? 'Sinds ' + fmt(s.sinds) + ' · ' : ''}${K().esc(UITLEG[s.status] || '')}</div>
        ${s.reden ? `<div style="font-size:12px;color:var(--text-3);margin-top:4px">Reden: ${K().esc(s.reden)}</div>` : ''}
      </div>
      ${voorstellen}
      ${formHtml()}
      <div style="font-weight:600;font-size:13px;margin-top:16px">Historiek</div>
      ${hist}
    </div>`;
  wire(rootEl);
}

function wire(rootEl) {
  rootEl.querySelectorAll('[data-ki]').forEach((el) => {
    el.addEventListener('change', (e) => {
      st.form[el.getAttribute('data-ki')] = e.target.value;
      if (el.getAttribute('data-ki') === 'status') render(rootEl);
    });
    if (el.tagName === 'INPUT') el.addEventListener('input', (e) => { st.form[el.getAttribute('data-ki')] = e.target.value; });
  });
  rootEl.querySelectorAll('[data-ki-voorstel]').forEach((b) => b.addEventListener('click', () => {
    const v = (st.data?.voorstellen || [])[Number(b.getAttribute('data-ki-voorstel'))];
    if (!v) return;
    st.form = { ...st.form, status: v.voorstel, sinds: v.sinds || vandaag(), reden: st.form.reden || v.bron, bron: 'voorstel' };
    render(rootEl);
  }));
  rootEl.querySelector('[data-ki-save]')?.addEventListener('click', async () => {
    const f = st.form;
    if (!f.reden || f.reden.trim().length < 3) { st.formError = 'Geef een reden.'; render(rootEl); return; }
    if (f.status === 'afgesloten' && !f.afgesloten_als) { st.formError = 'Kies: afgesloten als betaald of oninbaar.'; render(rootEl); return; }
    st.saving = true; st.formError = null; render(rootEl);
    try {
      const j = await K().authedJson('/api/klant-incassostatus', {
        method: 'POST',
        body: JSON.stringify({ customer_id: st.customerId, status: f.status, afgesloten_als: f.afgesloten_als || null, sinds: f.sinds || vandaag(), reden: f.reden, bron: f.bron || 'handmatig' }),
      });
      const vrij = j?.vrijgave?.vrijgegeven;
      K().toast('Incassostatus opgeslagen' + (vrij > 0 ? ` · € ${vrij.toFixed(2)} commissie vrijgegeven op betaalde facturen` : ''));
      st.form = { status: 'bij_incasso', afgesloten_als: '', sinds: vandaag(), reden: '' };
      st.saving = false;
      await laad(rootEl);
    } catch (e) {
      st.saving = false; st.formError = e?.message || 'Opslaan mislukt'; render(rootEl);
    }
  });
}

export async function renderIncassoTab(rootEl, { customer } = {}) {
  if (!customer?.id) { rootEl.innerHTML = '<div class="ds-empty" style="padding:40px 20px"><div class="ds-empty-t">Geen klant-data</div></div>'; return; }
  st = { customerId: customer.id, loading: true, error: null, data: null, saving: false, formError: null,
    form: { status: 'bij_incasso', afgesloten_als: '', sinds: vandaag(), reden: '' } };
  await laad(rootEl);
}
