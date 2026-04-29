"""
Employee Scripts 执行器自动验证。

运行：python tests/test_employee_scripts.py
"""
import io, sys, json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from api.employee_scripts import (  # noqa: E402
    list_scripts,
    execute_script,
    _safe_script_path,
    _scripts_dir_for,
)

PASS = 0
FAIL = 0


def check(name, cond, hint=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'[PASS] {name}')
    else:
        FAIL += 1
        print(f'[FAIL] {name}  {hint}')


# ── Test 1: 列出 pm-specialist 预设脚本 ──
print('\n## Test 1: list_scripts preset/pm-specialist')
items = list_scripts('preset', 'pm-specialist')
check('至少 3 个脚本', len(items) >= 3, f'got {len(items)}')
names = [i['name'] for i in items]
check('含 generate_sprint_plan.py', 'generate_sprint_plan.py' in names)
check('含 task_decompose_helper.py', 'task_decompose_helper.py' in names)
check('含 workspace_health_check.py', 'workspace_health_check.py' in names)
# 检查描述被提取
for item in items:
    check(f'{item["name"]} 有描述', len(item.get('description', '')) > 10)


# ── Test 2: 路径安全（拒绝目录穿越） ──
print('\n## Test 2: 路径安全')
scripts_dir = _scripts_dir_for('preset', 'pm-specialist')
check('scripts_dir 存在', scripts_dir and scripts_dir.is_dir())
# 直穿越
check('拒绝 ../',
      _safe_script_path(scripts_dir, '../../../../../etc/passwd.py') is None)
check('拒绝绝对路径',
      _safe_script_path(scripts_dir, '/etc/passwd.py') is None)
check('拒绝 .sh 扩展',
      _safe_script_path(scripts_dir, 'generate_sprint_plan.sh') is None)
check('接受合法 .py',
      _safe_script_path(scripts_dir, 'generate_sprint_plan.py') is not None)


# ── Test 3: 执行 task_decompose_helper.py（正常流程） ──
print('\n## Test 3: 执行脚本（local mode）')
result = execute_script(
    scope='preset',
    scope_id='pm-specialist',
    script_name='task_decompose_helper.py',
    args={'goal': '实现用户登录', 'max_tasks': 5},
    timeout=30,
    mode='local',
)
check('success=True', result.get('success'), f'result={result}')
check('exit_code=0', result.get('exit_code') == 0)
check('有 stdout', len(result.get('stdout', '')) > 0)
# 解析输出 JSON
try:
    parsed = json.loads(result.get('stdout', '').strip())
    check('stdout 是合法 JSON', parsed.get('ok') is True)
    check('有任务列表', len(parsed.get('tasks', [])) > 0)
except Exception as e:
    check('stdout 是合法 JSON', False, str(e))


# ── Test 4: 执行 workspace_health_check.py ──
print('\n## Test 4: 执行 workspace_health_check.py')
result2 = execute_script(
    scope='preset',
    scope_id='pm-specialist',
    script_name='workspace_health_check.py',
    args={'workspace': str(ROOT)},
    timeout=15,
)
check('health check success', result2.get('success'), f'result={result2}')
try:
    pr = json.loads(result2.get('stdout', '').strip())
    check('health ok=True', pr.get('ok') is True)
    check('有 file_count', 'file_count' in pr.get('checks', {}))
except Exception as e:
    check('health output 是 JSON', False, str(e))


# ── Test 5: 执行不存在的脚本 ──
print('\n## Test 5: 脚本不存在')
bad = execute_script(
    scope='preset',
    scope_id='pm-specialist',
    script_name='__nonexistent__.py',
    timeout=5,
)
check('失败且有 error', (not bad.get('success')) and 'error' in bad,
      f'got {bad}')


# ── Test 6: 无效 scope ──
print('\n## Test 6: 无效 scope')
bad2 = execute_script(
    scope='invalid-scope',
    scope_id='xxx',
    script_name='anything.py',
    timeout=5,
)
check('无效 scope 失败', not bad2.get('success'))


# ── Test 7: 超时 ──
print('\n## Test 7: 超时测试')
# 先写一个故意阻塞的脚本到临时位置
import tempfile, os
tmp_dir = Path(tempfile.mkdtemp(prefix='hermes_script_test_'))
sleep_script = tmp_dir / 'sleep.py'
sleep_script.write_text('import time\nimport sys\ntime.sleep(30)\n', encoding='utf-8')

# 用 absolute workspace 路径模式执行
# 由于 execute_script 只接受预设的 scope，我们直接调内部函数 _run_local
from api.employee_scripts import _run_local
tr = _run_local(sleep_script, {}, timeout=2, cwd=tmp_dir)
check('超时被捕获', not tr.get('success') and 'timeout' in str(tr.get('error', '')),
      f'got {tr}')

import shutil
shutil.rmtree(str(tmp_dir), ignore_errors=True)


# ── Test 8: Agent tool registered ──
print('\n## Test 8: Agent tool 是否已注册')
try:
    from tools.registry import registry
    # 从 registry 获取 tool 列表
    tools_by_set = {}
    for name, entry in registry._tools.items():  # 直接访问内部字典
        tools_by_set.setdefault(entry.toolset, []).append(name)
    check('employee_scripts toolset 存在',
          'employee_scripts' in tools_by_set,
          f'toolsets={list(tools_by_set.keys())[:10]}')
    check('run_employee_script 已注册',
          'run_employee_script' in tools_by_set.get('employee_scripts', []))
except Exception as e:
    check('Agent tool 注册', False, f'skipped or failed: {e}')


# ── 结束 ──
print(f"\n{'=' * 50}")
print(f"  PASS: {PASS}   FAIL: {FAIL}")
print(f"{'=' * 50}")
sys.exit(0 if FAIL == 0 else 1)
