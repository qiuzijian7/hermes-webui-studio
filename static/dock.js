/**
 * dock.js — 类 Unity/UE 的停靠窗口系统（极简版）
 *
 * 概念：
 *   - DockPanel：注册项 {id, title, icon?, element} — element 是预先存在的 DOM（由外部保留引用，dock 只搬动）
 *   - DockNode（树节点）：
 *       leaf:  { kind:'leaf',  id, panels:[panelId,...], activeId }
 *       split: { kind:'split', id, dir:'row'|'col', ratio:0..1, a:DockNode, b:DockNode }
 *   - 根容器由 DockManager.mount(rootEl) 接管；panel element 按需 reparent 到对应 leaf 的 body。
 *
 * 交互：
 *   - 拖 tab：在所有 leaf 上显示 5 区（中/上/下/左/右）drop zone；松手后：
 *       center  → 并入目标 leaf 的 panels
 *       T/B/L/R → 把目标 leaf 换成 split(dir,ratio=0.5)，新 leaf 在前/后
 *   - 单 panel 的 leaf：隐藏 tab 栏；多 panel：显示 tab 栏
 *   - split 之间的分隔条可拖动改变 ratio，双击重置 0.5
 *
 * 持久化：layoutKey（默认 'hermes-dock-layout-v1'）序列化树根到 localStorage。
 */

