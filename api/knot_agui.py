"""
Knot AG-UI protocol integration.

Proxies chat requests through the Knot AG-UI SSE protocol,
translating AG-UI events into Hermes internal SSE events
(token / reasoning / tool / done / apperror).

API docs: https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}
"""
import json
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
                             cancel_event, system_prompt="", employee_name=""):
    """Run a Knot AG-UI agent conversation and translate events to Hermes SSE.

    model format: "knot-agui:<agent_id>" or "knot-agui:<agent_id>/<knot_model>"

    The put() callback accepts (event, data) tuples matching Hermes SSE protocol:
      - ('token', {'text': ...})       -- assistant text content
      - ('reasoning', {'text': ...})   -- thinking content
      - ('tool', {...})                -- tool call event
      - ('done', {...})                -- conversation complete
      - ('apperror', {...})            -- error
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
            "enable_web_search": False,
            "chat_extra": {},
        }
    }
    if knot_model:
        chat_body["input"]["model"] = knot_model

    # ★ 将 system_prompt 注入 chat_extra（Knot AG-UI 协议支持通过 chat_extra.system_prompt 覆盖预设）
    if system_prompt:
        chat_body["input"]["chat_extra"]["system_prompt"] = system_prompt

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
                _debug_log.append(f'  >>> TEXT_MESSAGE_CONTENT matched! text={repr(text[:100])} full_text_len={len(full_text)}')
                if text:
                    full_text += text
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
                _debug_log.append(f'  >>> THINKING_TEXT_MESSAGE_CONTENT matched! text={repr(text[:100])} full_reasoning_len={len(full_reasoning)}')
                if text:
                    full_reasoning += text
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
                put('tool_end', {
                    'tool_call_id': tool_call_id,
                    'name': tc_info.get('name', ''),
                    'args': tc_info.get('args_buffer', ''),
                })

            elif _evt("ToolCallResult", "TOOL_CALL_RESULT"):
                put('tool_result', {
                    'tool_call_id': raw_event.get("tool_call_id", ""),
                    'result': raw_event.get("result", ""),
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
                # Knot 特有的自定义事件（如 remove-tool），忽略即可
                pass

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

    # Store conversation_id on the session for continuity
    if received_conversation_id:
        try:
            from api.models import get_session
            s = get_session(session_id)
            if s:
                s._knot_conversation_id = received_conversation_id
        except Exception:
            pass

    # Save assistant message to session
    try:
        from api.models import get_session
        s = get_session(session_id)
        if s:
            assistant_content = full_text
            if full_reasoning and full_text:
                assistant_content = full_reasoning + "\n\n" + full_text
            elif full_reasoning:
                assistant_content = full_reasoning
            s.messages.append({
                'role': 'assistant',
                'content': assistant_content,
                '_ts': time.time(),
            })
            s.save()
    except Exception:
        pass

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

    # Send done event
    usage = {
        'input_tokens': 0,
        'output_tokens': len(full_text),
    }
    put('done', {
        'session': {
            'session_id': session_id,
            'messages': [],
            'model': model,
            'tool_calls': [],
        },
        'usage': usage,
        '_knot_conversation_id': received_conversation_id,
    })
