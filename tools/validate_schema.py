#!/usr/bin/env python3
"""ainterior schema validator.

1. Parses every supabase/migrations/*.sql with pglast (the real PostgreSQL
   grammar, via libpg_query) so a syntax error fails the build.
2. Extracts tables/columns/foreign keys/policies/indexes/functions.
3. Asserts:
     * every table SPEC section 6 declares exists, with its specced columns
     * every FOREIGN KEY target table+column actually exists
     * every table has RLS enabled AND at least one explicit policy
     * catalog_items has a world-read policy gated on published = true
     * moderation_queue policies are admin-only
     * credits_ledger has no UPDATE/DELETE policy (append-only)
     * an ivfflat/hnsw vector index exists on catalog_items.embedding
     * scan_assets has an anon INSERT policy and NO anon SELECT policy
Exit code 0 = all green.

Usage: python3 tools/validate_schema.py [build_root]
"""
from __future__ import annotations
import glob
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..")
MIG = sorted(glob.glob(os.path.join(ROOT, "supabase", "migrations", "*.sql")))

# ---------------------------------------------------------------- SPEC section 6
SPEC_TABLES: dict[str, list[str]] = {
    "profiles": ["user_id", "display_name", "role", "plan", "credits"],
    "projects": ["owner", "name", "kind", "archived"],
    "rooms": ["project_id", "name", "polygon_mm", "height_mm", "openings",
              "features", "source", "confidence"],
    "capture_sessions": ["project_id", "code", "status", "expires_at", "claimed_by"],
    "scan_assets": ["session_id", "room_id", "storage_path", "kind", "exif",
                    "width", "height"],
    "recon_jobs": ["room_id", "provider", "provider_job_id", "status", "progress",
                   "result", "error"],
    "catalog_items": ["brand", "name", "product_type", "sku", "category", "archetype",
                      "dims_mm", "seat_h_mm", "footprint", "l_shape_mm", "clearance_mm",
                      "placement", "colorways", "price_usd", "url", "tags", "proxy",
                      "embedding", "phash", "published"],
    "user_items": ["owner", "name", "archetype", "dims_mm", "storage_path", "embedding",
                   "phash", "status", "matched_item_id"],
    "moderation_queue": ["user_item_id", "cluster_id", "cluster_size", "state",
                         "reviewer", "notes"],
    "layouts": ["room_id", "seed", "mode", "style", "score", "placements", "rationale",
                "metrics", "is_user_edited"],
    "renders": ["layout_id", "kind", "storage_path"],
    "credits_ledger": ["owner", "delta", "reason", "ref_id"],
}
# every table needs id + created_at per SPEC section 6 preamble
UNIVERSAL = ["id", "created_at"]

errors: list[str] = []
warns: list[str] = []
notes: list[str] = []


def err(m):
    errors.append(m)


def warn(m):
    warns.append(m)


# ---------------------------------------------------------------- 1. syntax
def check_syntax() -> str:
    blob = []
    try:
        from pglast import parse_sql
    except ImportError:
        warn("pglast not installed - skipping real PostgreSQL grammar check")
        parse_sql = None
    for path in MIG:
        sql = open(path).read()
        blob.append(sql)
        if parse_sql is None:
            continue
        try:
            stmts = parse_sql(sql)
            notes.append(f"parsed {os.path.basename(path)}: "
                         f"{len(stmts)} top-level statements (PostgreSQL grammar OK)")
        except Exception as e:  # pglast raises ParseError with cursorpos
            pos = getattr(e, "cursorpos", None)
            ctx = ""
            if pos:
                ctx = repr(sql[max(0, pos - 120):pos + 120])
            err(f"SYNTAX {os.path.basename(path)}: {e}\n    near: {ctx}")
    return "\n".join(blob)


SQL = check_syntax()
SQL_NC = re.sub(r"--[^\n]*", "", SQL)  # strip line comments for structural scans

# ---------------------------------------------------------------- 2. extract
table_re = re.compile(
    r"create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\((.*?)\n\)\s*;",
    re.S | re.I)
tables: dict[str, str] = {}
for m in table_re.finditer(SQL_NC):
    tables[m.group(1).lower()] = m.group(2)


def columns_of(body: str) -> list[str]:
    cols = []
    depth = 0
    line_start = True
    buf = ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            cols.append(buf.strip())
            buf = ""
        else:
            buf += ch
    if buf.strip():
        cols.append(buf.strip())
    out = []
    for c in cols:
        first = c.split()[0].lower() if c.split() else ""
        if first in ("constraint", "primary", "foreign", "unique", "check", "exclude"):
            continue
        out.append(first)
    return out


table_cols = {t: columns_of(b) for t, b in tables.items()}

