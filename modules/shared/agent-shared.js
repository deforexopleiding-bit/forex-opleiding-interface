/* ─── agent-shared.js ────────────────────────────────────────────────────────
   Gedeelde utilities en approval-kern voor agents.html, meetings.html en
   control-center.html.  Geëxporteerd als window.AgentShared.
   ──────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Utils ──────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatMd(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^## (.+)$/gm, '<div style="font-size:14px;font-weight:700;color:var(--text);margin:12px 0 4px">$1</div>')
      .replace(/^### (.+)$/gm, '<div style="font-size:13px;font-weight:600;color:var(--text-dim);margin:8px 0 2px">$1</div>')
      .replace(/^- (.+)$/gm, '<div style="padding-left:12px">• $1</div>')
      .replace(/\n/g, '<br>');
  }

  function relTime(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2)  return 'zojuist';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}u`;
    return `${Math.floor(hrs / 24)}d`;
  }

  function showToast(msg, type = 'success') {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;
      background:${type === 'success' ? 'var(--green)' : 'var(--red)'};
      color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600;
      box-shadow:0 4px 12px rgba(0,0,0,.4);animation:agents-slide-in .2s ease;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Report overlay ─────────────────────────────────────────────────────────
  // Injecteert de overlay dynamisch (voorkomt duplicatie tussen modules)

  function _ensureReportOverlay() {
    if (document.getElementById('reportOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="report-overlay hidden" id="reportOverlay">
        <div class="report-modal">
          <div class="report-header">
            <div class="report-title" id="reportTitle">Rapport</div>
            <button class="report-close" onclick="AgentShared.closeReport()">✕</button>
          </div>
          <div class="report-body">
            <div class="report-content" id="reportContent"></div>
          </div>
          <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end">
            <button class="btn btn-sm" onclick="AgentShared.closeReport()">Sluiten</button>
          </div>
        </div>
      </div>`);
  }

  function showReport(title, md) {
    _ensureReportOverlay();
    document.getElementById('reportTitle').textContent = title || 'Rapport';
    document.getElementById('reportContent').innerHTML = formatMd(esc(md || ''));
    document.getElementById('reportOverlay').classList.remove('hidden');
  }

  function closeReport() {
    document.getElementById('reportOverlay')?.classList.add('hidden');
  }

  // ── Approval overlay ───────────────────────────────────────────────────────
  // Injecteert #approvalDetailOverlay als het niet in het DOM aanwezig is

  function _ensureApprovalDetailOverlay() {
    if (document.getElementById('approvalDetailOverlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="approvalDetailOverlay" class="report-overlay hidden">
        <div class="report-modal" style="max-width:680px">
          <div class="report-header">
            <div class="report-title" id="approvalDetailTitle">Approval</div>
            <button class="report-close" onclick="AgentShared.closeApprovalDetail()">✕</button>
          </div>
          <div class="report-body" id="approvalDetailBody" style="max-height:52vh;overflow-y:auto;padding:20px"></div>
          <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input id="approvalComment" class="review-input" style="flex:1;min-width:160px;background:var(--bg-elev);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:13px;color:var(--text);font-family:inherit;outline:none" placeholder="Opmerking (optioneel)…"/>
            <button class="btn btn-sm" style="background:rgba(239,68,68,0.15);color:var(--red);border:1px solid rgba(239,68,68,0.3)" onclick="AgentShared.rejectApproval()">✗ Afkeuren</button>
            <button class="btn btn-sm" style="background:rgba(34,197,94,0.15);color:var(--green);border:1px solid rgba(34,197,94,0.3)" onclick="AgentShared.approveSelected()">✓ Geselecteerde</button>
            <button class="btn btn-sm btn-primary" onclick="AgentShared.approveAll()">✓ Alle goedkeuren</button>
          </div>
        </div>
      </div>`);
  }

  // ── Approval state ─────────────────────────────────────────────────────────

  let currentApprovalId   = null;
  let currentApprovalData = null;
  let approvalPollInterval = null;

  async function loadApprovals() {
    try {
      const res  = await fetch('/api/agent-approval?action=list');
      const data = await res.json();
      const list  = document.getElementById('approvalList');
      const badge = document.getElementById('approvalBadge');
      const count = (data.pending || []).length;

      // Update CC sidebar badge if present
      const ccBadge = document.getElementById('ccApprovalBadge');
      if (ccBadge) {
        ccBadge.textContent = count;
        ccBadge.classList.toggle('show', count > 0);
      }

      if (!list) return;
      if (badge) {
        badge.textContent = count;
        badge.classList.toggle('hidden', count === 0);
      }
      if (!count) {
        list.innerHTML = '<div style="color:var(--text-faint);font-size:12px">Geen openstaande approvals</div>';
        return;
      }
      list.innerHTML = (data.pending || []).map(a => {
        const hrs = a.expires_at ? Math.floor((new Date(a.expires_at) - Date.now()) / 3600000) : 999;
        const urgencyHtml = hrs < 24 ? `<span class="approval-urgency-red">⚠ ${hrs}u</span>`
                          : hrs < 48 ? `<span class="approval-urgency-amber">${hrs}u</span>` : '';
        const name  = a.agent_name || '';
        const title = esc(a.payload?.title || a.description || a.action || '');
        return `<div class="approval-row" onclick="AgentShared.showApprovalDetail('${a.id}')">
          <span class="chip ${name.toLowerCase()}">${esc(name)}</span>
          <span style="font-size:10px;color:var(--text-faint);flex-shrink:0">${esc(a.action)}</span>
          <span style="font-size:12px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title}</span>
          <span style="font-size:10px;color:var(--text-faint);flex-shrink:0">${relTime(a.created_at)}</span>
          ${urgencyHtml}
        </div>`;
      }).join('');
    } catch (e) {
      console.error('[approvals]', e.message);
    }
  }

  async function showApprovalDetail(approvalId) {
    _ensureApprovalDetailOverlay();
    currentApprovalId = approvalId;
    document.getElementById('approvalDetailTitle').textContent = 'Laden…';
    document.getElementById('approvalDetailBody').innerHTML = '<div style="padding:20px;color:var(--text-faint)">Laden…</div>';
    document.getElementById('approvalDetailOverlay').classList.remove('hidden');
    try {
      const res  = await fetch(`/api/agent-approval?action=get_detail&approval_id=${approvalId}`);
      const data = await res.json();
      currentApprovalData = data.approval;
      const ap    = data.approval;
      const title = ap.payload?.title || ap.action || 'Approval';
      document.getElementById('approvalDetailTitle').textContent = `${ap.agent_name}: ${title}`;
      const items = ap.payload?.preview_data || [];
      let bodyHtml = ap.description
        ? `<div style="font-size:12px;color:var(--text-faint);margin-bottom:14px">${esc(ap.description)}</div>`
        : '';
      if (items.length) {
        bodyHtml += items.map((item, i) => {
          const itemTitle = item.subject || item.titel || item.title || item.task_title || `Item ${i + 1}`;
          const preview   = item.concept_text || item.body || item.notes || '';
          return `<div style="display:flex;align-items:flex-start;gap:10px;padding:10px;background:var(--bg-elev);border-radius:8px;margin-bottom:8px">
            <input type="checkbox" id="apitem-${i}" checked style="margin-top:3px;flex-shrink:0"/>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;margin-bottom:4px">${esc(itemTitle)}</div>
              ${preview ? `<div style="font-size:11px;color:var(--text-faint);white-space:pre-wrap;max-height:100px;overflow:hidden">${esc(preview.slice(0, 400))}</div>` : ''}
              <div style="font-size:10px;color:var(--text-faint);margin-top:4px">${Object.entries(item).filter(([k]) => !['concept_text','body','notes','subject','titel','title','task_title'].includes(k)).map(([k,v]) => `${k}: ${String(v).slice(0,80)}`).join(' · ')}</div>
            </div>
          </div>`;
        }).join('');
      } else {
        bodyHtml += `<pre style="font-size:11px;color:var(--text-faint);white-space:pre-wrap;overflow:auto;max-height:200px">${esc(JSON.stringify(ap.payload, null, 2))}</pre>`;
      }
      document.getElementById('approvalDetailBody').innerHTML = bodyHtml;
      const commentEl = document.getElementById('approvalComment');
      if (commentEl) commentEl.value = '';
    } catch (e) {
      document.getElementById('approvalDetailBody').innerHTML = `<div style="color:var(--red);padding:20px">${esc(e.message)}</div>`;
    }
  }

  function closeApprovalDetail() {
    document.getElementById('approvalDetailOverlay')?.classList.add('hidden');
    currentApprovalId   = null;
    currentApprovalData = null;
  }

  async function approveAll() { await _doApprove(null); }

  async function approveSelected() {
    const checkboxes = document.querySelectorAll('[id^="apitem-"]');
    const indices    = [...checkboxes].map((cb, i) => cb.checked ? i : -1).filter(i => i >= 0);
    await _doApprove(indices.length ? indices : null);
  }

  async function _doApprove(indices) {
    if (!currentApprovalId) return;
    const btns = document.querySelectorAll('#approvalDetailOverlay .btn');
    btns.forEach(b => { b.disabled = true; });
    const comment = document.getElementById('approvalComment')?.value?.trim() || undefined;
    try {
      const res  = await fetch('/api/agent-approval', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action:                'approve',
          approval_id:           currentApprovalId,
          approved_item_indices: indices,
          decided_by:            'Jeffrey',
          comment,
        }),
      });
      const data = await res.json();
      closeApprovalDetail();
      const hasErrors = data.errors?.length > 0;
      showToast(
        hasErrors
          ? `${data.executed} uitgevoerd, ${data.failed} gefaald`
          : `✓ ${data.executed} item${data.executed !== 1 ? 's' : ''} goedgekeurd en uitgevoerd`,
        hasErrors ? 'error' : 'success'
      );
      loadApprovals();
      // Refresh audit log als aanwezig op pagina
      if (typeof loadAuditLog === 'function') loadAuditLog();
    } catch (e) {
      showToast('Fout bij uitvoeren: ' + e.message, 'error');
      btns.forEach(b => { b.disabled = false; });
    }
  }

  async function rejectApproval() {
    if (!currentApprovalId) return;
    const reason     = document.getElementById('approvalComment')?.value?.trim() || '';
    const decided_by = 'Jeffrey';
    try {
      await fetch('/api/agent-approval', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          action:           'reject',
          approval_id:      currentApprovalId,
          rejection_reason: reason,
          decided_by,
        }),
      });
      closeApprovalDetail();
      showToast('Approval afgewezen', 'error');
      loadApprovals();
      if (typeof loadAuditLog === 'function') loadAuditLog();
    } catch (e) {
      showToast('Fout: ' + e.message, 'error');
    }
  }

  function startApprovalPolling() {
    if (approvalPollInterval) clearInterval(approvalPollInterval);
    loadApprovals();
    approvalPollInterval = setInterval(loadApprovals, 30000);
  }

  function stopApprovalPolling() {
    if (approvalPollInterval) {
      clearInterval(approvalPollInterval);
      approvalPollInterval = null;
    }
  }

  // ── Logo fallback (hergebruikt in alle modules) ────────────────────────────

  function handleLogoError() {
    try {
      const b64 = localStorage.getItem('signature_logo_base64');
      if (b64?.startsWith('data:image')) {
        document.getElementById('sidebarLogoImg').src = b64;
        return;
      }
    } catch {}
    document.getElementById('sidebarLogo').innerHTML = '<span class="sidebar-logo-fallback">De Forex Opleiding</span>';
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  window.AgentShared = {
    esc,
    formatMd,
    relTime,
    showToast,
    showReport,
    closeReport,
    loadApprovals,
    showApprovalDetail,
    closeApprovalDetail,
    approveAll,
    approveSelected,
    _doApprove,
    rejectApproval,
    startApprovalPolling,
    stopApprovalPolling,
    handleLogoError,
  };
})();
