"""
Hermes Web UI -- Workspace and file system helpers.

Workspace lists and last-used workspace are stored per-profile so each
profile has its own workspace configuration.  State files live at
``{profile_home}/webui_state/workspaces.json`` and
``{profile_home}/webui_state/last_workspace.txt``.  The global STATE_DIR
paths are used as fallback when no profile module is available.
"""
import json
import os
import subprocess
from pathlib import Path

from api.config import (
    WORKSPACES_FILE as _GLOBAL_WS_FILE,
    LAST_WORKSPACE_FILE as _GLOBAL_LW_FILE,
    DEFAULT_WORKSPACE as _BOOT_DEFAULT_WORKSPACE,
    MAX_FILE_BYTES, IMAGE_EXTS, MD_EXTS
)


# ── Profile-aware path resolution ───────────────────────────────────────────

def _profile_state_dir() -> Path:
    """Return the webui_state directory for the active profile.

    For the default profile, returns the global STATE_DIR (respects
    HERMES_WEBUI_STATE_DIR env var for test isolation).
    For named profiles, returns {profile_home}/webui_state/.
    """
    try:
        from api.profiles import get_active_profile_name, get_active_hermes_home
        name = get_active_profile_name()
        if name and name != 'default':
            d = get_active_hermes_home() / 'webui_state'
            d.mkdir(parents=True, exist_ok=True)
            return d
    except ImportError:
        pass
    return _GLOBAL_WS_FILE.parent


def _workspaces_file() -> Path:
    """Return the workspaces.json path for the active profile."""
    return _profile_state_dir() / 'workspaces.json'


def _last_workspace_file() -> Path:
    """Return the last_workspace.txt path for the active profile."""
    return _profile_state_dir() / 'last_workspace.txt'


def _profile_default_workspace() -> str:
    """Read the profile's default workspace from its config.yaml.

    Checks keys in priority order:
      1. 'workspace'         — explicit webui workspace key
      2. 'default_workspace' — alternate explicit key
      3. 'terminal.cwd'      — hermes-agent terminal working dir (most common)

    Falls back to the boot-time DEFAULT_WORKSPACE constant.
    """
    try:
        from api.config import get_config
        cfg = get_config()
        # Explicit webui workspace keys first
        for key in ('workspace', 'default_workspace'):
            ws = cfg.get(key)
            if ws:
                p = Path(str(ws)).expanduser().resolve()
                if p.is_dir():
                    return str(p)
        # Fall through to terminal.cwd — the agent's configured working directory
        terminal_cfg = cfg.get('terminal', {})
        if isinstance(terminal_cfg, dict):
            cwd = terminal_cfg.get('cwd', '')
            if cwd and str(cwd) not in ('.', ''):
                p = Path(str(cwd)).expanduser().resolve()
                if p.is_dir():
                    return str(p)
    except (ImportError, Exception):
        pass
    return str(_BOOT_DEFAULT_WORKSPACE)


# ── Public API ──────────────────────────────────────────────────────────────

def _clean_workspace_list(workspaces: list) -> list:
    """Sanitize a workspace list:
    - Remove entries whose paths no longer exist on disk.
    - Remove entries that look like test artifacts (webui-mvp-test, test-workspace).
    - Remove entries whose paths live inside another profile's directory
      (e.g. ~/.hermes/profiles/X/... should not appear on a different profile).
    - Rename any entry whose name is literally 'default' to 'Home' (avoids
      confusion with the 'default' profile name).
    Returns the cleaned list (may be empty).
    """
    hermes_profiles = (Path.home() / '.hermes' / 'profiles').resolve()
    result = []
    for w in workspaces:
        path = w.get('path', '')
        name = w.get('name', '')
        p = Path(path).resolve() if path else Path('/')
        # Skip test artifacts
        if 'test-workspace' in path or 'webui-mvp-test' in path:
            continue
        # Skip paths that no longer exist
        if not p.is_dir():
            continue
        # Skip paths inside a named profile's directory (cross-profile leak)
        try:
            p.relative_to(hermes_profiles)
            continue  # it IS under profiles/ — remove it
        except ValueError:
            pass
        # Rename confusing 'default' label to 'Home'
        if name.lower() == 'default':
            name = 'Home'
        result.append({'path': str(p), 'name': name})
    return result


def _migrate_global_workspaces() -> list:
    """Read the legacy global workspaces.json, clean it, and return the result.

    This is the migration path for users upgrading from a pre-profile version:
    their global file may contain cross-profile entries, test artifacts, and
    stale paths accumulated over time.  We clean it in-place and rewrite it.
    """
    if not _GLOBAL_WS_FILE.exists():
        return []
    try:
        raw = json.loads(_GLOBAL_WS_FILE.read_text(encoding='utf-8'))
        cleaned = _clean_workspace_list(raw)
        if len(cleaned) != len(raw):
            # Rewrite the cleaned version so future reads are already clean
            _GLOBAL_WS_FILE.write_text(
                json.dumps(cleaned, ensure_ascii=False, indent=2), encoding='utf-8'
            )
        return cleaned
    except Exception:
        return []