# foreign keys: inline `references x(y)` and table-level FK constraints
fk_re = re.compile(r"references\s+((?:auth\.|storage\.)?[a-z_][a-z0-9_]*)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)",
                   re.I)
fks: list[tuple[str, str, str]] = []  # (owning table, target table, target col)
for t, body in tables.items():
    for m in fk_re.finditer(body):
        fks.append((t, m.group(1).lower(), m.group(2).lower()))

# policies
pol_re = re.compile(
    r"create\s+policy\s+([a-z0-9_]+)\s+on\s+((?:storage\.)?[a-z_][a-z0-9_]*)\s+"
    r"for\s+([a-z]+)\s*(?:to\s+([a-z_,\s]+?))?\s*(?:using|with\s+check)",
    re.I | re.S)
policies: list[dict] = []
for m in pol_re.finditer(SQL_NC):
    policies.append({
        "name": m.group(1),
        "table": m.group(2).lower(),
        "cmd": m.group(3).lower(),
        "roles": [r.strip() for r in (m.group(4) or "").split(",") if r.strip()],
    })

rls_enabled = {m.group(1).lower() for m in re.finditer(
    r"alter\s+table\s+([a-z_][a-z0-9_]*)\s+enable\s+row\s+level\s+security", SQL_NC, re.I)}
rls_forced = {m.group(1).lower() for m in re.finditer(
    r"alter\s+table\s+([a-z_][a-z0-9_]*)\s+force\s+row\s+level\s+security", SQL_NC, re.I)}

indexes = re.findall(
    r"create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)\s+on\s+([a-z_][a-z0-9_]*)(.*?);",
    SQL_NC, re.I | re.S)
functions = re.findall(
    r"create\s+or\s+replace\s+function\s+([a-z_][a-z0-9_]*)\s*\(", SQL_NC, re.I)
triggers = re.findall(
    r"create\s+trigger\s+([a-z0-9_]+)\s+(before|after)\s+([a-z\s]+?)\s+on\s+([a-z_.][a-z0-9_.]*)",
    SQL_NC, re.I)

# ---------------------------------------------------------------- 3. assertions
for t, cols in SPEC_TABLES.items():
    if t not in tables:
        err(f"MISSING TABLE: SPEC section 6 requires `{t}`")
        continue
    have = table_cols[t]
    for c in UNIVERSAL + cols:
        if c not in have:
            err(f"MISSING COLUMN: {t}.{c} (SPEC section 6)")

for owner, target, col in fks:
    if target.startswith("auth.") or target.startswith("storage."):
        continue  # supabase-managed schema, not in our DDL
    if target not in tables:
        err(f"BROKEN FK: {owner} -> {target}({col}): target table not defined")
    elif col not in table_cols[target]:
        err(f"BROKEN FK: {owner} -> {target}({col}): target column not defined")

pol_by_table: dict[str, list[dict]] = {}
for p in policies:
    pol_by_table.setdefault(p["table"], []).append(p)

for t in SPEC_TABLES:
    if t not in rls_enabled:
        err(f"NO RLS: `alter table {t} enable row level security` missing")
    if t not in rls_forced:
        warn(f"{t}: RLS not FORCEd (table owner would bypass policies)")
    if t not in pol_by_table:
        err(f"NO POLICY: table `{t}` has RLS but zero policies -> permanently unreadable")

# catalog_items world-readable only where published = true
cat_sql = re.search(
    r"create\s+policy\s+catalog_select_published_anon.*?;", SQL_NC, re.I | re.S)
if not cat_sql or "published = true" not in cat_sql.group(0):
    err("catalog_items: anon SELECT policy must be gated on `published = true`")
for p in pol_by_table.get("catalog_items", []):
    if p["cmd"] in ("all", "select") and "anon" in p["roles"]:
        blk = re.search(rf"create\s+policy\s+{p['name']}\b.*?;", SQL_NC, re.I | re.S)
        if blk and "published" not in blk.group(0):
            err(f"catalog_items policy {p['name']} exposes rows to anon without a published gate")

# moderation_queue admin-only
for p in pol_by_table.get("moderation_queue", []):
    blk = re.search(rf"create\s+policy\s+{p['name']}\b.*?;", SQL_NC, re.I | re.S)
    if "anon" in p["roles"]:
        err(f"moderation_queue policy {p['name']} is exposed to anon")
    if blk and "auth_is_admin()" not in blk.group(0):
        err(f"moderation_queue policy {p['name']} is not gated on auth_is_admin()")

# credits_ledger append-only
for p in pol_by_table.get("credits_ledger", []):
    if p["cmd"] in ("update", "delete", "all", "insert"):
        err(f"credits_ledger must be append-only: policy {p['name']} grants {p['cmd'].upper()}")
if "tg_credits_ledger_append_only" not in functions:
    err("credits_ledger: missing tg_credits_ledger_append_only() guard trigger fn")
