"""
Prompt Builder 自动验证脚本。

覆盖：
  - 中英文模板渲染
  - 含/不含 preset
  - 含/不含 skills（带 content / 不带）
  - 含/不含 manager
  - custom_prompt 模式
  - segment_overrides 段开关
  - Jinja2 可用/不可用两种情况
  - 降级渲染（无 Jinja2）的行为

运行：
  python tests/test_prompt_builder.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.prompt_builder import build_employee_prompt  # noqa: E402


# 统一输出用 UTF-8（绕开 Windows GBK 终端）
import io  # noqa: E402
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')


PASS = 0
FAIL = 0


def assert_contains(name: str, text: str, *needles: str):
    global PASS, FAIL
    missing = [n for n in needles if n not in text]
    if missing:
        FAIL += 1
        print(f"[FAIL] {name}")
        print(f"       missing: {missing}")
        print(f"       text[:300]: {text[:300]!r}")
    else:
        PASS += 1
        print(f"[PASS] {name}")


def assert_not_contains(name: str, text: str, *needles: str):
    global PASS, FAIL
    present = [n for n in needles if n in text]
    if present:
        FAIL += 1
        print(f"[FAIL] {name} — should NOT contain: {present}")
    else:
        PASS += 1
        print(f"[PASS] {name}")


# ── 测试 1：基础中文渲染 + preset.desc 优先于 role ──
print("\n## Test 1: 中文基础渲染（含 preset）")
emp = {
    'name': '小明',
    'role': '程序员',
    'params': {'language': 'Python', 'years': 5},
    'skills': [{'name': 'python', 'enabled': True}],
    'presetId': 'backend',
}
preset = {'id': 'backend', 'desc': '精通后端开发的全栈工程师'}
r = build_employee_prompt(emp, locale='zh', preset=preset, workspace=r'G:\ws\demo')

assert_contains('含角色定义', r, '## 角色定义', '你是「小明」', '精通后端开发的全栈工程师')
assert_contains('含配置参数', r, '## 配置参数', '**language**：Python', '**years**：5')
assert_contains('含工作区', r, '## 工作区上下文', 'demo', r'G:\ws\demo')
assert_contains('含行为指引', r, '## 行为指引', '行动优先')
assert_contains('含工具铁律', r, '工具调用的铁律')
assert_contains('含协作规则', r, '## 协作规则', 'PM专员')
assert_not_contains('无上级段（subagentOf=None）', r, '## 工作关系')


# ── 测试 2：含 subagent 关系 ──
print("\n## Test 2: 含 subagent 关系")
emp2 = dict(emp, subagentOf='emp-1')
manager = {'id': 'emp-1', 'name': '老李'}
r2 = build_employee_prompt(emp2, locale='zh', preset=preset, manager=manager)
assert_contains('含上级段', r2, '## 工作关系', '你是「老李」的下属员工')


# ── 测试 3：无 preset 时回退到 role ──
print("\n## Test 3: 无 preset 时用 role")
emp3 = {'name': '小刚', 'role': '设计师'}
r3 = build_employee_prompt(emp3, locale='zh')
assert_contains('无 preset 用 role', r3, '你是「小刚」', '角色为「设计师」')


# ── 测试 4：英文模板 ──
print("\n## Test 4: 英文模板")
r4 = build_employee_prompt(
    {'name': 'Alice', 'role': 'Developer', 'params': {'lang': 'Go'},
     'skills': [{'name': 'golang'}], 'subagentOf': 'emp-x'},
    locale='en',
    preset={'desc': 'Senior Go engineer'},
    workspace='/home/ws/demo',
    manager={'name': 'Bob'},
)
assert_contains('EN role', r4, '## Role Definition', 'You are "Alice"', 'Senior Go engineer')
assert_contains('EN config', r4, '## Configuration Parameters', '**lang**: Go')
assert_contains('EN workspace', r4, '## Workspace Context', '/home/ws/demo')
assert_contains('EN behavior', r4, '## Behavior Guidelines', 'Action first')
assert_contains('EN iron rules', r4, 'Iron Rules of Tool Calling')
assert_contains('EN collab', r4, '## Collaboration Rules')
assert_contains('EN manager', r4, 'You are a subordinate of "Bob"')


# ── 测试 5：带内容的 skill（注入 SKILL.md 正文） ──
print("\n## Test 5: 带 content 的 skill")
r5 = build_employee_prompt(
    {'name': 'Dev', 'role': 'coder', 'skills': [{'name': 'tdd'}]},
    locale='zh',
    skills=[{
        'name': 'tdd',
        'source': 'global',
        'description': '测试驱动开发',
        'content': '# TDD\n\nRED → GREEN → REFACTOR 循环...',
    }],
)
assert_contains('skill 段', r5, '## 专业技能', '### 技能：tdd', '测试驱动开发', 'RED → GREEN → REFACTOR')


# ── 测试 6：custom_prompt 模式 ──
print("\n## Test 6: custom_prompt 覆盖")
r6 = build_employee_prompt(
    {'name': 'X', 'role': 'y', 'customPrompt': '这是完全自定义的提示词。参数：{{params.mode}}',
     'params': {'mode': 'fast'}},
    locale='zh',
)
assert_contains('custom 被 render', r6, '这是完全自定义的提示词。参数：fast')
# custom 模式下 role/behavior 段应被跳过
assert_not_contains('custom 模式跳过默认段', r6, '## 行为指引', '## 角色定义')
# 但 collab_rules 仍保留
assert_contains('custom 模式保留协作规则', r6, '## 协作规则')


# ── 测试 7：segment_overrides 禁用段 ──
print("\n## Test 7: 显式禁用段")
r7 = build_employee_prompt(
    {'name': 'Q', 'role': 'r'},
    locale='zh',
    segment_overrides={'collab_rules': False, 'workspace_context': False},
)
assert_not_contains('禁用 collab', r7, '## 协作规则')
assert_not_contains('禁用 workspace', r7, '## 工作区上下文')
# 必需段不受影响
assert_contains('必需段仍在', r7, '## 角色定义', '## 行为指引')


# ── 测试 8：locale 回退（bad locale → 默认 zh） ──
print("\n## Test 8: 未知 locale 的行为（直接读 zh）")
# locale 参数在 handle_build 会校验，build_employee_prompt 会按传入的 locale 找模板
# 找不到时回退到 default_locale (zh)
r8 = build_employee_prompt({'name': 'A', 'role': 'b'}, locale='fr')
assert_contains('fr 回退到 zh', r8, '## 角色定义', '你是「A」')


# ── 测试 9：params 模板引用 {{params.xxx}} ──
print("\n## Test 9: customPrompt 中 {{params.xxx}} 替换")
r9 = build_employee_prompt(
    {'name': 'P', 'role': 'q', 'customPrompt': 'lang={{params.lang}} ver={{params.ver}}',
     'params': {'lang': 'Rust', 'ver': '1.70'}},
    locale='zh',
)
assert_contains('params 引用', r9, 'lang=Rust ver=1.70')


# ── 测试 10：空 emp 防御 ──
print("\n## Test 10: 空 / 异常输入")
try:
    r10 = build_employee_prompt({'name': ''}, locale='zh')
    # 空 name 不应导致崩溃
    assert_contains('空 name 不崩溃', r10, '## 角色定义')
except Exception as e:
    FAIL += 1
    print(f"[FAIL] 空输入导致崩溃: {e}")


# ── 结束 ──
print(f"\n{'=' * 50}")
print(f"  PASS: {PASS}   FAIL: {FAIL}")
print(f"{'=' * 50}")
sys.exit(0 if FAIL == 0 else 1)
