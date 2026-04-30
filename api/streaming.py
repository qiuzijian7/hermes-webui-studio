"""
Hermes Web UI -- SSE streaming engine and agent thread runner.
Includes Sprint 10 cancel support via CANCEL_FLAGS.
"""
import hashlib
import json
import os
import queue
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from api.config import (
    STREAMS, STREAMS_LOCK, CANCEL_FLAGS, AGENT_INSTANCES, CLI_TOOLSETS,
    STREAM_SUBS, STREAM_HISTORY, STREAM_HISTORY_MAX,
    LOCK, SESSIONS, SESSION_DIR,
    _get_session_agent_lock, _set_thread_env, _clear_thread_env,
    resolve_model_provider,
    LOG_SUBSCRIBERS, LOG_SUBSCRIBERS_LOCK,
    _LOG_HISTORY, _LOG_HISTORY_LOCK,
)
from api.helpers import redact_session_data

# Global lock for os.environ writes. Per-session locks (_agent_lock) prevent
# concurrent runs of the SAME session, but two DIFFERENT sessions can still
# interleave their os.environ writes. This global lock serializes the env
# save/restore around the entire agent run.
_ENV_LOCK = threading.Lock()


# ── Clarify (interactive questions) support ────────────────────────────────────
# When the agent calls the clarify tool, we push a "clarify" SSE event to the
# frontend and block the agent thread until the user responds via
# POST /api/clarify/respond.

class _ClarifyEntry:
    """One pending clarify question, blocking an agent thread."""
    __slots__ = ('question', 'choices', 'event', 'result')

    def __init__(self, question, choices):
        self.question = question
        self.choices = choices
        self.event = threading.Event()
        self.result = None          # set by resolve_clarify()


_CLARIFY_LOCK = threading.Lock()
_CLARIFY_QUEUES: dict[str, list[_ClarifyEntry]] = {}   # session_id → [_ClarifyEntry, …]


def submit_clarify(session_id: str, question: str, choices: list | None) -> _ClarifyEntry:
    """Create a pending clarify entry and enqueue it.  Returns the entry
    (caller should entry.event.wait() then read entry.result)."""
    entry = _ClarifyEntry(question, choices)
    with _CLARIFY_LOCK:
        _CLARIFY_QUEUES.setdefault(session_id, []).append(entry)
    return entry


def resolve_clarify(session_id: str, answer: str) -> bool:
    """Resolve the oldest pending clarify for *session_id* with *answer*.
    Returns True if a pending clarify was found and resolved."""
    with _CLARIFY_LOCK:
        q = _CLARIFY_QUEUES.get(session_id)
        if not q:
            return False
        entry = q.pop(0)
        if not q:
            _CLARIFY_QUEUES.pop(session_id, None)
    entry.result = answer
    entry.event.set()
    return True


def cancel_all_clarifies(session_id: str):
    """Cancel (unblock) all pending clarify entries for a session."""
    with _CLARIFY_LOCK:
        entries = _CLARIFY_QUEUES.pop(session_id, [])
    for entry in entries:
        entry.result = ""
        entry.event.set()

# Lazy import to avoid circular deps -- hermes-agent is on sys.path via api/config.py
try:
    from run_agent import AIAgent
except ImportError:
    AIAgent = None

def _get_ai_agent():
    """Return AIAgent class, retrying the import if the initial attempt failed.

    auto_install_agent_deps() in server.py may install missing packages after
    this module is first imported (common in Docker with a volume-mounted agent).
    Re-attempting the import here picks up the newly installed packages without
    requiring a server restart.
    """
    global AIAgent
    if AIAgent is None:
        try:
            from run_agent import AIAgent as _cls  # noqa: PLC0415
            AIAgent = _cls
        except ImportError:
            pass
    return AIAgent
from api.models import get_session, title_from
from api.workspace import set_last_workspace

# Fields that are safe to send to LLM provider APIs.
# Everything else (attachments, timestamp, _ts, etc.) is display-only
# metadata added by the webui and must be stripped before the API call.
_API_SAFE_MSG_KEYS = {'role', 'content', 'tool_calls', 'tool_call_id', 'name', 'refusal'}


def _sanitize_messages_for_api(messages):
    """Return a deep copy of messages with only API-safe fields.

    The webui stores extra metadata on messages (attachments, timestamp, _ts)
    for display purposes. Some providers (e.g. Z.AI/GLM) reject unknown fields
    instead of ignoring them, causing HTTP 400 errors on subsequent messages.
    """
    clean = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        sanitized = {k: v for k, v in msg.items() if k in _API_SAFE_MSG_KEYS}
        if sanitized.get('role'):
            clean.append(sanitized)
    return clean


def _sse(handler, event, data):
    """Write one SSE event to the response stream."""
    payload = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
    handler.wfile.write(payload.encode('utf-8'))
    handler.wfile.flush()


