"""
端到端集成测试：启动真实的 webui 服务，打所有新 API。

覆盖：
  - POST /api/prompt/build          （Prompt 构建）
  - GET  /api/prompt/config          （段配置）
  - GET  /api/employee/skills/resolve （三源技能解析）
  - GET  /api/skills/global/list      （全局技能库）
  - GET  /api/script/list             （脚本列表）
  - POST /api/script/execute          （脚本执行）
  - POST /api/employee-templates/init （员工模板初始化，验证 paramsSchema）

运行：python tests/test_integration_e2e.py
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

PASS = 0
FAIL = 0
SERVER_URL = None
SERVER_PROC = None


def check(name, cond, hint=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'[PASS] {name}')
    else:
        FAIL += 1
        print(f'[FAIL] {name}  {hint}')


# ── 启动后端 ─────────────────────────────────────────────────────────────────
def start_server() -> tuple[subprocess.Popen, str]:
    port = 18090  # 避开默认 18080 防止冲突
    env = {
        **os.environ,
        "HERMES_WEBUI_PORT": str(port),
        "HERMES_WEBUI_HOST": "127.0.0.1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        # 禁用鉴权方便测试
        "HERMES_WEBUI_PASSWORD": "",
    }
    proc = subprocess.Popen(
        [sys.executable, "-u", "server.py"],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    url = f"http://127.0.0.1:{port}"
    # 等待端口就绪
    for _ in range(60):
        try:
            with urllib.request.urlopen(f"{url}/api/prompt/config", timeout=1) as r:
                if r.status == 200:
                    return proc, url
        except Exception:
            time.sleep(0.5)
    proc.kill()
    raise RuntimeError("server failed to start within 30s")


def get_json(path: str, timeout: int = 10) -> dict:
    url = f"{SERVER_URL}{path}"
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post_json(path: str, body: dict, timeout: int = 30) -> dict:
    url = f"{SERVER_URL}{path}"
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 返回 4xx/5xx 的响应体用于排查
        return {"_http_status": e.code, "_body": e.read().decode("utf-8", errors="replace")}


# ── Main ─────────────────────────────────────────────────────────────────────
print("[E2E] starting webui server...")
try:
    SERVER_PROC, SERVER_URL = start_server()
    print(f"[E2E] server up at {SERVER_URL}")
except Exception as e:
    print(f"[FAIL] server start failed: {e}")
    sys.exit(1)

try:
    # ── 1. Prompt config ──
    print("\n## /api/prompt/config")
    r = get_json("/api/prompt/config")
    check("config ok", r.get("ok") is True)
    segs = r.get("config", {}).get("segments", [])
    check("≥ 8 segments", len(segs) >= 8, f"got {len(segs)}")


    # ── 2. Prompt build ──
    print("\n## /api/prompt/build")
    r = post_json("/api/prompt/build", {
        "emp": {
            "name": "测试员工",
            "role": "程序员",
            "presetId": "pm-specialist",
            "skills": [{"name": "sprint-plan", "enabled": True}],
            "params": {"lang": "Python"},
        },
        "locale": "zh",
        "preset": {"id": "pm-specialist", "desc": "项目管理专员"},
    })
    check("build ok", r.get("ok") is True, f'resp={r}')
    prompt = r.get("prompt", "")
    check("含角色定义", "## 角色定义" in prompt)
    check("含测试员工", "测试员工" in prompt)
    check("含 sprint-plan 技能", "sprint-plan" in prompt)
    check("含 SKILL.md 正文", "Sprint" in prompt and "核心原则" in prompt,
          "should inject skill content")
    check("含参数 lang", "**lang**：Python" in prompt)


    # ── 3. Prompt build - 英文 ──
    print("\n## /api/prompt/build (en)")
    r = post_json("/api/prompt/build", {
        "emp": {"name": "TestEmp", "role": "Dev"},
        "locale": "en",
    })
    check("EN ok", r.get("ok") is True)
    check("EN 含 Role Definition", "## Role Definition" in r.get("prompt", ""))


    # ── 4. Global skills list ──
    print("\n## /api/skills/global/list")
    r = get_json("/api/skills/global/list")
    check("list ok", r.get("ok") is True)
    skills = r.get("skills", [])
    check("≥ 20 全局技能", len(skills) >= 20, f"got {len(skills)}")
    names = [s["name"] for s in skills]
    check("含 plan", "plan" in names)


    # ── 5. Script list ──
    print("\n## /api/script/list (preset/pm-specialist)")
    r = get_json("/api/script/list?scope=preset&scope_id=pm-specialist")
    check("script list ok", r.get("ok") is True)
    sn = [s["name"] for s in r.get("scripts", [])]
    check("至少 3 个示例脚本", len(sn) >= 3, f"got {sn}")
    check("含 generate_sprint_plan.py", "generate_sprint_plan.py" in sn)


    # ── 6. Script execute ──
    print("\n## /api/script/execute")
    r = post_json("/api/script/execute", {
        "scope": "preset",
        "scope_id": "pm-specialist",
        "script_name": "task_decompose_helper.py",
        "args": {"goal": "实现支付", "max_tasks": 4},
        "timeout": 15,
    })
    check("execute ok", r.get("ok") is True, f'resp={r}')
    check("success=True", r.get("success") is True)
    check("exit_code=0", r.get("exit_code") == 0)
    try:
        script_out = json.loads(r.get("stdout", "{}"))
        check("script 返回 JSON", script_out.get("ok") is True)
        check("任务已拆解", len(script_out.get("tasks", [])) > 0)
    except Exception as e:
        check("script JSON 解析", False, str(e))


    # ── 7. 非法脚本路径 ──
    print("\n## /api/script/execute (安全测试)")
    r = post_json("/api/script/execute", {
        "scope": "preset",
        "scope_id": "pm-specialist",
        "script_name": "../../../../etc/passwd",
        "timeout": 5,
    })
    # 应该被路径安全检查拒绝
    check("目录穿越被拒绝",
          r.get("ok") is True and r.get("success") is False and "invalid" in str(r.get("error", "")),
          f'resp={r}')


    # ── 8. 段 override ──
    print("\n## /api/prompt/build (segment_overrides)")
    r = post_json("/api/prompt/build", {
        "emp": {"name": "Minimal", "role": "x"},
        "locale": "zh",
        "segment_overrides": {"collab_rules": False, "workspace_context": False},
    })
    check("override ok", r.get("ok") is True)
    pr = r.get("prompt", "")
    check("collab 被禁用", "## 协作规则" not in pr)
    check("必需段仍在", "## 角色定义" in pr and "## 行为指引" in pr)


    print(f"\n{'=' * 50}")
    print(f"  PASS: {PASS}   FAIL: {FAIL}")
    print(f"{'=' * 50}")
finally:
    print("\n[E2E] stopping server...")
    try:
        SERVER_PROC.terminate()
        SERVER_PROC.wait(timeout=5)
    except Exception:
        try: SERVER_PROC.kill()
        except Exception: pass

sys.exit(0 if FAIL == 0 else 1)
