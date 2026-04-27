import json, re
from pathlib import Path

state_dir = Path.home() / '.hermes' / 'webui' / 'sessions'

# Find group chat session IDs
gc_file = state_dir / '_group_chats.json'
gc_map = json.loads(gc_file.read_text()) if gc_file.exists() else {}
gc_sids = set(gc_map.values())

print("Group chat session IDs:", gc_sids)
print()

for f in sorted(state_dir.glob('*.json')):
    if f.name.startswith('_'):
        continue
    sid = f.stem
    is_gc = sid in gc_sids
    try:
        data = json.loads(f.read_text(encoding='utf-8'))
        msgs = data.get('messages', [])
        if not msgs:
            continue
        has_delegation = any('已将任务委派给' in str(m.get('content', '')) for m in msgs)
        if has_delegation:
            print(f'=== {"GROUP CHAT" if is_gc else "EMPLOYEE"} session: {sid} ({len(msgs)} msgs) ===')
            for i, m in enumerate(msgs):
                if '已将任务委派给' in str(m.get('content', '')):
                    # Look at nearby messages for context
                    print(f'  [{i}] role={m["role"]} content="{m["content"][:100]}"')
                    print(f'       keys={list(m.keys())}')
                    if i > 0:
                        prev = msgs[i-1]
                        print(f'  [{i-1}] role={prev["role"]} content="{str(prev.get("content",""))[:100]}" keys={list(prev.keys())}')
                    print()
    except Exception as e:
        pass
