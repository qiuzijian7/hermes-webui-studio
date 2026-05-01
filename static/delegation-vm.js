// ─────────────────────────────────────────────────────────────────────────────
// 委派任务 ViewModel（DelegationVM）— 方案 B：每员工独立任务队列
//
// 每一次"总群 @员工"委派或"在员工聊天框手动发消息"都会创建一个独立的 Task
// 对象 + 一个调度 Job。若该员工当前空闲 → 立即启动；若已有任务在跑 → 进入
// 该员工的 FIFO 队列，等上一个任务结束后自动启动。
//
// 数据结构：
//   tasks: Map<taskId, Task>           — 任务元数据（持有 sessionId、SSE 等）
//   queues: Map<empId, Job[]>          — 每员工等待队列（不含正在执行的）
//   running: Map<empId, Job>           — 每员工当前正在执行的 Job（至多一个）
//
// Job = {
//   id: string,                         // 与 Task.id 相同
//   empId, kind: 'delegated'|'manual', // 类型
//   label: string,                      // 短描述（用于 UI）
//   startFn: () => Promise<void>,       // 被调用时真正发起执行（创建 session、chat/start、watchStream）
//   cancelFn: () => Promise<void>,      // 取消：关 SSE、调 /api/chat/cancel
//   task: Task | null,                  // 关联的 Task 对象
// }
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  /**
   * Task 工厂
   * @returns {Task}
   */
  function _createTask(opts) {
    return {
      id: opts.taskId,                    // 任务 ID（委派唯一标识）
      empId: opts.empId,
      empName: opts.empName || '',
      sessionId: opts.sessionId || null,  // 任务自己的员工 session
      streamId: null,                     // /api/chat/start 返回后填入
      sseSource: null,                    // 活跃 EventSource（可选）
      pollTimer: null,                    // 活跃轮询定时器（可选）
      accumulatedText: '',                // SSE 累积的 token 文本
      taskContent: opts.taskContent || '',// 完整任务内容
      workspace: opts.workspace || '',
      requesterName: opts.requesterName || '你',
      status: 'pending',                  // pending | running | done | error | cancelled
      delegatedTo: null,                  // 如果内部再次 delegate_task
      posted: false,                      // 是否已回传到总群
      createdAt: Date.now(),
    };
  }

  // ── 任务持久化（localStorage）─────────────────────────────────────────────
  // 仅持久化 taskId → {sessionId, empId, empName, status, workspace} 映射，
  // 运行时数据（streamId, sseSource, pollTimer, accumulatedText 等）不持久化。
  const _TASK_PERSIST_KEY = 'hermes-delegation-tasks';

  /** 将单个 task 的可序列化字段写入持久化映射 */
  function _persistTask(task) {
    if (!task || !task.id) return;
    try {
      const map = _loadPersistedMap();
      map[task.id] = {
        sessionId: task.sessionId || null,
        empId: task.empId || '',
        empName: task.empName || '',
        status: task.status || 'pending',
        workspace: task.workspace || '',
        // ★ 2026-04-27：新增字段供刷新后 UI 路径 3 恢复使用
        //   - createdAt：用于挑选"最新"的运行中任务
        //   - taskContent：openEmployeeChat 刷新后需要它来补渲"委派消息 + 任务分隔"
        //   - requesterName：结果回传总群时沿用原请求者标识
        createdAt: task.createdAt || Date.now(),
        taskContent: task.taskContent || '',
        requesterName: task.requesterName || '你',
      };
      localStorage.setItem(_TASK_PERSIST_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  /** 从 localStorage 读取持久化映射（返回普通对象） */
  function _loadPersistedMap() {
    try {
      const raw = localStorage.getItem(_TASK_PERSIST_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  const DelegationVM = {
    /** taskId -> Task */
    tasks: new Map(),
    /** empId -> Job[]（等待中的任务，不含正在执行的） */
    queues: new Map(),
    /** empId -> Job（正在执行的任务） */
    running: new Map(),
    /** 去重守卫：已经成功 post 过的 key */
    _postedKeys: new Set(),

    // ── 队列管理 ─────────────────────────────────────────────────────────
    /** 返回该员工等待队列长度（不含正在执行的） */
    getQueueLength(empId) {
      if (!empId) return 0;
      const q = this.queues.get(empId);
      return q ? q.length : 0;
    },
    /** 返回该员工当前正在执行的 Job，或 null */
    getRunningJob(empId) {
      if (!empId) return null;
      return this.running.get(empId) || null;
    },
    /** 返回所有与该员工相关的 Job（running + 队列），按执行顺序 */
    getAllJobsFor(empId) {
      const out = [];
      const r = this.running.get(empId);
      if (r) out.push(r);
      const q = this.queues.get(empId);
      if (q && q.length) out.push(...q);
      return out;
    },
    /** 根据 jobId 查找 Job（可能在 running 或某个队列中） */
    findJob(jobId) {
      if (!jobId) return null;
      for (const j of this.running.values()) {
        if (j && j.id === jobId) return j;
      }
      for (const arr of this.queues.values()) {
        for (const j of arr) {
          if (j && j.id === jobId) return j;
        }
      }
      return null;
    },
    /**
     * 入队一个 Job。若该员工当前没有 running job，则立刻启动；否则追加到队列末尾。
     * 返回 Job 在队列中的位置（1 表示立即启动成为 running；2 表示排在第 1 位等待；以此类推）。
     */
    enqueueJob(job) {
      if (!job || !job.empId || typeof job.startFn !== 'function') {
        console.warn('[DelegationVM] enqueueJob: invalid job', job);
        return 0;
      }
      const empId = job.empId;
      if (!this.queues.has(empId)) this.queues.set(empId, []);

      if (!this.running.has(empId)) {
        // 员工空闲 → 立刻启动
        this.running.set(empId, job);
        try {
          Promise.resolve(job.startFn()).catch(err => {
            console.warn('[DelegationVM] startFn threw:', err);
            this.completeJob(empId, job.id, 'error');
          });
        } catch (err) {
          console.warn('[DelegationVM] startFn sync throw:', err);
          this.completeJob(empId, job.id, 'error');
        }
        this._refreshCardStatus(empId);
        return 1;  // 位置 1 = 正在执行
      }

      // 否则入队
      this.queues.get(empId).push(job);
      const pos = this.queues.get(empId).length + 1;  // +1 因为 running 也算
      this._refreshCardStatus(empId);
      return pos;
    },
    /**
     * 旁路登记：将一个已在执行中的 Job 直接注册为 running，不调用 startFn。
     * 用于：员工空闲时手动聊天直接走原路径的场景，事后把它登记进来以便
     *   ① UI 感知员工忙；
     *   ② 后续手动/委派消息自动入队。
     * 若该员工已有 running，则直接入队（队尾）并返回位置。
     */
    registerRunning(job) {
      if (!job || !job.empId) {
        console.warn('[DelegationVM] registerRunning: invalid job', job);
        return 0;
      }
      const empId = job.empId;
      if (!this.queues.has(empId)) this.queues.set(empId, []);
      if (!this.running.has(empId)) {
        this.running.set(empId, job);
        this._refreshCardStatus(empId);
        return 1;
      }
      this.queues.get(empId).push(job);
      const pos = this.queues.get(empId).length + 1;
      this._refreshCardStatus(empId);
      return pos;
    },
    /**
     * 标记某 Job 执行结束，从 running 弹出，若队列非空则取下一个启动。
     * 任何 Job 的 startFn 完成后（成功/失败/取消）都必须调用此方法，否则队列会堆积。
     */
    completeJob(empId, jobId, status) {
      if (!empId) return;
      const cur = this.running.get(empId);
      // ★ 修复：使用 == 而不是 ===，处理类型不匹配（字符串 vs 数字）
      console.log('[DelegationVM.completeJob] 入参: empId=', empId, 'jobId=', jobId, 'running.has=', this.running.has(empId), 'cur?.id=', cur?.id);
      if (cur && (!jobId || String(cur.id) === String(jobId) || cur.id == jobId)) {
        console.log('[DelegationVM.completeJob] 匹配成功, empId=', empId, 'jobId=', jobId, 'cur.id=', cur.id);
        this.running.delete(empId);
        if (cur.task && status) {
          cur.task.status = status;
          _persistTask(cur.task);
        }
      } else {
        console.warn('[DelegationVM.completeJob] 匹配失败, empId=', empId, 'jobId=', jobId, 'cur=', cur ? {id: cur.id, status: cur.task?.status} : 'null');
        // ★ 额外：即使不匹配，如果 running 中有该 empId 的条目但 jobId 不匹配，
        //   可能是旧的/错误的条目，强制清理（防止卡片永远显示 working）
        if (cur && !jobId) {
          console.warn('[DelegationVM.completeJob] jobId 为空，强制清理 running[', empId, ']');
          this.running.delete(empId);
        }
      }
      // 取下一个
      const q = this.queues.get(empId);
      if (q && q.length) {
        const next = q.shift();
        this.running.set(empId, next);
        try {
          Promise.resolve(next.startFn()).catch(err => {
            console.warn('[DelegationVM] next.startFn threw:', err);
            this.completeJob(empId, next.id, 'error');
          });
        } catch (err) {
          console.warn('[DelegationVM] next.startFn sync throw:', err);
          this.completeJob(empId, next.id, 'error');
        }
      }
      this._refreshCardStatus(empId);
    },
    /**
     * 取消指定 Job：
     *   - 如果在 running：调用其 cancelFn（关 SSE / 调后端 cancel），然后调 completeJob 推进队列
     *   - 如果在队列中：直接从队列移除，其 task 标记 cancelled
     * 返回是否找到并取消成功。
     */
    async cancelJob(jobId) {
      if (!jobId) return false;
      // 先查 running
      for (const [empId, job] of this.running.entries()) {
        if (job && job.id === jobId) {
          console.log('[DelegationVM] 取消正在执行的 Job:', jobId);
          if (job.task) {
            job.task.status = 'cancelled';
            _persistTask(job.task);
          }
          try {
            if (typeof job.cancelFn === 'function') await job.cancelFn();
          } catch (e) {
            console.warn('[DelegationVM] cancelFn error:', e);
          }
          // 不等后端回调，直接推进队列
          this.completeJob(empId, jobId, 'cancelled');
          return true;
        }
      }
      // 再查队列
      for (const [empId, arr] of this.queues.entries()) {
        const idx = arr.findIndex(j => j && j.id === jobId);
        if (idx !== -1) {
          console.log('[DelegationVM] 从队列中移除 Job:', jobId);
          const removed = arr.splice(idx, 1)[0];
          if (removed && removed.task) {
            removed.task.status = 'cancelled';
            _persistTask(removed.task);
          }
          this._refreshCardStatus(empId);
          return true;
        }
      }
      return false;
    },
    /** 刷新员工卡片的状态条（状态 label 会显示排队数）
     *  ★ 逻辑说明：_updateCardStatus 已直接根据 DelegationVM.running/queues 动态计算状态，
     *  所以这里只需更新 DOM，不再修改 emp.status（避免与 SSE 事件设置的状态冲突）
     */
    _refreshCardStatus(empId) {
      if (!empId) return;
      try {
        const emp = (typeof getEmployee === 'function') ? getEmployee(empId) : null;
        if (!emp) return;
        
        const hasRunning = this.running.has(empId);
        const queue = this.queues.get(empId);
        const hasQueued = queue && queue.length > 0;
        
        if (!hasRunning && !hasQueued && emp.status !== 'error') {
          emp.status = 'idle';
        }

        // ★ 调试日志
        if (empId === (typeof EMPLOYEE_STORE !== 'undefined' ? EMPLOYEE_STORE.selectedId : null)) {
          console.log('[_refreshCardStatus] empId=', empId,
            'hasRunning=', hasRunning,
            'hasQueued=', hasQueued,
            'emp.status=', emp.status);
        }

        const cards = document.querySelectorAll(`.emp-card[data-id="${empId}"]`);
        cards.forEach(card => {
          if (typeof _updateCardStatus === 'function') {
            _updateCardStatus(card, emp);
          }
        });
        // ★ 同步更新列表模式元素
        const listItems = document.querySelectorAll(`.emp-list-item[data-id="${empId}"]`);
        listItems.forEach(item => {
          if (typeof _updateCardStatus === 'function') {
            _updateCardStatus(item, emp);
          }
        });
      } catch (_) {}
      try {
        if (typeof EMPLOYEE_STORE !== 'undefined' && EMPLOYEE_STORE.selectedId === empId
            && typeof _updateDelegationBar === 'function') {
          const emp = (typeof getEmployee === 'function') ? getEmployee(empId) : null;
          _updateDelegationBar(emp);
        }
      } catch (_) {}
    },

    // ── 任务生命周期 ────────────────────────────────────────────────────────



    /**
     * 创建一个新任务对象并登记（此时不改 emp._activeTaskId / status —
     * 任务真正启动时由 startFn 内部设置）。
     * @returns {Task}
     */
    createTask({ taskId, emp, taskContent, workspace, requesterName }) {
      if (!taskId || !emp) return null;
      if (this.tasks.has(taskId)) return this.tasks.get(taskId);
      const task = _createTask({
        taskId,
        empId: emp.id,
        empName: emp.name || '',
        taskContent,
        workspace,
        requesterName,
      });
      this.tasks.set(taskId, task);
      // ★ 持久化 task 元数据（taskId → sessionId/empId 映射，页面刷新后可恢复）
      _persistTask(task);
      return task;
    },

    getTask(taskId) {
      return taskId ? this.tasks.get(taskId) || null : null;
    },

    /**
     * 统一设置 task.status 并自动持久化到 localStorage。
     * 所有外部代码设置 task.status 时应使用此方法，而非直接赋值 task.status = ...。
     * @param {string} taskId
     * @param {string} status — 'pending' | 'running' | 'done' | 'error' | 'cancelled'
     */
    setTaskStatus(taskId, status) {
      const task = this.getTask(taskId);
      if (!task) return;
      task.status = status;
      _persistTask(task);
    },

    /** 返回该员工最新（createdAt 最大）且未 done/error/cancelled 的任务，否则最新完成的任务 */
    getLatestTaskFor(empId) {
      if (!empId) return null;
      let latest = null;
      for (const t of this.tasks.values()) {
        if (t.empId !== empId) continue;
        if (!latest || t.createdAt > latest.createdAt) latest = t;
      }
      return latest;
    },

    /** 返回该员工所有进行中的任务 */
    getActiveTasksFor(empId) {
      const out = [];
      for (const t of this.tasks.values()) {
        if (t.empId === empId && (t.status === 'pending' || t.status === 'running')) {
          out.push(t);
        }
      }
      return out;
    },

    /**
     * [已废弃] 方案 B 使用任务队列，不再取消旧任务。保留 no-op 以兼容旧调用。
     */
    cancelActiveTasksForEmployee(_empId, _excludeTaskId) {
      // no-op — 现在使用队列串行执行
    },

    /** 关闭任务的 SSE 和轮询定时器 */
    _stopTaskStreams(task, reason) {
      if (!task) return;
      if (task.sseSource) {
        try {
          task.sseSource._intentionallyClosed = true;
          task.sseSource.close();
        } catch (_) {}
        task.sseSource = null;
      }
      if (task.pollTimer) {
        try { clearInterval(task.pollTimer); } catch (_) {}
        task.pollTimer = null;
      }
    },

    /** 任务结束清理（仅关闭流，保留历史数据） */
    finishTask(taskId, status) {
      const task = this.getTask(taskId);
      if (!task) return;
      this._stopTaskStreams(task, 'finished');
      task.status = status || 'done';
      // ★ 更新持久化状态
      _persistTask(task);
    },

    // ── 回传去重（保留兼容接口）───────────────────────────────────────────

    /**
     * 一次性回传任务结果到总群（内建去重守卫）
     * 调用入口：SSE done / 超时轮询 / 流错误 / 员工聊天框接管完成
     *
     * @param {object} params
     * @param {object} params.emp         员工对象（兼容旧调用）
     * @param {string} params.taskId      任务 ID
     * @param {string} params.result      最终 assistant 回复（已剥离 thinking 标签）
     * @param {string} params.workspace   工作区路径
     * @param {string} [params.sessionId] 员工 session ID（若提供，后端自行聚合完整回复）
     * @param {string} [params.requesterName='你']
     * @returns {Promise<boolean>}
     */
    async postResultOnce({ emp, taskId, result, workspace, sessionId, requesterName = '你' }) {
      if (!emp || !workspace) return false;
      const trimmed = String(result || '').trim();
      if (!trimmed && !sessionId) return false;

      const empId = emp.id || emp.name || 'unknown';
      const tid = taskId || '';
      let key;
      if (tid) {
        key = `${empId}::${tid}`;
      } else {
        const snippet = trimmed.slice(0, 80) || (sessionId ? `SESS::${sessionId}` : 'EMPTY');
        key = `${empId}::NOID::${snippet}`;
      }

      if (this._postedKeys.has(key)) {
        console.log('[DelegationVM] postResultOnce: 已回传过，跳过', key);
        return false;
      }
      this._postedKeys.add(key);

      // 也将任务对象标记 posted
      const task = this.getTask(tid);
      if (task) task.posted = true;

      try {
        const payload = {
          workspace,
          employee_name: emp.name,
          task_id: tid,
          result: trimmed,
          requester_name: requesterName,
        };
        if (sessionId) payload.session_id = sessionId;
        if (typeof _postResultToPMSession === 'function') {
          await _postResultToPMSession(payload);
        } else {
          await api('/api/session/message', {
            method: 'POST',
            body: JSON.stringify({
              session_id: sessionId || '',
              role: 'user',
              content: `[${emp.name} 完成任务 #${tid}]\n${trimmed.slice(0, 200)}`,
            }),
          });
        }
        return true;
      } catch (e) {
        console.warn('[DelegationVM] postResultOnce 请求失败:', e);
        this._postedKeys.delete(key);
        if (task) task.posted = false;
        return false;
      }
    },

    /**
     * 清除已回传守卫（用于调试或极端场景）
     */
    clearPostedKeys() {
      this._postedKeys.clear();
    },

    // ── 向后兼容的旧接口（保留以免破坏任何尚未迁移的调用）────────────────
    beginTask(emp, taskId, taskContent) {
      // 旧接口：仍保留，让 UI 感知"员工在思考"
      if (!emp) return;
      emp._activeTaskId = taskId || null;
      if (typeof setEmployeeStatus === 'function') {
        setEmployeeStatus(emp.id, 'thinking');
      }
    },
    setStreamId(emp, streamId) {
      // 旧接口：no-op（streamId 现在存在任务对象里）
    },
    endTask(emp) {
      if (!emp) return;
      // 只在员工卡片上清掉 UI 快捷索引（不碰任务对象）
      emp._activeTaskId = null;
    },

    // ── 持久化接口 ───────────────────────────────────────────────────────

    /** 暴露内部 _persistTask 供外部调用（如 pm-delegation.js 中 sessionId 赋值后） */
    _persistTask: _persistTask,

    /**
     * 从 localStorage 持久化映射中获取 task 元数据（页面刷新后内存 Map 为空时使用）。
     * @returns {{ sessionId: string|null, empId: string, empName: string, status: string, workspace: string }|null}
     */
    getPersistedTask(taskId) {
      if (!taskId) return null;
      const map = _loadPersistedMap();
      return map[taskId] || null;
    },

    /**
     * 从 localStorage 持久化映射恢复 task 到内存 Map。
     * 仅恢复 sessionId 等元数据，不恢复 streamId/sseSource 等运行时字段。
     * ★ 2026-04-27：同时恢复 taskContent / requesterName / createdAt，
     *   供 openEmployeeChat 刷新后补渲"委派消息 + 任务分隔"使用。
     * @returns {Task|null}
     */
    _restorePersistedTask(taskId) {
      if (!taskId) return null;
      // 已在内存中则跳过
      if (this.tasks.has(taskId)) return this.tasks.get(taskId);
      const meta = this.getPersistedTask(taskId);
      if (!meta) return null;
      const task = _createTask({
        taskId,
        empId: meta.empId || '',
        empName: meta.empName || '',
        taskContent: meta.taskContent || '',
        workspace: meta.workspace || '',
        requesterName: meta.requesterName || '你',
      });
      task.sessionId = meta.sessionId || null;
      task.status = meta.status || 'done';
      if (meta.createdAt) task.createdAt = Number(meta.createdAt) || task.createdAt;
      this.tasks.set(taskId, task);
      return task;
    },

    /** 暴露 _loadPersistedMap 给外部（right-panel.js 路径 3 恢复需要） */
    _loadPersistedMap() {
      return _loadPersistedMap();
    },
  };

  window.DelegationVM = DelegationVM;
})();
