#!/usr/bin/env python3
"""One-shot launcher for Hermes WebUI on Windows (loads .env automatically)."""

import os
import sys
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
ENV_FILE = REPO_ROOT / ".env"


def load_dotenv(path: Path) -> None:
    """Load a .env file into os.environ (simple parser, no shell expansion)."""
    if not path.exists():
        print(f"[!!] .env file not found: {path}")
        return
    print(f"[ok] Loading .env from {path}")
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            # Remove surrounding quotes
            if value and value[0] in ('"', "'") and value[-1] == value[0]:
                value = value[1:-1]
            os.environ[key] = value
            print(f"  {key} = {value}")


def main() -> int:
    print("=" * 40)
    print(" Hermes WebUI - Local Launcher")
    print("=" * 40)
    print()

    load_dotenv(ENV_FILE)

    # Verify agent dir
    agent_dir = os.environ.get("HERMES_WEBUI_AGENT_DIR", "")
    if agent_dir and (Path(agent_dir) / "run_agent.py").exists():
        print(f"[ok] Agent found: {agent_dir}")
    else:
        print(f"[!!] Warning: Agent dir invalid or run_agent.py not found: {agent_dir}")

    # Verify HERMES_HOME
    hermes_home = os.environ.get("HERMES_HOME", "")
    if hermes_home and Path(hermes_home).exists():
        print(f"[ok] HERMES_HOME: {hermes_home}")
    else:
        print(f"[!!] Warning: HERMES_HOME not found: {hermes_home}")

    host = os.environ.get("HERMES_WEBUI_HOST", "127.0.0.1")
    port = os.environ.get("HERMES_WEBUI_PORT", "18080")
    access_host = "127.0.0.1" if host in {"0.0.0.0", "::", "[::]"} else host
    print()
    print(f"[ok] Listening on http://{host}:{port}")
    print(f"[ok] Open in browser: http://{access_host}:{port}")
    print()


    # Start server.py in the same process so env vars are inherited
    os.chdir(str(REPO_ROOT))
    import server
    server.main()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n[ok] Shutting down...")
        sys.exit(0)