(function () {
  'use strict';

  const Dock = {
    _panels: new Map(),      // id -> {id, title, icon, element}
    _root: null,             // 当前树根
    _mountEl: null,          // 挂载点 DOM
    _layoutKey: 'hermes-dock-layout-v1',
    _uid: 0,
    _dragState: null,
    _floatingWindows: new Map(),  // id -> DOM (暂未实现浮动窗口)
  };

  function _nextId() { return 'dn_' + (++Dock._uid); }

  function _escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
    ));
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** 注册一个 dock panel。element 必须是已存在的 DOM（不会被重建）。 */
  Dock.registerPanel = function (spec) {
    if (!spec || !spec.id || !spec.element) return;
    Dock._panels.set(spec.id, {
      id: spec.id,
      title: spec.title || spec.id,
      icon: spec.icon || '',
      element: spec.element,
    });
    spec.element.classList.add('dock-panel-body');
  };

  /** 挂载 dock 系统到 rootEl。initialLayout 为默认树（注册完成后调用）。 */
  Dock.mount = function (rootEl, initialLayout) {
    Dock._mountEl = rootEl;
    rootEl.classList.add('dock-root');

    // 尝试从 localStorage 恢复
    const saved = _loadLayout();
    Dock._root = saved || initialLayout || _defaultLayout();
    _renderAll();
  };

  /** 返回当前序列化布局 */
  Dock.getLayout = function () { return _cloneTree(Dock._root); };

  /** 重置为默认布局 */
  Dock.resetLayout = function () {
    Dock._root = _defaultLayout();
    _saveLayout();
    _renderAll();
  };

  /** 激活某个 panel：找到它所在的 leaf 并设为 active tab */
  Dock.focusPanel = function (panelId) {
    const loc = _findPanel(Dock._root, panelId);
    if (!loc) return;
    loc.leaf.activeId = panelId;
    _renderAll();
  };

  // ── 默认布局：垂直分割，上画布下聊天 ──
  function _defaultLayout() {
    return {
      kind: 'split', id: _nextId(), dir: 'col', ratio: 0.6,
      a: { kind: 'leaf', id: _nextId(), panels: ['canvas'], activeId: 'canvas' },
      b: { kind: 'leaf', id: _nextId(), panels: ['chat'],   activeId: 'chat'   },
    };
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────
  function _saveLayout() {
    try {
      localStorage.setItem(Dock._layoutKey, JSON.stringify(Dock._root));
    } catch (e) {}
  }
  function _loadLayout() {
    try {
      const raw = localStorage.getItem(Dock._layoutKey);
      if (!raw) return null;
      const tree = JSON.parse(raw);
      // 清洗：只保留已注册 panel id
      const cleaned = _pruneTree(tree);
      return cleaned;
    } catch (e) { return null; }
  }

  /** 删除树中未注册的 panel，折叠空 leaf */
  function _pruneTree(node) {
    if (!node) return null;
    if (node.kind === 'leaf') {
      const panels = (node.panels || []).filter(id => Dock._panels.has(id));
      if (!panels.length) return null;
      let activeId = node.activeId;
      if (!panels.includes(activeId)) activeId = panels[0];
      return { kind: 'leaf', id: node.id || _nextId(), panels, activeId };
    }
    if (node.kind === 'split') {
      const a = _pruneTree(node.a);
      const b = _pruneTree(node.b);
      if (a && b) {
        return { kind: 'split', id: node.id || _nextId(),
                 dir: node.dir === 'row' ? 'row' : 'col',
                 ratio: Math.max(0.1, Math.min(0.9, node.ratio || 0.5)),
                 a, b };
      }
      return a || b;
    }
    return null;
  }

  function _cloneTree(node) {
    if (!node) return null;
    if (node.kind === 'leaf') {
      return { kind: 'leaf', id: node.id, panels: node.panels.slice(), activeId: node.activeId };
    }
    return { kind: 'split', id: node.id, dir: node.dir, ratio: node.ratio,
             a: _cloneTree(node.a), b: _cloneTree(node.b) };
  }

  // ── 查询 ──────────────────────────────────────────────────────────────────
  /** 返回 { leaf, parent, isA } — parent 可能为 null（根leaf） */
  function _findPanel(node, panelId, parent, isA) {
    if (!node) return null;
    if (node.kind === 'leaf') {
      return node.panels.includes(panelId) ? { leaf: node, parent, isA } : null;
    }
    return _findPanel(node.a, panelId, node, true) || _findPanel(node.b, panelId, node, false);
  }

  /** 返回 leafId -> {leaf, parent, isA} */
  function _collectLeaves(node, parent, isA, out) {
    if (!node) return;
    if (node.kind === 'leaf') { out.set(node.id, { leaf: node, parent, isA }); return; }
    _collectLeaves(node.a, node, true, out);
    _collectLeaves(node.b, node, false, out);
  }

  // ── 树操作 ────────────────────────────────────────────────────────────────
  /** 从树中移除 panel；若 leaf 空则折叠 split */
  function _removePanel(panelId) {
    const loc = _findPanel(Dock._root, panelId);
    if (!loc) return;
    const { leaf, parent, isA } = loc;
    leaf.panels = leaf.panels.filter(id => id !== panelId);
    if (leaf.activeId === panelId) leaf.activeId = leaf.panels[0] || null;
    if (leaf.panels.length > 0) return;
    // leaf 空 → 折叠
    if (!parent) {
      // 根空 → 重建默认
      Dock._root = _defaultLayout();
      return;
    }
    const sibling = isA ? parent.b : parent.a;
    _replaceNode(parent, sibling);
  }

  /** 用 newNode 取代 target（通过引用在根往下找） */
  function _replaceNode(target, newNode) {
    if (Dock._root === target) { Dock._root = newNode; return; }
    function recur(n) {
      if (!n || n.kind !== 'split') return false;
      if (n.a === target) { n.a = newNode; return true; }
      if (n.b === target) { n.b = newNode; return true; }
      return recur(n.a) || recur(n.b);
    }
    recur(Dock._root);
  }

  /** 把 panel dock 到目标 leaf：position ∈ 'center'|'top'|'bottom'|'left'|'right' */
  function _dockPanel(panelId, targetLeafId, position) {
    if (position === 'center') {
      // 同一 leaf 不变
      const cur = _findPanel(Dock._root, panelId);
      if (cur && cur.leaf.id === targetLeafId) {
        cur.leaf.activeId = panelId;
        return;
      }
    }
    _removePanel(panelId);
    // 根可能变了，重新找目标 leaf
    const leaves = new Map();
    _collectLeaves(Dock._root, null, null, leaves);
    let targetLoc = leaves.get(targetLeafId);
    if (!targetLoc) {
      // 目标 leaf 在删除时被折叠了；退化为挂根
      if (Dock._root && Dock._root.kind === 'leaf') {
        targetLoc = { leaf: Dock._root, parent: null, isA: null };
      } else {
        // 找第一个 leaf
        const iter = leaves.values().next();
        if (iter.done) {
          Dock._root = { kind:'leaf', id:_nextId(), panels:[panelId], activeId:panelId };
          return;
        }
        targetLoc = iter.value;
      }
    }
    const { leaf, parent, isA } = targetLoc;
    if (position === 'center') {
      if (!leaf.panels.includes(panelId)) leaf.panels.push(panelId);
      leaf.activeId = panelId;
      return;
    }
    // 生成新 split
    const newLeaf = { kind:'leaf', id:_nextId(), panels:[panelId], activeId:panelId };
    const dir = (position === 'left' || position === 'right') ? 'row' : 'col';
    const before = (position === 'left' || position === 'top');
    const split = {
      kind: 'split', id: _nextId(), dir, ratio: 0.5,
      a: before ? newLeaf : leaf,
      b: before ? leaf : newLeaf,
    };
    if (!parent) Dock._root = split;
    else if (isA) parent.a = split;
    else parent.b = split;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  function _renderAll() {
    if (!Dock._mountEl) return;
    // 先把所有 panel 元素从当前父移走（保留引用，不销毁）
    Dock._panels.forEach(p => {
      if (p.element.parentElement) p.element.parentElement.removeChild(p.element);
    });
    // 清空挂载点
    while (Dock._mountEl.firstChild) Dock._mountEl.removeChild(Dock._mountEl.firstChild);
    // 递归渲染
    const rootDom = _renderNode(Dock._root);
    if (rootDom) Dock._mountEl.appendChild(rootDom);
    _saveLayout();
    // 触发事件：外部可监听布局变化
    try { window.dispatchEvent(new CustomEvent('dock:layout-change', { detail: Dock._root })); } catch(e) {}
  }

  function _renderNode(node) {
    if (!node) return null;
    if (node.kind === 'leaf') return _renderLeaf(node);
    return _renderSplit(node);
  }

  function _renderSplit(node) {
    const el = document.createElement('div');
    el.className = 'dock-split dock-split-' + node.dir;   // row=左右, col=上下
    el.dataset.nodeId = node.id;

    const aWrap = document.createElement('div');
    aWrap.className = 'dock-split-pane';
    const aDom = _renderNode(node.a);
    if (aDom) aWrap.appendChild(aDom);

    const bWrap = document.createElement('div');
    bWrap.className = 'dock-split-pane';
    const bDom = _renderNode(node.b);
    if (bDom) bWrap.appendChild(bDom);

    // 用 flex-basis 百分比表达 ratio
    const ratioPct = (node.ratio * 100).toFixed(2) + '%';
    aWrap.style.flex = `0 0 calc(${ratioPct} - 3px)`;
    bWrap.style.flex = '1 1 0';

    const handle = document.createElement('div');
    handle.className = 'dock-split-handle';
    _bindSplitDrag(handle, node, el, aWrap);

    el.appendChild(aWrap);
    el.appendChild(handle);
    el.appendChild(bWrap);
    return el;
  }

  function _bindSplitDrag(handle, node, containerEl, aPaneEl) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = containerEl.getBoundingClientRect();
      const vertical = node.dir === 'col';  // col = 上下分, 分隔条水平
      const total = vertical ? rect.height : rect.width;
      const startPos = vertical ? e.clientY : e.clientX;
      const startOffset = vertical
        ? aPaneEl.getBoundingClientRect().height
        : aPaneEl.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('dock-resizing');

      const onMove = (ev) => {
        const cur = vertical ? ev.clientY : ev.clientX;
        const delta = cur - startPos;
        let newA = startOffset + delta;
        // 约束：前后至少 80px
        newA = Math.max(80, Math.min(total - 80, newA));
        const ratio = newA / total;
        node.ratio = ratio;
        aPaneEl.style.flex = `0 0 calc(${(ratio*100).toFixed(2)}% - 3px)`;
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('dock-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        _saveLayout();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      node.ratio = 0.5;
      aPaneEl.style.flex = `0 0 calc(50% - 3px)`;
      _saveLayout();
    });
  }

  function _renderLeaf(node) {
    const el = document.createElement('div');
    el.className = 'dock-leaf';
    el.dataset.leafId = node.id;

    // tab 栏（仅多 panel 时显示；单 panel 也显示一个 handle 便于拖拽）
    const tabbar = document.createElement('div');
    tabbar.className = 'dock-tabbar';
    if (node.panels.length <= 1) tabbar.classList.add('dock-tabbar-single');

    node.panels.forEach(pid => {
      const spec = Dock._panels.get(pid);
      if (!spec) return;
      const tab = document.createElement('div');
      tab.className = 'dock-tab';
      tab.dataset.panelId = pid;
      tab.dataset.leafId = node.id;
      tab.draggable = true;
      if (pid === node.activeId) tab.classList.add('active');
      tab.innerHTML = (spec.icon ? `<span class="dock-tab-icon">${spec.icon}</span>` : '')
        + `<span class="dock-tab-title">${_escapeHtml(spec.title)}</span>`;
      tab.addEventListener('click', () => {
        if (node.activeId !== pid) {
          node.activeId = pid;
          _renderAll();
        }
      });
      _bindTabDrag(tab, pid);
      tabbar.appendChild(tab);
    });

    // body：挂 active panel element
    const body = document.createElement('div');
    body.className = 'dock-leaf-body';
    body.dataset.leafId = node.id;
    if (node.activeId) {
      const active = Dock._panels.get(node.activeId);
      if (active && active.element) {
        body.appendChild(active.element);
        active.element.style.display = '';
        // 隐藏不活跃 panel（但保留 DOM 引用，只是不挂载）
      }
    }

    el.appendChild(tabbar);
    el.appendChild(body);
    return el;
  }

  // ── 拖拽交互 ──────────────────────────────────────────────────────────────
  function _bindTabDrag(tabEl, panelId) {
    tabEl.addEventListener('dragstart', (e) => {
      Dock._dragState = { panelId, startLeafId: tabEl.dataset.leafId };
      try { e.dataTransfer.setData('text/plain', 'dock-panel:' + panelId); } catch (_) {}
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dock-dragging');
      _showAllDropZones();
    });
    tabEl.addEventListener('dragend', () => {
      Dock._dragState = null;
      document.body.classList.remove('dock-dragging');
      _hideAllDropZones();
    });
  }

  function _showAllDropZones() {
    if (!Dock._mountEl) return;
    Dock._mountEl.querySelectorAll('.dock-leaf').forEach(leafEl => {
      let overlay = leafEl.querySelector('.dock-dropzone-overlay');
      if (overlay) return;
      overlay = document.createElement('div');
      overlay.className = 'dock-dropzone-overlay';
      // 5 区
      ['center','top','bottom','left','right'].forEach(pos => {
        const z = document.createElement('div');
        z.className = 'dock-dropzone dock-dz-' + pos;
        z.dataset.position = pos;
        z.dataset.targetLeaf = leafEl.dataset.leafId;
        z.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          z.classList.add('dock-dz-hover');
          _showPreview(leafEl, pos);
        });
        z.addEventListener('dragleave', () => {
          z.classList.remove('dock-dz-hover');
          _hidePreview();
        });
        z.addEventListener('drop', (e) => {
          e.preventDefault();
          z.classList.remove('dock-dz-hover');
          _hidePreview();
          if (!Dock._dragState) return;
          const { panelId } = Dock._dragState;
          _dockPanel(panelId, leafEl.dataset.leafId, pos);
          _renderAll();
        });
        overlay.appendChild(z);
      });
      leafEl.appendChild(overlay);
    });
  }

  function _hideAllDropZones() {
    if (!Dock._mountEl) return;
    Dock._mountEl.querySelectorAll('.dock-dropzone-overlay').forEach(o => o.remove());
    _hidePreview();
  }

  function _showPreview(leafEl, pos) {
    let p = leafEl.querySelector('.dock-drop-preview');
    if (!p) {
      p = document.createElement('div');
      p.className = 'dock-drop-preview';
      leafEl.appendChild(p);
    }
    p.dataset.position = pos;
  }
  function _hidePreview() {
    if (!Dock._mountEl) return;
    Dock._mountEl.querySelectorAll('.dock-drop-preview').forEach(p => p.remove());
  }

  // 暴露
  window.Dock = Dock;
})();
