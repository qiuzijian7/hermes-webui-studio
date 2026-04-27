"""knot-cli 诊断脚本。

用途
----
在不经过 WebUI 的情况下，用和 WebUI 完全相同的 subprocess 参数 (UTF-8 编码、
Popen line-buffered、stdin/stdout/stderr 管道) 跑一批 knot-cli 命令组合，
帮助定位："在 shell 里能跑，但在 WebUI 里不能跑" 的确切差异点。

怎么跑
-------
直接运行即可：
    python hermes-webui-studio/scripts/test_knot_cli.py

可选参数：
    --cmd  <path>    指定 knot-cli 可执行文件路径 (默认用 PATH 里的 knot-cli)
    --model <id>     指定模型 (默认 glm-5.1)
    --only <case>    只跑指定的用例名 (见 CASES 里的 key)
    --list           列出所有用例名后退出

每个用例会打印：
    [argv]       最终 argv (shlex quote 展示)
    [stdin]      stdin 内容预览 (若有)
    [stdout]     子进程标准输出
    [stderr]     子进程标准错误
    [returncode] 退出码
    [verdict]    PASS / FAIL / SUSPECT (基于启发式)
"""
from __future__ import annotations

import argparse
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import List, Optional


DEFAULT_MODEL = "glm-5.1"


# ──────────────────────────────────────────────────────────────────────────
# 测试用例定义
# ──────────────────────────────────────────────────────────────────────────

SHORT_SYSTEM = "你是「制作人」，请用一句话回答用户问题。"

LONG_SYSTEM = """## 角色定义
你是「制作人」，确保项目按时交付，管理冲刺计划、范围和跨部门协调。

## 专业技能
你擅长以下领域：sprint-plan、scope-check、estimate。

## 行为指引
- 始终以「制作人」身份回应，保持角色一致性
- 根据你的角色和技能，提供专业、精准的建议
- 如果问题超出你的专业领域，坦诚说明

## 管理范围
你管理以下下属员工：技术总监、游戏设计师、艺术总监、QA 负责人。

## 协作建议
- 复杂任务请使用 delegate_task 分解
- 需要协助时用 send_group_message @对方名
- 定期汇报进度
""".strip()


@dataclass
class Case:
    """单个测试用例。

    extra_args 里可以用占位符 {SESSION_ID} / {USER_RULES_FILE}，
    run() 会在运行时替换成实际路径/随机 id。
    """
    name: str
    desc: str
    extra_args: List[str] = field(default_factory=list)
    prompt: Optional[str] = "你好"     # -p 的值；None 则不传 -p
    stdin: Optional[str] = None       # 走 stdin 的 payload
    system_file_content: Optional[str] = None  # 若非 None，会生成临时文件替换 {USER_RULES_FILE}
    session_id: Optional[str] = None  # 若非 None，替换 {SESSION_ID}