def load_workspaces() -> list:
    ws_file = _workspaces_file()
    if ws_file.exists():
        try:
            raw = json.loads(ws_file.read_text(encoding='utf-8'))
            cleaned = _clean_workspace_list(raw)
            if len(cleaned) != len(raw):
                # Persist the cleaned version so stale entries don't keep reappearing
                try:
                    ws_file.write_text(
                        json.dumps(cleaned, ensure_ascii=False, indent=2), encoding='utf-8'
                    )
                except Exception:
                    pass
            return cleaned or [{'path': _profile_default_workspace(), 'name': 'Home'}]
        except Exception:
            pass
    # No profile-local file yet.
    # For the DEFAULT profile: migrate from the legacy global file (one-time cleanup).
    # For NAMED profiles: always start clean with just their own workspace.
    try:
        from api.profiles import get_active_profile_name
        is_default = get_active_profile_name() in ('default', None)
    except ImportError:
        is_default = True
    if is_default:
        migrated = _migrate_global_workspaces()
        if migrated:
            return migrated
    # Fresh start: single entry from the profile's configured workspace, labeled "Home"
    return [{'path': _profile_default_workspace(), 'name': 'Home'}]


def save_workspaces(workspaces: list) -> None:
    ws_file = _workspaces_file()
    ws_file.parent.mkdir(parents=True, exist_ok=True)
    ws_file.write_text(json.dumps(workspaces, ensure_ascii=False, indent=2), encoding='utf-8')


def get_last_workspace() -> str:
    lw_file = _last_workspace_file()
    if lw_file.exists():
        try:
            p = lw_file.read_text(encoding='utf-8').strip()
            if p and Path(p).is_dir():
                return p
        except Exception:
            pass
    # Fallback: try global file
    if _GLOBAL_LW_FILE.exists():
        try:
            p = _GLOBAL_LW_FILE.read_text(encoding='utf-8').strip()
            if p and Path(p).is_dir():
                return p
        except Exception:
            pass
    return _profile_default_workspace()


def set_last_workspace(path: str) -> None:
    try:
        lw_file = _last_workspace_file()
        lw_file.parent.mkdir(parents=True, exist_ok=True)
        lw_file.write_text(str(path), encoding='utf-8')
    except Exception:
        pass


def safe_resolve_ws(root: Path, requested: str) -> Path:
    """Resolve a relative path inside a workspace root, raising ValueError on traversal."""
    resolved = (root / requested).resolve()
    resolved.relative_to(root.resolve())
    return resolved


def list_dir(workspace: Path, rel: str='.'):
    target = safe_resolve_ws(workspace, rel)
    if not target.is_dir():
        raise FileNotFoundError(f"Not a directory: {rel}")
    entries = []
    for item in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        entries.append({
            'name': item.name,
            'path': str(item.relative_to(workspace)),
            'type': 'dir' if item.is_dir() else 'file',
            'size': item.stat().st_size if item.is_file() else None,
        })
        if len(entries) >= 200:
            break
    return entries


def read_file_content(workspace: Path, rel: str) -> dict:
    target = safe_resolve_ws(workspace, rel)
    if not target.is_file():
        raise FileNotFoundError(f"Not a file: {rel}")
    size = target.stat().st_size
    if size > MAX_FILE_BYTES:
        raise ValueError(f"File too large ({size} bytes, max {MAX_FILE_BYTES})")
    content = target.read_text(encoding='utf-8', errors='replace')
    return {'path': rel, 'content': content, 'size': size, 'lines': content.count('\n') + 1}


# ── Git detection ──────────────────────────────────────────────────────────

def _run_git(args, cwd, timeout=3):
    """Run a git command and return stdout, or None on failure."""
    try:
        r = subprocess.run(
            ['git'] + args, cwd=str(cwd), capture_output=True,
            text=True, timeout=timeout,
        )
        return r.stdout.strip() if r.returncode == 0 else None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def git_info_for_workspace(workspace: Path) -> dict:
    """Return git info for a workspace directory, or None if not a git repo."""
    if not (workspace / '.git').exists():
        return None
    branch = _run_git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)
    if branch is None:
        return None
    # Status counts
    status_out = _run_git(['status', '--porcelain'], workspace) or ''
    lines = [l for l in status_out.splitlines() if l]
    # git status --porcelain: XY format where X=index, Y=worktree
    modified = sum(1 for l in lines if len(l) >= 2 and (l[0] in 'MAR' or l[1] in 'MAR'))
    untracked = sum(1 for l in lines if l.startswith('??'))
    dirty = len(lines)
    # Ahead/behind
    ahead = _run_git(['rev-list', '--count', '@{u}..HEAD'], workspace)
    behind = _run_git(['rev-list', '--count', 'HEAD..@{u}'], workspace)
    return {
        'branch': branch,
        'dirty': dirty,
        'modified': modified,
        'untracked': untracked,
        'ahead': int(ahead) if ahead and ahead.isdigit() else 0,
        'behind': int(behind) if behind and behind.isdigit() else 0,
        'is_git': True,
    }


