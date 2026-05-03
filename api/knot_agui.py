"""
Knot AG-UI protocol integration.

Proxies chat requests through the Knot AG-UI SSE protocol,
translating AG-UI events into Hermes internal SSE events
(token / reasoning / tool / done / apperror).

API docs: https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}
Knot CLI docs: https://iwiki.woa.com/p/4018261384

Features:
- Auto-detect and install knot-cli if not present
- Programmatic workspace management via knot-cli
- Retrieve connection_uuid via `knot-cli client-status`
- Workspace commands: `knot-cli workspace --action [list|add|remove]`

Workspace Binding:
  The workspace path is bound at install time via --workspace parameter:
    curl -L 'https://mirrors.tencent.com/repository/generic/knot-cli/install.sh' | \
      bash -s -- --workspace /your/path --token {token} --origin knot
  After installation, the knot-cli instance represents that workspace path.
  Subsequent API calls only need the corresponding agent_client_uuid.
  
  When a workspace has no workid (connection_uuid), the system will:
  1. First try `knot-cli workspace --action add --path <path>` (fast)
  2. If that fails, fallback to the install command with --workspace binding

Note:
- connection_uuid (即 agent_client_uuid) 会自动注入到 chat_extra 中
  当工作区已注册且 connection_uuid 可用时，聊天请求会携带 agent_client_uuid，
  让 Knot 平台关联工作区上下文。如果获取失败，聊天仍可正常进行。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile
import logging

import requests

logger = logging.getLogger(__name__)

# Cache for knot-cli path (avoid repeated which() calls)
_KNOT_CLI_CACHE = None
_KNOT_CLI_CACHE_LOCK = None  # threading.Lock for thread safety

# Connection UUID cache: {workspace_path: connection_uuid}
_WORKSPACE_CONNECTION_CACHE = {}


def check_git_bash() -> dict:
    """Check if Git Bash is available on Windows.
    
    Returns:
        dict: {"available": bool, "path": str or None, "message": str}
    """
    if sys.platform != "win32":
        return {"available": True, "path": "/bin/bash", "message": "Non-Windows platform, bash available"}
    
    bash_paths = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        os.path.expanduser(r"~\scoop\apps\git\current\bin\bash.exe"),
    ]
    for bp in bash_paths:
        if os.path.exists(bp):
            return {"available": True, "path": bp, "message": f"Git Bash found: {bp}"}
    
    return {
        "available": False,
        "path": None,
        "message": "Git Bash 未安装。请先安装 Git for Windows: https://git-scm.com/download/win"
    }


def is_workspace_in_knot_list(workspace_path: str) -> bool:
    """Check if a workspace path is already registered in knot-cli workspace list.
    
    The list_workspaces() output may contain lines like:
      "✅ success", "Current workspaces:", "1. G:\\KnotWorkspace", "2. /path/to/ws"
    We need to strip number prefixes and ignore non-path lines.
    
    Args:
        workspace_path: Path to check
        
    Returns:
        bool: True if workspace is in the knot-cli list
    """
    workspaces = list_workspaces()
    if not workspaces:
        return False
    
    import pathlib
    target = str(pathlib.Path(workspace_path).resolve()).lower()
    
    for ws in workspaces:
        if isinstance(ws, str):
            # Strip numbered prefix like "1. " or "12. "
            cleaned = re.sub(r'^\d+\.\s*', '', ws).strip()
            # Skip non-path lines
            if not cleaned or cleaned.startswith('✅') or cleaned.startswith('success') or cleaned.lower().startswith('current'):
                continue
            try:
                ws_resolved = str(pathlib.Path(cleaned).resolve()).lower()
                if ws_resolved == target:
                    return True
            except (ValueError, OSError):
                continue
        elif isinstance(ws, dict):
            ws_path = ws.get("path", ws.get("workspace", ""))
            if ws_path:
                try:
                    ws_resolved = str(pathlib.Path(ws_path).resolve()).lower()
                    if ws_resolved == target:
                        return True
                except (ValueError, OSError):
                    continue
    return False


def ensure_knot_workspace(workspace_path: str) -> dict:
    """Ensure a workspace is registered in knot-cli.
    
    Uses `knot-cli workspace --action list` to check if the workspace exists.
    If not, uses `knot-cli workspace --action add --path <path>` to register it.
    
    Args:
        workspace_path: Path to ensure is registered
        
    Returns:
        dict: {"ok": bool, "action": "exists"|"added"|"failed", "message": str}
    """
    cli_path = _get_knot_cli_path()
    if not cli_path:
        return {"ok": False, "action": "failed", "message": "knot-cli not installed"}
    
    # Check if workspace is already in the list
    if is_workspace_in_knot_list(workspace_path):
        return {"ok": True, "action": "exists", "message": f"Workspace already registered: {workspace_path}"}
    
    # Not registered — add it
    success, _uuid = add_workspace(workspace_path)
    if success:
        return {"ok": True, "action": "added", "message": f"Workspace added: {workspace_path}"}
    else:
        return {"ok": False, "action": "failed", "message": f"Failed to add workspace: {workspace_path}"}


def remove_knot_workspace(workspace_path: str) -> dict:
    """Remove a workspace from knot-cli registration.
    
    Uses `knot-cli workspace --action remove --path <path>`.
    
    Args:
        workspace_path: Path to remove
        
    Returns:
        dict: {"ok": bool, "action": "removed"|"not_found"|"failed", "message": str}
    """
    cli_path = _get_knot_cli_path()
    if not cli_path:
        return {"ok": False, "action": "failed", "message": "knot-cli not installed"}
    
    # Check if workspace is registered
    if not is_workspace_in_knot_list(workspace_path):
        return {"ok": True, "action": "not_found", "message": f"Workspace not in knot-cli list: {workspace_path}"}
    
    # Remove it
    success = remove_workspace(workspace_path)
    if success:
        return {"ok": True, "action": "removed", "message": f"Workspace removed: {workspace_path}"}
    else:
        return {"ok": False, "action": "failed", "message": f"Failed to remove workspace: {workspace_path}"}


def _get_knot_cli_path():
    """Find knot-cli executable, with caching.
    
    Returns:
        str or None: Path to knot-cli executable, or None if not found
    """
    global _KNOT_CLI_CACHE
    
    if _KNOT_CLI_CACHE is not None:
        return _KNOT_CLI_CACHE
    
    # Try PATH first
    cli = shutil.which("knot-cli")
    if cli:
        # On Windows, shutil.which may return path with uppercase .EXE from PATHEXT.
        # knot-cli internally uses os.Args[0] basename to locate its env file,
        # and the case mismatch (e.g. "knot-cli.EXE" vs "knot-cli.exe") causes
        # "listen port not found in knot-cli.EXE env file" errors.
        # Normalize to lowercase extension to avoid this.
        if sys.platform == "win32" and cli.lower().endswith(".exe") and not cli.endswith(".exe"):
            cli = cli[:-4] + ".exe"
        _KNOT_CLI_CACHE = cli
        return cli
    
    # Common installation paths (Windows)
    candidates = [
        os.path.expanduser(r"~\background_agent_cli\bin\knot-cli.exe"),
        os.path.expanduser(r"~\background_agent_cli\bin\knot-cli"),
        r"C:\background_agent_cli\bin\knot-cli.exe",
    ]
    for c in candidates:
        if os.path.exists(c):
            _KNOT_CLI_CACHE = c
            return c
    
    _KNOT_CLI_CACHE = None
    return None


def _install_knot_cli(workspace_path: str, token: str) -> tuple:
    """Install knot-cli programmatically and bind workspace.
    
    The workspace path is bound at install time via --workspace parameter.
    This is the canonical way to create a knot workspace binding:
      curl -L 'https://mirrors.tencent.com/repository/generic/knot-cli/install.sh' | \
        bash -s -- --workspace /your/path --token {token} --origin knot
    
    On Windows: Uses PowerShell to download and run the install script.
    On Linux/Mac: Uses curl | bash.
    
    Args:
        workspace_path: Path to register as workspace (bound at install time)
        token: API token for authentication
        
    Returns:
        tuple: (success: bool, connection_uuid: str)
    """
    install_script = "https://mirrors.tencent.com/repository/generic/knot-cli/install.sh"
    
    try:
        if sys.platform == "win32":
            # Windows: Use PowerShell to download and execute install script
            # The install script is designed for bash, so on Windows we use
            # the knot-cli's own restart mechanism with workspace binding.
            # First try: if knot-cli is already installed, use restart with --workspace
            cli_path = _get_knot_cli_path()
            if cli_path:
                # knot-cli already installed — restart with new workspace binding
                logger.info("knot-cli already installed, restarting with workspace: %s", workspace_path)
                cmd = [cli_path, "restart"]
                result = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    timeout=30
                )
                stdout_text = result.stdout.decode('utf-8', errors='replace') if result.stdout else ""
                stderr_text = result.stderr.decode('utf-8', errors='replace') if result.stderr else ""
                logger.info("knot-cli restart output: rc=%d stdout=%s stderr=%s",
                           result.returncode, stdout_text[:300], stderr_text[:200])
                # After restart, add workspace
                time.sleep(2)
                add_ok, add_uuid = add_workspace(workspace_path)
                if add_ok:
                    # Use UUID from add if available
                    if add_uuid:
                        return True, add_uuid
                    time.sleep(2)
                    uuid = get_connection_uuid(workspace_path)
                    if uuid:
                        logger.info("Got connection_uuid after restart+add: %s...", uuid[:8])
                        return True, uuid
                # If restart+add didn't work, try WSL/Git Bash
                logger.warning("restart+add did not yield connection_uuid, trying shell install...")
            
            # Try using Git Bash or WSL to run the install script
            bash_paths = [
                r"C:\Program Files\Git\bin\bash.exe",
                r"C:\Program Files (x86)\Git\bin\bash.exe",
                os.path.expanduser(r"~\scoop\apps\git\current\bin\bash.exe"),
            ]
            bash_exe = None
            for bp in bash_paths:
                if os.path.exists(bp):
                    bash_exe = bp
                    break
            
            if bash_exe:
                cmd = (
                    f'curl -sL "{install_script}" | '
                    f'bash -s -- --workspace "{workspace_path}" --token {token} --origin knot'
                )
                logger.info("Installing knot-cli via Git Bash: %s", bash_exe)
                result = subprocess.run(
                    [bash_exe, "-c", cmd],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    universal_newlines=True, timeout=300,
                    env=dict(os.environ)
                )
                output = (result.stdout or "") + (result.stderr or "")
                if result.returncode == 0:
                    logger.info("knot-cli installed successfully via Git Bash")
                    global _KNOT_CLI_CACHE
                    _KNOT_CLI_CACHE = None
                    time.sleep(3)
                    uuid = get_connection_uuid(workspace_path)
                    if uuid:
                        return True, uuid
                    return True, ""
                else:
                    logger.warning("Git Bash install failed (code %d): %s", result.returncode, output[:500])
            
            # Fallback: just add workspace to running server
            logger.warning(
                "Windows install: no bash available. "
                "Attempting workspace add to running server."
            )
            if not cli_path:
                logger.error(
                    "Auto-install of knot-cli is not supported on Windows without Git Bash. "
                    "Please install manually: "
                    "https://mirrors.tencent.com/repository/generic/knot-cli/"
                )
                return False, ""
            # Add workspace to running server
            add_ok, add_uuid = add_workspace(workspace_path)
            if add_ok:
                # Use UUID from add if available
                if add_uuid:
                    return True, add_uuid
                time.sleep(2)
                uuid = get_connection_uuid(workspace_path)
                if uuid:
                    return True, uuid
            return False, ""
        else:
            # Linux/Mac: Use official install script with --workspace binding
            cmd = (
                f'curl -sL "{install_script}" | '
                f'bash -s -- --workspace "{workspace_path}" --token {token} --origin knot'
            )
            
            logger.info("Installing knot-cli with workspace binding: %s", cmd)
            
            result = subprocess.run(
                cmd,
                shell=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                universal_newlines=True, timeout=300,
                env=dict(os.environ)
            )
            
            output = (result.stdout or "") + (result.stderr or "")
            
            if result.returncode == 0:
                logger.info("knot-cli installed successfully")
                logger.info("knot-cli install output (stdout): %s", result.stdout[:1000])
                
                # Clear cache to re-detect
                _KNOT_CLI_CACHE = None
                
                # Try to get connection_uuid via client-status
                time.sleep(3)
                uuid = get_connection_uuid(workspace_path)
                if uuid:
                    logger.info("Got connection_uuid after install: %s...", uuid[:8])
                    return True, uuid
                
                logger.warning("knot-cli installed but connection_uuid not found yet")
                return True, ""
            else:
                logger.error("knot-cli installation failed (code %d): %s", result.returncode, output[:500])
                return False, ""
            
    except subprocess.TimeoutExpired:
        logger.error("knot-cli installation timed out")
        return False, ""
    except Exception as e:
        logger.error("knot-cli installation error: %s", e)
        return False, ""


def ensure_knot_cli(workspace_path: str = ".", token: str = "") -> str:
    """Ensure knot-cli is installed and workspace is registered.
    
    Auto-installs knot-cli if not present, then ensures the workspace
    is registered and returns the connection_uuid.
    
    Args:
        workspace_path: Workspace path to register (default: current directory)
        token: API token for authentication
        
    Returns:
        str: Path to knot-cli if available, empty string otherwise
    """
    cli_path = _get_knot_cli_path()
    
    if cli_path is None:
        # Auto-install if token is provided
        if token:
            logger.info("knot-cli not found, attempting auto-install...")
            success, uuid = _install_knot_cli(workspace_path, token)
            if success:
                cli_path = _get_knot_cli_path()
                # If we got connection_uuid from install, cache it (machine-level UUID)
                if uuid:
                    _WORKSPACE_CONNECTION_CACHE["__machine_uuid__"] = uuid
        
        if cli_path is None:
            logger.warning("knot-cli not installed and no token provided for auto-install")
            return ""
    
    return cli_path


def get_connection_uuid(workspace_path: str = "") -> str:
    """Get machine-level connection_uuid (IGNORES workspace_path).
    
    The connection_uuid is MACHINE-UNIQUE (one per machine).
    All workspaces on the same machine share the same connection_uuid.
    
    The workspace_path is passed SEPARATELY via chat_extra.workspace_path,
    so Knot server knows which workspace to use.
    
    Strategy:
    1. Check cache (fixed key "__machine_uuid__")
    2. Call `knot-cli client-status` to get the machine's connection_uuid
    3. Cache and return (same UUID for ALL workspaces on this machine)
    
    Args:
        workspace_path: Ignored (kept for backward compatibility)
        
    Returns:
        str: machine-level connection_uuid if found, empty string otherwise
    """
    # Fixed cache key — connection_uuid is machine-unique, NOT workspace-unique
    cache_key = "__machine_uuid__"
    if cache_key in _WORKSPACE_CONNECTION_CACHE:
        cached = _WORKSPACE_CONNECTION_CACHE[cache_key]
        print(f"[get_connection_uuid] Cache hit (machine UUID): {cached[:20]}", flush=True)
        return cached
    
    cli_path = ensure_knot_cli(".")
    if not cli_path:
        logger.error("get_connection_uuid: knot-cli not found")
        return ""
    
    # Always use client-status to get the machine's connection_uuid
    # (workspace_path is ignored — the UUID is the same for all workspaces)
    print(f"[get_connection_uuid] Getting machine-level connection_uuid (workspace_path='{workspace_path}' is ignored)", flush=True)
    
    try:
        result = subprocess.run(
            [cli_path, "client-status"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=15
        )
        
        # Decode with UTF-8 + replace to avoid UnicodeDecodeError from emoji
        stdout_text = result.stdout.decode('utf-8', errors='replace') if result.stdout else ""
        stderr_text = result.stderr.decode('utf-8', errors='replace') if result.stderr else ""
        output = stdout_text + stderr_text
        logger.info("knot-cli client-status returncode=%d output: %s", result.returncode, output[:500])
        print(f"[get_connection_uuid] client-status output={output[:300]}", flush=True)
        
        # Try to extract JSON from output (output may have prefix like "✅ success\n...")
        uuid = _extract_uuid_from_output(output)
        if uuid:
            # This is the MACHINE's UUID (same for ALL workspaces on this machine)
            print(f"[get_connection_uuid] Got machine UUID from client-status: {uuid[:20]}...", flush=True)
            _WORKSPACE_CONNECTION_CACHE["__machine_uuid__"] = uuid
            return uuid
        
        logger.warning("connection_uuid not found in client-status output: %s", output[:500])
        return ""
        
    except subprocess.TimeoutExpired:
        logger.error("knot-cli client-status timed out (15s)")
        return ""
    except Exception as e:
        logger.error("Error running knot-cli client-status: %s", e)
        return ""


def ensure_workspace(workspace_path: str, token: str = "") -> str:
    """Ensure workspace is registered and return connection_uuid.
    
    This is the main entry point for workspace management:
    1. Auto-install knot-cli if not present
    2. Get connection_uuid from running server
    3. If not found, register workspace via:
       a. `knot-cli workspace --action add` (fast, for running server)
       b. Install command with --workspace binding (creates deep binding)
    4. Return connection_uuid for API calls
    
    The workspace path is bound at install time via --workspace parameter.
    After installation, the knot-cli instance represents that workspace path,
    and subsequent API calls only need the agent_client_uuid.
    
    Args:
        workspace_path: Path to register as workspace
        token: API token for authentication (used for install-based registration)
        
    Returns:
        str: connection_uuid if successful, empty string otherwise
    """
    # Ensure knot-cli is available
    cli_path = ensure_knot_cli(".", token)  # workspace_path ignored for UUID
    if not cli_path:
        return ""
    
    # Get machine-level connection_uuid via client-status
    uuid = get_connection_uuid("")  # ignore workspace_path
    
    # If not registered, try to register workspace
    if not uuid and cli_path:
        logger.info("Workspace not registered, attempting to register...")
        uuid = _register_workspace(workspace_path, cli_path, token)
        # Update cache if registration succeeded
        if uuid:
            _WORKSPACE_CONNECTION_CACHE["__machine_uuid__"] = uuid
            logger.info("Workspace registered successfully, uuid: %s...", uuid[:8])
        else:
            logger.warning("Failed to register workspace")
    
    return uuid


def _register_workspace(workspace_path: str, cli_path: str, token: str = "") -> str:
    """Register workspace with knot-cli and return connection_uuid.
    
    Strategy:
    1. First try `knot-cli workspace --action add --path <path>` (fast, for running server).
    2. If that doesn't yield a connection_uuid, fallback to the install command
       which binds the workspace at a deeper level:
         curl -L install.sh | bash -s -- --workspace <path> --token <token> --origin knot
    
    The workspace path is bound at install time via --workspace parameter.
    Subsequent API calls only need the agent_client_uuid.
    
    Args:
        workspace_path: Path to register as workspace
        cli_path: Path to knot-cli executable
        token: API token for authentication (needed for install fallback)
        
    Returns:
        str: connection_uuid if registration succeeded, empty string otherwise
    """
    # Strategy 1: Use workspace add (fast, for running server)
    logger.info("Registering workspace (strategy 1: workspace add): %s", workspace_path)
    
    success, add_uuid = add_workspace(workspace_path)
    if success:
        # Use UUID from add output if available
        if add_uuid:
            _WORKSPACE_CONNECTION_CACHE["__machine_uuid__"] = add_uuid
            return add_uuid
        
        logger.info("Workspace add succeeded, getting connection_uuid...")
        
        # Wait a moment for registration to take effect
        time.sleep(2)
        
        # Get machine-level connection_uuid via client-status
        uuid = get_connection_uuid("")  # ignore workspace_path
        if uuid:
            logger.info("Got connection_uuid after workspace add: %s...", uuid[:8])
            return uuid
        
        # Retry after a short delay
        logger.warning("connection_uuid not found after workspace add, retrying...")
        time.sleep(3)
        _WORKSPACE_CONNECTION_CACHE.pop("__machine_uuid__", None)
        uuid = get_connection_uuid("")  # ignore workspace_path
        if uuid:
            return uuid
    
    # Strategy 2: Fallback to install command with --workspace binding
    # The workspace path is bound at install time via --workspace parameter,
    # so when workspace add doesn't produce a connection_uuid, we need to
    # use the install command to create the binding.
    if token:
        logger.info("Registering workspace (strategy 2: install with --workspace): %s", workspace_path)
        install_ok, install_uuid = _install_knot_cli(workspace_path, token)
        if install_uuid:
            return install_uuid
        if install_ok:
            # Install succeeded but no uuid yet, try one more time
            time.sleep(3)
            _WORKSPACE_CONNECTION_CACHE.pop("__machine_uuid__", None)
            uuid = get_connection_uuid("")  # ignore workspace_path
            if uuid:
                return uuid
    else:
        logger.warning("No token provided, cannot use install fallback for workspace registration")
    
    logger.error("Failed to get connection_uuid after all registration strategies")
    return ""


def list_workspaces() -> list:
    """List all registered workspaces.
    
    Runs `knot-cli workspace --action list` and parses the output.
    
    Returns:
        list: List of workspace paths, empty list if error
    """
    cli_path = _get_knot_cli_path()
    if not cli_path:
        logger.error("list_workspaces: knot-cli not found")
        return []
    
    try:
        result = subprocess.run(
            [cli_path, "workspace", "--action", "list"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30
        )
        
        stdout_text = result.stdout.decode('utf-8', errors='replace') if result.stdout else ""
        stderr_text = result.stderr.decode('utf-8', errors='replace') if result.stderr else ""
        output = stdout_text + stderr_text
        logger.info("knot-cli workspace --action list output: %s", output[:500])
        
        # Try to parse as JSON first
        try:
            data = json.loads(output)
            if isinstance(data, list):
                return data
            elif isinstance(data, dict) and "workspaces" in data:
                return data["workspaces"]
        except (json.JSONDecodeError, TypeError):
            pass
        
        # Fallback: parse line by line
        workspaces = []
        for line in output.split("\n"):
            line = line.strip()
            if line and not line.startswith("=") and not line.startswith("Workspace"):
                workspaces.append(line)
        
        return workspaces
        
    except Exception as e:
        logger.error("Error listing workspaces: %s", e)
        return []


def add_workspace(path: str) -> tuple:
    """Add a workspace directory.
    
    Runs `knot-cli workspace --action add --path <path>`.
    
    Args:
        path: Workspace directory path to add
        
    Returns:
        tuple: (success: bool, connection_uuid: str) — connection_uuid may be empty
               even on success if the CLI output doesn't contain one.
    """
    cli_path = _get_knot_cli_path()
    if not cli_path:
        logger.error("add_workspace: knot-cli not found")
        return False, ""
    
    try:
        result = subprocess.run(
            [cli_path, "workspace", "--action", "add", "--path", path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30
        )
        
        stdout_text = result.stdout.decode('utf-8', errors='replace') if result.stdout else ""
        stderr_text = result.stderr.decode('utf-8', errors='replace') if result.stderr else ""
        output = stdout_text + stderr_text
        logger.info("knot-cli workspace --action add output: %s", output[:500])
        print(f"[add_workspace] path='{path}' rc={result.returncode} output={output[:300]}", flush=True)
        
        # Try to extract connection_uuid from the add output
        _uuid = _extract_uuid_from_output(output)
        
        if result.returncode == 0:
            logger.info("Workspace added successfully: %s", path)
            # Clear cache to force refresh
            _WORKSPACE_CONNECTION_CACHE.clear()
            # Cache the UUID if we got one (machine-level UUID)
            if _uuid:
                _WORKSPACE_CONNECTION_CACHE["__machine_uuid__"] = _uuid
                logger.info("Got connection_uuid from add output: %s...", _uuid[:8])
            return True, _uuid
        else:
            logger.error("Failed to add workspace: %s", output[:500])
            return False, ""
        
    except Exception as e:
        logger.error("Error adding workspace: %s", e)
        return False, ""


def _extract_uuid_from_output(output: str) -> str:
    """Extract a connection_uuid from knot-cli command output.
    
    Tries JSON parsing first, then UUID regex fallback.
    
    Returns:
        str: UUID string if found, empty string otherwise
    """
    # Try JSON extraction
    json_start = output.find('{')
    json_end = output.rfind('}')
    if json_start >= 0 and json_end > json_start:
        json_str = output[json_start:json_end + 1]
        try:
            data = json.loads(json_str)
            if isinstance(data, dict):
                for key in ("connection_uuid", "workid", "uuid", "id"):
                    if key in data and data[key]:
                        return str(data[key])
        except (json.JSONDecodeError, TypeError):
            pass
    
    # Try parsing entire output as JSON
    try:
        data = json.loads(output)
        if isinstance(data, dict):
            for key in ("connection_uuid", "workid", "uuid", "id"):
                if key in data and data[key]:
                    return str(data[key])
    except (json.JSONDecodeError, TypeError):
        pass
    
    # Fallback: regex search for UUID pattern
    match = re.search(r'([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})', output, re.IGNORECASE)
    if match:
        return match.group(1)
    
    return ""


def _get_connection_uuid_from_workspace_list(workspace_path: str) -> str:
    """Try to get connection_uuid for a specific workspace from workspace list.
    
    Runs `knot-cli workspace --action list` and looks for the workspace_path
    in the output, then extracts its connection_uuid if available.
    
    Args:
        workspace_path: The workspace path to look up
        
    Returns:
        str: connection_uuid if found, empty string otherwise
    """
    if not workspace_path or workspace_path == ".":
        return ""
    
    cli_path = _get_knot_cli_path()
    if not cli_path:
        return ""
    
    try:
        import pathlib
        target_resolved = str(pathlib.Path(workspace_path).resolve()).lower()
    except (ValueError, OSError):
        target_resolved = workspace_path.lower()
    
    try:
        result = subprocess.run(
            [cli_path, "workspace", "--action", "list"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30
        )
        
        stdout_text = result.stdout.decode('utf-8', errors='replace') if result.stdout else ""
        stderr_text = result.stderr.decode('utf-8', errors='replace') if result.stderr else ""
        output = stdout_text + stderr_text
        print(f"[_get_connection_uuid_from_workspace_list] output={output[:500]}", flush=True)
        
        # Try JSON parsing — list may contain objects with path + connection_uuid
        json_start = output.find('[')
        json_end = output.rfind(']')
        if json_start >= 0 and json_end > json_start:
            try:
                data = json.loads(output[json_start:json_end + 1])
                if isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict):
                            ws_path = item.get("path", item.get("workspace", ""))
                            ws_uuid = item.get("connection_uuid", item.get("workid", item.get("uuid", "")))
                            if ws_path:
                                try:
                                    ws_resolved = str(pathlib.Path(ws_path).resolve()).lower()
                                except (ValueError, OSError):
                                    ws_resolved = ws_path.lower()
                                if ws_resolved == target_resolved and ws_uuid:
                                    print(f"[_get_connection_uuid_from_workspace_list] MATCH: path={ws_path} uuid={ws_uuid[:20]}", flush=True)
                                    return str(ws_uuid)
            except (json.JSONDecodeError, TypeError):
                pass
        
        # Also try top-level JSON object
        json_start = output.find('{')
        json_end = output.rfind('}')
        if json_start >= 0 and json_end > json_start:
            try:
                data = json.loads(output[json_start:json_end + 1])
                if isinstance(data, dict):
                    workspaces = data.get("workspaces", data.get("data", []))
                    if isinstance(workspaces, list):
                        for item in workspaces:
                            if isinstance(item, dict):
                                ws_path = item.get("path", item.get("workspace", ""))
                                ws_uuid = item.get("connection_uuid", item.get("workid", item.get("uuid", "")))
                                if ws_path:
                                    try:
                                        ws_resolved = str(pathlib.Path(ws_path).resolve()).lower()
                                    except (ValueError, OSError):
                                        ws_resolved = ws_path.lower()
                                    if ws_resolved == target_resolved and ws_uuid:
                                        print(f"[_get_connection_uuid_from_workspace_list] MATCH(dict): path={ws_path} uuid={ws_uuid[:20]}", flush=True)
                                        return str(ws_uuid)
            except (json.JSONDecodeError, TypeError):
                pass
        
        print(f"[_get_connection_uuid_from_workspace_list] No UUID found for workspace={workspace_path}", flush=True)
        return ""
        
    except Exception as e:
        logger.error("Error in _get_connection_uuid_from_workspace_list: %s", e)
        return ""


def remove_workspace(path: str) -> bool:
    """Remove a workspace directory.
    
    Runs `knot-cli workspace --action remove --path <path>`.
    
    Args:
        path: Workspace directory path to remove
        
    Returns:
        bool: True if successful, False otherwise
    """
    cli_path = _get_knot_cli_path()
    if not cli_path:
        logger.error("remove_workspace: knot-cli not found")
        return False
    
    try:
        result = subprocess.run(
            [cli_path, "workspace", "--action", "remove", "--path", path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30
        )
        
        stdout_text = result.stdout.decode('utf-8', errors='replace') if result.stdout else ""
        stderr_text = result.stderr.decode('utf-8', errors='replace') if result.stderr else ""
        output = stdout_text + stderr_text
        logger.info("knot-cli workspace --action remove output: %s", output[:500])
        
        if result.returncode == 0:
            logger.info("Workspace removed successfully: %s", path)
            # Clear cache to force refresh
            _WORKSPACE_CONNECTION_CACHE.clear()
            return True
        else:
            logger.error("Failed to remove workspace: %s", output[:500])
            return False
        
    except Exception as e:
        logger.error("Error removing workspace: %s", e)
        return False


def _load_agui_settings():
    """Load Knot AG-UI settings from the settings store."""
    try:
        from api.config import load_settings
        s = load_settings()
        return {
            "token": s.get("knot_agui_token", ""),
            "user": s.get("knot_agui_user", ""),
            "agents_raw": s.get("knot_agui_agents", ""),
        }
    except Exception:
        return {"token": "", "user": "", "agents_raw": ""}


def get_knot_agents():
    """Return the list of configured Knot AG-UI agents as parsed list.
    Format: [{"id": "agent_id", "name": "Display Name"}, ...]
    """
    settings = _load_agui_settings()
    raw = settings.get("agents_raw", "")
    if not raw or not raw.strip():
        return []
    try:
        agents = json.loads(raw)
        if isinstance(agents, list):
            return [a for a in agents if isinstance(a, dict) and a.get("id")]
        return []
    except (json.JSONDecodeError, TypeError):
        return []


def run_knot_agui_streaming(session_id, msg_text, model, stream_id, put,
                             cancel_event, system_prompt="", employee_name="",
                             enable_web_search=False,
                             employee=None, workspace=""):
    """Run a Knot AG-UI agent conversation and translate events to Hermes SSE.
    
    Knot AG-UI agent 的工具由智能体后台统一配置（Client 工具），
    工具调用通过 AG-UI 协议的 ToolCallStart/Args/End/Result 事件流原生处理。
    
    自动检测并安装 knot-cli，程序化创建工作区。
    """
    # ── Auto-setup knot-cli and workspace ─────────────────────
    # Parse model id first to get agent_id for token
    print(f"[knot_agui_streaming] ENTER — workspace='{workspace}', model='{model[:60]}', session_id='{session_id[:12]}'", flush=True)
    raw = model[len("knot-agui:"):]
    if "/" in raw:
        agent_id, knot_model = raw.split("/", 1)
    else:
        agent_id, knot_model = raw, ""
    agent_id = agent_id.strip()
    knot_model = knot_model.strip()

    if not agent_id:
        put('apperror', {'type': 'config_error', 'message': 'Knot AG-UI agent_id is empty'})
        return

    # Load settings for auto-install
    settings = _load_agui_settings()
    api_token = settings.get("token", "")
    api_user = settings.get("user", "")

    # Auto-setup knot-cli if not present
    if not _get_knot_cli_path():
        put('tool', {
            'name': 'knot-cli-setup',
            'preview': '[Auto] Checking knot-cli installation...',
            'args': {},
        })
        
        if api_token:
            put('tool', {
                'name': 'knot-cli-setup',
                'preview': '[Auto] Installing knot-cli...',
                'args': {'workspace': workspace or '.'},
            })
            install_ok, _install_uuid = _install_knot_cli(workspace or ".", api_token)
            if install_ok:
                put('tool', {
                    'name': 'knot-cli-setup',
                    'preview': '[Auto] knot-cli installed successfully',
                    'args': {},
                })
            else:
                put('tool', {
                    'name': 'knot-cli-setup',
                    'preview': '[Auto] knot-cli auto-install failed, please install manually',
                    'args': {},
                })
        else:
            put('apperror', {
                'type': 'config_error',
                'message': 'knot-cli not found and no token for auto-install',
                'hint': 'Please install knot-cli manually or configure knot_agui_token',
            })
    
    # ── Original logic continues ─────────────────────────────
    # NOTE: agent_client_uuid (connection_uuid) is injected into chat_extra below
    # when available, enabling workspace-level tool/context association on Knot platform.
    if not agent_id:
        put('apperror', {'type': 'config_error', 'message': 'Knot AG-UI agent_id is empty'})
        return

    if not api_token:
        print(f"[knot_agui_streaming] ABORT — api_token is EMPTY, cannot call Knot API. workspace='{workspace}'", flush=True)
        put('apperror', {
            'type': 'config_error',
            'message': 'Knot AG-UI token not configured',
            'hint': '请在 Settings > Knot AG-UI 中配置 API Token',
        })
        return

    # Resolve agent display name
    agents = get_knot_agents()
    agent_name = agent_id
    for a in agents:
        if a.get("id") == agent_id:
            agent_name = a.get("name", agent_id)
            break

    # Build API URL
    api_url = f"https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}"

    # Resolve conversation_id from session for continuity
    conversation_id = ""
    try:
        from api.models import get_session
        s = get_session(session_id)
        if s and hasattr(s, '_knot_conversation_id'):
            conversation_id = s._knot_conversation_id or ""
    except Exception:
        pass

    # Build request body
    chat_body = {
        "input": {
            "message": msg_text,
            "conversation_id": conversation_id,
            "stream": True,
            "enable_web_search": enable_web_search,
            "chat_extra": {},
        }
    }
    if knot_model:
        chat_body["input"]["model"] = knot_model

    # ★ 将 system_prompt 注入 chat_extra（Knot AG-UI 协议支持通过 chat_extra.system_prompt 覆盖预设）
    # ★ 同时注入员工 memory（MEMORY.md / USER.md）
    _final_system_prompt = system_prompt or ""
    if employee_name and workspace:
        try:
            from api.employee_memory import build_employee_memory_system_prompt
            _emp_memory = build_employee_memory_system_prompt(workspace, employee_name)
            if _emp_memory:
                if _final_system_prompt:
                    _final_system_prompt = _final_system_prompt + "\n\n" + _emp_memory
                else:
                    _final_system_prompt = _emp_memory
                print(f"[knot_agui_streaming] Injected employee memory (len={len(_emp_memory)})", flush=True)
        except Exception as _mem_err:
            print(f"[knot_agui_streaming] Failed to load employee memory: {_mem_err}", flush=True)

    if _final_system_prompt:
        chat_body["input"]["chat_extra"]["system_prompt"] = _final_system_prompt

    # ★ 注入 agent_client_uuid（机器 ID）到 chat_extra
    #   NOTE: connection_uuid is MACHINE-UNIQUE (same for ALL workspaces on this machine).
    #   The workspace is specified SEPARATELY via chat_extra.workspace_path (see below).
    #   Knot server uses BOTH fields to determine which workspace to use.
    _ws_path = workspace or "."
    _agent_client_uuid = ""
    print(f"[knot_agui_streaming] agent_client_uuid lookup — _ws_path='{_ws_path}', cache_keys={list(_WORKSPACE_CONNECTION_CACHE.keys())}", flush=True)
    if _ws_path and _ws_path != ".":
        # ★ Get machine-level UUID (same for all workspaces)
        try:
            _agent_client_uuid = get_connection_uuid("")  # ignore workspace_path
        except Exception as _uuid_err:
            print(f"[knot_agui_streaming] get_connection_uuid failed: {_uuid_err}", flush=True)
    if _agent_client_uuid:
        chat_body["input"]["chat_extra"]["agent_client_uuid"] = _agent_client_uuid
        print(f"[knot_agui_streaming] Injected agent_client_uuid={_agent_client_uuid} (machine ID, same for all workspaces)", flush=True)
    else:
        print(f"[knot_agui_streaming] agent_client_uuid is EMPTY — _ws_path='{_ws_path}'", flush=True)

    # ★ 传递 workspace_path 到 chat_extra，告诉 Knot 服务端使用哪个工作区
    #   This is CRITICAL when the machine has multiple workspaces registered.
    #   Knot server will use this path to determine which workspace to operate on.
    if _ws_path and _ws_path != ".":
        chat_body["input"]["chat_extra"]["workspace_path"] = _ws_path

    # ★ 工具策略：统一使用 Knot 智能体后台配置的工具（Client 工具）
    #   不再注入本地工具到 system prompt，由 Knot 平台原生处理工具调用。
    #   AG-UI 协议的 ToolCallStart/Args/End/Result 事件会被原样透传给前端展示。

    # Build headers
    headers = {
        "x-knot-api-token": api_token,
        "Content-Type": "application/json",
    }
    if api_user:
        headers["x-knot-api-user"] = api_user

    # ★ 诊断：打印即将发送的 chat_extra，确认 agent_client_uuid 是否在内
    print(f"[knot_agui_streaming] SEND chat_extra={json.dumps(chat_body.get('input', {}).get('chat_extra', {}), ensure_ascii=False)}", flush=True)

    # ★ 持久化用户消息到 session（与 AIAgent 路径的 persist_user_message 行为一致）
    #   这样 SSE done 后 loadGroupChat() 从后端刷新时不会丢失用户消息
    try:
        from api.models import get_session
        _sess = get_session(session_id)
        if _sess:
            _sess.messages.append({
                'role': 'user',
                'content': msg_text,
                '_ts': time.time(),
            })
            _sess.save()
    except Exception:
        pass

    # Log start
    put('tool', {
        'name': 'knot-agui:' + agent_name,
        'preview': '[AG-UI] ' + agent_name + ' ...',
        'args': {'agent_id': agent_id, 'model': knot_model or 'default'},
    })

    # ★ 入口日志
    try:
        import os
        _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
        with open(_elog, 'w', encoding='utf-8') as f:
            f.write(f'=== Knot AG-UI Entry ===\n')
            f.write(f'agent_id={agent_id} model={knot_model} session_id={session_id}\n')
            f.write(f'api_url={api_url}\n')
            f.write(f'api_token_len={len(api_token)}\n')
            f.write(f'msg_text_len={len(msg_text)}\n')
            f.write(f'system_prompt_len={len(system_prompt) if system_prompt else 0}\n')
            f.write(f'conversation_id={conversation_id}\n')
    except:
        pass

    # Make streaming request
    try:
        response = requests.post(
            api_url, json=chat_body, headers=headers,
            stream=True, timeout=300,
        )
        # ★ 强制设置响应编码为 UTF-8，防止中文乱码
        response.encoding = 'utf-8'
    except requests.exceptions.ConnectionError as e:
        put('apperror', {
            'type': 'connection_error',
            'message': 'Cannot connect to Knot AG-UI: ' + str(e)[:300],
            'hint': 'Check network access to knot.woa.com',
        })
        return
    except requests.exceptions.Timeout:
        put('apperror', {'type': 'timeout', 'message': 'Knot AG-UI connection timed out'})
        return

    if response.status_code in (401, 403):
        put('apperror', {
            'type': 'auth_error',
            'message': 'Knot AG-UI auth failed (HTTP ' + str(response.status_code) + ')',
            'hint': 'Check API Token in Settings > Knot AG-UI',
        })
        return

    if response.status_code != 200:
        body_text = response.text[:500] if response.text else ''
        # ★ 记录非200响应
        try:
            import os
            _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
            with open(_elog, 'a', encoding='utf-8') as f:
                f.write(f'\n=== HTTP ERROR ===\n')
                f.write(f'status={response.status_code}\n')
                f.write(f'body={body_text[:1000]}\n')
        except:
            pass
        put('apperror', {
            'type': 'api_error',
            'message': 'Knot AG-UI HTTP ' + str(response.status_code) + ': ' + body_text,
        })
        return

    # Parse SSE stream from Knot
    full_text = ""
    full_reasoning = ""
    received_conversation_id = ""
    # Track active tool calls for incremental args
    _active_tool_calls = {}  # tool_call_id → {name, args_buffer}
    _debug_log = []  # ★ 调试日志缓冲
    # ★ 追踪完整的 tool_calls 和 tool result，用于保存结构化消息到 session
    #   这样 done 后 _renderRpMessages 可以渲染思考过程和工具调用卡片
    _completed_tool_calls = []  # [{id, name, args_str, result}]
    _assistant_iterations = []  # [{reasoning, text, tool_calls}] — 每次 step 的完整迭代
    _removed_tool_call_ids = set()  # ★ 被 remove-tool 事件标记移除的 tool_call_id

    try:
        _line_count = 0
        for raw_line in response.iter_lines(decode_unicode=False):
            _line_count += 1
            if cancel_event.is_set():
                put('cancel', {'message': 'Cancelled by user'})
                return

            if not raw_line:
                continue

            # ★ 手动 UTF-8 解码，避免 iter_lines(decode_unicode=True) 的编码问题
            try:
                line = raw_line.decode('utf-8')
            except UnicodeDecodeError:
                line = raw_line.decode('utf-8', errors='replace')

            # Strip "data:" prefix
            line = line.strip()
            # ★ 调试：收集前 30 行原始 SSE 数据
            if _line_count <= 30:
                _debug_log.append(f'raw #{_line_count}: {line[:300]}')
            if line.startswith("data:"):
                line = line[5:].strip()
            elif line.startswith("data: "):
                line = line[6:].strip()
            elif line.startswith("event:"):
                # SSE event type line, skip (we parse type from data JSON)
                continue
            else:
                # Not a data line, skip
                continue

            if line == "[DONE]":
                break

            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue

            if "type" not in msg:
                # ★ 检测 Knot API 返回的非标准错误（如 token 非法、code 190001 等）
                #   这些响应没有 AG-UI "type" 字段，但包含 "code" 和 "msg" 字段
                if "code" in msg or "error" in msg or "msg" in msg:
                    error_code = msg.get("code", "")
                    error_msg = msg.get("msg", "") or msg.get("error", "") or str(msg)
                    put('apperror', {
                        'type': 'knot_api_error',
                        'message': f'Knot AG-UI API error (code {error_code}): {error_msg[:500]}',
                        'hint': '请在 Settings > Knot AG-UI 中检查 API Token 是否正确且未过期',
                    })
                    return
                print(f'[knot-agui] SKIP no type: {str(msg)[:200]}', flush=True)
                continue

            msg_type = msg.get("type", "")
            raw_event = msg.get("rawEvent", {})
            _debug_log.append(f'event: {msg_type} keys={list(raw_event.keys()) if isinstance(raw_event, dict) else "N/A"}')
            # ★★★ 详细调试：记录 TEXT_MESSAGE_CONTENT 和 THINKING_TEXT_MESSAGE_CONTENT 的实际 content 值
            if msg_type in ("TEXT_MESSAGE_CONTENT", "TextMessageContent", "THINKING_TEXT_MESSAGE_CONTENT", "ThinkingTextMessageContent"):
                _content_val = raw_event.get("content", "❌MISSING") if isinstance(raw_event, dict) else "❌NOT_DICT"
                _delta_val = msg.get("delta", "❌MISSING")
                _debug_log.append(f'  >>> content={repr(_content_val)} delta={repr(_delta_val)} matched_so_far={_matched}')

            # ★ Knot 实际 API 返回 UPPER_SNAKE_CASE 事件类型（如 TEXT_MESSAGE_CONTENT），
            #   标准 AG-UI 协议用 PascalCase（如 TextMessageContent）。
            #   此处归一化，同时兼容两种格式。
            _matched = False
            def _evt(name_pascal, name_upper):
                """接受 PascalCase 或 UPPER_SNAKE_CASE 两种事件类型名"""
                nonlocal _matched
                if msg_type == name_pascal or msg_type == name_upper:
                    _matched = True
                    return True
                return False

            # Track conversation_id
            if raw_event.get("conversation_id"):
                received_conversation_id = raw_event["conversation_id"]

            # ── 1.2.1 Text message events ──────────────────────────────────
            if _evt("TextMessageStart", "TEXT_MESSAGE_START"):
                put('message_start', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("TextMessageContent", "TEXT_MESSAGE_CONTENT"):
                text = raw_event.get("content", "")
                # ★★★ 如果 raw_event 中没有 content，尝试从顶层 delta 字段获取
                if not text:
                    text = msg.get("delta", "")
                # ★ 过滤空外观 token：某些 provider/模型（如 GLM）在 tool_calls 前发送
                #   content="{}" / "{" / "}" / "[]" / '""' 等，不应推送到前端
                if text and re.match(r'^[\s{}\[\]"]+$', text.strip()):
                    _debug_log.append(f'  >>> TEXT_MESSAGE_CONTENT filtered empty-like: {repr(text)}')
                    text = ""
                _debug_log.append(f'  >>> TEXT_MESSAGE_CONTENT matched! text={repr(text[:100])} full_text_len={len(full_text)}')
                if text:
                    full_text += text
                    # ★ 追踪到当前迭代（若无迭代则自动创建——兼容无 StepStarted 事件的情况）
                    if not _assistant_iterations:
                        _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                    _assistant_iterations[-1]['text'] += text
                    put('token', {'text': text})

            elif _evt("TextMessageEnd", "TEXT_MESSAGE_END"):
                put('message_end', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            # ── 1.2.2 Thinking message events ──────────────────────────────
            elif _evt("ThinkingTextMessageStart", "THINKING_TEXT_MESSAGE_START"):
                put('thinking_start', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("ThinkingTextMessageContent", "THINKING_TEXT_MESSAGE_CONTENT"):
                text = raw_event.get("content", "")
                # ★★★ 如果 raw_event 中没有 content，尝试从顶层 delta 字段获取
                if not text:
                    text = msg.get("delta", "")
                # ★ 过滤空外观 token（同 TEXT_MESSAGE_CONTENT 逻辑）
                if text and re.match(r'^[\s{}\[\]"]+$', text.strip()):
                    _debug_log.append(f'  >>> THINKING_TEXT_MESSAGE_CONTENT filtered empty-like: {repr(text)}')
                    text = ""
                _debug_log.append(f'  >>> THINKING_TEXT_MESSAGE_CONTENT matched! text={repr(text[:100])} full_reasoning_len={len(full_reasoning)}')
                if text:
                    full_reasoning += text
                    # ★ 追踪到当前迭代（若无迭代则自动创建——兼容无 StepStarted 事件的情况）
                    if not _assistant_iterations:
                        _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                    _assistant_iterations[-1]['reasoning'] += text
                    put('reasoning', {'text': text})

            elif _evt("ThinkingTextMessageEnd", "THINKING_TEXT_MESSAGE_END"):
                put('thinking_end', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            # ── 1.2.3 Tool call events ─────────────────────────────────────
            elif _evt("ToolCallStart", "TOOL_CALL_START"):
                tool_name = raw_event.get("name", "unknown_tool")
                tool_call_id = raw_event.get("tool_call_id", "")
                args_str = raw_event.get("args", "")
                # Register active tool call
                _active_tool_calls[tool_call_id] = {
                    'name': tool_name,
                    'args_buffer': args_str or "",
                }
                # ★ 追踪到当前迭代的 tool_calls
                if not _assistant_iterations:
                    _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                _assistant_iterations[-1]['tool_calls'].append({
                    'id': tool_call_id,
                    'name': tool_name,
                    'args': raw_event.get("args", {}),
                })
                put('tool', {
                    'name': tool_name,
                    'preview': '[AG-UI Tool] ' + tool_name,
                    'args': raw_event.get("args", {}),
                    'tool_call_id': tool_call_id,
                    'phase': 'started',
                })

            elif _evt("ToolCallArgs", "TOOL_CALL_ARGS"):
                tool_call_id = raw_event.get("tool_call_id", "")
                args_delta = raw_event.get("args", "")
                if tool_call_id in _active_tool_calls:
                    _active_tool_calls[tool_call_id]['args_buffer'] += args_delta or ""
                put('tool_args', {
                    'tool_call_id': tool_call_id,
                    'args_delta': args_delta,
                })

            elif _evt("ToolCallEnd", "TOOL_CALL_END"):
                tool_call_id = raw_event.get("tool_call_id", "")
                tc_info = _active_tool_calls.pop(tool_call_id, {})
                # ★ 记录完整的 tool call（供保存到 session messages 使用）
                _completed_tool_calls.append({
                    'id': tool_call_id,
                    'name': tc_info.get('name', 'unknown_tool'),
                    'args_str': tc_info.get('args_buffer', ''),
                })
                # ★ 更新迭代追踪中的 args（用完整累积的 args 替换初始值）
                for _iter in _assistant_iterations:
                    for _tc in _iter.get('tool_calls', []):
                        if _tc.get('id') == tool_call_id:
                            try:
                                _tc['args'] = json.loads(tc_info.get('args_buffer', '{}'))
                            except Exception:
                                _tc['args'] = tc_info.get('args_buffer', {})
                put('tool_end', {
                    'tool_call_id': tool_call_id,
                    'name': tc_info.get('name', ''),
                    'args': tc_info.get('args_buffer', ''),
                })

            elif _evt("ToolCallResult", "TOOL_CALL_RESULT"):
                tool_call_id = raw_event.get("tool_call_id", "")
                result = raw_event.get("result", "")
                # 记录结果到 completed_tool_calls
                for tc in _completed_tool_calls:
                    if tc['id'] == tool_call_id:
                        tc['result'] = result
                        break
                # ★ 过滤空外观的 tool_result（如 "{}" / "[]" / '""'），
                #   避免前端在 tool card 下方显示孤立的 "{}" 文本
                _rs_str = result if isinstance(result, str) else json.dumps(result)
                if not _rs_str or re.match(r'^[\s{}\[\]"]+$', _rs_str.strip()):
                    _debug_log.append(f'  >>> TOOL_CALL_RESULT filtered empty-like: {repr(result)}')
                else:
                    put('tool_result', {
                        'tool_call_id': tool_call_id,
                        'result': result,
                    })

            # ── 1.3 Status sync: RunError ──────────────────────────────────
            elif _evt("RunError", "RUN_ERROR"):
                tip = raw_event.get("tip_option", {})
                error_msg = ""
                if isinstance(tip, dict):
                    error_msg = tip.get("content", "")
                if not error_msg:
                    error_msg = str(raw_event)
                put('apperror', {
                    'type': 'knot_run_error',
                    'message': 'Knot AG-UI error: ' + error_msg[:500],
                })
                return

            # ── 1.4 Step lifecycle events ──────────────────────────────────
            elif _evt("StepStarted", "STEP_STARTED"):
                step_name = raw_event.get("step_name", "")
                # ★ AG-UI 迭代边界：call_llm step → 新迭代开始
                #   execute_tool step 属于当前迭代（不新建）
                if step_name == 'call_llm':
                    _assistant_iterations.append({'reasoning': '', 'text': '', 'tool_calls': []})
                put('step_started', {
                    'step_name': step_name,
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("StepFinished", "STEP_FINISHED"):
                step_name = raw_event.get("step_name", "")
                token_usage = raw_event.get("token_usage")
                step_data = {
                    'step_name': step_name,
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                }
                if token_usage:
                    step_data['token_usage'] = token_usage
                put('step_finished', step_data)

            # ── 1.5 Run lifecycle events ──────────────────────────────────
            elif _evt("RunStarted", "RUN_STARTED"):
                put('message_start', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            elif _evt("RunFinished", "RUN_FINISHED"):
                put('message_end', {
                    'message_id': raw_event.get("message_id", ""),
                    'conversation_id': raw_event.get("conversation_id", ""),
                })

            # ── 1.6 Custom events (e.g. remove-tool) ─────────────────────
            elif _evt("Custom", "CUSTOM"):
                # ★ Knot 特有的自定义事件：remove-tool 表示平台决定移除某个 tool call
                #   被 remove 的 tool call 不应出现在最终保存的 assistant 消息中
                _custom_type = raw_event.get("type", "") if isinstance(raw_event, dict) else ""
                if _custom_type == "remove-tool":
                    _removed_tc_id = raw_event.get("tool_call_id", "")
                    if _removed_tc_id:
                        _removed_tool_call_ids.add(_removed_tc_id)
                        _debug_log.append(f'remove-tool: {_removed_tc_id}')

            # ★ 未匹配的事件类型，记录到调试日志
            if not _matched:
                _debug_log.append(f'UNMATCHED event: {msg_type}')
                print(f'[knot-agui] UNMATCHED event type: {msg_type}', flush=True)

    except requests.exceptions.Timeout:
        # ★ 超时也写调试日志
        pass  # Send what we have
    except Exception as e:
        # ★ 写调试日志（即使异常）
        try:
            import os
            _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
            with open(_elog, 'w', encoding='utf-8') as f:
                f.write(f'=== Knot AG-UI Debug Log (EXCEPTION) ===\n')
                f.write(f'agent_id={agent_id} model={knot_model} session_id={session_id}\n')
                f.write(f'full_text_len={len(full_text)} full_reasoning_len={len(full_reasoning)}\n')
                f.write(f'line_count={_line_count}\n')
                f.write(f'exception: {e}\n\n')
                for entry in _debug_log:
                    f.write(entry + '\n')
                f.write(f'\n=== full_text (first 500) ===\n{full_text[:500]}\n')
        except:
            pass
        if not full_text:
            put('apperror', {
                'type': 'stream_error',
                'message': 'Knot AG-UI stream error: ' + str(e)[:300],
            })
            return

    # （工具调用由 Knot 智能体自行处理，上方 SSE 流中已透传 ToolCall 事件给前端）
    if received_conversation_id:
        try:
            from api.models import get_session
            s = get_session(session_id)
            if s:
                s._knot_conversation_id = received_conversation_id
        except Exception:
            pass

    # ★★★ 保存结构化消息到 session（含 tool_calls、reasoning、tool result）★★★
    #   旧实现只保存了扁平的 assistant content 字符串，导致 _renderRpMessages
    #   无法渲染思考卡片和工具调用卡片——刷新后全部消失。
    #   新实现按 AG-UI 协议逐迭代保存：
    #     - 有 tool_calls 的迭代 → assistant msg（含 tool_calls）+ tool result msgs
    #     - 纯文本迭代 → assistant msg（含 reasoning 和 content）
    try:
        from api.models import get_session
        s = get_session(session_id)
        if s:
            _now = time.time()
            # ★★★ 调试日志：记录迭代追踪数据
            print(f'[knot-agui] SAVE: iterations={len(_assistant_iterations)} completed_tcs={len(_completed_tool_calls)} full_text_len={len(full_text)} full_reasoning_len={len(full_reasoning)}', flush=True)
            for _iidx, _iter in enumerate(_assistant_iterations):
                _reasoning = _iter.get('reasoning', '').strip()
                _text = _iter.get('text', '').strip()
                _tcs = _iter.get('tool_calls', [])
                print(f'[knot-agui] SAVE: iter[{_iidx}] reasoning_len={len(_reasoning)} text_len={len(_text)} tcs={len(_tcs)}', flush=True)
            # ★ 将每个迭代保存为结构化的 assistant + tool 消息
            for _iter in _assistant_iterations:
                _reasoning = _iter.get('reasoning', '').strip()
                _text = _iter.get('text', '').strip()
                # ★ 过滤空外观文本（只由括号/引号/空白组成）
                if _text and re.match(r'^[\s{}\[\]"]+$', _text):
                    _text = ''
                # ★ 过滤掉被 remove-tool 标记移除的 tool calls
                _tcs = [tc for tc in _iter.get('tool_calls', [])
                        if tc.get('id', '') not in _removed_tool_call_ids]
                if not _reasoning and not _text and not _tcs:
                    continue
                # 构建 assistant 消息
                _asst_msg = {
                    'role': 'assistant',
                    'content': _text or '',
                    '_ts': _now,
                }
                if _reasoning:
                    _asst_msg['reasoning'] = _reasoning
                # ★ OpenAI 格式的 tool_calls
                if _tcs:
                    _asst_msg['tool_calls'] = []
                    for _tc in _tcs:
                        _args_val = _tc.get('args', {})
                        if isinstance(_args_val, str):
                            try:
                                _args_val = json.loads(_args_val)
                            except Exception:
                                _args_val = {'raw': _args_val}
                        _asst_msg['tool_calls'].append({
                            'id': _tc.get('id', ''),
                            'type': 'function',
                            'function': {
                                'name': _tc.get('name', 'unknown_tool'),
                                'arguments': json.dumps(_args_val, ensure_ascii=False),
                            },
                        })
                s.messages.append(_asst_msg)
                # ★ 保存 tool result 消息（配对到 tool_call_id）
                for _tc in _tcs:
                    _tcid = _tc.get('id', '')
                    if not _tcid:
                        continue
                    _result = ''
                    for _ctc in _completed_tool_calls:
                        if _ctc['id'] == _tcid:
                            _result = _ctc.get('result', '')
                            break
                    if not _result:
                        _result = '(no result)'
                    # 序列化非字符串结果
                    if not isinstance(_result, str):
                        try:
                            _result = json.dumps(_result, ensure_ascii=False)
                        except Exception:
                            _result = str(_result)
                    # 截断过长结果
                    if len(_result) > 8000:
                        _result = _result[:8000] + '...(truncated)'
                    s.messages.append({
                        'role': 'tool',
                        'tool_call_id': _tcid,
                        'content': str(_result),
                        '_ts': _now,
                    })
            # ★ 兜底：如果没有追踪到迭代数据（如纯文本模型），保存传统格式
            if not _assistant_iterations and (full_text or full_reasoning):
                assistant_content = full_text
                _msg = {
                    'role': 'assistant',
                    'content': assistant_content,
                    '_ts': _now,
                }
                if full_reasoning:
                    _msg['reasoning'] = full_reasoning
                s.messages.append(_msg)
            s.save()
            # ★★★ 调试：保存后验证 s.messages 的结构
            _saved_summary = []
            for _sm in s.messages:
                _sr = _sm.get('role', '?')
                _sh_r = 'reasoning' in _sm and bool(_sm.get('reasoning'))
                _sh_tc = 'tool_calls' in _sm and bool(_sm.get('tool_calls'))
                _sc_len = len(str(_sm.get('content', '')))
                _saved_summary.append(f'{_sr}(c={_sc_len},reasoning={_sh_r},tc={_sh_tc})')
            print(f'[knot-agui] SAVE DONE: total msgs in session={len(s.messages)} summary=[{", ".join(_saved_summary)}]', flush=True)
    except Exception as _save_err:
        print(f'[knot-agui] SAVE EXCEPTION: {_save_err}', flush=True)

    # ★ 写入调试日志到文件
    try:
        import os, traceback
        _log_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
        with open(_log_path, 'w', encoding='utf-8') as f:
            f.write(f'=== Knot AG-UI Debug Log ===\n')
            f.write(f'agent_id={agent_id} model={knot_model} session_id={session_id}\n')
            f.write(f'full_text_len={len(full_text)} full_reasoning_len={len(full_reasoning)}\n')
            f.write(f'line_count={_line_count}\n')
            f.write(f'conversation_id={received_conversation_id}\n\n')
            for entry in _debug_log:
                f.write(entry + '\n')
            f.write(f'\n=== full_text (first 500) ===\n{full_text[:500]}\n')
            f.write(f'\n=== full_reasoning (first 500) ===\n{full_reasoning[:500]}\n')
    except Exception as _dbg_err:
        # 即使写日志失败也打印错误
        try:
            import os
            _elog = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'knot_agui_debug.log')
            with open(_elog, 'w', encoding='utf-8') as f:
                f.write(f'DEBUG LOG WRITE ERROR: {_dbg_err}\n')
                import traceback; traceback.print_exc(file=f)
        except:
            pass

    # ★★★ Send done event with REAL session data (not empty arrays) ★★★
    #   旧实现发送 messages:[] 和 tool_calls:[]，导致前端 _attachLiveStreamToChat
    #   的 done handler Path 1 失败，Path 2 虽然能拿到 session 数据但消息不含
    #   结构化 tool_calls/reasoning → _renderRpMessages 渲染不出思考/工具卡片。
    _done_session = {
        'session_id': session_id,
        'messages': [],
        'model': model,
        'tool_calls': [],
    }
    try:
        from api.models import get_session as _gs
        _done_sess = _gs(session_id)
        if _done_sess:
            from api.helpers import redact_session_data
            _raw = _done_sess.compact() | {'messages': _done_sess.messages, 'tool_calls': getattr(_done_sess, 'tool_calls', [])}
            _done_session = redact_session_data(_raw)
            # ★★★ 调试日志：记录 done event 中的 session 数据结构
            _msg_summary = []
            for _dm in _done_session.get('messages', []):
                _r = _dm.get('role', '?')
                _has_reasoning = 'reasoning' in _dm and bool(_dm.get('reasoning'))
                _has_tc = 'tool_calls' in _dm and bool(_dm.get('tool_calls'))
                _c_len = len(str(_dm.get('content', '')))
                _msg_summary.append(f'{_r}(c={_c_len},reasoning={_has_reasoning},tc={_has_tc})')
            print(f'[knot-agui] DONE session: sid={session_id} msgs={len(_done_session.get("messages",[]))} summary=[{", ".join(_msg_summary)}]', flush=True)
        else:
            print(f'[knot-agui] DONE session: get_session returned None for sid={session_id}', flush=True)
    except Exception as _done_err:
        print(f'[knot-agui] DONE session: exception={_done_err}', flush=True)
    usage = {
        'input_tokens': 0,
        'output_tokens': len(full_text),
    }
    put('done', {
        'session': _done_session,
        'usage': usage,
        '_knot_conversation_id': received_conversation_id,
    })

    # ★★★ 自动更新员工记忆（LLM 提取对话关键信息）★★★
    #   在对话结束后，使用 LLM 提取关键信息并保存到 MEMORY.md / USER.md
    if employee_name and workspace and msg_text and full_text:
        try:
            from api.employee_memory import sync_employee_memory_after_turn
            import threading

            def _do_memory_sync():
                try:
                    result = sync_employee_memory_after_turn(
                        workspace, employee_name, msg_text, full_text
                    )
                    if result and result.get("ok"):
                        print(f"[knot-agui] Auto-updated memory: {result.get('message', '')}", flush=True)
                except Exception as _mem_err:
                    print(f"[knot-agui] Auto-update memory failed: {_mem_err}", flush=True)

            # 异步执行，不阻塞主流程
            _mem_thread = threading.Thread(target=_do_memory_sync, daemon=True)
            _mem_thread.start()
        except Exception as _import_err:
            print(f"[knot-agui] Failed to import memory module: {_import_err}", flush=True)


def run_knot_agui_sync(message: str, *,
                        model_name: str = "",
                        system_prompt: str = "",
                        enable_web_search: bool = False,
                        workspace: str = "") -> str:
    """同步调用 Knot AG-UI agent 并返回完整文本响应。

    供 MCP Gateway Worker（gateway_client.py 的 _execute_task）使用，
    避免在 Worker 子进程中启动完整 AIAgent，改为直接调用 Knot AG-UI API。
    所有 MCP 工具统一使用 knot_agui_mcp_model 配置的模型。

    自动检测并安装 knot-cli，程序化创建工作区。

    Args:
        message: 用户消息
        model_name: 模型名称（如 "hy3-preview"），为空时从 settings 读取 knot_agui_mcp_model
        system_prompt: 可选的系统提示词
        enable_web_search: 是否启用联网搜索
        workspace: 工作区路径（用于程序化创建工作区）

    Returns:
        助手的回复文本；若出错则返回 "[Error] ..." 格式的错误信息。
    """
    # ── Auto-setup knot-cli and workspace ────────────────────
    print(f"[knot_agui_sync] ENTER — workspace='{workspace}', model_name='{model_name[:40]}'", flush=True)
    # 直接读取完整 settings（不用 _load_agui_settings() 的过滤版本）
    try:
        from api.config import load_settings
        _s = load_settings()
    except Exception as _cfg_err:
        return f"[Error] Cannot load settings: {_cfg_err}"

    api_token = _s.get("knot_agui_token", "")

    # Auto-setup knot-cli if not present
    if not _get_knot_cli_path():
        print("[knot-agui-sync] knot-cli not found, attempting auto-install...", flush=True)
        if api_token:
            install_ok, _install_uuid = _install_knot_cli(workspace or ".", api_token)
            if install_ok:
                print("[knot-agui-sync] knot-cli installed successfully", flush=True)
            else:
                print("[knot-agui-sync] knot-cli auto-install failed", flush=True)
        else:
            print("[knot-agui-sync] knot-cli not found and no token for auto-install", flush=True)

    # ── Original logic continues ─────────────────────────────
    # NOTE: agent_client_uuid (connection_uuid) is injected into chat_extra below
    # when available, enabling workspace-level context on Knot platform.
    
    # agent_id：从 knot_agui_agents 取第一个 agent 的 id
    agents_str = _s.get("knot_agui_agents", "").strip()
    agent_id = ""
    if agents_str:
        try:
            _agents = json.loads(agents_str)
            if isinstance(_agents, list) and len(_agents) > 0:
                agent_id = str(_agents[0].get("id", "")).strip()
        except Exception:
            pass
    if not agent_id:
        return "[Error] Knot AG-UI agents not configured or first agent has no id (knot_agui_agents)"

    # model_name：从参数或 settings 读取
    if not model_name:
        model_name = _s.get("knot_agui_mcp_model", "").strip()
    if not model_name:
        return "[Error] Knot AG-UI mcp_model not configured (knot_agui_mcp_model)"

    knot_model = model_name

    # 读取 token / user
    api_token = _s.get("knot_agui_token", "")
    if not api_token:
        return "[Error] Knot AG-UI token not configured (knot_agui_token)"

    # 构建请求
    api_url = f"https://knot.woa.com/apigw/api/v1/agents/agui/{agent_id}"
    headers = {
        "x-knot-api-token": api_token,
        "Content-Type": "application/json",
    }
    api_user = _s.get("knot_agui_user", "")
    if api_user:
        headers["x-knot-api-user"] = api_user

    chat_body = {
        "input": {
            "message": message,
            "conversation_id": "",
            "stream": True,
            "enable_web_search": enable_web_search,
            "chat_extra": {},
        }
    }
    if knot_model:
        chat_body["input"]["model"] = knot_model
    if system_prompt:
        chat_body["input"]["chat_extra"]["system_prompt"] = system_prompt

    # ★ 注入 agent_client_uuid（工作区 ID）到 chat_extra
    _ws_path = workspace or "."
    _agent_client_uuid = ""
    print(f"[knot_agui_sync] agent_client_uuid lookup — _ws_path='{_ws_path}', cache_keys={list(_WORKSPACE_CONNECTION_CACHE.keys())}", flush=True)
    if _ws_path and _ws_path != ".":
        # ★ 使用 get_connection_uuid（内部会自动注册未注册的工作区）
        try:
            _agent_client_uuid = get_connection_uuid(_ws_path)
        except Exception:
            pass
    if _agent_client_uuid:
        chat_body["input"]["chat_extra"]["agent_client_uuid"] = _agent_client_uuid
        print(f"[knot_agui_sync] Injected agent_client_uuid={_agent_client_uuid} for workspace={_ws_path}", flush=True)
    else:
        print(f"[knot_agui_sync] agent_client_uuid is EMPTY — workspace={_ws_path}", flush=True)

    # ★ 同时传递 workspace_path 到 chat_extra，让 Knot 平台可以双重验证工作区
    if _ws_path and _ws_path != ".":
        chat_body["input"]["chat_extra"]["workspace_path"] = _ws_path

    # 发送请求
    try:
        response = requests.post(
            api_url, json=chat_body, headers=headers,
            stream=True, timeout=300,
        )
        response.encoding = 'utf-8'
    except requests.exceptions.ConnectionError as e:
        return f"[Error] Cannot connect to Knot AG-UI: {e}"
    except requests.exceptions.Timeout:
        return "[Error] Knot AG-UI connection timed out"

    if response.status_code not in (200, 201):
        return f"[Error] Knot AG-UI HTTP {response.status_code}: {response.text[:500]}"

    # 解析 SSE 流，收集 full_text
    full_text = ""
    for raw_line in response.iter_lines(decode_unicode=False):
        if not raw_line:
            continue
        try:
            line = raw_line.decode('utf-8')
        except UnicodeDecodeError:
            line = raw_line.decode('utf-8', errors='replace')

        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        elif line.startswith("data: "):
            line = line[6:].strip()
        elif line.startswith("event:"):
            continue
        else:
            continue

        if line == "[DONE]":
            break

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        if "type" not in msg:
            continue

        msg_type = msg.get("type", "")
        raw_event = msg.get("rawEvent", {})

        if msg_type in ("TextMessageContent", "TEXT_MESSAGE_CONTENT",
                        "ThinkingTextMessageContent", "THINKING_TEXT_MESSAGE_CONTENT"):
            text = raw_event.get("content", "")
            if not text:
                text = msg.get("delta", "")
            if text and not re.match(r'^[\s{}\[\]"]+$', text.strip()):
                full_text += text

    return full_text if full_text else "[No response from Knot AG-UI agent]"

