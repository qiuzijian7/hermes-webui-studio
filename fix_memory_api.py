"""修复 _handle_employee_memory_read 函数，优先使用 name 参数"""
import re
import os

script_dir = os.path.dirname(os.path.abspath(__file__))
routes_path = os.path.join(script_dir, 'api', 'routes.py')

with open(routes_path, 'r', encoding='utf-8') as f:
    content = f.read()

print(f"File size: {len(content)} bytes")
print(f"Looking for function _handle_employee_memory_read...")

# 找到函数的开始位置
func_start = content.find('def _handle_employee_memory_read(')
if func_start == -1:
    print("[ERROR] Function not found!")
    exit(1)

print(f"Function starts at index: {func_start}")

# 找到函数的结束位置（下一个 def 或文件结束）
next_def = content.find('\ndef ', func_start + 1)
if next_def == -1:
    func_body = content[func_start:]
else:
    func_body = content[func_start:next_def]

print(f"Function length: {len(func_body)} chars")
print("---FIRST 300 CHARS OF FUNCTION ---")
print(repr(func_body[:300]))
print("---LAST 200 CHARS OF FUNCTION ---")
print(repr(func_body[-200:]))

# 新函数开始
new_start = '''def _handle_employee_memory_read(handler, parsed):
    """GET /api/employee/memory?workspace=...&id=...&name=...

    Read employee's MEMORY.md and USER.md.
    Priority: name > id (to avoid filesystem lookup if name is provided).
    """
    from urllib.parse import parse_qs
    qs = parse_qs(parsed.query)
    workspace = (qs.get("workspace", [None])[0] or "").strip()
    emp_id = (qs.get("id", [None])[0] or "").strip()
    emp_name = (qs.get("name", [None])[0] or "").strip()

    print(f"[Memory API] GET /api/employee/memory - workspace={workspace}, emp_id={emp_id}, emp_name={emp_name}", flush=True)

    if not workspace:
        return bad(handler, "workspace is required")
    if not emp_id and not emp_name:
        return bad(handler, "id or name is required")

    try:
        from api.employee_fs import get_employee_by_id, _employee_dir, _employees_root, _safe_dirname
        from pathlib import Path

        emp_dir = None

        # 优先使用 name 直接构造路径（前端已提供 name）
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

# 替换函数开始部分
if func_body.startswith('def _handle_employee_memory_read('):
    # 找到 try: 之后的内容，然后替换到 emp_dir 打印之后
    # 简化为：直接替换整个函数
    # 我们需要找到函数体的结束位置（except Exception as e:）
    except_pos = func_body.find('    except Exception as e:')
    if except_pos == -1:
        print("[ERROR] Could not find 'except Exception as e:' in function!")
        exit(1)

    # 完整新函数
    new_func = new_start + '''\n        mem_file = emp_dir / "MEMORY.md"\n        user_file = emp_dir / "USER.md"\n\n        memory = mem_file.read_text(encoding="utf-8", errors="replace") if mem_file.exists() else ""\n        user = user_file.read_text(encoding="utf-8", errors="replace") if user_file.exists() else ""\n\n        return j(handler, {\n            "ok": True,\n            "memory": memory,\n            "user": user,\n            "memory_path": str(mem_file),\n            "user_path": str(user_file),\n            "memory_mtime": mem_file.stat().st_mtime if mem_file.exists() else None,\n            "user_mtime": user_file.stat().st_mtime if user_file.exists() else None,\n        })\n\n    except Exception as e:\n        print(f"[Memory API] Error: {e}", flush=True)\n        return bad(handler, str(e), 500)\n'''

    # 替换
    content_new = content[:func_start] + new_func + content[func_start + except_pos + len('    except Exception as e:'):]

    with open(routes_path, 'w', encoding='utf-8') as f:
        f.write(content_new)

    print("[OK] Successfully patched _handle_employee_memory_read!")
    print("Changes:")
    print("  - Added emp_name parameter")
    print("  - Priority: name > id")
    print("  - Removed excessive debug logs")
else:
    print("[ERROR] Function body doesn't start as expected")
    exit(1)