CASES = {
    # ── 基线：确认裸命令可用 ────────────────────────────────────────
    "01_bare_p_hello": Case(
        name="01_bare_p_hello",
        desc="最简: chat -m <model> -p 'hello'  (你手工跑成功的那个)",
        extra_args=[],
        prompt="hello",
    ),
    "02_bare_p_chinese": Case(
        name="02_bare_p_chinese",
        desc="最简 + 中文: chat -m <model> -p '你好'",
        extra_args=[],
        prompt="你好",
    ),

    # ── sessionId 相关 ─────────────────────────────────────────────
    "03_with_session_random": Case(
        name="03_with_session_random",
        desc="加一个从没见过的 sessionId，看 knot-cli 是否接受",
        extra_args=["--sessionId", "{SESSION_ID}"],
        prompt="你好",
        session_id="webui-test-aaaa1111",
    ),

    # ── --user-rules 相关 (短/长) ──────────────────────────────────
    "04_user_rules_short": Case(
        name="04_user_rules_short",
        desc="--user-rules 指向短 system 文件 + -p '你好'",
        extra_args=["--user-rules", "{USER_RULES_FILE}"],
        prompt="你好",
        system_file_content=SHORT_SYSTEM,
    ),
    "05_user_rules_long": Case(
        name="05_user_rules_long",
        desc="--user-rules 指向 2000+ 字符的制作人 system + -p '你好'",
        extra_args=["--user-rules", "{USER_RULES_FILE}"],
        prompt="你好",
        system_file_content=LONG_SYSTEM,
    ),
    "06_user_rules_plus_session": Case(
        name="06_user_rules_plus_session",
        desc="WebUI 实际发的组合：--user-rules + --sessionId + -p",
        extra_args=["--user-rules", "{USER_RULES_FILE}", "--sessionId", "{SESSION_ID}"],
        prompt="你好",
        system_file_content=LONG_SYSTEM,
        session_id="webui-test-bbbb2222",
    ),

    # ── prepend 模式：system 拼到 -p 开头 ──────────────────────────
    "07_prepend_short": Case(
        name="07_prepend_short",
        desc="prepend 模式：系统提示 + --- + 用户消息 整个塞给 -p",
        extra_args=[],
        prompt=f"{SHORT_SYSTEM}\n\n---\n\n你好",
    ),
    "08_prepend_long": Case(
        name="08_prepend_long",
        desc="prepend 模式 (长 system, 2000+ 字符)",
        extra_args=[],
        prompt=f"{LONG_SYSTEM}\n\n---\n\n你好",
    ),

    # ── 极端: 缺 -p / 空 -p  (用于复现错误提示) ────────────────────
    "09_missing_p": Case(
        name="09_missing_p",
        desc="故意不传 -p —— 应该命中 'One-time mode' 错误提示",
        extra_args=[],
        prompt=None,
    ),
    "10_empty_p": Case(
        name="10_empty_p",
        desc="传 -p '' —— 应该命中 '提问内容不能为空'",
        extra_args=[],
        prompt="",
    ),

    # ── stdin 模式 ─────────────────────────────────────────────────
    "11_stdin_only": Case(
        name="11_stdin_only",
        desc="不传 -p，但从 stdin 喂 '你好' —— 探 knot-cli 是否支持 stdin",
        extra_args=[],
        prompt=None,
        stdin="你好\n",
    ),

    # ── shell 包装: 通过 cmd.exe /c 启动，绕过 "请使用 knot-cli 进行对话" ─
    "12_cmd_shell_wrapped": Case(
        name="12_cmd_shell_wrapped",
        desc="cmd.exe /c 包装: Windows 关键修复 —— 让父进程是 cmd.exe",
        extra_args=[],  # 会在 run_case 里特判
        prompt="你好",
    ),
    "13_cmd_shell_wrapped_long": Case(
        name="13_cmd_shell_wrapped_long",
        desc="cmd.exe /c 包装 + prepend 长 system",
        extra_args=[],
        prompt=f"{LONG_SYSTEM}\n\n---\n\n你好",
    ),
}


# ──────────────────────────────────────────────────────────────────────────
# 执行器
# ──────────────────────────────────────────────────────────────────────────

