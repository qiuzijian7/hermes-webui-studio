"""只修复 _handle_employee_memory_auto_update 函数"""
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
routes_path = os.path.join(script_dir, 'api', 'routes.py')

with open(routes_path, 'r', encoding='utf-8') as f:
    content = f.read()

print("Patching _handle_employee_memory_auto_update...")

# 旧函数体开始（从 try: 之后）
old = '''    try:
        # 修复：先用员工 ID 查找员工，获取员工名称
        from api.employee_fs import get_employee_by_id
        emp = get_employee_by_id(workspace, emp_id)
        if not emp:
            return bad(handler, f"Employee not found: {emp_id}", 404)

        # 使用员工名称调用 sync_employee_memory_after_turn
        from api.employee_memory import sync_employee_memory_after_turn'''

# 新函数体
new = '''    try:
        from api.employee_fs import get_employee_by_id, _employee_dir, _employees_root, _safe_dirname

        emp = None
        emp_dir = None

        # 优先使用 name 直接构造路径并验证目录存在
        emp_name = (body.get("name") or "").strip()
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
        print(f"[Memory API] Employee: {emp.get('name', '')}, ID: {emp.get('id', '')}", flush=True)

        # 使用员工名称调用 sync_employee_memory_after_turn
        from api.employee_memory import sync_employee_memory_after_turn'''

if old in content:
    content = content.replace(old, new)
    with open(routes_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("[OK] Patched _handle_employee_memory_auto_update!")
else:
    print("[WARN] Could not find target code block")
    # 调试：显示 try: 块的内容
    idx = content.find('def _handle_employee_memory_auto_update(')
    if idx >= 0:
        # 找到 try: 的位置
        try_idx = content.find('    try:', idx)
        if try_idx >= 0:
            print("Found try: block, first 500 chars:")
            print(repr(content[try_idx:try_idx+500]))
