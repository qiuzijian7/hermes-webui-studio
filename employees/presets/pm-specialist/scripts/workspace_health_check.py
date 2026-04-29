"""
工作区健康检查（供 PM 专员日常巡检）。

输入（stdin JSON）：
    {"workspace": "/absolute/path/to/workspace"}   # 可选；为空则用当前 CWD

输出（stdout JSON）：
    {
        "ok": true,
        "workspace": "...",
        "checks": {
            "has_readme": true,
            "has_plan": true,
            "file_count": 42,
            "largest_file_kb": 120,
            "md_count": 5
        },
        "warnings": ["No SPRINT.md found", ...]
    }
"""
import json
import os
import sys
from pathlib import Path


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}

    ws_path = (payload.get("workspace") or os.getcwd()).strip()
    ws = Path(ws_path)
    if not ws.is_dir():
        print(json.dumps({"ok": False, "error": f"workspace not a dir: {ws_path}"}))
        return 1

    checks: dict = {}
    warnings: list = []

    # 关键文档
    def _exists(name_variants: list[str]) -> bool:
        for n in name_variants:
            if (ws / n).is_file():
                return True
        return False

    checks["has_readme"] = _exists(["README.md", "readme.md", "README.txt"])
    checks["has_plan"] = _exists(["PLAN.md", "plan.md", "PLANNING.md"])
    checks["has_sprint"] = _exists(["SPRINT.md", "SPRINTS.md", "sprints.md"])
    checks["has_tasks"] = _exists(["TASKS.md", "TODO.md", "tasks.md"])

    if not checks["has_readme"]:
        warnings.append("No README found — project purpose unclear")
    if not checks["has_plan"] and not checks["has_sprint"]:
        warnings.append("No PLAN / SPRINT doc — roadmap missing")

    # 文件统计（浅层，避免巨大）
    file_count = 0
    md_count = 0
    largest_kb = 0
    for p in ws.iterdir():
        if p.is_file():
            file_count += 1
            if p.suffix.lower() == ".md":
                md_count += 1
            size_kb = p.stat().st_size // 1024
            if size_kb > largest_kb:
                largest_kb = size_kb

    checks["file_count"] = file_count
    checks["md_count"] = md_count
    checks["largest_file_kb"] = largest_kb

    if file_count == 0:
        warnings.append("Workspace is empty")
    if largest_kb > 500:
        warnings.append(f"Large file detected ({largest_kb} KB) — consider splitting")

    print(json.dumps({
        "ok": True,
        "workspace": str(ws),
        "checks": checks,
        "warnings": warnings,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