def resolve_knot_cli(override: Optional[str]) -> str:
    if override:
        p = os.path.abspath(os.path.expanduser(override))
        if not os.path.exists(p):
            sys.exit(f"[fatal] knot-cli not found at {p}")
        return p
    # 常见路径尝试
    candidates = [
        shutil.which("knot-cli"),
        shutil.which("knot-cli.exe"),
        os.path.expanduser(r"~\background_agent_cli\bin\knot-cli.exe"),
        os.path.expanduser(r"~\background_agent_cli\bin\knot-cli"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    sys.exit("[fatal] cannot locate knot-cli. Pass --cmd <path> explicitly.")


def run_case(cli: str, model: str, case: Case, timeout: int = 60) -> dict:
    """执行单个用例，返回结果字典。"""
    # 处理 system file 临时文件
    tmp_rules: Optional[str] = None
    if case.system_file_content is not None:
        tf = tempfile.NamedTemporaryFile(
            mode="w", suffix=".md", prefix="hermes-test-sysprompt-",
            delete=False, encoding="utf-8",
        )
        tf.write(case.system_file_content)
        tf.flush()
        tf.close()
        tmp_rules = tf.name

    # 占位符替换
    subbed: List[str] = []
    for a in case.extra_args:
        if a == "{USER_RULES_FILE}":
            subbed.append(tmp_rules or "")
        elif a == "{SESSION_ID}":
            subbed.append(case.session_id or "")
        else:
            subbed.append(a)

    argv = [cli, "chat", "-m", model] + subbed
    if case.prompt is not None:
        argv += ["-p", case.prompt]

    # 和 WebUI 相同的 env 设置
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")

    # ★ cmd.exe /c 包装：对标 Windows 修复
    # 必须三个条件: (1) cmd.exe 作为父进程 (2) cmdline 里 knot-cli 用裸名字
    # (3) 用字符串 Popen 形式，否则引号会被 Python 的 list2cmdline 破坏
    popen_target = argv  # 默认 list
    if case.name.startswith("12_") or case.name.startswith("13_"):
        if os.name == "nt":
            cmd_dir = os.path.dirname(cli)
            bare_name = os.path.splitext(os.path.basename(cli))[0]
            env["PATH"] = cmd_dir + os.pathsep + env.get("PATH", "")
            bare_argv = [bare_name] + argv[1:]
            inner = subprocess.list2cmdline(bare_argv)
            popen_target = f"cmd.exe /c {inner}"  # 字符串形式

    # ── 执行 ───────────────────────────────────────────────────────
    t0 = time.time()
    try:
        proc = subprocess.Popen(
            popen_target,
            stdin=subprocess.PIPE if case.stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        try:
            stdout, stderr = proc.communicate(input=case.stdin, timeout=timeout)
            rc = proc.returncode
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            rc = -1
            stderr = (stderr or "") + f"\n[timeout after {timeout}s]"
    except Exception as e:
        stdout, stderr, rc = "", f"[spawn exception] {e}", -2
    dt = time.time() - t0

    # 清理临时 rules 文件
    if tmp_rules:
        try:
            os.unlink(tmp_rules)
        except Exception:
            pass

    # ── 简单裁决 ───────────────────────────────────────────────────
    joined = (stdout + "\n" + stderr).strip()
    verdict = "PASS"
    if rc not in (0, None):
        verdict = "FAIL"
    if "请使用 knot-cli 进行对话" in joined:
        verdict = "FAIL (usage-hint)"
    if "提问内容不能为空" in joined:
        verdict = "FAIL (empty-prompt)"
    if rc == 0 and not stdout.strip() and stderr.strip():
        verdict = "SUSPECT (empty stdout + stderr)"

    return {
        "argv": argv,
        "popen_target": popen_target,
        "stdin": case.stdin,
        "stdout": stdout,
        "stderr": stderr,
        "returncode": rc,
        "elapsed_sec": round(dt, 2),
        "verdict": verdict,
    }


def print_result(case: Case, result: dict) -> None:
    print("=" * 78)
    print(f"[{case.name}] {case.desc}")
    print("-" * 78)
    print("[argv]       " + " ".join(shlex.quote(a) for a in result["argv"]))
    pt = result.get("popen_target")
    if isinstance(pt, str):
        print("[popen_cmd]  " + pt + "   (shell-wrapped string form)")
    elif pt is not None and pt != result["argv"]:
        print("[popen_argv] " + " ".join(shlex.quote(a) for a in pt))
    if result["stdin"] is not None:
        preview = (result["stdin"] or "")[:120].replace("\n", "\\n")
        print(f"[stdin]      {preview}")
    print(f"[returncode] {result['returncode']}   elapsed={result['elapsed_sec']}s")
    if result["stdout"].strip():
        print("[stdout]")
        for line in result["stdout"].rstrip().splitlines():
            print("    " + line)
    if result["stderr"].strip():
        print("[stderr]")
        for line in result["stderr"].rstrip().splitlines():
            print("    " + line)
    print(f"[verdict]    {result['verdict']}")


# ──────────────────────────────────────────────────────────────────────────
# CLI 入口
# ──────────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="knot-cli diagnostic runner")
    ap.add_argument("--cmd", help="path to knot-cli executable (default: auto-detect)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="model id (default: %(default)s)")
    ap.add_argument("--only", help="run only the given case name")
    ap.add_argument("--list", action="store_true", help="list all case names and exit")
    ap.add_argument("--timeout", type=int, default=60, help="per-case timeout (sec)")
    args = ap.parse_args()

    if args.list:
        for k, c in CASES.items():
            print(f"{k:30s}  {c.desc}")
        return

    cli = resolve_knot_cli(args.cmd)
    print(f"[info] knot-cli = {cli}")
    print(f"[info] model    = {args.model}")
    print(f"[info] timeout  = {args.timeout}s")
    print(f"[info] PYTHONIOENCODING=utf-8  PYTHONUTF8=1  (与 WebUI 一致)")
    print()

    selected = [CASES[args.only]] if args.only else list(CASES.values())
    if args.only and args.only not in CASES:
        sys.exit(f"[fatal] unknown case: {args.only}. Use --list to see all.")

    summary: List[tuple] = []
    for case in selected:
        result = run_case(cli, args.model, case, timeout=args.timeout)
        print_result(case, result)
        summary.append((case.name, result["verdict"]))
        print()

    # ── 汇总 ────────────────────────────────────────────────────────
    print("=" * 78)
    print("SUMMARY")
    print("-" * 78)
    for name, v in summary:
        print(f"  {v:32s}  {name}")


if __name__ == "__main__":
    main()
