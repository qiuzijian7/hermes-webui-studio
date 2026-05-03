#!/usr/bin/env python3
"""
Example: Using the Employee Memory System.

This script demonstrates:
1. Creating an employee with memory files
2. Reading memory and injecting into system prompt
3. Updating memory manually
4. Integrating with Knot AG-UI (conceptual)
"""

import sys
import os

# Add current directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api.employee_fs import create_employee, get_employee, list_employees
from api.employee_memory import (
    EmployeeMemoryStore,
    build_employee_memory_system_prompt,
    initialize_employee_memory_files,
    get_employee_memory_store,
)


def example_1_create_employee_with_memory():
    """Example 1: Create an employee (memory files auto-created)."""
    print("=== Example 1: Create Employee with Memory ===")

    workspace = "."  # Current directory (for demo only)
    employee_name = "Demo Assistant"

    try:
        # Create employee (memory files auto-created via initialize_employee_memory_files)
        emp = create_employee(workspace, {
            "name": employee_name,
            "role": "代码工程师",
            "model": "anthropic/claude-sonnet-4",
        })
        print(f"  Created employee: {emp['name']}")
        print(f"  ID: {emp['id']}")

        # Check if memory files exist
        import pathlib
        emp_dir = pathlib.Path(workspace) / "employees" / employee_name
        memory_path = emp_dir / "MEMORY.md"
        user_path = emp_dir / "USER.md"
        print(f"  MEMORY.md exists: {memory_path.exists()}")
        print(f"  USER.md exists: {user_path.exists()}")

        print("PASSED\n")
        return emp

    except Exception as e:
        print(f"  ERROR: {e}")
        return None


def example_2_read_and_inject_memory(workspace, employee_name):
    """Example 2: Read memory and inject into system prompt."""
    print("=== Example 2: Read & Inject Memory ===")

    # Build system prompt (reads MEMORY.md and USER.md)
    prompt = build_employee_memory_system_prompt(workspace, employee_name)
    print(f"  System prompt length: {len(prompt)}")
    print(f"  Prompt preview:\n{prompt[:300]}...")

    # This prompt can be injected into Knot AG-UI API calls:
    #   chat_body["input"]["chat_extra"]["system_prompt"] = prompt

    print("PASSED\n")


def example_3_update_memory_manually(workspace, employee_name):
    """Example 3: Update memory manually (via API or direct file edit)."""
    print("=== Example 3: Update Memory Manually ===")

    store = get_employee_memory_store(workspace, employee_name)
    if not store:
        print("  ERROR: Employee not found")
        return

    # Add entries
    r1 = store.add("memory", "User prefers Python over JavaScript")
    print(f"  Add memory: {r1}")

    r2 = store.add("user", "Communication style: concise")
    print(f"  Add user profile: {r2}")

    # Check file contents
    memory_path = store.employee_dir / "MEMORY.md"
    with open(memory_path, 'r', encoding='utf-8') as f:
        content = f.read()
        print(f"  MEMORY.md content:\n{content}")

    print("PASSED\n")


def example_4_simulate_knot_agui_integration(workspace, employee_name):
    """Example 4: Conceptual integration with Knot AG-UI.

    In knot_agui.py, the run_knot_agui_streaming() function
    automatically calls build_employee_memory_system_prompt()
    and injects it into the system_prompt.
    """
    print("=== Example 4: Knot AG-UI Integration (Conceptual) ===")

    # Step 1: Build system prompt with memory
    prompt = build_employee_memory_system_prompt(workspace, employee_name)
    print(f"  System prompt built (len={len(prompt)})")

    # Step 2: Inject into Knot API request
    chat_body = {
        "input": {
            "message": "Hello",
            "chat_extra": {},
        }
    }
    if prompt:
        chat_body["input"]["chat_extra"]["system_prompt"] = prompt
        print("  Injected into chat_body['input']['chat_extra']['system_prompt']")

    # Step 3: Send request to Knot API (omitted)
    print("  (Request sent to Knot API...)")

    # Step 4: Parse response (if <memory> tags detected, update memory)
    #   This is a future enhancement.
    print("  (Future: Parse response for <memory> tags and update memory)")

    print("PASSED\n")


def example_5_advanced_memory_operations(workspace, employee_name):
    """Example 5: Advanced operations (replace, remove, list)."""
    print("=== Example 5: Advanced Memory Operations ===")

    store = get_employee_memory_store(workspace, employee_name)
    if not store:
        print("  ERROR: Employee not found")
        return

    # List entries
    mem_entries = store.get_all_entries("memory")
    user_entries = store.get_all_entries("user")
    print(f"  Memory entries: {len(mem_entries)}")
    print(f"  User entries: {len(user_entries)}")

    # Replace an entry
    if mem_entries:
        old = mem_entries[0]
        r = store.replace("memory", old, old + " (updated)")
        print(f"  Replace: {r}")

    # Remove an entry
    if mem_entries:
        r = store.remove("memory", mem_entries[0])
        print(f"  Remove: {r}")

    print("PASSED\n")


def cleanup(workspace, employee_name):
    """Clean up demo files."""
    import shutil
    emp_dir = os.path.join(workspace, "employees", employee_name)
    if os.path.exists(emp_dir):
        shutil.rmtree(emp_dir)
        print(f"Cleaned up: {emp_dir}")


if __name__ == "__main__":
    print("\nRunning Employee Memory System Examples...\n")

    # Example 1: Create employee
    emp = example_1_create_employee_with_memory()

    if emp:
        workspace = "."
        employee_name = emp["name"]

        # Example 2: Read & inject
        example_2_read_and_inject_memory(workspace, employee_name)

        # Example 3: Update manually
        example_3_update_memory_manually(workspace, employee_name)

        # Example 4: Knot AG-UI integration (conceptual)
        example_4_simulate_knot_agui_integration(workspace, employee_name)

        # Example 5: Advanced operations
        example_5_advanced_memory_operations(workspace, employee_name)

        # Cleanup
        cleanup(workspace, employee_name)

    print("All examples completed!")
