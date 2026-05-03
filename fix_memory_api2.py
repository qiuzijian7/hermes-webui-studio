"""修复 _handle_employee_memory_write 和 _handle_employee_memory_auto_update 函数"""
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
routes_path = os.path.join(script_dir, 'api', 'routes.py')

with open(routes_path, 'r', encoding='utf-8') as f:
    content = f.read()

# ── 修复 1: _handle_employee_memory_write ──────────────────────────────────
old_write = '''def _handle_employee_memory_write(handler, body):
    """POST /api/employee/memory

    Write employee's MEMORY.md and/or USER.md.
    Body: { workspace, id, memory_content, user_content }
    """
    workspace = (body.get("workspace") or "").strip()
    emp_id = (body.get("id") or body.get("employee_id") or "").strip()

    # ★ 调试：打印接收到的参数
    print(f"[Memory API] POST /api/employee/memory - workspace={workspace}, emp_id={emp_id}", flush=True)

    if not workspace:
        return bad(handler, "workspace is required")
    if not emp_id:
        return bad(handler, "id (employee id) is required")

    try:
        from api.employee_fs import get_employee_by_id, _employee_dir
        from pathlib import Path

        # ★ 修复：先用员工 ID 查找员工
        print(f"[Memory API] Looking up employee by ID: {emp_id} in workspace: {workspace}", flush=True)
        emp = get_employee_by_id(workspace, emp_id)
        if not emp:
            print(f"[Memory API] Employee not found by ID: {emp_id}", flush=True)
            return bad(handler, f"Employee not found: {emp_id}", 404)

        print(f"[Memory API] Found employee: {emp.get('name', '')}, ID: {emp.get('id', '')}", flush=True)

        # 使用员工名称构造目录路径
        emp_dir = _employee_dir(workspace, emp.get("name", ""))
        if not emp_dir.exists():
            return bad(handler, f"Employee directory not found for: {emp.get('name', '')}", 404)'''

new_write = '''def _handle_employee_memory_write(handler, body):
    """POST /api/employee/memory

    Write employee's MEMORY.md and/or USER.md.
    Body: { workspace, id, name, memory_content, user_content }
    """
    workspace = (body.get("workspace") or "").strip()
    emp_id = (body.get("id") or body.get("employee_id") or "").strip()
    emp_name = (body.get("name") or "").strip()

    print(f"[Memory API] POST /api/employee/memory - workspace={workspace}, emp_id={emp_id}, emp_name={emp_name}", flush=True)

    if not workspace:
        return bad(handler, "workspace is required")
    if not emp_id and not emp_name:
        return bad(handler, "id or name is required")

    try:
        from api.employee_fs import get_employee_by_id, _employee_dir, _employees_root, _safe_dirname
        from pathlib import Path

        emp_dir = None

        # 优先使用 name 直接构造路径
        if emp_name:
            root = _employees_root(workspace)
            emp_dir = root / _safe_dirname(emp_name)
            print(f"[Memory API] Using name to construct path: {emp_dir}", flush=True)

        # 如果没有 name 或路径不存在，回退到用 id 查找
        if not emp_dir or not emp_dir.exists():
            if emp_id:
                print(f"[Memory API] Looking up employee by ID: {emp_id}", flush=True)
                emp = get_employee_by_id(workspace, emp_id)
                if not emp:
                    print(f"[Memory API] Employee not found by ID: {emp_id}", flush=True)
                    return bad(handler, f"Employee not found: {emp_id}", 404)
                emp_dir = _employee_dir(workspace, emp.get("name", ""))
            else:
                return bad(handler, "Cannot find employee: neither name nor valid id provided", 404)

        if not emp_dir.exists():
            print(f"[Memory API] Employee directory not found: {emp_dir}", flush=True)
            return bad(handler, f"Employee directory not found for: {emp_name or emp_id}", 404)

        print(f"[Memory API] Employee directory: {emp_dir}", flush=True)'''

