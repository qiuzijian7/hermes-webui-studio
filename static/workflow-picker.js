/**
 * workflow-picker.js — 协同模板选择器
 *
 * 功能：
 *  - 拉取后端 /api/workflows 列表并在弹框中展示
 *  - 点击"应用" → 拉取 /api/workflow?id=xxx 详情 → 转为 createTeamFromJSON 格式 → 调用批量创建
 *  - 一键创建所需员工卡 + 上下级连线关系
 *
 * 与 employee.js 中 ``createTeamFromJSON`` 的映射：
 *    workflow.members[i]         → teamData.members[i]
 *      .name                     → member.name
 *      .preset                   → member.presetId
 *      .role                     → member.role
 *      .model                    → member.model
 *    workflow.topology.subagents → 通过 ``manages`` 字段转成自下而上关系
 *      例如：{ planner: ['coder'] }  →  planner.manages = ['coder']
 *
 * 后端 API：api/workflow.py
 */

(function() {
  'use strict';

  let _workflows = []; // 缓存列表

  /** 打开选择器。 */
  async function openWorkflowPicker() {
    const overlay = document.getElementById('workflowOverlay');
    const list = document.getElementById('workflowList');
    if (!overlay || !list) return;

    overlay.style.display = 'flex';
    list.innerHTML = '<div class="wf-loading">正在加载模板…</div>';

    try {
      const resp = await fetch('/api/workflows');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || '加载失败');
      _workflows = Array.isArray(data.workflows) ? data.workflows : [];
      _renderList(list, _workflows);
    } catch (e) {
      list.innerHTML = `<div class="wf-loading" style="color:#ff9b9b">加载失败：${_esc(e.message || e)}</div>`;
    }
  }
  window.openWorkflowPicker = openWorkflowPicker;

  function closeWorkflowPicker() {
    const overlay = document.getElementById('workflowOverlay');
    if (overlay) overlay.style.display = 'none';
  }
  window.closeWorkflowPicker = closeWorkflowPicker;

  function _renderList(listEl, items) {
    if (!items.length) {
      listEl.innerHTML = '<div class="wf-loading">未找到可用模板（workflows/ 目录为空）</div>';
      return;
    }
    listEl.innerHTML = items.map(wf => {
      const chips = (wf.members_preview || []).map(n =>
        `<span class="wf-chip">👤 ${_esc(n)}</span>`
      ).join('');
      return `
        <div class="wf-item" data-wf-id="${_esc(wf.id)}">
          <div class="wf-item-head">
            <span class="wf-item-title">${_esc(wf.title || wf.name)}</span>
            <span class="wf-item-badge">${wf.member_count} 位成员</span>
          </div>
          <div class="wf-item-desc">${_esc(wf.description || '')}</div>
          <div class="wf-item-members">${chips}</div>
          <div class="wf-item-actions">
            <button class="wf-apply-btn" onclick="applyWorkflow('${_esc(wf.id)}', this)">应用到当前工作区</button>
          </div>
        </div>
      `;
    }).join('');
  }

  /** 应用指定 workflow。 */
  async function applyWorkflow(workflowId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '应用中…'; }
    try {
      const resp = await fetch('/api/workflow?id=' + encodeURIComponent(workflowId));
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (!data.ok) throw new Error((data.errors && data.errors.join('; ')) || data.error || '加载详情失败');
      const wf = data.workflow;

      const teamData = _workflowToTeamData(wf);
      if (!teamData.members.length) throw new Error('workflow 无有效成员');

      if (typeof createTeamFromJSON !== 'function') {
        throw new Error('createTeamFromJSON 未定义（employee.js 未加载）');
      }

      const createdBefore = EMPLOYEE_STORE ? EMPLOYEE_STORE.employees.length : 0;
      createTeamFromJSON(teamData);
      const createdAfter = EMPLOYEE_STORE ? EMPLOYEE_STORE.employees.length : 0;
      const added = createdAfter - createdBefore;

      if (typeof showToast === 'function') {
        showToast(`已应用"${wf.title || wf.name}"：新增 ${added} 位员工（总 ${teamData.members.length} 位，跳过已存在同名）`);
      }
      closeWorkflowPicker();
    } catch (e) {
      if (typeof showToast === 'function') {
        showToast('应用失败：' + (e.message || e));
      } else {
        alert('应用失败：' + (e.message || e));
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '应用到当前工作区'; }
    }
  }
  window.applyWorkflow = applyWorkflow;

  /**
   * 将 workflow YAML 结构（members + topology.subagents）转成
   * createTeamFromJSON 期望的 teamData 格式。
   *
   * teamData.members[i] = { name, presetId, role, model, manages: [childName1, ...] }
   */
  function _workflowToTeamData(wf) {
    const membersIn = Array.isArray(wf.members) ? wf.members : [];
    // key → name 的映射（manages 引用的是 key，需要转成 name）
    const keyToName = {};
    for (const m of membersIn) {
      if (m && m.key) keyToName[m.key] = m.name || m.key;
    }
    const subagentsMap = (wf.topology && wf.topology.subagents) || {};

    const membersOut = membersIn.map(m => {
      const out = {
        name: m.name || m.key || '?',
      };
      if (m.preset) out.presetId = m.preset;
      if (m.role) out.role = m.role;
      if (m.model) out.model = m.model;
      if (m.avatar) out.avatar = m.avatar;
      // manages: workflow 的 topology.subagents[parent_key] = [child_key,...]
      const childKeys = subagentsMap[m.key];
      if (Array.isArray(childKeys) && childKeys.length) {
        out.manages = childKeys.map(k => keyToName[k] || k).filter(Boolean);
      }
      // skills（workflow 可选字段）
      if (Array.isArray(m.skills) && m.skills.length) {
        out.skills = m.skills;
      }
      return out;
    });

    return {
      team_name: wf.title || wf.name || '',
      members: membersOut,
    };
  }

  // ── ESC 关闭 + 点击外部关闭 ─────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('workflowOverlay');
    if (overlay && overlay.style.display !== 'none') {
      closeWorkflowPicker();
    }
  });
  document.addEventListener('click', (e) => {
    const overlay = document.getElementById('workflowOverlay');
    if (!overlay || overlay.style.display === 'none') return;
    if (e.target === overlay) closeWorkflowPicker();
  });

  // ── Helpers ────────────────────────────────────────────────────────────
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
})();
