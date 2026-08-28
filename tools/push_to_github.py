"""Push the ainterior monorepo to GitHub in batched commits.

Runs from the sandbox so file contents stream from disk instead of being inlined
into a tool call. Text files only — binary fixtures are reported, not silently
dropped.
"""
import json
import os
import sys

from gumloop import Gumloop

ROOT = "/home/user/ainterior"
REPO = "https://github.com/TheDemApples/ainterior"
BRANCH = "main"

SKIP_DIRS = {".git", "dist", ".verify", "node_modules", "__pycache__", ".pytest_cache"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gz", ".tar", ".zip", ".ico", ".woff", ".woff2", ".pyc"}

text_files, binary_files = [], []
for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
    for fn in sorted(filenames):
        if fn.startswith(".") and fn != ".env.example":
            continue
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, ROOT)
        ext = os.path.splitext(fn)[1].lower()
        if ext in SKIP_EXT:
            binary_files.append(rel)
            continue
        try:
            with open(full, "r", encoding="utf-8") as fh:
                content = fh.read()
        except UnicodeDecodeError:
            binary_files.append(rel)
            continue
        text_files.append((rel, content))

total = sum(len(c.encode()) for _, c in text_files)
print(f"text files: {len(text_files)}  total {total/1024:.0f} KiB")
print(f"binary skipped: {len(binary_files)} -> {binary_files}")

# batch so no single commit payload gets unwieldy
BATCH_BYTES = 600 * 1024
batches, cur, cur_bytes = [], [], 0
for rel, content in text_files:
    b = len(content.encode())
    if cur and cur_bytes + b > BATCH_BYTES:
        batches.append(cur)
        cur, cur_bytes = [], 0
    cur.append((rel, content))
    cur_bytes += b
if cur:
    batches.append(cur)

print(f"{len(batches)} commit(s)")

client = Gumloop()
for i, batch in enumerate(batches, 1):
    payload = [{"path": rel, "content": content} for rel, content in batch]
    size = sum(len(c.encode()) for _, c in batch)
    msg = (
        "ainterior: initial monorepo — spec, catalog, layout engine, blueprint, 3D editor, backend, demo"
        if i == 1 else f"ainterior: monorepo contents ({i}/{len(batches)})"
    )
    res = client.mcp.execute("github", "create_or_update_file", {
        "repo_url": REPO,
        "message": msg,
        "branch": BRANCH,
        "files": payload,
    }).results[0]
    if res.status != "success":
        print(f"  batch {i}: FAILED {res.error}")
        sys.exit(1)
    try:
        out = res.decoded_content
        sha = (out.get("commit") or {}).get("oid", "?")[:8] if isinstance(out, dict) else "?"
    except Exception:
        sha = "?"
    print(f"  batch {i}/{len(batches)}: {len(batch)} files, {size/1024:.0f} KiB -> {sha}")

print("PUSH COMPLETE")