# ── 修复 2: _handle_employee_memory_auto_update ─────────────────────────────
old_auto = '''def _handle_employee_memory_auto_update(handler, body):
    """POST /api/employee/memory/auto-update

    Trigger LLM-based memory extraction after a conversation turn.
    Body: { workspace, id, user_message, assistant_response }
    """
    workspace = (body.get("workspace") or "").strip()
    emp_id = (body.get("id") or body.get("employee_id") or "").strip()
    user_message = body.get("user_message", "")
    assistant_response = body.get("assistant_response", "")

    if not workspace:
        return bad(handler, "workspace is required")
    if not emp_id:
        return bad(handler, "id (employee id) is required")
    if not user_message or not assistant_response:
        return bad(handler, "user_message and assistant_response are required")

    try:
        # ★ 修复：先用员工 ID 查找员工，获取员工名称
        from api.employee_fs import get_employee_by_id
        emp = get_employee_by_id(workspace, emp_id)
        if not emp:
            return bad(handler, f"Employee not found: {emp_id}", 404)

        # 使用员工名称调用 sync_employee_memory_after_turn
        from api.employee_memory import sync_employee_memory_after_turn'''

new_auto = '''def _handle_employee_memory_auto_update(handler, body):
    """POST /api/employee/memory/auto-update

    Trigger LLM-based memory extraction after a conversation turn.
    Body: { workspace, id, name, user_message, assistant_response }
    """
    workspace = (body.get("workspace") or "").strip()
    emp_id = (body.get("id") or body.get("employee_id") or "").strip()
    emp_name = (body.get("name") or "").strip()
    user_message = body.get("user_message", "")
    assistant_response = body.get("assistant_response", "")

    print(f"[Memory API] POST /api/employee/memory/auto-update - workspace={workspace}, emp_id={emp_id}, emp_name={emp_name}", flush=True)

    if not workspace:
        return bad(handler, "workspace is required")
    if not emp_id and not emp_name:
        return bad(handler, "id or name is required")
    if not user_message or not assistant_response:
        return bad(handler, "user_message and assistant_response are required")

    try:
        from api.employee_fs import get_employee_by_id, _employee_dir, _employees_root, _safe_dirname

        emp = None
        emp_dir = None

        # 优先使用 name 直接构造路径并验证目录存在
        if emp_name:
            root = _employees_root(workspace)
            emp_dir = root / _safe_dirname(emp_name)
            print(f"[Memory API] Using name to construct path: {emp_dir}", flush=True)
            if emp_dir.exists():
                # 尝试从目录中的 info.json 加载员工信息
                info_path = emp_dir / "info.json"
                if info_path.exists():
                    try:
                        import json as _json
                        emp = _json.loads(info_path.read_text(encoding='utf-8'))
                    except:
                        emp = None

        # 如果没有 name 或路径不存在，回退到用 id 查找
        if not emp:
            if emp_id:
                print(f"[Memory API] Looking up employee by ID: {emp_id}", flush=True)
                emp = get_employee_by_id(workspace, emp_id)
                if not emp:
                    print(f"[Memory API] Employee not found by ID: {emp_id}", flush=True)
                    return bad(handler, f"Employee not found: {emp_id}", 404)
                emp_dir = _employee_dir(workspace, emp.get("name", ""))
            else:
                return bad(handler, "Cannot find employee: neither name nor valid id provided", 404)

        if not emp_dir or not emp_dir.exists():
            print(f"[Memory API] Employee directory not found: {emp_dir}", flush=True)
            return bad(handler, f"Employee directory not found for: {emp_name or emp_id}", 404)

        print(f"[Memory API] Employee directory: {emp_dir}", flush=True)

        # 使用员工名称调用 sync_employee_memory_after_turn
        from api.employee_memory import sync_employee_memory_after_turn'''

# 执行替换
modified = False

if old_write in content:
    content = content.replace(old_write, new_write)
    print("[OK] Patched _handle_employee_memory_write!")
    modified = True
else:
    print("[WARN] Could not find _handle_employee_memory_write target")
    # 调试：显示前 200 个字符
    idx = content.find('def _handle_employee_memory_write(')
    if idx >= 0:
        print("Found function, first 400 chars:")
        print(repr(content[idx:idx+400]))

if old_auto in content:
    content = content.replace(old_auto, new_auto)
    print("[OK] Patched _handle_employee_memory_auto_update!")
    modified = True
else:
    print("[WARN] Could not find _handle_employee_memory_auto_update target")
    idx = content.find('def _handle_employee_memory_auto_update(')
    if idx >= 0:
        print("Found function, first 500 chars:")
        print(repr(content[idx:idx+500]))

if modified:
    with open(routes_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("\n✅ All patches applied and saved!")
else:
    print("\n❌ No patches applied.")