def _run_agent_streaming(session_id, msg_text, model, workspace, stream_id, attachments=None, system_prompt="", employee_name="", disable_tools=False):
    """Run agent in background thread, writing SSE events to STREAMS[stream_id]."""
    q = STREAMS.get(stream_id)
    if q is None:
        return

    # Sprint 10: create a cancel event for this stream
    cancel_event = threading.Event()
    with STREAMS_LOCK:
        CANCEL_FLAGS[stream_id] = cancel_event

    def put(event, data):
        # If cancelled, drop all further events except the cancel event itself
        if cancel_event.is_set() and event not in ('cancel', 'error'):
            return
        # 主 queue (保持向后兼容，第一个 SSE 连接从这里消费)
        try:
            q.put_nowait((event, data))
        except Exception:
            pass
        # ── 广播给所有附加 SSE 订阅者（支持多连接同时观察同一 stream_id）──
        try:
            subs = STREAM_SUBS.get(stream_id, [])
            for sub_q in list(subs):
                try:
                    sub_q.put_nowait((event, data))
                except Exception:
                    pass
        except Exception:
            pass
        # 保留历史，供新订阅者接入时回放（尤其是从总群跳到员工聊天的场景）
        try:
            hist = STREAM_HISTORY.setdefault(stream_id, [])
            hist.append((event, data))
            if len(hist) > STREAM_HISTORY_MAX:
                # 超出上限时保留最新 N 条 + 结构事件（tool/done/approval/clarify 等）
                keep = [e for e in hist if e[0] in ('tool', 'tool_result', 'tool_end', 'tool_args', 'done', 'error', 'cancel', 'approval', 'clarify', 'apperror', 'message_start', 'message_end', 'thinking_start', 'thinking_end', 'step_started', 'step_finished')]
                tail = hist[-(STREAM_HISTORY_MAX - len(keep)):] if len(keep) < STREAM_HISTORY_MAX else []
                STREAM_HISTORY[stream_id] = keep + tail
        except Exception:
            pass
        # ── Broadcast to global log channel ──
        try:
            log_entry = dict(data) if isinstance(data, dict) else {'data': data}
            log_entry['event'] = event
            log_entry['session_id'] = session_id
            log_entry['employee_name'] = employee_name or ''
            log_entry['ts'] = time.time()
            # ★ 生成唯一 ID 用于前端去重（基于 event + session_id + ts + 内容哈希）
            _id_content = f"{event}:{session_id}:{log_entry.get('text','')}:{log_entry.get('message','')}:{log_entry.get('name','')}"
            log_entry['_log_id'] = hashlib.md5(_id_content.encode()).hexdigest()[:16]
            with _LOG_HISTORY_LOCK:
                # 去重：如果最后一条的 _log_id 相同，则替换（更新）而非追加
                if _LOG_HISTORY and _LOG_HISTORY[-1].get('_log_id') == log_entry['_log_id']:
                    _LOG_HISTORY[-1] = log_entry
                else:
                    _LOG_HISTORY.append(log_entry)
            with LOG_SUBSCRIBERS_LOCK:
                # ★ 2026-04-28 移除高频 print：token/reasoning 事件每秒数十次，
                #   print 到 stdout 会产生大量 I/O 瓶颈。仅保留非 token 事件的日志。
                sub_count = len(LOG_SUBSCRIBERS)
                if sub_count and event not in ('token', 'reasoning'):
                    print(f'[logs-put] Broadcasting {event} to {sub_count} subscriber(s)', flush=True)
                for sub_q in list(LOG_SUBSCRIBERS):
                    try:
                        sub_q.put_nowait(log_entry)
                    except Exception:
                        pass  # drop message if queue full, don't remove subscriber
        except Exception:
            pass

    try:
        s = get_session(session_id)
        s.workspace = str(Path(workspace).expanduser().resolve())
        s.model = model

        # ── Local CLI backend path (OpenClaw-style) ──
        # model 形如 "cli:<backend_name>" 或 "cli:<backend_name>/<alias>" 时，
        # 绕过 AIAgent，直接 spawn 本地 CLI 子进程并把 stdout 以 token 事件流出去。
        if isinstance(model, str) and model.startswith('cli:'):
            try:
                _run_cli_backend_streaming(s, msg_text, model, put, cancel_event, attachments, system_prompt)
            finally:
                with STREAMS_LOCK:
                    AGENT_INSTANCES.pop(stream_id, None)
                    CANCEL_FLAGS.pop(stream_id, None)
            return

        # ── Knot AG-UI protocol path ──
        # model 形如 "knot-agui:<agent_id>" 或 "knot-agui:<agent_id>/<knot_model>" 时，
        # 绕过 AIAgent，通过 Knot AG-UI HTTPS API 代理对话，翻译 AG-UI SSE 事件。
        if isinstance(model, str) and model.startswith('knot-agui:'):
            try:
                from api.knot_agui import run_knot_agui_streaming
                run_knot_agui_streaming(
                    session_id, msg_text, model, stream_id, put,
                    cancel_event, system_prompt=system_prompt,
                    employee_name=employee_name,
                )
            except Exception as _e:
                put('apperror', {'type': 'knot_agui_import_error', 'message': str(_e)[:300]})
            finally:
                with STREAMS_LOCK:
                    AGENT_INSTANCES.pop(stream_id, None)
                    CANCEL_FLAGS.pop(stream_id, None)
            return

        _agent_lock = _get_session_agent_lock(session_id)
        # TD1: set thread-local env context so concurrent sessions don't clobber globals
        # Check for pre-flight cancel (user cancelled before agent even started)
        if cancel_event.is_set():
            put('cancel', {'message': 'Cancelled before start'})
            return

        # Resolve profile home for this agent run (snapshot at start)
        try:
            from api.profiles import get_active_hermes_home
            _profile_home = str(get_active_hermes_home())
        except ImportError:
            _profile_home = os.environ.get('HERMES_HOME', '')

        _set_thread_env(
            TERMINAL_CWD=str(s.workspace),
            HERMES_EXEC_ASK='1',
            HERMES_SESSION_KEY=session_id,
            HERMES_HOME=_profile_home,
            HERMES_EMPLOYEE_NAME=employee_name or '',
        )
        # Still set process-level env as fallback for tools that bypass thread-local
        # Acquire lock only for the env mutation, then release before the agent runs.
        # The finally block re-acquires to restore — keeping critical sections short
        # and preventing a deadlock where the restore would re-enter the same lock.
        with _ENV_LOCK:
            old_cwd = os.environ.get('TERMINAL_CWD')
            old_exec_ask = os.environ.get('HERMES_EXEC_ASK')
            old_session_key = os.environ.get('HERMES_SESSION_KEY')
            old_hermes_home = os.environ.get('HERMES_HOME')
            old_employee_name = os.environ.get('HERMES_EMPLOYEE_NAME')
            os.environ['TERMINAL_CWD'] = str(s.workspace)
            os.environ['HERMES_EXEC_ASK'] = '1'
            os.environ['HERMES_SESSION_KEY'] = session_id
            if _profile_home:
                os.environ['HERMES_HOME'] = _profile_home
            # Set employee name so tools like delegate_task and send_group_message
            # know which employee is running
            if employee_name:
                os.environ['HERMES_EMPLOYEE_NAME'] = employee_name
            else:
                os.environ.pop('HERMES_EMPLOYEE_NAME', None)
        # Lock released — agent runs without holding it
        # Register a gateway-style notify callback so the approval system can
        # push the `approval` SSE event the moment a dangerous command is
        # detected, without waiting for the next on_tool() poll cycle.
        # Without this, the agent thread blocks inside the terminal tool
        # waiting for approval that the UI never knew to ask for, leaving
        # the chat stuck in "Thinking…" forever.
        _approval_registered = False
        _unreg_notify = None
        # ── P0/P1/P2 + P3: Browser 事件捕获 + "下一步"暂停机制 ──
        # 在这里创建一个 BrowserEventCapture，让 tool_progress/tool_complete 回调
        # 把 browser_* 工具进度打包成 SSE browser_step 事件推给前端；
        # 同时给 user_continue_tool 注册一个 notify 回调，请求发 SSE
        # user_continue_required 事件。
        try:
            from api.browser_events import BrowserEventCapture
            _browser_cap = BrowserEventCapture(session_id=session_id, put_sse=put)
        except Exception as _e:
            _browser_cap = None
            print(f"[webui] WARN: BrowserEventCapture init failed: {_e}", flush=True)

        _user_continue_registered = False
        try:
            from tools.user_continue_tool import (
                register_notify as _reg_uc_notify,
                unregister_notify as _unreg_uc_notify,
            )
            def _uc_notify_cb(data):
                # data: {continue_id, reason, timeout_seconds}
                payload = dict(data) if isinstance(data, dict) else {}
                payload["session_id"] = session_id
                put("user_continue_required", payload)
            _reg_uc_notify(session_id, _uc_notify_cb)
            _user_continue_registered = True
        except Exception as _e:
            _unreg_uc_notify = None
            print(f"[webui] WARN: user_continue notify reg failed: {_e}", flush=True)

        # ★ 2026-04-27: 注册 delegation observer —— 解决"制作人调 delegate_task 后
        #   被委派员工聊天框看不到任务与思考过程"的问题。当父 agent 调用 delegate_task
        #   创建子 agent 时，delegate_hooks 会通知所有观察者，我们在这里把事件转换成
        #   delegation_* 系列 SSE 事件推给前端；前端 messages.js 监听后：
        #     1. 在对应员工的 session 中插入一条"制作人派的任务" user message
        #     2. 把 child 的 token/reasoning/tool 事件实时渲染到该员工聊天面板
        #     3. 在 DelegationVM 登记一个 Task，刷新后仍能通过 session_id 拉历史
        _delegation_observer_registered = False
        try:
            from tools.delegate_hooks import (
                register_delegation_observer as _reg_deleg,
                unregister_delegation_observer as _unreg_deleg,
            )

            def _delegation_observer(event: str, data: dict) -> None:
                # event ∈ {"child.spawned", "child.token", "child.reasoning",
                #          "child.tool.started", "child.tool.completed", "child.completed"}
                try:
                    payload = dict(data) if isinstance(data, dict) else {}
                    payload.setdefault("session_id", session_id)
                    _mapping = {
                        "child.spawned":          "delegation_started",
                        "child.token":            "delegation_token",
                        "child.reasoning":        "delegation_reasoning",
                        "child.tool.started":     "delegation_tool",
                        "child.tool.completed":   "delegation_tool_done",
                        "child.completed":        "delegation_completed",
                    }
                    sse_event = _mapping.get(event, event)
                    put(sse_event, payload)
                except Exception as _e:
                    print(f"[webui] delegation observer err: {_e}", flush=True)

            _reg_deleg(session_id, _delegation_observer)
            _delegation_observer_registered = True
        except Exception as _e:
            _unreg_deleg = None
            print(f"[webui] WARN: delegation observer reg failed: {_e}", flush=True)

        try:
            from tools.approval import (
                register_gateway_notify as _reg_notify,
                unregister_gateway_notify as _unreg_notify,
            )
            def _approval_notify_cb(approval_data):
                put('approval', approval_data)
            _reg_notify(session_id, _approval_notify_cb)
            _approval_registered = True
        except ImportError:
            pass  # approval module not available — fall back to polling

        try:
            def on_token(text):
                if text is None:
                    return  # end-of-stream sentinel
                put('token', {'text': text})

            def on_reasoning(text):
                if text is None:
                    return
                put('reasoning', {'text': text})

            def on_clarify(question, choices):
                """clarify_callback for WebUI: push SSE event, block until user answers."""
                entry = submit_clarify(session_id, question, choices)
                # Push clarify SSE event so the frontend can show the question
                put('clarify', {
                    'session_id': session_id,
                    'question': question,
                    'choices': choices or [],
                })
                # Block the agent thread until the user responds
                entry.event.wait(timeout=300)
                return entry.result or ""

            def on_tool(*cb_args, **cb_kwargs):
                """
                ★ 2026-04-27 升级为可变参数回调：
                  原实现 on_tool(name, preview, args) 只认 3 参数，但 run_agent.py 实际
                  以 4 位置参数调用：on_tool(phase, name, preview, args) 和
                  on_tool("tool.completed", name, None, None, duration=..., is_error=...)；
                  调用方错配时会抛 TypeError 被 except 吞掉，导致 'tool' 事件 **从未** 真正
                  推送到前端（UI 上的 tool 卡是从 done 事件的 tool_calls 数组渲染的）。
                  现在统一解析 phase/name/preview/args，打通两条路：
                    (1) 原有 put('tool', …) 仍在 tool.started 阶段推（保持向后兼容）
                    (2) BrowserEventCapture 接收 started/completed 两阶段，推 browser_step
                """
                phase = "tool.started"
                name = ""
                preview = ""
                args: Any = None
                # 兼容 3 参数旧调用（如果还有调用方这样传）
                if len(cb_args) == 3:
                    name, preview, args = cb_args
                elif len(cb_args) >= 4:
                    phase, name, preview, args = cb_args[0], cb_args[1], cb_args[2], cb_args[3]
                elif len(cb_args) == 2:
                    # _thinking / reasoning.available 等特殊阶段 —— 忽略
                    phase = cb_args[0] or "tool.misc"
                    name = cb_args[1] or ""
                elif len(cb_args) == 1:
                    name = cb_args[0] or ""

                # 过滤掉非工具阶段（_thinking / reasoning.available）
                if phase not in ("tool.started", "tool.completed"):
                    return

                # ── P0/P1/P2: browser_* 工具事件打桩 ──
                # 只在 started 阶段打桩 —— completed 由 tool_complete_callback 做（能拿到 result）
                if _browser_cap is not None and phase == "tool.started":
                    try:
                        _browser_cap.on_started(name, args, preview=str(preview or ""))
                    except Exception as _e:
                        print(f"[webui] browser_cap err: {_e}", flush=True)

                # ── AI 变更追踪：在 started 阶段捕获原始文件内容 ──
                if phase == "tool.started" and name in ("write_file", "write_to_file", "patch", "edit_file"):
                    try:
                        from api.ai_changes import capture_original
                        ws = getattr(s, "workspace", "") or ""
                        # 从 args 推导 tc_id（on_tool 回调没有 tc_id，使用 name+path 作为临时 key）
                        _tc_id = str(id(args)) + "_" + name
                        capture_original(session_id, _tc_id, ws, name, args or {})
                    except Exception as _e:
                        pass  # 非关键路径，静默失败

                # 仅在 started 阶段推 'tool' SSE（避免一次调用双推重复卡片）
                if phase != "tool.started":
                    return

                args_snap = {}
                if isinstance(args, dict):
                    for k, v in list(args.items())[:4]:
                        s2 = str(v); args_snap[k] = s2[:120]+('...' if len(s2)>120 else '')
                put('tool', {'name': name, 'preview': preview, 'args': args_snap})
                # When delegate_task is called with an employee_name,
                # push an employee_created event so the frontend can
                # auto-create the employee card + connection line.
                if name == 'delegate_task' and isinstance(args, dict):
                    emp_name = args.get('employee_name')
                    if emp_name:
                        put('employee_created', {
                            'name': emp_name,
                            'role': args.get('employee_role', ''),
                        })
                    # Team structure: when agent returns a structured team
                    # definition, push a team_created event so the frontend
                    # can batch-create employee cards with connections.
                    team = args.get('team_structure')
                    if team and isinstance(team, dict) and team.get('members'):
                        put('team_created', team)
                # Fallback: poll for pending approval in case notify_cb wasn't
                # registered (e.g. older approval module without gateway support).
                try:
                    from tools.approval import has_pending as _has_pending, _pending, _lock
                    if _has_pending(session_id):
                        with _lock:
                            p = dict(_pending.get(session_id, {}))
                        if p:
                            put('approval', p)
                except ImportError:
                    pass

            def on_tool_complete(tc_id, tool_name, tool_args, tool_result):
                """
                tool_complete_callback — 工具完成时拿到 result（拼接到 browser_step 里方便前端展示 url/title）。
                （注意：这个回调在 run_agent.py 里另有独立调用路径，**不是** tool_progress_callback 的一部分）
                """
                # ── AI 变更追踪：在工具完成后记录变更 ──
                if tool_name in ("write_file", "write_to_file", "patch", "edit_file"):
                    try:
                        from api.ai_changes import record_change
                        ws = getattr(s, "workspace", "") or ""
                        # 使用 tc_id + tool_name 匹配 capture_original 时的 key
                        _cap_key = str(id(tool_args)) + "_" + tool_name
                        record_change(session_id, _cap_key, tool_name,
                                      tool_args or {}, str(tool_result or "")[:500])
                    except Exception as _e:
                        pass  # 非关键路径，静默失败

                if _browser_cap is None:
                    return
                try:
                    _browser_cap.on_completed(
                        tool_name, tool_args, result=tool_result,
                        duration=0.0, is_error=False,
                    )
                except Exception as _e:
                    print(f"[webui] on_tool_complete err: {_e}", flush=True)

            _AIAgent = _get_ai_agent()
            if _AIAgent is None:
                raise ImportError("AIAgent not available -- check that hermes-agent is on sys.path")
            resolved_model, resolved_provider, resolved_base_url = resolve_model_provider(model)

            # Resolve API key via Hermes runtime provider (matches gateway behaviour).
            # Pass the resolved provider so non-default providers get their own credentials.
            resolved_api_key = None
            try:
                from hermes_cli.runtime_provider import resolve_runtime_provider
                _rt = resolve_runtime_provider(requested=resolved_provider)
                resolved_api_key = _rt.get("api_key")
                if not resolved_provider:
                    resolved_provider = _rt.get("provider")
                if not resolved_base_url:
                    resolved_base_url = _rt.get("base_url")
            except Exception as _e:
                print(f"[webui] WARNING: resolve_runtime_provider failed: {_e}", flush=True)

            # Read per-profile config at call time (not module-level snapshot)
            from api.config import get_config as _get_config
            _cfg = _get_config()

            # Per-profile toolsets (fall back to module-level CLI_TOOLSETS)
            _pt = _cfg.get('platform_toolsets', {})
            _toolsets = _pt.get('cli', CLI_TOOLSETS) if isinstance(_pt, dict) else CLI_TOOLSETS

            # ★ 只有 PM专员 拥有委派权限（delegation 工具集），
            #   普通员工不允许使用 delegate_task，任务委派统一由 PM专员 处理
            if employee_name and employee_name != PM_NAME:
                _toolsets = [ts for ts in _toolsets if ts != 'delegation']

            # ★ 禁用工具模式（如生成 configHtml 时不需要任何工具）
            if disable_tools:
                _toolsets = []

            # Fallback model from profile config (e.g. for rate-limit recovery)
            _fallback = _cfg.get('fallback_model') or None
            if _fallback:
                # Resolve the fallback through our provider logic too
                fb_model = _fallback.get('model', '')
                fb_provider = _fallback.get('provider', '')
                fb_base_url = _fallback.get('base_url')
                _fallback_resolved = {
                    'model': fb_model,
                    'provider': fb_provider,
                    'base_url': fb_base_url,
                }
            else:
                _fallback_resolved = None

            agent = _AIAgent(
                model=resolved_model,
                provider=resolved_provider,
                base_url=resolved_base_url,
                api_key=resolved_api_key,
                platform='cli',
                quiet_mode=True,
                enabled_toolsets=_toolsets,
                fallback_model=_fallback_resolved,
                session_id=session_id,
                stream_delta_callback=on_token,
                reasoning_callback=on_reasoning,
                tool_progress_callback=on_tool,
                tool_complete_callback=on_tool_complete,  # ★ P0/P1: 工具完成后拍截图、推 browser_step(done)
                clarify_callback=on_clarify,
            )

            # Store agent instance for cancel/interrupt propagation
            with STREAMS_LOCK:
                AGENT_INSTANCES[stream_id] = agent
                # Check if cancel was requested during agent initialization
                if stream_id in CANCEL_FLAGS and CANCEL_FLAGS[stream_id].is_set():
                    # Cancel arrived during agent creation - interrupt immediately
                    try:
                        agent.interrupt("Cancelled before start")
                    except Exception:
                        pass
                    put('cancel', {'message': 'Cancelled by user'})
                    return

            # Prepend workspace context so the agent always knows which directory
            # to use for file operations, regardless of session age or AGENTS.md defaults.
            workspace_ctx = f"[Workspace: {s.workspace}]\n"
            workspace_system_msg = (
                f"Active workspace at session start: {s.workspace}\n"
                "Every user message is prefixed with [Workspace: /absolute/path] indicating the "
                "workspace the user has selected in the web UI at the time they sent that message. "
                "This tag is the single authoritative source of the active workspace and updates "
                "with every message. It overrides any prior workspace mentioned in this system "
                "prompt, memory, or conversation history. Always use the value from the most recent "
                "[Workspace: ...] tag as your default working directory for ALL file operations: "
                "write_file, read_file, search_files, terminal workdir, and patch. "
                "Never fall back to a hardcoded path when this tag is present."
            )
            # Resolve personality prompt from config.yaml agent.personalities
            # (matches hermes-agent CLI behavior — passes via ephemeral_system_prompt)
            _personality_prompt = None
            _pname = getattr(s, 'personality', None)
            if _pname:
                _agent_cfg = _cfg.get('agent', {})
                _personalities = _agent_cfg.get('personalities', {})
                if isinstance(_personalities, dict) and _pname in _personalities:
                    _pval = _personalities[_pname]
                    if isinstance(_pval, dict):
                        _parts = [_pval.get('system_prompt', '') or _pval.get('prompt', '')]
                        if _pval.get('tone'):
                            _parts.append(f'Tone: {_pval["tone"]}')
                        if _pval.get('style'):
                            _parts.append(f'Style: {_pval["style"]}')
                        _personality_prompt = '\n'.join(p for p in _parts if p)
                    else:
                        _personality_prompt = str(_pval)
            # Pass personality via ephemeral_system_prompt (agent's own mechanism)
            if _personality_prompt:
                agent.ephemeral_system_prompt = _personality_prompt

            # Inject employee-level system prompt (from WebUI employee card)
            # Combines with personality prompt if both exist
            if system_prompt:
                if agent.ephemeral_system_prompt:
                    agent.ephemeral_system_prompt = agent.ephemeral_system_prompt + "\n\n" + system_prompt
                else:
                    agent.ephemeral_system_prompt = system_prompt

            # 发射 agent.start 事件（graceful no-op）
            try:
                from api.event_bus import emit as _emit_start
                _emit_start("agent.start", {
                    "session_id": session_id,
                    "workspace": getattr(s, "workspace", "") or "",
                    "model": getattr(agent, "model", None),
                    "user_message": (msg_text or "")[:500],
                    "employee_name": getattr(s, "employee_name", None),
                })
            except Exception:
                pass

            # ★ 总群 session 过滤：系统消息是显示元数据（"已委派给@xxx"等），
            #   对 AI 无意义且会污染上下文导致模型重复问候语模式。
            #   仅在 is_group_chat session 时过滤。
            _history = _sanitize_messages_for_api(s.messages)
            if getattr(s, 'is_group_chat', False):
                _history = [m for m in _history if m.get('role') != 'system']

            result = agent.run_conversation(
                user_message=workspace_ctx + msg_text,
                system_message=workspace_system_msg,
                conversation_history=_history,
                task_id=session_id,
                persist_user_message=msg_text,
            )
            s.messages = result.get('messages') or s.messages

            # ★ 2026-04-27 纠错循环：检测"模型只输出文本伪装成工具调用"的偷懒行为
            #   场景：用户从总群派"规划/分派"类任务给制作人（或其它有下属的员工），
            #   模型没有真正发起任何 tool_call，只输出一段类似：
            #       ```bash
            #       list_files G:\HermesWorkspaces\GodotWorkspace
            #       ```
            #       （等待结果...）
            #   或者更"高级"的 JSON 伪调用：
            #       ```json
            #       { "name": "list_files", "arguments": { "path": "..." } }
            #       ```
            #   然后结束。这种回复 api_calls==1 且末尾 assistant 消息无 tool_calls。
            #
            #   Prompt 已明确禁止，但模型仍会偷懒。这里做**最多 2 次**硬纠错：
            #   注入 system-like user message 强制重跑，并允许它继续正常使用工具。
            #   2 次后若仍偷懒（例如模型根本不支持 function calling），停止避免无限循环。
            _is_delegation_task = isinstance(msg_text, str) and (
                msg_text.startswith('[总群委派任务 #') or
                msg_text.startswith('[制作人委派任务 ')
            )

            def _detect_tool_loafing() -> bool:
                """检查末尾 assistant 消息是否是"偷懒"回复（无 tool_call 但文本伪装成工具调用）"""
                _last_assistant = None
                for _m in reversed(s.messages or []):
                    if isinstance(_m, dict) and _m.get('role') == 'assistant':
                        _last_assistant = _m
                        break
                if _last_assistant is None:
                    return False
                _tcs = _last_assistant.get('tool_calls') or []
                _content = _last_assistant.get('content', '')
                _has_tool_use = bool(_tcs)
                if not _has_tool_use and isinstance(_content, list):
                    for _p in _content:
                        if isinstance(_p, dict) and _p.get('type') == 'tool_use':
                            _has_tool_use = True
                            break
                if _has_tool_use:
                    return False  # 真的调了工具 → 不是偷懒
                _content_text = _content if isinstance(_content, str) else (
                    ''.join(p.get('text', '') for p in _content if isinstance(p, dict) and p.get('type') == 'text')
                    if isinstance(_content, list) else ''
                )
                if not _content_text:
                    return False
                # 偷懒特征：
                _TOOL_NAMES = ('list_files', 'read_file', 'write_to_file',
                               'delegate_task', 'terminal', 'search_in_files',
                               'edit_file', 'send_group_message')
                _mentions_tool = any(n in _content_text for n in _TOOL_NAMES)
                _has_fake_codeblock = (
                    '```bash' in _content_text
                    or '```json' in _content_text
                    or '```python' in _content_text
                )
                # ★ 2026-04-27: 更强的 JSON 伪调用检测：  "name": "<tool>" 模式
                import re as _re
                _json_fake_call = bool(_re.search(
                    r'"name"\s*:\s*"(?:' + '|'.join(_TOOL_NAMES) + r')"',
                    _content_text,
                ))
                # tool-use: <name> 这种纯文本伪装（用户第一次日志里的那个）
                _tooluse_prefix = any(f'tool-use: {n}' in _content_text for n in _TOOL_NAMES)
                return _mentions_tool or _has_fake_codeblock or _json_fake_call or _tooluse_prefix

            try:
                _CORRECTION_PROMPTS = [
                    (
                        '⚠️ **系统自动纠错（第 1 次）**：你刚才的回复没有调用任何真实工具，'
                        '只在文本/代码块里写了工具名（如 ```bash list_files ...```）。这只是**纯文本**，'
                        '不会被执行。现在请立即通过真正的 function call（tool_call）机制'
                        '发起你承诺的操作：先 `list_files` 扫描工作区根目录，'
                        '然后 `read_file` 读取 PLAN/TASK/SPRINT/README 等规划文档，'
                        '再用 `write_to_file` 落地任务拆解，最后通过 `delegate_task` 并行分派给下属。'
                        '禁止只在文本里描述，必须真正调用工具。'
                    ),
                    (
                        '⚠️ **系统自动纠错（第 2 次，最后一次）**：你仍然没有发起真正的 tool_call。'
                        '写 JSON 到代码块里（例如 ```json\n{"name":"list_files","arguments":{...}}\n```）'
                        '**不是**工具调用——这依然只是纯文本。你必须通过你的客户端提供的 function_call / tool_call 协议字段'
                        '去触发工具。如果你的模型支持 function calling，现在就请发出结构化的 tool_call；'
                        '如果你的模型不支持，请**直接用自然语言输出最终答案/拆解结论**，不要再写任何假装调用的代码块。'
                    ),
                ]
                _correction_count = 0
                while (
                    _is_delegation_task
                    and _correction_count < len(_CORRECTION_PROMPTS)
                    and _detect_tool_loafing()
                ):
                    _correction = _CORRECTION_PROMPTS[_correction_count]
                    _correction_count += 1
                    print(f"[webui] delegation-task loafing detected ({_correction_count}/{len(_CORRECTION_PROMPTS)}): "
                          f"sid={session_id} — injecting corrective continue",
                          flush=True)
                    _result2 = agent.run_conversation(
                        user_message=_correction,
                        conversation_history=_history,
                        task_id=session_id,
                        persist_user_message=_correction,
                    )
                    s.messages = _result2.get('messages') or s.messages
                    try:
                        result['api_calls'] = int(result.get('api_calls', 0) or 0) + int(_result2.get('api_calls', 0) or 0)
                        result['final_response'] = _result2.get('final_response') or result.get('final_response')
                    except Exception:
                        pass
            except Exception as _lle:
                print(f"[webui] delegation loafing detector err: {_lle}", flush=True)

            # 发射 agent.complete 事件（供 hooks 订阅 — graceful no-op）
            try:
                from api.event_bus import emit as _emit
                _emit("agent.complete", {
                    "session_id": session_id,
                    "workspace": getattr(s, "workspace", "") or "",
                    "model": getattr(agent, "model", None),
                    "final_response": (result.get("final_response") or "")[:2000],
                    "api_calls": result.get("api_calls", 0),
                    "interrupted": result.get("interrupted", False),
                    "employee_name": getattr(s, "employee_name", None),
                })
            except Exception:
                pass

            # ── Extract delegate_task results for employee-session binding ──
            # After run_conversation completes, scan tool results for
            # delegate_task calls that created subagents. Push an
            # employee_session_bound SSE event for each so the frontend
            # can bind the child_session_id to the corresponding employee card.
            _pending_names = {}  # tool_call_id -> employee_name
            _pending_roles = {}  # tool_call_id -> employee_role
            for _m in s.messages:
                if not isinstance(_m, dict):
                    continue
                if _m.get('role') == 'assistant':
                    # Collect delegate_task call args (employee_name)
                    c = _m.get('content', '')
                    if isinstance(c, list):
                        for p in c:
                            if isinstance(p, dict) and p.get('type') == 'tool_use' and p.get('name') == 'delegate_task':
                                inp = p.get('input', {})
                                if isinstance(inp, dict) and inp.get('employee_name'):
                                    _pending_names[p.get('id', '')] = inp['employee_name']
                                    _pending_roles[p.get('id', '')] = inp.get('employee_role', '')
                    for tc in _m.get('tool_calls', []):
                        if not isinstance(tc, dict):
                            continue
                        fn = tc.get('function', {})
                        if fn.get('name') == 'delegate_task':
                            try:
                                args = json.loads(fn.get('arguments', '{}') or '{}')
                            except Exception:
                                args = {}
                            if isinstance(args, dict) and args.get('employee_name'):
                                tid = tc.get('id', '') or tc.get('call_id', '')
                                _pending_names[tid] = args['employee_name']
                                _pending_roles[tid] = args.get('employee_role', '')
                elif _m.get('role') == 'tool':
                    tid = _m.get('tool_call_id') or _m.get('tool_use_id', '')
                    emp_name = _pending_names.pop(tid, None)
                    emp_role = _pending_roles.pop(tid, None)
                    if emp_name:
                        raw = str(_m.get('content', ''))
                        try:
                            rd = json.loads(raw)
                            for r in rd.get('results', []):
                                child_sid = r.get('child_session_id')
                                if child_sid:
                                    put('employee_session_bound', {
                                        'name': emp_name,
                                        'role': emp_role or '',
                                        'child_session_id': child_sid,
                                    })
                        except Exception:
                            pass

            # If the agent failed (e.g. 401/403/429 from the LLM provider),
            # send an apperror event so the frontend shows the error clearly
            # instead of silently completing with no assistant response.
            _err = result.get('error')
            _failed = result.get('failed')
            if _failed and _err:
                _err_str = str(_err)
                _err_type = 'error'
                if '429' in _err_str or 'rate limit' in _err_str.lower():
                    _err_type = 'rate_limit'
                elif '401' in _err_str or '403' in _err_str:
                    _err_type = 'auth_error'
                put('apperror', {
                    'type': _err_type,
                    'message': _err_str[:500],
                    'hint': 'Check your API key and provider configuration in .env',
                })
                return

            # ── Handle context compression side effects ──
            # If compression fired inside run_conversation, the agent may have
            # rotated its session_id. Detect and fix the mismatch so the WebUI
            # continues writing to the correct session file.
            _agent_sid = getattr(agent, 'session_id', None)
            _compressed = False
            if _agent_sid and _agent_sid != session_id:
                old_sid = session_id
                new_sid = _agent_sid
                # Rename the session file
                old_path = SESSION_DIR / f'{old_sid}.json'
                new_path = SESSION_DIR / f'{new_sid}.json'
                s.session_id = new_sid
                with LOCK:
                    if old_sid in SESSIONS:
                        SESSIONS[new_sid] = SESSIONS.pop(old_sid)
                if old_path.exists() and not new_path.exists():
                    try:
                        old_path.rename(new_path)
                    except OSError:
                        pass
                _compressed = True
            # Also detect compression via the result dict or compressor state
            if not _compressed:
                _compressor = getattr(agent, 'context_compressor', None)
                if _compressor and getattr(_compressor, 'compression_count', 0) > 0:
                    _compressed = True
            # Notify the frontend that compression happened
            if _compressed:
                put('compressed', {
                    'message': 'Context auto-compressed to continue the conversation',
                })

            # Stamp 'timestamp' on any messages that don't have one yet
            _now = time.time()
            for _m in s.messages:
                if isinstance(_m, dict) and not _m.get('timestamp') and not _m.get('_ts'):
                    _m['timestamp'] = int(_now)
            # Only auto-generate title when still default; preserves user renames
            if s.title == 'Untitled' or s.title == 'New Chat' or not s.title:
                s.title = title_from(s.messages, s.title)
            # Read token/cost usage from the agent object (if available)
            input_tokens = getattr(agent, 'session_prompt_tokens', 0) or 0
            output_tokens = getattr(agent, 'session_completion_tokens', 0) or 0
            estimated_cost = getattr(agent, 'session_estimated_cost_usd', None)
            s.input_tokens = (s.input_tokens or 0) + input_tokens
            s.output_tokens = (s.output_tokens or 0) + output_tokens
            if estimated_cost:
                s.estimated_cost = (s.estimated_cost or 0) + estimated_cost
            # Extract tool call metadata grouped by assistant message index
            # Each tool call gets assistant_msg_idx so the client can render
            # cards inline with the assistant bubble that triggered them.
            tool_calls = []
            pending_names = {}   # tool_call_id -> name
            pending_args = {}    # tool_call_id -> args dict
            pending_asst_idx = {} # tool_call_id -> index in s.messages
            for msg_idx, m in enumerate(s.messages):
                if m.get('role') == 'assistant':
                    c = m.get('content', '')
                    # Anthropic format: content is a list with type=tool_use blocks
                    if isinstance(c, list):
                        for p in c:
                            if isinstance(p, dict) and p.get('type') == 'tool_use':
                                tid = p.get('id', '')
                                pending_names[tid] = p.get('name', '')
                                pending_args[tid] = p.get('input', {})
                                pending_asst_idx[tid] = msg_idx
                    # OpenAI format: tool_calls as top-level field on the message
                    for tc in m.get('tool_calls', []):
                        if not isinstance(tc, dict):
                            continue
                        tid = tc.get('id', '') or tc.get('call_id', '')
                        fn = tc.get('function', {})
                        name = fn.get('name', '')
                        try:
                            import json as _j
                            args = _j.loads(fn.get('arguments', '{}') or '{}')
                        except Exception:
                            args = {}
                        if tid and name:
                            pending_names[tid] = name
                            pending_args[tid] = args
                            pending_asst_idx[tid] = msg_idx
                elif m.get('role') == 'tool':
                    tid = m.get('tool_call_id') or m.get('tool_use_id', '')
                    name = pending_names.get(tid, '')
                    if not name or name == 'tool':
                        continue  # skip unresolvable tool entries
                    asst_idx = pending_asst_idx.get(tid, -1)
                    args = pending_args.get(tid, {})
                    raw = str(m.get('content', ''))
                    try:
                        rd = json.loads(raw)
                        snippet = str(rd.get('output') or rd.get('result') or rd.get('error') or raw)[:200]
                    except Exception:
                        snippet = raw[:200]
                    # Truncate args values for storage
                    args_snap = {}
                    if isinstance(args, dict):
                        for k, v in list(args.items())[:6]:
                            s2 = str(v)
                            args_snap[k] = s2[:120] + ('...' if len(s2) > 120 else '')
                    tool_calls.append({
                        'name': name, 'snippet': snippet, 'tid': tid,
                        'assistant_msg_idx': asst_idx, 'args': args_snap,
                    })
            s.tool_calls = tool_calls
            # Tag the matching user message with attachment filenames for display on reload
            # Only tag a user message whose content relates to this turn's text
            # (msg_text is the full message including the [Attached files: ...] suffix)
            if attachments:
                for m in reversed(s.messages):
                    if m.get('role') == 'user':
                        content = str(m.get('content', ''))
                        # Match if content is part of the sent message or vice-versa
                        base_text = msg_text.split('\n\n[Attached files:')[0].strip()
                        if base_text[:60] in content or content[:60] in msg_text:
                            m['attachments'] = attachments
                            break
            s.save()
            # Sync to state.db for /insights (opt-in setting)
            try:
                from api.config import load_settings as _load_settings
                if _load_settings().get('sync_to_insights'):
                    from api.state_sync import sync_session_usage
                    sync_session_usage(
                        session_id=s.session_id,
                        input_tokens=s.input_tokens or 0,
                        output_tokens=s.output_tokens or 0,
                        estimated_cost=s.estimated_cost,
                        model=model,
                        title=s.title,
                        message_count=len(s.messages),
                    )
            except Exception:
                pass  # never crash the stream for sync failures
            usage = {'input_tokens': input_tokens, 'output_tokens': output_tokens, 'estimated_cost': estimated_cost}
            # Include context window data from the agent's compressor for the UI indicator
            _cc = getattr(agent, 'context_compressor', None)
            if _cc:
                usage['context_length'] = getattr(_cc, 'context_length', 0) or 0
                usage['threshold_tokens'] = getattr(_cc, 'threshold_tokens', 0) or 0
                usage['last_prompt_tokens'] = getattr(_cc, 'last_prompt_tokens', 0) or 0
            raw_session = s.compact() | {'messages': s.messages, 'tool_calls': tool_calls}
            put('done', {'session': redact_session_data(raw_session), 'usage': usage})
        finally:
            # Unregister the gateway approval callback and unblock any threads
            # still waiting on approval (e.g. stream cancelled mid-approval).
            if _approval_registered and _unreg_notify is not None:
                try:
                    _unreg_notify(session_id)
                except Exception:
                    pass
            # ★ P3: 清理 user_continue notify + 解除所有挂起的"下一步"条目
            if _user_continue_registered:
                try:
                    _unreg_uc_notify(session_id)
                except Exception:
                    pass
            # ★ 2026-04-27: 清理 delegation observer
            if _delegation_observer_registered:
                try:
                    _unreg_deleg(session_id)
                except Exception:
                    pass
            # Unblock any pending clarify questions
            cancel_all_clarifies(session_id)
            with _ENV_LOCK:
                if old_cwd is None: os.environ.pop('TERMINAL_CWD', None)
                else: os.environ['TERMINAL_CWD'] = old_cwd
                if old_exec_ask is None: os.environ.pop('HERMES_EXEC_ASK', None)
                else: os.environ['HERMES_EXEC_ASK'] = old_exec_ask
                if old_session_key is None: os.environ.pop('HERMES_SESSION_KEY', None)
                else: os.environ['HERMES_SESSION_KEY'] = old_session_key
                if old_hermes_home is None: os.environ.pop('HERMES_HOME', None)
                else: os.environ['HERMES_HOME'] = old_hermes_home
                if old_employee_name is None: os.environ.pop('HERMES_EMPLOYEE_NAME', None)
                else: os.environ['HERMES_EMPLOYEE_NAME'] = old_employee_name

    except Exception as e:
        print('[webui] stream error:\n' + traceback.format_exc(), flush=True)
        err_str = str(e)
        # Detect rate limit errors specifically so the client can show a helpful card
        # rather than the generic "Connection lost" message
        is_rate_limit = 'rate limit' in err_str.lower() or '429' in err_str or 'RateLimitError' in type(e).__name__
        is_auth_error = (
            '401' in err_str
            or 'AuthenticationError' in type(e).__name__
            or 'authentication' in err_str.lower()
            or 'unauthorized' in err_str.lower()
            or 'invalid api key' in err_str.lower()
            or 'no cookie auth credentials' in err_str.lower()
        )
        if is_rate_limit:
            put('apperror', {
                'message': err_str,
                'type': 'rate_limit',
                'hint': 'Rate limit reached. The fallback model (if configured) was also exhausted. Try again in a moment.',
            })
        elif is_auth_error:
            put('apperror', {
                'message': err_str,
                'type': 'auth_mismatch',
                'hint': (
                    'The selected model may not be supported by your configured provider. '
                    'Run `hermes model` in your terminal to switch providers, then restart the WebUI.'
                ),
            })
        else:
            put('apperror', {'message': err_str, 'type': 'error'})
    finally:
        _clear_thread_env()  # TD1: always clear thread-local context
        with STREAMS_LOCK:
            STREAMS.pop(stream_id, None)
            CANCEL_FLAGS.pop(stream_id, None)
            AGENT_INSTANCES.pop(stream_id, None)  # Clean up agent instance reference
            # 通知所有附加订阅者流已结束（用 None 作 EOF 哨兵），然后移除
            for _sub_q in STREAM_SUBS.pop(stream_id, []):
                try: _sub_q.put_nowait(None)
                except Exception: pass
            # 保留历史 60 秒（让后续短暂连接仍能回放），后台线程延迟清理
            def _delayed_clear(_sid=stream_id):
                time.sleep(60)
                STREAM_HISTORY.pop(_sid, None)
            threading.Thread(target=_delayed_clear, daemon=True).start()

