"""
Knot AG-UI protocol integration.

Proxies chat requests through the Knot AG-UI SSE protocol,
translating AG-UI events into Hermes internal SSE events
(token / reasoning / tool / done / apperror).

API docs: https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}
"""
import json
import re
import time

import requests


def _load_agui_settings():
    """Load Knot AG-UI settings from the settings store."""
    try:
        from api.config import load_settings
        s = load_settings()
        return {
            "token": s.get("knot_agui_token", ""),
            "user": s.get("knot_agui_user", ""),
            "agents_raw": s.get("knot_agui_agents", ""),
        }
    except Exception:
        return {"token": "", "user": "", "agents_raw": ""}


def get_knot_agents():
    """Return the list of configured Knot AG-UI agents as parsed list.
    Format: [{"id": "agent_id", "name": "Display Name"}, ...]
    """
    settings = _load_agui_settings()
    raw = settings.get("agents_raw", "")
    if not raw or not raw.strip():
        return []
    try:
        agents = json.loads(raw)
        if isinstance(agents, list):
            return [a for a in agents if isinstance(a, dict) and a.get("id")]
        return []
    except (json.JSONDecodeError, TypeError):
        return []


def run_knot_agui_streaming(session_id, msg_text, model, stream_id, put,
                             cancel_event, system_prompt="", employee_name="",
                             enable_web_search=False,
                             employee=None, workspace=""):
    """Run a Knot AG-UI agent conversation and translate events to Hermes SSE.

    Knot AG-UI agent 的工具由智能体后台统一配置（Client 工具），
    工具调用通过 AG-UI 协议的 ToolCallStart/Args/End/Result 事件流原生处理。
    """
    # Parse model id
    raw = model[len("knot-agui:"):]
    if "/" in raw:
        agent_id, knot_model = raw.split("/", 1)
    else:
        agent_id, knot_model = raw, ""
    agent_id = agent_id.strip()
    knot_model = knot_model.strip()

    if not agent_id:
        put('apperror', {'type': 'config_error', 'message': 'Knot AG-UI agent_id is empty'})
        return

    # Load settings
    settings = _load_agui_settings()
    api_token = settings.get("token", "")
    api_user = settings.get("user", "")

    if not api_token:
        put('apperror', {
            'type': 'config_error',
            'message': 'Knot AG-UI token not configured',
            'hint': '请在 Settings > Knot AG-UI 中配置 API Token',
        })
        return

    # Resolve agent display name
    agents = get_knot_agents()
    agent_name = agent_id
    for a in agents:
        if a.get("id") == agent_id:
            agent_name = a.get("name", agent_id)
            break

    # Build API URL
    api_url = f"https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}"

    # Resolve conversation_id from session for continuity
    conversation_id = ""
    try:
        from api.models import get_session
        s = get_session(session_id)
        if s and hasattr(s, '_knot_conversation_id'):
            conversation_id = s._knot_conversation_id or ""
    except Exception:
        pass

    # Build request body
    chat_body = {
        "input": {
            "message": msg_text,
            "conversation_id": conversation_id,
            "stream": True,
            "enable_web_search": enable_web_search,
            "chat_extra": {},
        }
    }
    if knot_model:
        chat_body["input"]["model"] = knot_model

    # ★ 将 system_prompt 注入 chat_extra（Knot AG-UI 协议支持通过 chat_extra.system_prompt 覆盖预设）
    if system_prompt:
        chat_body["input"]["chat_extra"]["system_prompt"] = system_prompt

    # ★ 工具策略：统一使用 Knot 智能体后台配置的工具（Client 工具）
    #   不再注入本地工具到 system prompt，由 Knot 平台原生处理工具调用。
    #   AG-UI 协议的 ToolCallStart/Args/End/Result 事件会被原样透传给前端展示。

    # Build headers
    headers = {
        "x-knot-api-token": api_token,
        "Content-Type": "application/json",
    }
    if api_user:
        headers["x-knot-api-user"] = api_user

    # ★ 持久化用户消息到 session（与 AIAgent 路径的 persist_user_message 行为一致）
    #   这样 SSE done 后 loadGroupChat() 从后端刷新时不会丢失用户消息
    try:
        from api.models import get_session
        _sess = get_session(session_id)
        if _sess:
            _sess.messages.append({
                'role': 'user',
                'content': msg_text,
                '_ts': time.time(),
            })
            _sess.save()
    except Exception:
        pass

    # Log start
    put('tool', {
        'name': 'knot-agui:' + agent_name,
        'preview': '[AG-UI] ' + agent_name + ' ...',
        'args': {'agent_id': agent_id, 'model': knot_model or 'default'},
    })

    # ★ 入口日志
    try:
        import os
        _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
        with open(_elog, 'w', encoding='utf-8') as f:
            f.write(f'=== Knot AG-UI Entry ===\n')
            f.write(f'agent_id={agent_id} model={knot_model} session_id={session_id}\n')
            f.write(f'api_url={api_url}\n')
            f.write(f'api_token_len={len(api_token)}\n')
            f.write(f'msg_text_len={len(msg_text)}\n')
            f.write(f'system_prompt_len={len(system_prompt) if system_prompt else 0}\n')
            f.write(f'conversation_id={conversation_id}\n')
    except:
        pass

    # Make streaming request
    try:
        response = requests.post(
            api_url, json=chat_body, headers=headers,
            stream=True, timeout=300,
        )
        # ★ 强制设置响应编码为 UTF-8，防止中文乱码
        response.encoding = 'utf-8'
    except requests.exceptions.ConnectionError as e:
        put('apperror', {
            'type': 'connection_error',
            'message': 'Cannot connect to Knot AG-UI: ' + str(e)[:300],
            'hint': 'Check network access to knot.woa.com',
        })
        return
    except requests.exceptions.Timeout:
        put('apperror', {'type': 'timeout', 'message': 'Knot AG-UI connection timed out'})
        return

    if response.status_code in (401, 403):
        put('apperror', {
            'type': 'auth_error',
            'message': 'Knot AG-UI auth failed (HTTP ' + str(response.status_code) + ')',
            'hint': 'Check API Token in Settings > Knot AG-UI',
        })
        return

    if response.status_code != 200:
        body_text = response.text[:500] if response.text else ''
        # ★ 记录非200响应
        try:
            import os
            _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
            with open(_elog, 'a', encoding='utf-8') as f:
                f.write(f'\n=== HTTP ERROR ===\n')
                f.write(f'status={response.status_code}\n')
                f.write(f'body={body_text[:1000]}\n')
        except:
            pass
        put('apperror', {
            'type': 'api_error',
            'message': 'Knot AG-UI HTTP ' + str(response.status_code) + ': ' + body_text,
        })
        return

    # Parse SSE stream from Knot
    full_text = ""
    full_reasoning = ""
    received_conversation_id = ""
    # Track active tool calls for incremental args
    _active_tool_calls = {}  # tool_call_id → {name, args_buffer}
    _debug_log = []  # ★ 调试日志缓冲
    # ★ 追踪完整的 tool_calls 和 tool result，用于保存结构化消息到 session
    #   这样 done 后 _renderRpMessages 可以渲染思考过程和工具调用卡片
    _completed_tool_calls = []  # [{id, name, args_str, result}]
    _assistant_iterations = []  # [{reasoning, text, tool_calls}] — 每次 step 的完整迭代
    _removed_tool_call_ids = set()  # ★ 被 remove-tool 事件标记移除的 tool_call_id

    try:
        _line_count = 0
        for raw_line in response.iter_lines(decode_unicode=False):
            _line_count += 1
            if cancel_event.is_set():
                put('cancel', {'message': 'Cancelled by user'})
                return

            if not raw_line:
                continue

            # ★ 手动 UTF-8 解码，避免 iter_lines(decode_unicode=True) 的编码问题
            try:
                line = raw_line.decode('utf-8')
            except UnicodeDecodeError:
                line = raw_line.decode('utf-8', errors='replace')

            # Strip "data:" prefix
            line = line.strip()
            # ★ 调试：收集前 30 行原始 SSE 数据
            if _line_count <= 30:
                _debug_log.append(f'raw #{_line_count}: {line[:300]}')
            if line.startswith("data:"):
                line = line[5:].strip()
            elif line.startswith("data: "):
                line = line[6:].strip()
            elif line.startswith("event:"):
                # SSE event type line, skip (we parse type from data JSON)
                continue
            else:
                # Not a data line, skip
                continue

            if line == "[DONE]":
                break

            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            if "type" not in msg:
                # ★ 检测 Knot API 返回的非标准错误（如 token 非法、code 190001 等）
                #   这些响应没有 AG-UI "type" 字段，但包含 "code" 和 "msg" 字段
                if "code" in msg or "error" in msg or "msg" in msg:
                    error_code = msg.get("code", "")
                    error_msg = msg.get("msg", "") or msg.get("error", "") or str(msg)
                    put('apperror', {
                        'type': 'knot_api_error',
                        'message': f'Knot AG-UI API error (code {error_code}): {error_msg[:500]}',
                        'hint': '请在 Settings > Knot AG-UI 中检查 API Token 是否正确且未过期',
                    })
                    return
                print(f'[knot-agui] SKIP no type: {str(msg)[:200]}', flush=True)
                continue

            msg_type = msg.get("type", "")
            raw_event = msg.get("rawEvent", {})
            _debug_log.append(f'event: {msg_type} keys={list(raw_event.keys()) if isinstance(raw_event, dict) else "N/A"}')
            # ★★★ 详细调试：记录 TEXT_MESSAGE_CONTENT 和 THINKING_TEXT_MESSAGE_CONTENT 的实际 content 值
            if msg_type in ("TEXT_MESSAGE_CONTENT", "TextMessageContent", "THINKING_TEXT_MESSAGE_CONTENT", "ThinkingTextMessageContent"):
                _content_val = raw_event.get("content", "❌MISSING") if isinstance(raw_event, dict) else "❌NOT_DICT"
                _delta_val = msg.get("delta", "❌MISSING")
                _debug_log.append(f'  >>> content={repr(_content_val)} delta={repr(_delta_val)} matched_so_far={_matched}')

            # ★ Knot 实际 API 返回 UPPER_SNAKE_CASE 事件类型（如 TEXT_MESSAGE_CONTENT），
            #   标准 AG-UI 协议用 PascalCase（如 TextMessageContent）。
            #   此处归一化，同时兼容两种格式。
            _matched = False
            def _evt(name_pascal, name_upper):
                """接受 PascalCase 或 UPPER_SNAKE_CASE 两种事件类型名"""
                nonlocal _matched
                if msg_type == name_pascal or msg_type == name_upper:
                    _matched = True
                    return True
                return False

            # Track conversation_id
            if raw_event.get("conversation_id"):
                received_conversation_id = raw_event["conversation_id"]

            # ── 1.2.1 Text message events ──────────────────────────────────
            if _evt("TextMessageStart", "TEXT_MESSAGE_START"):
                put('message_start', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("TextMessageContent", "TEXT_MESSAGE_CONTENT"):
                text = raw_event.get("content", "")
                # ★★★ 如果 raw_event 中没有 content，尝试从顶层 delta 字段获取
                if not text:
                    text = msg.get("delta", "")
                # ★ 过滤空外观 token：某些 provider/模型（如 GLM）在 tool_calls 前发送
                #   content="{}" / "{" / "}" / "[]" / '""' 等，不应推送到前端
                if text and re.match(r'^[\s{}\[\]"]+$', text.strip()):
                    _debug_log.append(f'  >>> TEXT_MESSAGE_CONTENT filtered empty-like: {repr(text)}')
                    text = ""
                _debug_log.append(f'  >>> TEXT_MESSAGE_CONTENT matched! text={repr(text[:100])} full_text_len={len(full_text)}')
                if text:
                    full_text += text
                    # ★ 追踪到当前迭代（若无迭代则自动创建——兼容无 StepStarted 事件的情况）
                    if not _assistant_iterations:
                        _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                    _assistant_iterations[-1]['text'] += text
                    put('token', {'text': text})

            elif _evt("TextMessageEnd", "TEXT_MESSAGE_END"):
                put('message_end', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            # ── 1.2.2 Thinking message events ──────────────────────────────
            elif _evt("ThinkingTextMessageStart", "THINKING_TEXT_MESSAGE_START"):
                put('thinking_start', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("ThinkingTextMessageContent", "THINKING_TEXT_MESSAGE_CONTENT"):
                text = raw_event.get("content", "")
                # ★★★ 如果 raw_event 中没有 content，尝试从顶层 delta 字段获取
                if not text:
                    text = msg.get("delta", "")
                # ★ 过滤空外观 token（同 TEXT_MESSAGE_CONTENT 逻辑）
                if text and re.match(r'^[\s{}\[\]"]+$', text.strip()):
                    _debug_log.append(f'  >>> THINKING_TEXT_MESSAGE_CONTENT filtered empty-like: {repr(text)}')
                    text = ""
                _debug_log.append(f'  >>> THINKING_TEXT_MESSAGE_CONTENT matched! text={repr(text[:100])} full_reasoning_len={len(full_reasoning)}')
                if text:
                    full_reasoning += text
                    # ★ 追踪到当前迭代（若无迭代则自动创建——兼容无 StepStarted 事件的情况）
                    if not _assistant_iterations:
                        _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                    _assistant_iterations[-1]['reasoning'] += text
                    put('reasoning', {'text': text})

            elif _evt("ThinkingTextMessageEnd", "THINKING_TEXT_MESSAGE_END"):
                put('thinking_end', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            # ── 1.2.3 Tool call events ─────────────────────────────────────
            elif _evt("ToolCallStart", "TOOL_CALL_START"):
                tool_name = raw_event.get("name", "unknown_tool")
                tool_call_id = raw_event.get("tool_call_id", "")
                args_str = raw_event.get("args", "")
                # Register active tool call
                _active_tool_calls[tool_call_id] = {
                    'name': tool_name,
                    'args_buffer': args_str or "",
                }
                # ★ 追踪到当前迭代的 tool_calls
                if not _assistant_iterations:
                    _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                _assistant_iterations[-1]['tool_calls'].append({
                    'id': tool_call_id,
                    'name': tool_name,
                    'args': raw_event.get("args", {}),
                })
                put('tool', {
                    'name': tool_name,
                    'preview': '[AG-UI Tool] ' + tool_name,
                    'args': raw_event.get("args", {}),
                    'tool_call_id': tool_call_id,
                    'phase': 'started',
                })

            elif _evt("ToolCallArgs", "TOOL_CALL_ARGS"):
                tool_call_id = raw_event.get("tool_call_id", "")
                args_delta = raw_event.get("args", "")
                if tool_call_id in _active_tool_calls:
                    _active_tool_calls[tool_call_id]['args_buffer'] += args_delta or ""
                put('tool_args', {
                    'tool_call_id': tool_call_id,
                    'args_delta': args_delta,
                })

            elif _evt("ToolCallEnd", "TOOL_CALL_END"):
                tool_call_id = raw_event.get("tool_call_id", "")
                tc_info = _active_tool_calls.pop(tool_call_id, {})
                # ★ 记录完整的 tool call（供保存到 session messages 使用）
                _completed_tool_calls.append({
                    'id': tool_call_id,
                    'name': tc_info.get('name', 'unknown_tool'),
                    'args_str': tc_info.get('args_buffer', ''),
                })
                # ★ 更新迭代追踪中的 args（用完整累积的 args 替换初始值）
                for _iter in _assistant_iterations:
                    for _tc in _iter.get('tool_calls', []):
                        if _tc.get('id') == tool_call_id:
                            try:
                                _tc['args'] = json.loads(tc_info.get('args_buffer', '{}'))
                            except Exception:
                                _tc['args'] = tc_info.get('args_buffer', {})
                put('tool_end', {
                    'tool_call_id': tool_call_id,
                    'name': tc_info.get('name', ''),
                    'args': tc_info.get('args_buffer', ''),
                })

            elif _evt("ToolCallResult", "TOOL_CALL_RESULT"):
                tool_call_id = raw_event.get("tool_call_id", "")
                result = raw_event.get("result", "")
                # 记录结果到 completed_tool_calls
                for tc in _completed_tool_calls:
                    if tc['id'] == tool_call_id:
                        tc['result'] = result
                        break
                # ★ 过滤空外观的 tool_result（如 "{}" / "[]" / '""'），
                #   避免前端在 tool card 下方显示孤立的 "{}" 文本
                _rs_str = result if isinstance(result, str) else json.dumps(result)
                if not _rs_str or re.match(r'^[\s{}\[\]"]+$', _rs_str.strip()):
                    _debug_log.append(f'  >>> TOOL_CALL_RESULT filtered empty-like: {repr(result)}')
                else:
                    put('tool_result', {
                        'tool_call_id': tool_call_id,
                        'result': result,
                    })

            # ── 1.3 Status sync: RunError ──────────────────────────────────
            elif _evt("RunError", "RUN_ERROR"):
                tip = raw_event.get("tip_option", {})
                error_msg = ""
                if isinstance(tip, dict):
                    error_msg = tip.get("content", "")
                if not error_msg:
                    error_msg = str(raw_event)
                put('apperror', {
                    'type': 'knot_run_error',
                    'message': 'Knot AG-UI error: ' + error_msg[:500],
                })
                return

            # ── 1.4 Step lifecycle events ──────────────────────────────────
            elif _evt("StepStarted", "STEP_STARTED"):
                step_name = raw_event.get("step_name", "")
                # ★ AG-UI 迭代边界：call_llm step → 新迭代开始
                #   execute_tool step 属于当前迭代（不新建）
                if step_name == 'call_llm':
                    _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                put('step_started', {
                    'step_name': step_name,
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("StepFinished", "STEP_FINISHED"):
                step_name = raw_event.get("step_name", "")
                token_usage = raw_event.get("token_usage")
                step_data = {
                    'step_name': step_name,
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                }
                if token_usage:
                    step_data['token_usage'] = token_usage
                put('step_finished', step_data)

            # ── 1.5 Run lifecycle events ──────────────────────────────────
            elif _evt("RunStarted", "RUN_STARTED"):
                put('message_start', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("RunFinished", "RUN_FINISHED"):
                put('message_end', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            # ── 1.6 Custom events (e.g. remove-tool) ─────────────────────
            elif _evt("Custom", "CUSTOM"):
                # ★ Knot 特有的自定义事件：remove-tool 表示平台决定移除某个 tool call
                #   被 remove 的 tool call 不应出现在最终保存的 assistant 消息中
                _custom_type = raw_event.get("type", "") if isinstance(raw_event, dict) else ""
                if _custom_type == "remove-tool":
                    _removed_tc_id = raw_event.get("tool_call_id", "")
                    if _removed_tc_id:
                        _removed_tool_call_ids.add(_removed_tc_id)
                        _debug_log.append(f'remove-tool: {_removed_tc_id}')

            # ★ 未匹配的事件类型，记录到调试日志
            if not _matched:
                _debug_log.append(f'UNMATCHED event: {msg_type}')
                print(f'[knot-agui] UNMATCHED event type: {msg_type}', flush=True)

    except requests.exceptions.Timeout:
        # ★ 超时也写调试日志
        pass  # Send what we have
    except Exception as e:
        # ★ 写调试日志（即使异常）
        try:
            import os
            _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
            with open(_elog, 'w', encoding='utf-8') as f:
                f.write(f'=== Knot AG-UI Debug Log (EXCEPTION) ===\n')
                f.write(f'agent_id={agent_id} model={knot_model} session_id={session_id}\n')
                f.write(f'full_text_len={len(full_text)} full_reasoning_len={len(full_reasoning)}\n')
                f.write(f'line_count={_line_count}\n')
                f.write(f'exception: {e}\n\n')
                for entry in _debug_log:
                    f.write(entry + '\n')
                f.write(f'\n=== full_text (first 500) ===\n{full_text[:500]}\n')
        except:
            pass
        if not full_text:
            put('apperror', {
                'type': 'stream_error',
                'message': 'Knot AG-UI stream error: ' + str(e)[:300],
            })
            return

    # （工具调用由 Knot 智能体自行处理，上方 SSE 流中已透传 ToolCall 事件给前端）
    if received_conversation_id:
        try:
            from api.models import get_session
            s = get_session(session_id)
            if s:
                s._knot_conversation_id = received_conversation_id
        except Exception:
            pass

    # ★★★ 保存结构化消息到 session（含 tool_calls、reasoning、tool result）★★★
    #   旧实现只保存了扁平的 assistant content 字符串，导致 _renderRpMessages
    #   无法渲染思考卡片和工具调用卡片——刷新后全部消失。
    #   新实现按 AG-UI 协议逐迭代保存：
    #     - 有 tool_calls 的迭代 → assistant msg（含 tool_calls）+ tool result msgs
    #     - 纯文本迭代 → assistant msg（含 reasoning 和 content）
    try:
        from api.models import get_session
        s = get_session(session_id)
        if s:
            _now = time.time()
            # ★★★ 调试日志：记录迭代追踪数据
            print(f'[knot-agui] SAVE: iterations={len(_assistant_iterations)} completed_tcs={len(_completed_tool_calls)} full_text_len={len(full_text)} full_reasoning_len={len(full_reasoning)}', flush=True)
            for _iidx, _iter in enumerate(_assistant_iterations):
                _reasoning = _iter.get('reasoning', '').strip()
                _text = _iter.get('text', '').strip()
                _tcs = _iter.get('tool_calls', [])
                print(f'[knot-agui] SAVE: iter[{_iidx}] reasoning_len={len(_reasoning)} text_len={len(_text)} tcs={len(_tcs)}', flush=True)
            # ★ 将每个迭代保存为结构化的 assistant + tool 消息
            for _iter in _assistant_iterations:
                _reasoning = _iter.get('reasoning', '').strip()
                _text = _iter.get('text', '').strip()
                # ★ 过滤空外观文本（只由括号/引号/空白组成）
                if _text and re.match(r'^[\s{}\[\]"]+$', _text):
                    _text = ''
                # ★ 过滤掉被 remove-tool 标记移除的 tool calls
                _tcs = [tc for tc in _iter.get('tool_calls', [])
                        if tc.get('id', '') not in _removed_tool_call_ids]
                if not _reasoning and not _text and not _tcs:
                    continue
                # 构建 assistant 消息
                _asst_msg = {
                    'role': 'assistant',
                    'content': _text or '',
                    '_ts': _now,
                }
                if _reasoning:
                    _asst_msg['reasoning'] = _reasoning
                # ★ OpenAI 格式的 tool_calls
                if _tcs:
                    _asst_msg['tool_calls'] = []
                    for _tc in _tcs:
                        _args_val = _tc.get('args', {})
                        if isinstance(_args_val, str):
                            try:
                                _args_val = json.loads(_args_val)
                            except Exception:
                                _args_val = {'raw': _args_val}
                        _asst_msg['tool_calls'].append({
                            'id': _tc.get('id', ''),
                            'type': 'function',
                            'function': {
                                'name': _tc.get('name', 'unknown_tool'),
                                'arguments': json.dumps(_args_val, ensure_ascii=False),
                            },
                        })
                s.messages.append(_asst_msg)
                # ★ 保存 tool result 消息（配对到 tool_call_id）
                for _tc in _tcs:
                    _tcid = _tc.get('id', '')
                    if not _tcid:
                        continue
                    _result = ''
                    for _ctc in _completed_tool_calls:
                        if _ctc['id'] == _tcid:
                            _result = _ctc.get('result', '')
                            break
                    if not _result:
                        _result = '(no result)'
                    # 序列化非字符串结果
                    if not isinstance(_result, str):
                        try:
                            _result = json.dumps(_result, ensure_ascii=False)
                        except Exception:
                            _result = str(_result)
                    # 截断过长结果
                    if len(_result) > 8000:
                        _result = _result[:8000] + '...(truncated)'
                    s.messages.append({
                        'role': 'tool',
                        'tool_call_id': _tcid,
                        'content': str(_result),
                        '_ts': _now,
                    })
            # ★ 兜底：如果没有追踪到迭代数据（如纯文本模型），保存传统格式
            if not _assistant_iterations and (full_text or full_reasoning):
                assistant_content = full_text
                _msg = {
                    'role': 'assistant',
                    'content': assistant_content,
                    '_ts': _now,
                }
                if full_reasoning:
                    _msg['reasoning'] = full_reasoning
                s.messages.append(_msg)
            s.save()
            # ★★★ 调试：保存后验证 s.messages 的结构
            _saved_summary = []
            for _sm in s.messages:
                _sr = _sm.get('role', '?')
                _sh_r = 'reasoning' in _sm and bool(_sm.get('reasoning'))
                _sh_tc = 'tool_calls' in _sm and bool(_sm.get('tool_calls'))
                _sc_len = len(str(_sm.get('content', '')))
                _saved_summary.append(f'{_sr}(c={_sc_len},reasoning={_sh_r},tc={_sh_tc})')
            print(f'[knot-agui] SAVE DONE: total msgs in session={len(s.messages)} summary=[{", ".join(_saved_summary)}]', flush=True)
    except Exception as _save_err:
        print(f'[knot-agui] SAVE EXCEPTION: {_save_err}', flush=True)

    # ★ 写入调试日志到文件
    try:
        import os, traceback
        _log_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
        with open(_log_path, 'w', encoding='utf-8') as f:
            f.write(f'=== Knot AG-UI Debug Log ===\n')
            f.write(f'agent_id={agent_id} model={knot_model} session_id={session_id}\n')
            f.write(f'full_text_len={len(full_text)} full_reasoning_len={len(full_reasoning)}\n')
            f.write(f'line_count={_line_count}\n')
            f.write(f'conversation_id={received_conversation_id}\n\n')
            for entry in _debug_log:
                f.write(entry + '\n')
            f.write(f'\n=== full_text (first 500) ===\n{full_text[:500]}\n')
            f.write(f'\n=== full_reasoning (first 500) ===\n{full_reasoning[:500]}\n')
    except Exception as _dbg_err:
        # 即使写日志失败也打印错误
        try:
            import os
            _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
            with open(_elog, 'w', encoding='utf-8') as f:
                f.write(f'DEBUG LOG WRITE ERROR: {_dbg_err}\n')
                import traceback; traceback.print_exc(file=f)
        except:
            pass

    # ★★★ Send done event with REAL session data (not empty arrays) ★★★
    #   旧实现发送 messages:[] 和 tool_calls:[]，导致前端 _attachLiveStreamToChat
    #   的 done handler Path 1 失败，Path 2 虽然能拿到 session 数据但消息不含
    #   结构化 tool_calls/reasoning → _renderRpMessages 渲染不出思考/工具卡片。
    _done_session = {
        'session_id': session_id,
        'messages': [],
        'model': model,
        'tool_calls': [],
    }
    try:
        from api.models import get_session as _gs
        _done_sess = _gs(session_id)
        if _done_sess:
            from api.helpers import redact_session_data
            _raw = _done_sess.compact() | {'messages': _done_sess.messages, 'tool_calls': getattr(_done_sess, 'tool_calls', [])}
            _done_session = redact_session_data(_raw)
            # ★★★ 调试日志：记录 done event 中的 session 数据结构
            _msg_summary = []
            for _dm in _done_session.get('messages', []):
                _r = _dm.get('role', '?')
                _has_reasoning = 'reasoning' in _dm and bool(_dm.get('reasoning'))
                _has_tc = 'tool_calls' in _dm and bool(_dm.get('tool_calls'))
                _c_len = len(str(_dm.get('content', '')))
                _msg_summary.append(f'{_r}(c={_c_len},reasoning={_has_reasoning},tc={_has_tc})')
            print(f'[knot-agui] DONE session: sid={session_id} msgs={len(_done_session.get("messages",[]))} summary=[{", ".join(_msg_summary)}]', flush=True)
        else:
            print(f'[knot-agui] DONE session: get_session returned None for sid={session_id}', flush=True)
    except Exception as _done_err:
        print(f'[knot-agui] DONE session: exception={_done_err}', flush=True)
    usage = {
        'input_tokens': 0,
        'output_tokens': len(full_text),
    }
    put('done', {
        'session': _done_session,
        'usage': usage,
        '_knot_conversation_id': received_conversation_id,
    })


def run_knot_agui_sync(message: str, *,
                        model_name: str = "",
                        system_prompt: str = "",
                        enable_web_search: bool = False) -> str:
    """同步调用 Knot AG-UI agent 并返回完整文本响应。

    供 MCP Gateway Worker（gateway_client.py 的 _execute_task）使用，
    避免在 Worker 子进程中启动完整 AIAgent，改为直接调用 Knot AG-UI API。
    所有 MCP 工具统一使用 knot_agui_mcp_model 配置的模型。

    Args:
        message: 用户消息
        model_name: 模型名称（如 "hy3-preview"），为空时从 settings 读取 knot_agui_mcp_model
        system_prompt: 可选的系统提示词
        enable_web_search: 是否启用联网搜索

    Returns:
        助手的回复文本；若出错则返回 "[Error] ..." 格式的错误信息。
    """
    # 直接读取完整 settings（不用 _load_agui_settings() 的过滤版本）
    try:
        from api.config import load_settings
        _s = load_settings()
    except Exception as _cfg_err:
        return f"[Error] Cannot load settings: {_cfg_err}"

    # agent_id：从 knot_agui_agents 取第一个 agent 的 id
    agents_str = _s.get("knot_agui_agents", "").strip()
    agent_id = ""
    if agents_str:
        try:
            _agents = json.loads(agents_str)
            if isinstance(_agents, list) and len(_agents) > 0:
                agent_id = str(_agents[0].get("id", "")).strip()
        except Exception:
            pass
    if not agent_id:
        return "[Error] Knot AG-UI agents not configured or first agent has no id (knot_agui_agents)"

    # model_name：从参数或 settings 读取
    if not model_name:
        model_name = _s.get("knot_agui_mcp_model", "").strip()
    if not model_name:
        return "[Error] Knot AG-UI mcp_model not configured (knot_agui_mcp_model)"

    knot_model = model_name

    # 读取 token / user
    api_token = _s.get("knot_agui_token", "")
    if not api_token:
        return "[Error] Knot AG-UI token not configured (knot_agui_token)"

    # 构建请求
    api_url = f"https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}"
    headers = {
        "x-knot-api-token": api_token,
        "Content-Type": "application/json",
    }
    api_user = _s.get("knot_agui_user", "")
    if api_user:
        headers["x-knot-api-user"] = api_user

    chat_body = {
        "input": {
            "message": message,
            "conversation_id": "",
            "stream": True,
            "enable_web_search": enable_web_search,
            "chat_extra": {},
        }
    }
    if knot_model:
        chat_body["input"]["model"] = knot_model
    if system_prompt:
        chat_body["input"]["chat_extra"]["system_prompt"] = system_prompt

    # 发送请求
    try:
        response = requests.post(
            api_url, json=chat_body, headers=headers,
            stream=True, timeout=300,
        )
        response.encoding = 'utf-8'
    except requests.exceptions.ConnectionError as e:
        return f"[Error] Cannot connect to Knot AG-UI: {e}"
    except requests.exceptions.Timeout:
        return "[Error] Knot AG-UI connection timed out"

    if response.status_code not in (200, 201):
        return f"[Error] Knot AG-UI HTTP {response.status_code}: {response.text[:500]}"

    # 解析 SSE 流，收集 full_text
    full_text = ""
    for raw_line in response.iter_lines(decode_unicode=False):
        if not raw_line:
            continue
        try:
            line = raw_line.decode('utf-8')
        except UnicodeDecodeError:
            line = raw_line.decode('utf-8', errors='replace')

        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        elif line.startswith("data: "):
            line = line[6:].strip()
        elif line.startswith("event:"):
            continue
        else:
            continue

        if line == "[DONE]":
            break

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        if "type" not in msg:
            continue

        msg_type = msg.get("type", "")
        raw_event = msg.get("rawEvent", {})

        if msg_type in ("TextMessageContent", "TEXT_MESSAGE_CONTENT",
                        "ThinkingTextMessageContent", "THINKING_TEXT_MESSAGE_CONTENT"):
            text = raw_event.get("content", "")
            if not text:
                text = msg.get("delta", "")
            if text and not re.match(r'^[\s{}\[\]"]+$', text.strip()):
                full_text += text

    return full_text if full_text else "[No response from Knot AG-UI agent]"

