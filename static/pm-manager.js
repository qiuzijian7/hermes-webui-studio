/**
 * pm-manager.js — PM 专员管理
 *
 * 功能：
 *   1. 工作区创建时自动创建默认 PM 专员（pm-specialist 预设）
 *   2. 切换工作区时若无 PM 自动补建
 *   3. 提供"替换 PM"菜单（下拉选择其他预设）
 *   4. 动态更新顶部栏 PM 按钮的显示名
 *
 * 约定：
 *   - 同一工作区最多只有一个 isPM:true 的员工
 *   - 若 EMPLOYEE_STORE 中存在 presetId='pm-specialist' 但无 isPM 标记，
 *     迁移时自动标记（兼容旧数据）
 */

(function () {
  'use strict';

  const DEFAULT_PM_PRESET_ID = 'pm-specialist';

  // ── 查询 ──────────────────────────────────────────────────────────────
  function getPMEmployee() {
    if (typeof EMPLOYEE_STORE === 'undefined') return null;
    return EMPLOYEE_STORE.employees.find(e => e && e.isPM) || null;
  }

  function getCurrentPMName() {
    const pm = getPMEmployee();
    if (pm && pm.name) return pm.name;
    return (typeof PM_NAME !== 'undefined') ? PM_NAME : 'PM专员';
  }

  // ── 迁移：兼容旧数据（有 pm-specialist 预设但没 isPM 标记） ──────────
  function _migrateLegacyPM() {
    if (typeof EMPLOYEE_STORE === 'undefined') return false;
    const emps = EMPLOYEE_STORE.employees || [];
    // 1. 已经有 isPM 的 → 不动
    if (emps.some(e => e && e.isPM)) return false;
    // 2. 找 preset=pm-specialist 的 → 标记
    const legacy = emps.find(e => e && e.presetId === DEFAULT_PM_PRESET_ID);
    if (legacy) {
      legacy.isPM = true;
      if (typeof _saveEmployees === 'function') _saveEmployees();
      return true;
    }
    return false;
  }

  // ── 自动创建 PM（工作区初始化 / 缺失时调用） ──────────────────────────
  function ensurePMExists() {
    if (typeof EMPLOYEE_STORE === 'undefined') return null;
    if (typeof AGENT_PRESETS === 'undefined') return null;
    if (typeof createEmployee !== 'function') return null;

    _migrateLegacyPM();

    const existing = getPMEmployee();
    if (existing) {
      // ★ PM专员已存在：如果当前无自动协作激活员工，默认为 PM 开启
      if (typeof getActiveAutoCollabEmpId === 'function' && !getActiveAutoCollabEmpId()) {
        if (typeof setActiveAutoCollabEmpId === 'function') {
          setActiveAutoCollabEmpId(existing.id);
          console.log('[pm-manager] 已为已有 PM 专员默认开启自动协作+心跳');
        }
      }
      return existing;
    }

    // 找预设
    const preset = AGENT_PRESETS.find(p => p.id === DEFAULT_PM_PRESET_ID);
    if (!preset) {
      console.warn('[pm-manager] 默认预设 pm-specialist 未找到，跳过自动创建');
      return null;
    }

    const emp = _createFromPreset(preset, { isPM: true });
    if (emp) {
      console.log('[pm-manager] 自动创建 PM 专员:', emp.name);
      if (typeof showToast === 'function') {
        showToast(`已自动创建 ${emp.name}`);
      }
      updatePMButtonLabel();
      // ★ PM专员默认开启自动协作+心跳
      if (typeof setActiveAutoCollabEmpId === 'function') {
        setActiveAutoCollabEmpId(emp.id);
        console.log('[pm-manager] 已为 PM 专员默认开启自动协作+心跳');
      }
    }
    return emp;
  }

  // ── 替换 PM：删除旧 PM，用新预设创建新 PM（保留 isPM 标记） ────────
  async function replacePMWithPreset(presetId) {
    if (!presetId) return null;
    const preset = (typeof AGENT_PRESETS !== 'undefined')
      ? AGENT_PRESETS.find(p => p.id === presetId)
      : null;
    if (!preset) {
      if (typeof showToast === 'function') showToast('预设不存在');
      return null;
    }

    const old = getPMEmployee();
    if (old && old.presetId === presetId) {
      if (typeof showToast === 'function') showToast('当前 PM 已是该预设');
      return old;
    }

    // 确认
    const msg = old
      ? `将把当前 PM「${old.name}」替换为「${preset.name}」。\n\n旧 PM 会被删除（聊天历史不可恢复）。\n\n确认继续？`
      : `将创建 PM「${preset.name}」。确认？`;
    const ok = (typeof showConfirmDialog === 'function')
      ? await showConfirmDialog({
          title: 'PM 专员替换',
          message: msg,
          confirmLabel: '替换',
          danger: true,
        })
      : confirm(msg);
    if (!ok) return null;

    // 删除旧 PM
    if (old && typeof deleteEmployee === 'function') {
      try { deleteEmployee(old.id); } catch (e) {
        console.warn('[pm-manager] 删除旧 PM 失败:', e);
      }
    }

    // 创建新 PM
    const emp = _createFromPreset(preset, { isPM: true });
    if (emp) {
      updatePMButtonLabel();
      if (typeof showToast === 'function') showToast(`PM 已更新为 ${emp.name}`);
      // ★ 新 PM 默认开启自动协作+心跳
      if (typeof setActiveAutoCollabEmpId === 'function') {
        setActiveAutoCollabEmpId(emp.id);
      }
      // 选中新 PM
      if (typeof selectEmployee === 'function') {
        setTimeout(() => selectEmployee(emp.id), 150);
      }
    }
    return emp;
  }

  // ── 内部：从预设创建员工 ──────────────────────────────────────────
  function _createFromPreset(preset, extraOpts) {
    const opts = {
      name: preset.name,
      role: preset.role || '通用助手',
      presetId: preset.id,
      characterImg: preset.characterImg,
      model: preset.model || '',
      skills: preset.skills || [],
    };
    if (preset.configHtml) opts.configHtml = preset.configHtml;
    if (preset.customPrompt) opts.customPrompt = preset.customPrompt;
    if (preset.params && Object.keys(preset.params).length) opts.params = preset.params;
    Object.assign(opts, extraOpts || {});
    return createEmployee(opts);
  }

  // ── UI：下拉菜单 ──────────────────────────────────────────────────
  function openPMManageMenu(evt) {
    if (evt && evt.stopPropagation) evt.stopPropagation();

    // 关掉已有菜单
    const old = document.getElementById('pmManageMenu');
    if (old) { old.remove(); return; }

    const anchor = document.getElementById('pmGroupChatWrap')
                || document.getElementById('pmManageBtn')
                || document.getElementById('pmGroupChatBtn');
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'pmManageMenu';
    menu.className = 'pm-manage-menu';
    Object.assign(menu.style, {
      position: 'fixed',
      top: (rect.bottom + 4) + 'px',
      left: Math.max(8, rect.right - 260) + 'px',
      width: '260px',
      maxHeight: '380px',
      overflow: 'auto',
      background: 'var(--surface, #1a1a1a)',
      border: '1px solid var(--border2, #333)',
      borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,.4)',
      zIndex: 10000,
      padding: '6px',
      fontSize: '12px',
    });

    const pm = getPMEmployee();
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 10px;font-weight:600;color:var(--text);border-bottom:1px solid var(--border);margin-bottom:4px';
    header.textContent = pm ? `当前 PM：${pm.name}` : '未设置 PM 专员';
    menu.appendChild(header);

    // 子菜单：打开群聊
    const openBtn = _mkMenuItem('💬 打开 PM 群聊', () => {
      menu.remove();
      if (typeof openGroupChat === 'function') openGroupChat();
    });
    menu.appendChild(openBtn);

    // 分隔
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--border);margin:4px 0';
    menu.appendChild(sep);

    // 替换候选项：所有 leads/directors 类目的预设
    const candidateLabel = document.createElement('div');
    candidateLabel.style.cssText = 'padding:4px 10px;color:var(--muted);font-size:11px';
    candidateLabel.textContent = '替换为：';
    menu.appendChild(candidateLabel);

    const candidates = _getPMCandidates();
    if (candidates.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:8px 10px;color:var(--muted);font-size:11px;font-style:italic';
      empty.textContent = '（无可用预设，请先加载 AGENT_PRESETS）';
      menu.appendChild(empty);
    } else {
      candidates.forEach(p => {
        const isCurrent = pm && pm.presetId === p.id;
        const it = _mkMenuItem(
          `${isCurrent ? '✓ ' : '   '}${p.name} · ${p.role || ''}`,
          () => {
            menu.remove();
            if (isCurrent) {
              if (typeof showToast === 'function') showToast('已是当前 PM');
              return;
            }
            replacePMWithPreset(p.id);
          }
        );
        if (isCurrent) {
          it.style.color = 'var(--blue)';
          it.style.fontWeight = '600';
        }
        menu.appendChild(it);
      });
    }

    document.body.appendChild(menu);

    // 点击外部关闭
    const outside = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', outside);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', outside), 10);
  }

  function _mkMenuItem(text, onClick) {
    const el = document.createElement('div');
    el.className = 'pm-manage-menu-item';
    el.textContent = text;
    el.style.cssText = 'padding:6px 10px;border-radius:4px;cursor:pointer;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--hover-bg, rgba(255,255,255,.06))'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
    el.addEventListener('click', onClick);
    return el;
  }

  function _getPMCandidates() {
    if (typeof AGENT_PRESETS === 'undefined') return [];
    // 优先：pm-specialist + 所有 leads/directors 类目的预设
    const wanted = (p) => (
      p.id === DEFAULT_PM_PRESET_ID
      || p.category === 'leads'
      || p.category === 'directors'
    );
    const picked = AGENT_PRESETS.filter(wanted);
    // 让 pm-specialist 排第一
    picked.sort((a, b) => {
      if (a.id === DEFAULT_PM_PRESET_ID) return -1;
      if (b.id === DEFAULT_PM_PRESET_ID) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    return picked;
  }

  // ── 更新顶部栏 PM 按钮的显示名 ──────────────────────────────────────
  function updatePMButtonLabel() {
    const labelEl = document.getElementById('pmGroupChatLabel');
    const name = getCurrentPMName();
    if (labelEl) labelEl.textContent = name;
    const btn = document.getElementById('pmGroupChatBtn');
    if (btn) btn.title = `打开 ${name} 群聊`;
  }

  // ── 工作区切换时自动确保 PM 存在 ──────────────────────────────────
  function _hookWorkspaceSwitch() {
    if (typeof window === 'undefined') return;
    const orig = window.switchCanvasWorkspace;
    if (typeof orig !== 'function' || orig._pmHooked) return;
    window.switchCanvasWorkspace = function () {
      const ret = orig.apply(this, arguments);
      // 切换后稍等 EMPLOYEE_STORE 加载完再检查
      setTimeout(() => {
        try { ensurePMExists(); updatePMButtonLabel(); } catch (e) {
          console.warn('[pm-manager] switchCanvasWorkspace hook err:', e);
        }
      }, 200);
      return ret;
    };
    window.switchCanvasWorkspace._pmHooked = true;
  }

  // ── 启动：等 AGENT_PRESETS 加载完后确保 PM ──────────────────────
  function _bootstrap() {
    _hookWorkspaceSwitch();

    const tryEnsure = (retries) => {
      if (typeof AGENT_PRESETS !== 'undefined' && AGENT_PRESETS.length > 0) {
        try { ensurePMExists(); } catch (e) {
          console.warn('[pm-manager] ensurePMExists err:', e);
        }
        updatePMButtonLabel();
      } else if (retries > 0) {
        setTimeout(() => tryEnsure(retries - 1), 300);
      } else {
        // 预设仍未加载也要把 label 更新一下
        updatePMButtonLabel();
      }
    };
    // 首次进入页面：等预设加载完
    setTimeout(() => tryEnsure(20), 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap);
  } else {
    _bootstrap();
  }

  // ── 导出 ────────────────────────────────────────────────────────────
  window.openPMManageMenu = openPMManageMenu;
  window.ensurePMExists = ensurePMExists;
  window.replacePMWithPreset = replacePMWithPreset;
  window.getCurrentPMName = getCurrentPMName;
  window.getPMEmployee = getPMEmployee;
  window.updatePMButtonLabel = updatePMButtonLabel;
})();