if not any(t[3] == "credits_ledger" and "update" in t[2].lower() for t in triggers):
    err("credits_ledger: no BEFORE UPDATE/DELETE trigger enforcing append-only")

# scan_assets anon path: INSERT yes, SELECT never
anon_sa = [p for p in pol_by_table.get("scan_assets", []) if "anon" in p["roles"]]
if not any(p["cmd"] == "insert" for p in anon_sa):
    err("scan_assets: no anon INSERT policy -> the QR phone path cannot work")
for p in anon_sa:
    if p["cmd"] != "insert":
        err(f"scan_assets: anon must be INSERT-only, found {p['cmd'].upper()} in {p['name']}")
ins = next((p for p in anon_sa if p["cmd"] == "insert"), None)
if ins:
    blk = re.search(rf"create\s+policy\s+{ins['name']}\b.*?;", SQL_NC, re.I | re.S).group(0)
    for needle, label in [("auth_capture_session_id()", "session scoping"),
                          ("expires_at > now()", "TTL check"),
                          ("asset_count < s.max_assets", "40-asset cap")]:
        if needle not in blk:
            err(f"scan_assets anon INSERT policy missing {label} ({needle})")

# pgvector index
if not any(tbl == "catalog_items" and ("ivfflat" in rest or "hnsw" in rest) and "embedding" in rest
           for _, tbl, rest in indexes):
    err("catalog_items: no ivfflat/hnsw vector index on embedding (dedupe would seq-scan)")
if "vector" not in SQL_NC or "create extension if not exists vector" not in SQL_NC.lower():
    err("pgvector extension is not created")
if "vector(512)" not in SQL_NC:
    err("embedding column must be vector(512) per SPEC section 6")

# required functions
REQUIRED_FNS = ["deduct_credits", "credit_balance", "credits_saved", "log_dedupe_saved",
                "match_catalog_items", "dedupe_gate_user_item", "find_user_item_clusters",
                "promote_clusters_to_moderation", "promote_cluster_to_catalog",
                "create_recon_job", "apply_recon_result", "create_capture_session",
                "claim_capture_session", "close_capture_session", "expire_capture_sessions",
                "auth_profile_id", "auth_is_admin", "auth_capture_session_id"]
for f in REQUIRED_FNS:
    if f not in functions:
        err(f"MISSING FUNCTION: {f}()")

# dedupe threshold must be 0.86 somewhere in the SQL
if "0.86" not in SQL_NC:
    err("dedupe threshold 0.86 not present in SQL (SPEC section 5.4)")
if not re.search(r"p_min_users\s+integer\s+default\s+5", SQL_NC, re.I):
    err("cluster promotion threshold of 5 distinct users not encoded (SPEC section 5.4)")
if not re.search(r"p_cos\s+double\s+precision\s+default\s+0\.9", SQL_NC, re.I):
    err("cluster cosine threshold of 0.9 not encoded (SPEC section 5.4)")
if "interval '15 minutes'" not in SQL_NC:
    err("capture session 15-minute TTL default not found (SPEC section 6)")
if "max_assets <= 40" not in SQL_NC:
    err("capture session 40-asset cap not constrained (SPEC section 6)")

# realtime publication for the QR flow
if "alter publication supabase_realtime add table scan_assets" not in SQL_NC:
    err("scan_assets not added to supabase_realtime publication (desktop live thumbnails)")

# ---------------------------------------------------------------- report
print("=" * 72)
print("ainterior schema validation")
print("=" * 72)
for n in notes:
    print("  .", n)
print(f"\n  tables defined      : {len(tables)}  -> {', '.join(sorted(tables))}")
print(f"  columns total       : {sum(len(c) for c in table_cols.values())}")
print(f"  foreign keys        : {len(fks)}")
print(f"  indexes             : {len(indexes)}")
print(f"  functions           : {len(functions)}")
print(f"  triggers            : {len(triggers)}")
print(f"  policies            : {len(policies)}")
for t in sorted(SPEC_TABLES):
    ps = pol_by_table.get(t, [])
    cmds = ",".join(sorted({p['cmd'] for p in ps}))
    roles = ",".join(sorted({r for p in ps for r in p['roles']}))
    print(f"    - {t:<18} rls={'Y' if t in rls_enabled else 'N'} "
          f"force={'Y' if t in rls_forced else 'N'} policies={len(ps):<2} [{cmds}] ({roles})")

if warns:
    print("\nWARNINGS")
    for w in warns:
        print("  ! " + w)
if errors:
    print("\nFAILURES")
    for e in errors:
        print("  X " + e)
    print(f"\nRESULT: FAIL ({len(errors)} errors, {len(warns)} warnings)")
    sys.exit(1)
print(f"\nRESULT: PASS (0 errors, {len(warns)} warnings)")
