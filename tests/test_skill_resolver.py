"""
Skill Resolver 自动验证。

覆盖：
  - Preset 源查找
  - Global 源查找
  - 未指定 source 的三源回退
  - 显式 source 不回退
  - Skill 未找到时的返回结构
  - resolve_employee_skills 整体
  - handle_list_global 扫描全局库

运行：python tests/test_skill_resolver.py
"""
import io, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from api.skill_resolver import (  # noqa: E402
    resolve_skill,
    resolve_employee_skills,
    GLOBAL_SKILLS_DIR,
)
from api.prompt_builder import build_employee_prompt  # noqa: E402


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


# ── Test 1: preset 源（pm-specialist 有多个 skill） ──
print('\n## Test 1: preset 源查找')
r = resolve_skill('sprint-plan', preset_id='pm-specialist')
check('找到 sprint-plan', r.get('found'))
check('来源是 preset', r.get('source') == 'preset', f"got {r.get('source')}")
check('有 content', len(r.get('content', '')) > 500)
check('有 description', 'Sprint' in r.get('description', '') or len(r.get('description', '')) > 0)


# ── Test 2: global 源（hermes-agent/skills） ──
print('\n## Test 2: global 源查找')
check('GLOBAL_SKILLS_DIR 存在', GLOBAL_SKILLS_DIR is not None)
r2 = resolve_skill('plan', preset_id='', workspace='')
check('找到 plan', r2.get('found'))
check('plan 来自 global', r2.get('source') == 'global')

r3 = resolve_skill('systematic-debugging')
check('找到 systematic-debugging', r3.get('found'))
check('systematic-debugging 来自 global', r3.get('source') == 'global')


# ── Test 3: 三源回退 ──
print('\n## Test 3: 三源回退（preset 没有则回退 global）')
# writer 预设有 writing.md，应从 preset 命中
rw = resolve_skill('writing', preset_id='writer')
check('writer 的 writing 从 preset 命中', rw.get('found') and rw.get('source') == 'preset')

# ai-programmer 没有 'plan'，应回退到 global
rb = resolve_skill('plan', preset_id='ai-programmer')
check('ai-programmer 的 plan 回退到 global', rb.get('found') and rb.get('source') == 'global')


# ── Test 4: 显式 source 不回退 ──
print('\n## Test 4: 显式 source 不回退')
r4a = resolve_skill({'name': 'plan', 'source': 'preset'}, preset_id='ai-programmer')
check('显式 preset 源未命中', not r4a.get('found'),
      f"source={r4a.get('source')} found={r4a.get('found')}")

r4b = resolve_skill({'name': 'plan', 'source': 'global'})
check('显式 global 源命中 plan', r4b.get('found') and r4b.get('source') == 'global')


# ── Test 5: 未找到的 skill 返回结构 ──
print('\n## Test 5: 未找到时的返回')
r5 = resolve_skill('nonexistent-skill-xxx')
check('未找到 found=False', not r5.get('found'))
check('仍有 name', r5.get('name') == 'nonexistent-skill-xxx')
check('content 为空', r5.get('content') == '')


# ── Test 6: resolve_employee_skills 整体 ──
print('\n## Test 6: resolve_employee_skills')
emp = {
    'name': 'PM小张',
    'presetId': 'pm-specialist',
    'skills': [
        'sprint-plan',
        {'name': 'task-decompose', 'enabled': True},
        {'name': 'nonexistent', 'enabled': True},
        {'name': 'disabled-one', 'enabled': False},   # disabled 应被过滤
    ],
}
resolved = resolve_employee_skills(emp, workspace='')
enabled_count = len(resolved)
check('disabled 已过滤', enabled_count == 3, f'got {enabled_count}')
found_names = [s['name'] for s in resolved if s.get('found')]
check('sprint-plan 找到', 'sprint-plan' in found_names)
check('task-decompose 找到', 'task-decompose' in found_names)


# ── Test 7: prompt_builder 自动解析 skills（handle_build 路径） ──
print('\n## Test 7: prompt_builder 集成 skill 内容')
# 构造一个带 skill 的员工，不显式传 skills，让 build 自动解析
# 但注意 build_employee_prompt 的 skills 参数需要显式传入才会渲染；
# 我们验证一下手动传入已解析 skill 的情况
skills = resolve_employee_skills(
    {'presetId': 'pm-specialist', 'skills': ['sprint-plan']},
    workspace='',
)
prompt = build_employee_prompt(
    {'name': 'PMTest', 'role': '主管', 'presetId': 'pm-specialist',
     'skills': [{'name': 'sprint-plan', 'enabled': True}]},
    locale='zh',
    preset={'desc': '项目管理专员', 'id': 'pm-specialist'},
    skills=skills,
)
check('prompt 含 sprint-plan', 'sprint-plan' in prompt)
check('prompt 含 SKILL 内容', 'Sprint' in prompt and '工时' in prompt)
check('prompt 含来源标记', 'preset' in prompt)


# ── Test 8: handle_list_global（列举全局 skill 库） ──
print('\n## Test 8: 列举全局 skill 库')
from api.skill_resolver import handle_list_global

class MockHandler:
    def __init__(self):
        self.response = None
        self.status = None
        self.headers = {}
    def send_response(self, code): self.status = code
    def send_header(self, k, v): self.headers[k] = v
    def end_headers(self): pass
    @property
    def wfile(self):
        class W:
            def __init__(self, outer): self.outer = outer
            def write(self, b):
                import json as _j
                self.outer.response = _j.loads(b.decode('utf-8'))
        return W(self)

h = MockHandler()
handle_list_global(h, None)
check('list_global 返回 ok', h.response and h.response.get('ok') is True)
check('skills 数量 > 20', h.response and len(h.response.get('skills', [])) > 20,
      f"got {len(h.response.get('skills', [])) if h.response else 0}")

# 看看有没有熟悉的技能
names = [s['name'] for s in (h.response or {}).get('skills', [])]
check('包含 plan', 'plan' in names)
check('包含 systematic-debugging', 'systematic-debugging' in names)


# ── 结束 ──
print(f"\n{'=' * 50}")
print(f"  PASS: {PASS}   FAIL: {FAIL}")
print(f"{'=' * 50}")
sys.exit(0 if FAIL == 0 else 1)