def _run_git_raw(args, cwd, timeout=5):
    """Run a git command; return full stdout (no strip), or None on failure."""
    try:
        r = subprocess.run(
            ['git'] + args, cwd=str(cwd), capture_output=True,
            text=True, timeout=timeout, errors='replace',
        )
        return r.stdout if r.returncode == 0 else None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return None


def git_changes_for_workspace(workspace: Path) -> dict:
    """Return per-file changes (status + additions/deletions) for a workspace.

    Returns: { is_git, branch, modified, added, deleted, untracked,
               files: [ {path, status, additions, deletions}, ... ] }
    """
    if not (workspace / '.git').exists():
        return {'is_git': False}
    branch = _run_git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace)
    if branch is None:
        return {'is_git': False}

    # Per-file status via porcelain
    status_out = _run_git_raw(['status', '--porcelain'], workspace) or ''
    file_entries = []  # list of (status_code, path)
    for line in status_out.splitlines():
        if len(line) < 3:
            continue
        code = line[:2]
        rest = line[3:]
        # Handle renames: "R  old -> new"
        if ' -> ' in rest:
            rest = rest.split(' -> ', 1)[1]
        file_entries.append((code, rest.strip().strip('"')))

    # additions/deletions via `git diff --numstat` (unstaged + staged)
    numstat_map = {}
    # working tree vs index
    for args in (
        ['diff', '--numstat'],
        ['diff', '--cached', '--numstat'],
    ):
        out = _run_git_raw(args, workspace) or ''
        for line in out.splitlines():
            parts = line.split('\t')
            if len(parts) < 3:
                continue
            add_s, del_s, path = parts[0], parts[1], parts[2]
            try:
                a = int(add_s) if add_s != '-' else 0
                d = int(del_s) if del_s != '-' else 0
            except ValueError:
                a, d = 0, 0
            cur = numstat_map.get(path, (0, 0))
            numstat_map[path] = (cur[0] + a, cur[1] + d)

    files = []
    modified = added = deleted = untracked = 0
    for code, path in file_entries:
        s = code.strip() or '??'
        add, dele = numstat_map.get(path, (0, 0))
        # If untracked and no numstat, try counting lines
        if code.startswith('??') and add == 0 and dele == 0:
            try:
                fp = workspace / path
                if fp.is_file():
                    with open(fp, 'rb') as f:
                        head = f.read(1024 * 128)
                    add = head.count(b'\n')
            except Exception:
                pass
        files.append({
            'path': path,
            'status': s,
            'additions': add,
            'deletions': dele,
        })
        if s.startswith('?'):
            untracked += 1
        elif 'A' in s:
            added += 1
        elif 'D' in s:
            deleted += 1
        else:
            modified += 1

    return {
        'is_git': True,
        'branch': branch,
        'modified': modified,
        'added': added,
        'deleted': deleted,
        'untracked': untracked,
        'files': files,
    }


def git_diff_for_path(workspace: Path, rel_path: str) -> str:
    """Return unified diff for a single path (worktree + staged combined)."""
    if not (workspace / '.git').exists():
        return ''
    # Unstaged diff
    unstaged = _run_git_raw(['diff', '--', rel_path], workspace) or ''
    # Staged diff
    staged = _run_git_raw(['diff', '--cached', '--', rel_path], workspace) or ''
    # Untracked file: show as full-add diff
    if not unstaged and not staged:
        # check if untracked
        status = _run_git_raw(['status', '--porcelain', '--', rel_path], workspace) or ''
        if status.startswith('??'):
            try:
                fp = workspace / rel_path
                if fp.is_file():
                    text = fp.read_text(encoding='utf-8', errors='replace')
                    lines = text.splitlines()
                    body = '\n'.join('+' + l for l in lines)
                    header = (
                        f"diff --git a/{rel_path} b/{rel_path}\n"
                        f"new file\n"
                        f"--- /dev/null\n"
                        f"+++ b/{rel_path}\n"
                        f"@@ -0,0 +1,{len(lines)} @@\n"
                    )
                    return header + body
            except Exception:
                return ''
        return ''
    parts = []
    if staged.strip():
        parts.append('# --- staged ---\n' + staged)
    if unstaged.strip():
        parts.append('# --- unstaged ---\n' + unstaged)
    return '\n'.join(parts)
