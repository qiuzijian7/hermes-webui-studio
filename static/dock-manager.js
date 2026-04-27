/**
 * dock-manager.js — Unity/UE 风格的可停靠窗口系统
 *
 * 数据结构（树）：
 *   Node = LeafNode | SplitNode
 *   LeafNode  = { type: 'leaf',  id, panels: [panelId,...], activeId }
 *   SplitNode = { type: 'split', id, dir: 'row'|'col', ratio: 0..1, a: Node, b: Node }
 *
 * Panel 由外部注册：{ id, title, contentEl, icon? }
 *   contentEl 是已存在的 DOM 元素；DockManager 只负责 re-parent 它。
 *
 * 持久化 key: localStorage['hermes-dock-layout-v1']
 */
(function () {
  'use strict';

  const LS_KEY = 'hermes-dock-layout-v1';
  const MIN_RATIO = 0.1;
  const MAX_RATIO = 0.9;

  // ── Panel Registry ────────────────────────────────────────────────────────
  const _panels = new Map(); // id -> { id, title, contentEl, icon, _homeParent, _homeNext }

  /** 注册一个面板；contentEl 在注册时会被 DockManager 接管（从原位置 detach）。 */
  function registerPanel(def) {
    if (!def || !def.id || !def.contentEl) {
      console.warn('[dock] registerPanel needs {id, contentEl}', def);
      return;
    }
    // 记住原挂载点，便于 unregister 还原
    const parent = def.contentEl.parentNode;
    const next = def.contentEl.nextSibling;
    _panels.set(def.id, {
      id: def.id,
      title: def.title || def.id,
      icon: def.icon || '',
      contentEl: def.contentEl,
      _homeParent: parent,
      _homeNext: next,
    });
  }

  function getPanel(id) { return _panels.get(id); }

  // ── Tree helpers ──────────────────────────────────────────────────────────
  let _nodeIdSeq = 1;
  function _newNodeId() { return 'n' + (_nodeIdSeq++); }

  function _makeLeaf(panelIds, activeId) {
    return {
      type: 'leaf',
      id: _newNodeId(),
      panels: panelIds.slice(),
      activeId: activeId || panelIds[0],
    };
  }
  function _makeSplit(dir, a, b, ratio) {
    return { type: 'split', id: _newNodeId(), dir, ratio: ratio || 0.5, a, b };
  }

  /** 深度克隆树（保持 id 稳定） */
  function _cloneTree(n) {
    if (!n) return null;
    if (n.type === 'leaf') {
      return { type: 'leaf', id: n.id, panels: n.panels.slice(), activeId: n.activeId };
    }
    return { type: 'split', id: n.id, dir: n.dir, ratio: n.ratio, a: _cloneTree(n.a), b: _cloneTree(n.b) };
  }

  /** 在树中查找含某 panel 的 leaf；返回 {leaf, parent, side} 或 null */
  function _findLeafWithPanel(tree, panelId, parent, side) {
    if (!tree) return null;
    if (tree.type === 'leaf') {
      return tree.panels.includes(panelId) ? { leaf: tree, parent, side } : null;
    }
    return _findLeafWithPanel(tree.a, panelId, tree, 'a')
        || _findLeafWithPanel(tree.b, panelId, tree, 'b');
  }

  /** 在树中查找指定 nodeId；返回 {node, parent, side} 或 null */
  function _findNode(tree, nodeId, parent, side) {
    if (!tree) return null;
    if (tree.id === nodeId) return { node: tree, parent, side };
    if (tree.type === 'split') {
      return _findNode(tree.a, nodeId, tree, 'a')
          || _findNode(tree.b, nodeId, tree, 'b');
    }
    return null;
  }

  /** 从树中移除一个 panel；如果 leaf 变空，折叠该 split（另一侧替代它） */
  function _removePanel(tree, panelId) {
    if (!tree) return null;
    if (tree.type === 'leaf') {
      const idx = tree.panels.indexOf(panelId);
      if (idx < 0) return tree;
      tree.panels.splice(idx, 1);
      if (tree.activeId === panelId) {
        tree.activeId = tree.panels[0] || null;
      }
      return tree.panels.length ? tree : null; // 空 leaf → null
    }
    // split
    tree.a = _removePanel(tree.a, panelId);
    tree.b = _removePanel(tree.b, panelId);
    if (!tree.a && !tree.b) return null;
    if (!tree.a) return tree.b;
    if (!tree.b) return tree.a;
    return tree;
  }

  // ── DockManager ───────────────────────────────────────────────────────────
  class DockManager {
    constructor(rootEl) {
      this.rootEl = rootEl;
      this.tree = null;
      this._dragging = null; // { panelId, ghostEl }
      this._dropIndicator = null;
      this._saveTimer = null;
      this._boundOnMove = this._onDragMove.bind(this);
      this._boundOnUp = this._onDragEnd.bind(this);
    }

    /** 使用默认布局（一个 leaf，包含所有注册的 panel） */
    useDefaultLayout(panelIds) {
      this.tree = _makeSplit('col',
        _makeLeaf([panelIds[0]]),
        _makeLeaf(panelIds.slice(1)),
        0.6
      );
    }

    /** 加载保存的布局；若失败返回 false */
    loadSavedLayout(validPanelIds) {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || !data.tree) return false;
        // 校验：所有用到的 panel id 都已注册；所有已注册的 panel 都出现在树里
        const used = new Set();
        const collect = (n) => {
          if (!n) return;
          if (n.type === 'leaf') n.panels.forEach(p => used.add(p));
          else { collect(n.a); collect(n.b); }
        };
        collect(data.tree);
        for (const p of used) {
          if (!validPanelIds.includes(p)) return false;
        }
        // 补全：已注册但未在树中的 panel，追加到首个 leaf
        const missing = validPanelIds.filter(p => !used.has(p));
        this.tree = data.tree;
        if (missing.length) {
          const leaf = this._firstLeaf(this.tree);
          if (leaf) {
            leaf.panels.push(...missing);
            if (!leaf.activeId) leaf.activeId = missing[0];
          }
        }
        return true;
      } catch (e) {
        console.warn('[dock] loadSavedLayout failed:', e);
        return false;
      }
    }

    _firstLeaf(n) {
      if (!n) return null;
      if (n.type === 'leaf') return n;
      return this._firstLeaf(n.a) || this._firstLeaf(n.b);
    }

    saveLayout() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, tree: this.tree }));
        } catch (e) {}
      }, 200);
    }

    resetLayout() {
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
      const ids = Array.from(_panels.keys());
      this.useDefaultLayout(ids);
      this.render();
    }

    /** 渲染整棵树到 rootEl。保留 panel 的 contentEl（re-parent 而非 recreate）。 */
    render() {
      if (!this.rootEl || !this.tree) return;
      // 备份当前活跃 panel 的交互状态（例如 textarea 焦点）
      const activeEl = document.activeElement;
      const activeSelStart = activeEl && activeEl.selectionStart;
      const activeSelEnd = activeEl && activeEl.selectionEnd;

      // 从所有 panel 的 contentEl 先 detach（保留在内存）
      _panels.forEach(p => {
        if (p.contentEl && p.contentEl.parentNode) {
          p.contentEl.parentNode.removeChild(p.contentEl);
        }
      });

      this.rootEl.innerHTML = '';
      const tree = this.tree || _makeLeaf(Array.from(_panels.keys()));
      this.rootEl.appendChild(this._renderNode(tree));

      // 恢复焦点
      if (activeEl && document.body.contains(activeEl)) {
        try {
          activeEl.focus();
          if (typeof activeSelStart === 'number' && activeEl.setSelectionRange) {
            activeEl.setSelectionRange(activeSelStart, activeSelEnd);
          }
        } catch (e) {}
      }

      // 广播事件让外部做布局后处理
      window.dispatchEvent(new CustomEvent('dock:rendered'));
    }

    _renderNode(node) {
      if (node.type === 'leaf') return this._renderLeaf(node);
      return this._renderSplit(node);
    }

    _renderLeaf(leaf) {
      const el = document.createElement('div');
      el.className = 'dock-leaf';
      el.dataset.nodeId = leaf.id;

      // Tab bar：
      //  - 若只有 1 个 panel：仅当面板自身有 "showSoloTab" 标记时才显示完整 tab，
      //    否则显示一个极简 grip（仅用于拖拽），不占太多高度。
      //  - 若多个 panel：显示完整 tab 栏
      const multi = leaf.panels.length > 1;
      const tabBar = document.createElement('div');
      tabBar.className = multi ? 'dock-tabbar dock-tabbar-multi' : 'dock-tabbar dock-tabbar-solo';
      tabBar.dataset.nodeId = leaf.id;

      leaf.panels.forEach(pid => {
        const p = _panels.get(pid);
        if (!p) return;
        const tab = document.createElement('div');
        tab.className = 'dock-tab';
        if (pid === leaf.activeId) tab.classList.add('active');
        tab.draggable = false; // 我们用原生 mousedown 实现自定义拖拽
        tab.dataset.panelId = pid;
        tab.dataset.nodeId = leaf.id;
        if (p.icon) {
          const ic = document.createElement('span');
          ic.className = 'dock-tab-icon';
          ic.innerHTML = p.icon;
          tab.appendChild(ic);
        }
        const title = document.createElement('span');
        title.className = 'dock-tab-title';
        title.textContent = p.title;
        tab.appendChild(title);

        tab.addEventListener('click', (e) => {
          if (this._dragging) return;
          leaf.activeId = pid;
          this.render();
          this.saveLayout();
        });
        tab.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          this._onDragStart(e, pid);
        });
        tabBar.appendChild(tab);
      });

      // 拖拽 handle（solo 模式下的极简 grip）
      if (!multi && leaf.panels.length === 1) {
        const grip = tabBar.querySelector('.dock-tab');
        if (grip) grip.classList.add('dock-tab-solo');
      }

      el.appendChild(tabBar);

      // Content 区：挂载 active panel 的 contentEl
      const content = document.createElement('div');
      content.className = 'dock-content';
      content.dataset.nodeId = leaf.id;
      const active = _panels.get(leaf.activeId);
      if (active && active.contentEl) {
        active.contentEl.classList.add('dock-panel-content');
        content.appendChild(active.contentEl);
      }
      el.appendChild(content);
      return el;
    }

    _renderSplit(split) {
      const el = document.createElement('div');
      el.className = 'dock-split dock-split-' + split.dir; // row / col
      el.dataset.nodeId = split.id;

      const a = this._renderNode(split.a);
      a.style.flex = `${split.ratio} 1 0`;
      el.appendChild(a);

      const splitter = document.createElement('div');
      splitter.className = 'dock-splitter dock-splitter-' + split.dir;
      splitter.dataset.nodeId = split.id;
      splitter.addEventListener('mousedown', (e) => this._onSplitterDown(e, split));
      el.appendChild(splitter);

      const b = this._renderNode(split.b);
      b.style.flex = `${1 - split.ratio} 1 0`;
      el.appendChild(b);

      return el;
    }

    // ── Splitter 拖拽 ──────────────────────────────────────────────────────
    _onSplitterDown(e, split) {
      e.preventDefault();
      const parent = e.target.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      const isRow = split.dir === 'row';

      const onMove = (ev) => {
        const pos = isRow ? (ev.clientX - rect.left) : (ev.clientY - rect.top);
        const total = isRow ? rect.width : rect.height;
        let ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, pos / total));
        split.ratio = ratio;
        // 直接调整兄弟 flex 值，不 rerender
        const aEl = parent.children[0];
        const bEl = parent.children[2];
        if (aEl) aEl.style.flex = `${ratio} 1 0`;
        if (bEl) bEl.style.flex = `${1 - ratio} 1 0`;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('dock-resizing');
        this.saveLayout();
      };
      document.body.classList.add('dock-resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    // ── Tab 拖拽 ──────────────────────────────────────────────────────────
    _onDragStart(e, panelId) {
      e.preventDefault();
      const p = _panels.get(panelId);
      if (!p) return;
      this._dragging = {
        panelId,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        ghostEl: null,
      };
      document.addEventListener('mousemove', this._boundOnMove);
      document.addEventListener('mouseup', this._boundOnUp);
    }

    _onDragMove(e) {
      if (!this._dragging) return;
      const d = this._dragging;
      if (!d.started) {
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        d.started = true;
        this._createGhost();
      }
      this._moveGhost(e.clientX, e.clientY);
      this._updateDropIndicator(e.clientX, e.clientY);
    }

    _createGhost() {
      const p = _panels.get(this._dragging.panelId);
      if (!p) return;
      const ghost = document.createElement('div');
      ghost.className = 'dock-drag-ghost';
      ghost.textContent = p.title;
      document.body.appendChild(ghost);
      this._dragging.ghostEl = ghost;
      document.body.classList.add('dock-dragging');
    }

    _moveGhost(x, y) {
      if (!this._dragging.ghostEl) return;
      this._dragging.ghostEl.style.left = (x + 12) + 'px';
      this._dragging.ghostEl.style.top = (y + 12) + 'px';
    }

    /** 根据鼠标位置计算落点（target leaf + side: center/top/bottom/left/right） */
    _hitTestDrop(x, y) {
      const leaves = this.rootEl.querySelectorAll('.dock-leaf');
      for (const leafEl of leaves) {
        const rect = leafEl.getBoundingClientRect();
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const nodeId = leafEl.dataset.nodeId;
        // 判定五分区：边缘 25% 宽/高 为 split 区；中心为 tab-merge 区
        const rx = (x - rect.left) / rect.width;
        const ry = (y - rect.top) / rect.height;
        const edge = 0.28;
        let side = 'center';
        // 优先看哪个方向离边缘更近
        const dists = {
          left: rx,
          right: 1 - rx,
          top: ry,
          bottom: 1 - ry,
        };
        const minKey = Object.keys(dists).reduce((a, b) => dists[a] < dists[b] ? a : b);
        if (dists[minKey] < edge) {
          side = minKey;
        }
        return { nodeId, rect, side, leafEl };
      }
      // 也可拖到 tab bar 上 → 合并到该 leaf（center）
      const tabbars = this.rootEl.querySelectorAll('.dock-tabbar');
      for (const tb of tabbars) {
        const rect = tb.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return {
            nodeId: tb.dataset.nodeId,
            rect: tb.parentElement.getBoundingClientRect(),
            side: 'tabs',
            leafEl: tb.parentElement,
          };
        }
      }
      return null;
    }

    _updateDropIndicator(x, y) {
      const hit = this._hitTestDrop(x, y);
      if (!this._dropIndicator) {
        this._dropIndicator = document.createElement('div');
        this._dropIndicator.className = 'dock-drop-indicator';
        document.body.appendChild(this._dropIndicator);
      }
      const ind = this._dropIndicator;
      if (!hit) {
        ind.style.display = 'none';
        return;
      }
      ind.style.display = 'block';
      const r = hit.rect;
      let left = r.left, top = r.top, w = r.width, h = r.height;
      if (hit.side === 'left')   { w = r.width * 0.5; }
      if (hit.side === 'right')  { left = r.left + r.width * 0.5; w = r.width * 0.5; }
      if (hit.side === 'top')    { h = r.height * 0.5; }
      if (hit.side === 'bottom') { top = r.top + r.height * 0.5; h = r.height * 0.5; }
      if (hit.side === 'tabs' || hit.side === 'center') { /* 覆盖整个 leaf */ }
      ind.style.left = left + 'px';
      ind.style.top = top + 'px';
      ind.style.width = w + 'px';
      ind.style.height = h + 'px';
      ind.dataset.side = hit.side;
    }

    _onDragEnd(e) {
      document.removeEventListener('mousemove', this._boundOnMove);
      document.removeEventListener('mouseup', this._boundOnUp);
      const d = this._dragging;
      this._dragging = null;
      document.body.classList.remove('dock-dragging');
      if (d && d.ghostEl) d.ghostEl.remove();
      if (this._dropIndicator) { this._dropIndicator.remove(); this._dropIndicator = null; }
      if (!d || !d.started) return;

      const hit = this._hitTestDrop(e.clientX, e.clientY);
      if (!hit) return;
      this._applyDrop(d.panelId, hit.nodeId, hit.side);
    }

    /** 核心：把 panelId 从原位置移除，插入到目标 leaf 的指定 side */
    _applyDrop(panelId, targetNodeId, side) {
      const targetInfo = _findNode(this.tree, targetNodeId);
      if (!targetInfo || targetInfo.node.type !== 'leaf') return;
      const targetLeaf = targetInfo.node;

      // 若源和目标是同一 leaf 且 side=tabs/center：无变化
      const srcInfo = _findLeafWithPanel(this.tree, panelId);
      if (!srcInfo) return;
      if (srcInfo.leaf === targetLeaf && (side === 'tabs' || side === 'center') && targetLeaf.panels.length === 1) {
        return;
      }

      // 1) 先从源中移除 panelId（仅修改 panels 数组，不删 leaf）
      const srcLeaf = srcInfo.leaf;
      const idx = srcLeaf.panels.indexOf(panelId);
      if (idx >= 0) srcLeaf.panels.splice(idx, 1);
      if (srcLeaf.activeId === panelId) {
        srcLeaf.activeId = srcLeaf.panels[0] || null;
      }

      // 2) 插入到目标
      if (side === 'tabs' || side === 'center') {
        // 合并到目标 leaf 的 tab
        if (!targetLeaf.panels.includes(panelId)) {
          targetLeaf.panels.push(panelId);
        }
        targetLeaf.activeId = panelId;
      } else {
        // 分割：把目标 leaf 替换为一个 split 节点
        const newLeaf = _makeLeaf([panelId], panelId);
        let dir, aFirst;
        if (side === 'left')   { dir = 'row'; aFirst = true;  } // new 在左，target 在右
        if (side === 'right')  { dir = 'row'; aFirst = false; }
        if (side === 'top')    { dir = 'col'; aFirst = true;  }
        if (side === 'bottom') { dir = 'col'; aFirst = false; }
        const split = aFirst
          ? _makeSplit(dir, newLeaf, _cloneTreeNodeOnly(targetLeaf), 0.5)
          : _makeSplit(dir, _cloneTreeNodeOnly(targetLeaf), newLeaf, 0.5);
        // 把 targetLeaf 替换为 split
        if (!targetInfo.parent) {
          this.tree = split;
        } else {
          targetInfo.parent[targetInfo.side] = split;
        }
      }

      // 3) 清理空 leaf（srcLeaf 可能变空）
      this.tree = _collapseEmpty(this.tree);

      // 4) 重新渲染 + 保存
      this.render();
      this.saveLayout();
    }
  }

  /** 克隆一个 leaf 节点（新 id 以便成为 split 的子节点不和自身冲突） */
  function _cloneTreeNodeOnly(leaf) {
    return {
      type: 'leaf',
      id: _newNodeId(),
      panels: leaf.panels.slice(),
      activeId: leaf.activeId,
    };
  }

  /** 后序折叠空 leaf：若 leaf.panels 为空，用 sibling 替代父 split */
  function _collapseEmpty(n) {
    if (!n) return null;
    if (n.type === 'leaf') {
      return n.panels.length ? n : null;
    }
    n.a = _collapseEmpty(n.a);
    n.b = _collapseEmpty(n.b);
    if (!n.a && !n.b) return null;
    if (!n.a) return n.b;
    if (!n.b) return n.a;
    return n;
  }

  // ── 全局导出 ──────────────────────────────────────────────────────────────
  window.DockManager = DockManager;
  window.dockRegisterPanel = registerPanel;
  window.dockGetPanel = getPanel;
})();