# ============================================================
# SECTION: Local CLI backend streaming (OpenClaw-style)
# 当用户在模型下拉里选了 "cli:<backend>[/<alias>]" 时，走这条路径：
# 不经过 AIAgent，直接 spawn 本地 CLI 子进程，把 stdout 以 token 事件流式推给前端。
# ============================================================

def _run_cli_backend_streaming(sess, msg_text, model, put, cancel_event, attachments, system_prompt):
    """Run a local CLI backend as a lightweight provider.
    model format: "cli:<backend_name>" or "cli:<backend_name>/<alias>"
    """
    import subprocess
    import shutil
    import shlex

    # 解析 model id
    raw = model[len('cli:'):]
    if '/' in raw:
        backend_name, alias = raw.split('/', 1)
    else:
        backend_name, alias = raw, ''
    backend_name = backend_name.strip()
    alias = alias.strip()

    # 读取 cli_backends 配置
    try:
        from api.config import get_config as _get_config, reload_config as _reload_config
        # ★ 每次都 reload，避免用户刚在 UI 里改了配置却读到旧缓存
        try: _reload_config()
        except Exception: pass
        _cfg = _get_config()
        _backends = _cfg.get('cli_backends') or {}
    except Exception as e:
        put('apperror', {'type': 'config_error', 'message': f'Failed to read cli_backends: {e}'})
        put('done', {'session': {'session_id': sess.session_id, 'messages': sess.messages}, 'usage': {}})
        return

    if backend_name not in _backends or not isinstance(_backends[backend_name], dict):
        # 收集可用的替代项，给出迁移建议
        avail_cli = [str(n) for n, v in _backends.items() if isinstance(v, dict) and v.get('enabled') is not False]
        hint_lines = [f'CLI backend "{backend_name}" 已被删除或重命名。']
        if avail_cli:
            hint_lines.append('可用的 CLI backends: ' + ', '.join(avail_cli))
        hint_lines.append('操作：在聊天框上方的模型下拉里重新选择一个可用模型（员工记忆的旧模型会自动更新）。')
        put('apperror', {
            'type': 'backend_not_found',
            'message': f'CLI backend "{backend_name}" not found.',
            'hint': '\n'.join(hint_lines),
        })
        put('done', {'session': {'session_id': sess.session_id, 'messages': sess.messages}, 'usage': {}})
        return

    b = _backends[backend_name]
    if b.get('enabled') is False:
        put('apperror', {'type': 'backend_disabled', 'message': f'CLI backend "{backend_name}" is disabled.'})
        put('done', {'session': {'session_id': sess.session_id, 'messages': sess.messages}, 'usage': {}})
        return

    # ── 智能回退：根据 command basename 补齐缺失的关键字段 ──
    # 旧版 UI 或手动编辑的 YAML 可能没写 userPromptArg/systemPromptFileArg/systemPromptMode。
    # 为已知的 CLI (knot-cli / claude) 预填默认值，避免退化成「无 -p 的裸调用」。
    try:
        _cmd_hint = os.path.basename(str(b.get('command', ''))).lower()
        _cmd_hint = os.path.splitext(_cmd_hint)[0]
        if _cmd_hint == 'knot-cli':
            if not str(b.get('userPromptArg', '')).strip():
                b['userPromptArg'] = '-p'
            if not str(b.get('systemPromptFileArg', '')).strip():
                b['systemPromptFileArg'] = '--user-rules'
            if not str(b.get('systemPromptMode', '')).strip():
                # knot-cli 配合 cmd.exe 包装后，--user-rules 是最稳的方式
                # (prepend 会因 cmd.exe 换行处理导致 system 被截断)
                b['systemPromptMode'] = 'file'
            # Windows 下 knot-cli 直接 CreateProcess 会触发 "请使用 knot-cli 进行对话"
            # 必须用 cmd.exe /c 包装
            if os.name == 'nt' and 'useShellWrapper' not in b:
                b['useShellWrapper'] = True
        elif _cmd_hint == 'claude':
            if not str(b.get('systemPromptArg', '')).strip():
                b['systemPromptArg'] = '--append-system-prompt'
            if not str(b.get('systemPromptMode', '')).strip():
                b['systemPromptMode'] = 'arg'
    except Exception:
        pass

    command = str(b.get('command', '')).strip()
    if not command:
        put('apperror', {'type': 'backend_invalid', 'message': f'CLI backend "{backend_name}" has no command.'})
        put('done', {'session': {'session_id': sess.session_id, 'messages': sess.messages}, 'usage': {}})
        return

    resolved_cmd = shutil.which(command) or (command if (os.path.isabs(command) and os.path.exists(command)) else None)
    if not resolved_cmd:
        put('apperror', {'type': 'backend_not_installed', 'message': f'CLI command not found in PATH: {command}'})
        put('done', {'session': {'session_id': sess.session_id, 'messages': sess.messages}, 'usage': {}})
        return

    # 构建参数
    args_list = list(b.get('args') or [])
    # ★ 去重保护：若 args[0] 与 command 同名（用户误把 command 又写进 args 里），
    #   自动剥离，避免生成 "knot-cli.EXE knot-cli chat ..." 这种重复 argv。
    if args_list:
        try:
            _cmd_base = os.path.basename(resolved_cmd).lower()
            _cmd_stem = os.path.splitext(_cmd_base)[0]
            _first = str(args_list[0]).strip().lower()
            _first_stem = os.path.splitext(os.path.basename(_first))[0]
            if _first_stem and _first_stem == _cmd_stem:
                args_list = args_list[1:]
        except Exception:
            pass
    # 模型别名映射
    if alias:
        aliases = b.get('modelAliases') or {}
        real_model = str(aliases.get(alias, alias))
        model_arg = str(b.get('modelArg', '')).strip()
        if model_arg:
            args_list.extend([model_arg, real_model])
    # system prompt 处理：
    #   systemPromptArg 非空 → 作为独立参数 (如 Claude Code 的 --append-system-prompt)
    #   systemPromptFileArg 非空 → 写入临时文件，以 <arg> <file_path> 传入 (如 knot-cli 的 --user-rules)
    #   systemPromptArg 为空且有 system → 默认拼接到用户消息前（适用于 knot-cli 这种不支持 system 参数的 CLI）
    sp_arg = str(b.get('systemPromptArg', '')).strip()
    sp_file_arg = str(b.get('systemPromptFileArg', '')).strip()
    sp_mode = str(b.get('systemPromptMode', '')).strip().lower()  # '', 'arg', 'file', 'prepend', 'skip'
    # ★ 传给 CLI 前，剥离前端给所有员工共享的委派样板：
    #    (1) 开头的 "[总群委派任务 #task-xxxx] " 前缀（前端用于点击跳回总群）
    #    (2) 结尾的 "---\n⚠️ **执行要求（必读...）**：..." 样板（针对 Hermes agent 的工具调用约束，
    #        对 knot-cli/claude-code 等外部 CLI 无意义，且会污染 -p 前景）
    #    这些清理不影响 WebUI 聊天框显示（sess.messages 保留原 msg_text）。
    _cleaned_msg = msg_text
    try:
        import re as _re
        # 开头前缀
        _cleaned_msg = _re.sub(r'^\s*\[总群委派任务[^\]]*\]\s*', '', _cleaned_msg, count=1)
        # 结尾"执行要求"样板：从 "---\n⚠ **执行要求" 起全部砍掉
        # (⚠ 后可能跟 \ufe0f 变体选择符；用可选非贪婪匹配兼容两种写法)
        _cleaned_msg = _re.sub(
            r'\s*---\s*\n\s*\u26a0\ufe0f?\s*\*\*执行要求.*$',
            '',
            _cleaned_msg,
            count=1,
            flags=_re.DOTALL,
        )
        _cleaned_msg = _cleaned_msg.strip()
    except Exception:
        pass
    effective_user_msg = _cleaned_msg
    _sp_tmpfile = None
    if system_prompt:
        if sp_mode == 'skip':
            pass  # 明确丢弃 system
        elif sp_mode == 'file' or (not sp_mode and sp_file_arg):
            # 写到临时文件再用参数传入
            if sp_file_arg:
                try:
                    import tempfile as _tmp
                    _sp_tmpfile = _tmp.NamedTemporaryFile(mode='w', suffix='.md', prefix='hermes-sysprompt-', delete=False, encoding='utf-8')
                    _sp_tmpfile.write(system_prompt)
                    _sp_tmpfile.flush()
                    _sp_tmpfile.close()
                    args_list.extend([sp_file_arg, _sp_tmpfile.name])
                except Exception as _e:
                    # fallback: prepend
                    effective_user_msg = f"{system_prompt}\n\n---\n\n{msg_text}"
        elif sp_mode == 'prepend' or (not sp_arg and not sp_mode):
            # 拼接到用户消息前
            effective_user_msg = f"{system_prompt}\n\n---\n\n{msg_text}"
        elif sp_arg:
            args_list.extend([sp_arg, system_prompt])
    # 会话 ID
    session_mode = str(b.get('sessionMode', 'none')).strip()
    session_arg = str(b.get('sessionArg', '')).strip()
    if session_mode == 'always' and session_arg:
        args_list.extend([session_arg, sess.session_id])

    # 输入模式
    input_mode = str(b.get('input', 'stdin')).strip() or 'stdin'
    # 用户 prompt 参数名：若设置则以 <userPromptArg> <msg> 形式作为 argv，否则沿用旧 input 行为
    user_prompt_arg = str(b.get('userPromptArg', '')).strip()
    # 工作目录
    workdir = str(b.get('workdir', '')).strip() or sess.workspace
    # 环境变量
    env = dict(os.environ)
    for k, v in (b.get('env') or {}).items():
        env[str(k)] = str(v)

    # 构造最终 argv
    # ★ 防御：若用户消息为空（例如员工首次被委派、或 UI 误发空串），
    #   给一个最小占位，避免 CLI 以"prompt 为空"拒绝执行。
    if not str(effective_user_msg or '').strip():
        if system_prompt and sp_mode != 'skip':
            # 有 system 就让 system 直接当 prompt 值
            effective_user_msg = system_prompt
        else:
            effective_user_msg = '你好'
    if user_prompt_arg:
        # 明确指定了用户 prompt 参数名（如 knot-cli 的 -p）
        argv = [resolved_cmd] + args_list + [user_prompt_arg, effective_user_msg]
        stdin_data = None
    elif input_mode == 'args':
        argv = [resolved_cmd] + args_list + [effective_user_msg]
        stdin_data = None
    else:
        argv = [resolved_cmd] + args_list
        stdin_data = effective_user_msg

    # 记录用户消息到 session
    sess.messages.append({'role': 'user', 'content': msg_text, '_ts': time.time()})

    # ★ 记录 CLI 启动信息到日志面板（便于排查"模型没有返回"问题）
    _argv_preview = ' '.join(argv[:6]) + ('...' if len(argv) > 6 else '')
    put('tool', {
        'name': f'cli:{backend_name}',
        'preview': f'[启动] {_argv_preview}',
        'args': {'command': resolved_cmd, 'model': model, 'session_id': sess.session_id},
    })

    # ★ Windows shell 包装：某些 CLI (如 knot-cli) 会检测父进程/argv[0]，
    #   直接 CreateProcess + 绝对路径启动 → knot-cli 判定为"被包装"并吐
    #   "请使用 xx 进行对话" 退出。
    #   实测关键条件：
    #     (1) 必须用 cmd.exe /c 包装 (父进程是 cmd.exe)
    #     (2) cmdline 里 knot-cli 必须是裸名字 (不能是绝对路径)
    #     (3) 必须用 Popen(str) 形式 (不能用 list)，否则 Python 的 list2cmdline
    #         对 cmd.exe/c 这种嵌套命令行的引号处理会让 knot-cli 收到被截断的 prompt
    #   所以我们把绝对路径的目录临时加到 PATH 里，cmdline 用裸命令名，
    #   并手工拼一个"cmd.exe /c <cmdline>"的字符串给 Popen。
    use_shell_wrapper = bool(b.get('useShellWrapper', False))
    needs_wrap = os.name == 'nt' and use_shell_wrapper
    popen_cmd = None  # 字符串形式 (Windows shell 包装使用)
    popen_argv = argv  # list 形式 (默认)
    if needs_wrap:
        cmd_dir = os.path.dirname(resolved_cmd)
        bare_name = os.path.splitext(os.path.basename(resolved_cmd))[0]
        env['PATH'] = cmd_dir + os.pathsep + env.get('PATH', '')
        # 用裸名字重新 quote 出 cmdline 字符串
        bare_argv = [bare_name] + list(argv[1:])
        inner_cmdline = subprocess.list2cmdline(bare_argv)
        # 最外层用字符串形式 (关键：不再 Popen(list))
        popen_cmd = f'cmd.exe /c {inner_cmdline}'

    put('tool', {
        'name': f'cli:{backend_name}',
        'preview': ' '.join(shlex.quote(a) for a in argv),
        'args': {
            'cmd': resolved_cmd,
            'input': input_mode,
            'workdir': workdir,
            'full_argv': argv,
            'shell_wrapped': use_shell_wrapper and os.name == 'nt',
            'stdin_preview': (stdin_data[:200] + '...') if (stdin_data and len(stdin_data) > 200) else (stdin_data or ''),
        },
    })

    # Spawn 子进程并逐行读取 stdout
    proc = None
    accumulated_text = []
    # ★ Windows 下 subprocess 默认用系统 ANSI（如 GBK）解码，CLI 输出 UTF-8 时会崩。
    #   强制用 UTF-8 + errors='replace' 避免 UnicodeDecodeError；
    #   同时设置 PYTHONIOENCODING 让子进程的 Python/Node 默认也输出 UTF-8。
    env.setdefault('PYTHONIOENCODING', 'utf-8')
    env.setdefault('PYTHONUTF8', '1')
    # 让子进程 (Python CLI) 不要缓冲 stdout。Go/原生二进制忽略此变量但无副作用。
    env.setdefault('PYTHONUNBUFFERED', '1')

    # ── 尝试 ConPTY 伪终端（Windows 真正的"实时流"需要此路径）──
    # 原因：knot-cli 是 Go 二进制，它探测到 stdout 是 PIPE 时会全缓冲(4KB)，
    # 必须让它以为自己连到了终端才会按行 flush。ConPTY 是 Windows 10/11 的方案，
    # Python 侧用 pywinpty 封装。未安装则回退到普通 PIPE（一次性输出）。
    use_conpty = bool(b.get('useConPty', True)) and os.name == 'nt'
    conpty_active = False
    if use_conpty:
        try:
            import winpty as _winpty  # type: ignore
            # 构造 cmdline：和 popen_cmd 一致 (shell 包装) 或 list2cmdline
            if popen_cmd is not None:
                _pty_cmdline = popen_cmd
            else:
                _pty_cmdline = subprocess.list2cmdline(popen_argv)
            pty_proc = _winpty.PtyProcess.spawn(
                _pty_cmdline,
                cwd=workdir or None,
                env=env,
                dimensions=(40, 200),  # (rows, cols)；cols 大一点减少自动换行
            )
            conpty_active = True
        except ImportError:
            pass
        except Exception as _e:
            put('tool', {
                'name': f'cli:{backend_name}',
                'preview': f'[warn] ConPTY 初始化失败: {_e}，回退到 PIPE 模式 (输出会变非实时)',
                'args': {'conpty_error': str(_e)},
            })

    if conpty_active:
        # ── ConPTY 路径 ──
        accumulated_text_cp = []
        try:
            if stdin_data is not None:
                try:
                    pty_proc.write(stdin_data)
                    # 发一个 EOF (Ctrl+Z)? 让 CLI 知道输入结束 —— 实际不少 CLI 期待换行即可
                    pty_proc.write('\n')
                except Exception:
                    pass
            import re as _re_ansi
            # 覆盖 CSI (ESC [ ...), OSC (ESC ] ... BEL 或 ESC \), DCS/APC/PM/SOS,
            # ESC 后跟单字符的普通 Fs/Fp 序列 (=, >, (, ), c, 7, 8, D, E, H, M, N, O, P, Z 等),
            # 以及独立的 \r（非 \r\n）。
            _ansi_esc = _re_ansi.compile(
                r'\x1b\[[0-9;?]*[ -/]*[@-~]'        # CSI: ESC [ ... <final>
                r'|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)'  # OSC: ESC ] ... BEL 或 ESC \
                r'|\x1b[PX^_][^\x1b]*\x1b\\'        # DCS/SOS/PM/APC
                r'|\x1b[ -/][@-~]'                  # nF escape (ESC + 中间字符 + 终结字符)
                r'|\x1b[=>]'                        # ESC = / ESC > (keypad mode)
                r'|\x1b[78cDEHMNOPZ]'              # 单字符 ESC 命令
                r'|\x1b\([AB012]'                   # 字符集选择 ESC ( x
                r'|\r(?!\n)'                        # 独立 \r (光标复位)
            )
            # ── 非阻塞轮询：给底层 socket 设超时，避免 read() 永久阻塞 ──
            # 这样在 knot-cli 执行 [编辑文件] 之类耗时工具（期间 PTY 无新字节）时
            # 也能周期性检查 cancel_event 并保持心跳；进程末尾 EOF 也不会被漏吞。
            import socket as _socket_mod
            try:
                pty_proc.fileobj.settimeout(0.2)
            except Exception:
                pass
            _eof_reached = False
            _last_activity_ts = time.time()
            _intr_sent = False
            _intr_deadline = 0.0
            while not _eof_reached:
                if cancel_event.is_set():
                    # 两段式取消：
                    #  1. 首次检测到 → 发 Ctrl-C (sendintr) 让 knot-cli 有机会优雅收尾
                    #     （吐出 "interrupted" 提示、清理临时文件等），给 1.5s 宽限
                    #  2. 宽限期过了还没退 → 强杀整个进程树（包括 cmd.exe shell wrap 下的
                    #     knot-cli 孙子进程，避免孤儿进程占着工作区文件）
                    if not _intr_sent:
                        try: pty_proc.sendintr()  # Ctrl-C → CTRL_C_EVENT 投递给整个 console 进程组
                        except Exception: pass
                        _intr_sent = True
                        _intr_deadline = time.time() + 1.5
                        put('token', {'text': '\n[cancelling...]\n'})
                        # 继续读循环，让 knot-cli 的 "interrupted" 提示也能流出来
                    elif time.time() >= _intr_deadline:
                        try: pty_proc.terminate(force=True)
                        except Exception: pass
                        # Windows 下 cmd.exe + knot-cli 进程树需要额外 taskkill /T 兜底
                        try:
                            _pid = getattr(pty_proc, 'pid', None)
                            if _pid and os.name == 'nt':
                                subprocess.run(
                                    ['taskkill', '/F', '/T', '/PID', str(_pid)],
                                    capture_output=True, timeout=3,
                                )
                        except Exception:
                            pass
                        put('cancel', {'message': 'Cancelled by user'})
                        break
                try:
                    data = pty_proc.read(4096)
                except EOFError:
                    _eof_reached = True
                    break
                except _socket_mod.timeout:
                    # 正常的"当前无新数据"—— 不跳出循环，只做心跳检查后继续等
                    # 仅当进程已退出且连续多次超时才认为真的没残留了
                    if not pty_proc.isalive() and (time.time() - _last_activity_ts) > 0.5:
                        # 进程已死且已静默 >500ms，再给 socket 一次机会抓残留
                        try:
                            pty_proc.fileobj.settimeout(0.05)
                            tail = pty_proc.read(4096)
                            if tail:
                                clean_tail = _ansi_esc.sub('', tail)
                                if clean_tail:
                                    accumulated_text_cp.append(clean_tail)
                                    put('token', {'text': clean_tail})
                                _last_activity_ts = time.time()
                                # 还有数据，继续循环
                                try: pty_proc.fileobj.settimeout(0.2)
                                except Exception: pass
                                continue
                        except EOFError:
                            pass
                        except _socket_mod.timeout:
                            pass
                        except Exception:
                            pass
                        _eof_reached = True
                        break
                    continue
                except OSError:
                    # 管道异常关闭 —— 可能还有残留在内核缓冲，走下面残留读取
                    break
                except Exception:
                    break
                if not data:
                    continue
                _last_activity_ts = time.time()
                # 去掉 ANSI 颜色/光标控制序列，避免聊天框出现乱码
                clean = _ansi_esc.sub('', data)
                if clean:
                    accumulated_text_cp.append(clean)
                    put('token', {'text': clean})
            # ── 收尾：尽可能读尽残留（非阻塞、忽略 timeout、只在 EOF/无数据时停）──
            try:
                pty_proc.fileobj.settimeout(0.05)
            except Exception:
                pass
            for _tail_try in range(20):  # 最多重试 20 次 × 50ms = 1s 缓冲耗尽时间
                try:
                    data = pty_proc.read(4096)
                except EOFError:
                    break
                except _socket_mod.timeout:
                    if not pty_proc.isalive():
                        break
                    continue
                except Exception:
                    break
                if not data:
                    break
                clean = _ansi_esc.sub('', data)
                if clean:
                    accumulated_text_cp.append(clean)
                    put('token', {'text': clean})
            rc = pty_proc.exitstatus if pty_proc.exitstatus is not None else 0
            full_text = ''.join(accumulated_text_cp)
            stderr_text = ''  # ConPTY 下 stderr 和 stdout 合并
            display_text = full_text
            sess.messages.append({'role': 'assistant', 'content': display_text, '_ts': time.time()})
            if rc != 0 and not full_text.strip():
                put('apperror', {'type': 'cli_error', 'message': f'CLI exited with code {rc}', 'hint': 'ConPTY mode, empty output'})
            put('done', {
                'session': {
                    'session_id': sess.session_id,
                    'messages': sess.messages,
                    'model': model,
                    'workspace': sess.workspace,
                    'title': getattr(sess, 'title', '') or title_from(msg_text),
                    'tool_calls': [],
                },
                'usage': {'input_tokens': 0, 'output_tokens': len(full_text)},
            })
            # ConPTY 路径完成，清理 sp tmpfile 后直接返回
            if _sp_tmpfile is not None:
                try: os.unlink(_sp_tmpfile.name)
                except Exception: pass
            return
        except Exception as e:
            put('apperror', {'type': 'cli_conpty_exception', 'message': str(e)})
            # fallthrough 到 PIPE 兜底

    try:
        # 当 popen_cmd 非空 (Windows shell wrap)，传字符串形式
        _popen_target = popen_cmd if popen_cmd is not None else popen_argv
        proc = subprocess.Popen(
            _popen_target,
            cwd=workdir or None,
            env=env,
            stdin=subprocess.PIPE if stdin_data is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace',
            bufsize=0,  # ★ 无缓冲：让 Python 一收到字节就把字符 return 给我们
        )
        # 写入 stdin 并关闭
        if stdin_data is not None and proc.stdin:
            try:
                proc.stdin.write(stdin_data)
                proc.stdin.close()
            except Exception:
                pass

        # ★ 实时流式读取：stdout / stderr 各开一个后台线程按小块读，
        #   主线程仅等待两端 EOF + 进程退出，期间周期性检查取消。
        import threading as _threading
        import queue as _queue
        _io_q: '_queue.Queue[tuple[str, str]]' = _queue.Queue()

        def _drain(stream, tag):
            try:
                while True:
                    # 小块读：text 模式 read(n) 至少等 1 个字符即返回，
                    # 配合 bufsize=0，能把 Go/Node 等 line-buffered 输出拆成每行立刻推。
                    chunk = stream.read(64)
                    if not chunk:
                        break
                    _io_q.put((tag, chunk))
            except Exception as _e:
                _io_q.put((tag, f'\n[{tag} read error] {_e}\n'))
            finally:
                _io_q.put((tag, ''))  # EOF sentinel

        th_out = _threading.Thread(target=_drain, args=(proc.stdout, 'stdout'), daemon=True)
        th_err = _threading.Thread(target=_drain, args=(proc.stderr, 'stderr'), daemon=True)
        th_out.start(); th_err.start()

        stderr_buf = []
        eof_count = 0
        _pipe_intr_sent = False
        _pipe_intr_deadline = 0.0
        while eof_count < 2:
            if cancel_event.is_set():
                if not _pipe_intr_sent:
                    # 尝试优雅中断：Windows 用 CTRL_BREAK_EVENT（需 CREATE_NEW_PROCESS_GROUP），
                    # 但我们这里用的是 shell wrap，没加该 flag，所以直接 terminate() 即可；
                    # 仍给一次 1s 宽限让 shell/子进程自己退
                    try: proc.terminate()
                    except Exception: pass
                    _pipe_intr_sent = True
                    _pipe_intr_deadline = time.time() + 1.0
                    put('token', {'text': '\n[cancelling...]\n'})
                elif time.time() >= _pipe_intr_deadline:
                    # 超时 → 强杀进程树
                    try:
                        if os.name == 'nt':
                            subprocess.run(
                                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                                capture_output=True, timeout=3,
                            )
                        else:
                            proc.kill()
                    except Exception:
                        pass
                    put('cancel', {'message': 'Cancelled by user'})
                    break
            try:
                tag, chunk = _io_q.get(timeout=0.2)
            except _queue.Empty:
                # 周期性唤醒检查取消
                continue
            if chunk == '':
                eof_count += 1
                continue
            if tag == 'stdout':
                accumulated_text.append(chunk)
                put('token', {'text': chunk})
            else:
                stderr_buf.append(chunk)
                # stderr 也实时流到前端（用独立事件，前端可区分展示）
                put('token', {'text': chunk, 'stream': 'stderr'})

        # 等待退出
        try:
            rc = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = proc.wait()

        stderr_text = ''.join(stderr_buf)

        full_text = ''.join(accumulated_text)

        # 将 stderr 作为后缀合并到保存到 session 的 display_text（供历史查看）。
        # 注意：stderr 已经在 _drain 循环里实时 put('token', stream='stderr') 推给前端，
        # 此处不再重复 put，避免重复显示。
        display_text = full_text
        if stderr_text.strip():
            marker = '\n\n' if full_text.strip() else ''
            display_text = full_text + marker + '[stderr]\n' + stderr_text.strip()

        sess.messages.append({'role': 'assistant', 'content': display_text, '_ts': time.time()})

        # 若 rc != 0 或输出为空，推送 apperror 提示
        if rc != 0 or (not full_text.strip() and not stderr_text.strip()):
            hint_parts = []
            if stderr_text.strip():
                hint_parts.append(stderr_text.strip()[:400])
            hint_parts.append(f'argv: {" ".join(shlex.quote(a) for a in argv)}')
            hint_parts.append(f'input mode: {input_mode}')
            if input_mode == 'stdin':
                hint_parts.append('提示：若 CLI 不支持从 stdin 读 prompt，请在 Settings → Local CLI 把 "输入模式" 改为 "args"')
            put('apperror', {
                'type': 'cli_error',
                'message': f'CLI exited with code {rc}',
                'hint': '\n'.join(hint_parts),
            })
        put('done', {
            'session': {
                'session_id': sess.session_id,
                'messages': sess.messages,
                'model': model,
                'workspace': sess.workspace,
                'title': getattr(sess, 'title', '') or title_from(msg_text),
                'tool_calls': [],
            },
            'usage': {'input_tokens': 0, 'output_tokens': len(full_text)},
        })
    except Exception as e:
        put('apperror', {'type': 'cli_exception', 'message': str(e)})
        put('done', {
            'session': {'session_id': sess.session_id, 'messages': sess.messages},
            'usage': {},
        })
    finally:
        if proc is not None:
            try:
                if proc.poll() is None:
                    # Windows shell wrap 下 proc.terminate() 只杀 cmd.exe，
                    # knot-cli 会残留成孤儿进程并继续锁着工作区文件。
                    # 用 taskkill /T 把整棵进程树杀掉。
                    if os.name == 'nt':
                        try:
                            subprocess.run(
                                ['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                                capture_output=True, timeout=3,
                            )
                        except Exception:
                            proc.terminate()
                    else:
                        proc.terminate()
            except Exception:
                pass
        # 清理 system prompt 临时文件
        if _sp_tmpfile is not None:
            try:
                os.unlink(_sp_tmpfile.name)
            except Exception:
                pass


# ============================================================
# SECTION: HTTP Request Handler
# do_GET: read-only API endpoints + SSE stream + static HTML
# do_POST: mutating endpoints (session CRUD, chat, upload, approval)
# Routing is a flat if/elif chain. See ARCHITECTURE.md section 4.1.
# ============================================================


def cancel_stream(stream_id: str) -> bool:
    """Signal an in-flight stream to cancel. Returns True if the stream existed."""
    with STREAMS_LOCK:
        if stream_id not in STREAMS:
            return False

        # Set WebUI layer cancel flag
        flag = CANCEL_FLAGS.get(stream_id)
        if flag:
            flag.set()

        # Interrupt the AIAgent instance to stop tool execution
        agent = AGENT_INSTANCES.get(stream_id)
        if agent:
            try:
                agent.interrupt("Cancelled by user")
            except Exception as e:
                # Log but don't block the cancel flow
                import logging
                logging.getLogger(__name__).debug(
                    f"Failed to interrupt agent for stream {stream_id}: {e}"
                )
        else:
            # Agent not yet stored - cancel_event flag will be checked by agent thread
            import logging
            logging.getLogger(__name__).debug(
                f"Cancel requested for stream {stream_id} before agent ready - "
                f"cancel_event flag set, will be checked on agent startup"
            )

        # Put a cancel sentinel into the queue so the SSE handler wakes up
        q = STREAMS.get(stream_id)
        if q:
            try:
                q.put_nowait(('cancel', {'message': 'Cancelled by user'}))
            except Exception:
                pass
    return True
