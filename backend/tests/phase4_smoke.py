"""
Phase 4 smoke test — runs the 8 Phase 3.3 endpoint checks against main branch.
Run from backend/: python3 tests/phase4_smoke.py
"""
import os
import sys
import json
import time
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone

API = os.getenv("SMOKE_API", "http://localhost:5001/api")
PASS = "\033[92m✅\033[0m"
FAIL = "\033[91m❌\033[0m"
INFO = "\033[94mℹ️\033[0m"

results = {}

def api(path, method="GET", data=None, token=None):
    url = f"{API}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        try:
            body_json = json.loads(body_text)
        except Exception:
            body_json = {"raw": body_text}
        return e.code, body_json

def check(name, condition, detail=""):
    status = PASS if condition else FAIL
    results[name] = condition
    print(f"{status} {name}: {detail}")
    if not condition:
        print(f"   {FAIL} FAILED")

# ─── 1. Health check ───────────────────────────────────────────
print(f"\n{INFO} === 1. Health check ===")
code, health = api("/health")
check("health_check", code == 200 and health.get("status") == "ok", f"{code} {health}")

# ─── 2. Login (owner) ─────────────────────────────────────────
print(f"\n{INFO} === 2. Login (owner PIN 1240) ===")
code, login = api("/auth/login", method="POST", data={"attendant_id": 1, "pin": "1240"})
token = login.get("access_token", "")
attendant = login.get("attendant", {})
check("login", code == 200 and len(token) > 0 and attendant.get("shop_role") == "owner",
      f"token_len={len(token)}, role={attendant.get('shop_role')}")

# ─── 3. Products ──────────────────────────────────────────────
print(f"\n{INFO} === 3. GET /api/products ===")
code, products = api("/products", token=token)
# Find Red Onions
onion = next((p for p in products if "Onion" in p.get("name", "")), None)
onion_id = onion["id"] if onion else None
onion_stock_before = onion.get("total_stock") if onion else None
print(f"   Total products: {len(products)}")
print(f"   Red Onions: id={onion_id}, stock={onion_stock_before} kg, cost={onion.get('current_cost_per_unit')}, price={onion.get('sell_price')}")
check("products_count", len(products) == 9, f"{len(products)} products (expect 9)")
check("red_onions_present", onion is not None, f"found: {onion is not None}")
check("red_onions_stock", onion_stock_before == 48.0, f"stock={onion_stock_before} (expect 48.0)")

# ─── 4. Single POS sale (2 kg Red Onions @ KSh 120/kg) ───────
print(f"\n{INFO} === 4. Single POS sale (2 kg Red Onions @ 120/kg) ===")
now_iso = datetime.now(timezone.utc).isoformat()
sale_payload = {
    "client_uuid": f"test-phase4-{int(time.time())}",
    "product_id": onion_id,
    "attendant_id": 1,
    "quantity_sold": 2.0,
    "unit_sold_in": "kg",
    "price_charged": 120.0,
    "created_at": now_iso,
}
code, sync_resp = api("/sales/sync", method="POST", data={"sales": [sale_payload]}, token=token)
results_sync = sync_resp.get("results", [])
sale_result = results_sync[0] if results_sync else {}
sale_id = sale_result.get("sale_id")
print(f"   Sync result: status={sale_result.get('status')}, sale_id={sale_id}")
check("single_sale_synced", sale_result.get("status") == "synced" and sale_id is not None,
      f"status={sale_result.get('status')}, sale_id={sale_id}")

# Verify stock decreased by 2 kg
print(f"   Checking stock after sale...")
code, products_after = api("/products", token=token)
onion_after = next((p for p in products_after if p["id"] == onion_id), None)
stock_after_sale = onion_after.get("total_stock") if onion_after else None
print(f"   Stock after sale: {stock_after_sale} kg (was {onion_stock_before})")
check("stock_decreased", stock_after_sale == onion_stock_before - 2.0,
      f"{onion_stock_before} → {stock_after_sale} (expect {onion_stock_before - 2.0})")

# ─── 5. Concurrent sync test (2 × 24 kg Red Onions) ──────────
print(f"\n{INFO} === 5. Concurrent sync (2 × 24 kg Red Onions) ===")
concurrent_results = {}

def fire_sale(label, qty):
    payload = {
        "client_uuid": f"test-concurrent-{label}-{int(time.time() * 1000)}",
        "product_id": onion_id,
        "attendant_id": 1,
        "quantity_sold": qty,
        "unit_sold_in": "kg",
        "price_charged": 120.0,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    code, resp = api("/sales/sync", method="POST", data={"sales": [payload]}, token=token)
    results_arr = resp.get("results", [])
    r = results_arr[0] if results_arr else {}
    concurrent_results[label] = r

# Synchronize start so both requests hit at the same time
done = threading.Barrier(2)
def fire_with_barrier(label, qty):
    done.wait()
    fire_sale(label, qty)

t = threading.Thread(target=fire_with_barrier, args=("A", 24.0))
t2 = threading.Thread(target=fire_with_barrier, args=("B", 24.0))
t2.start()
t.start()
t.join()
t2.join()

print(f"   Sale A: {concurrent_results.get('A', {})}")
print(f"   Sale B: {concurrent_results.get('B', {})}")
statuses = [concurrent_results.get("A", {}).get("status"), concurrent_results.get("B", {}).get("status")]
check("concurrent_one_synced", "synced" in statuses, f"statuses={statuses}")
check("concurrent_one_error", "error" in statuses, f"statuses={statuses}")
# Verify no oversell
error_result = concurrent_results.get("B" if concurrent_results.get("A", {}).get("status") == "synced" else "A", {})
check("concurrent_no_oversell", "error" in statuses and "Insufficient stock" in str(error_result.get("reason", "")),
      f"reason={error_result.get('reason', 'N/A')}")

# Verify final stock
code, products_final = api("/products", token=token)
onion_final = next((p for p in products_final if p["id"] == onion_id), None)
final_stock = onion_final.get("total_stock") if onion_final else None
print(f"   Final stock: {final_stock} kg")
# Expected: 48 - 2 (single) - 24 (concurrent A) = 22
check("final_stock_correct", final_stock == 22.0, f"final={final_stock} (expect 22.0)")

# ─── 6. Dashboard summary ─────────────────────────────────────
print(f"\n{INFO} === 6. GET /api/dashboard/summary ===")
code, dash = api("/dashboard/summary", token=token)
today = dash.get("today", {})
print(f"   Today: revenue={today.get('revenue')}, cost={today.get('cost')}, profit={today.get('profit')}, count={today.get('sale_count')}")
print(f"   Low stock: {dash.get('low_stock_products', [])}")
check("dashboard_summary", code == 200 and "revenue" in today, f"code={code}, keys={list(today.keys())}")
check("dashboard_has_revenue", today.get("revenue") is not None and today.get("revenue") > 0,
      f"revenue={today.get('revenue')}")

# ─── 7. Wastage ───────────────────────────────────────────────
print(f"\n{INFO} === 7. POST /api/wastage ===")
# Wastage on onions — record 2 kg spoilage
code, wastage = api("/wastage", method="POST", data={
    "product_id": onion_id,
    "quantity": 2.0,
    "reason": "spoilage",
    "date": datetime.now(timezone.utc).isoformat(),
}, token=token)
check("wastage_created", code in (200, 201) and wastage.get("id") is not None,
      f"code={code}, id={wastage.get('id')}")

# Verify wastage shows in GET
code, wastage_list = api("/wastage", token=token)
wastage_count = len(wastage_list) if isinstance(wastage_list, list) else 0
print(f"   Total wastage entries: {wastage_count}")
check("wastage_listed", code == 200 and wastage_count >= 9, f"count={wastage_count}")

# Verify stock changed after wastage
code, products_w = api("/products", token=token)
onion_w = next((p for p in products_w if p["id"] == onion_id), None)
stock_after_wastage = onion_w.get("total_stock") if onion_w else None
print(f"   Stock after wastage: {stock_after_wastage} kg")
check("wastage_stock_decreased", stock_after_wastage == final_stock - 2.0,
      f"{final_stock} → {stock_after_wastage} (expect {final_stock - 2.0})")

# ─── Summary ──────────────────────────────────────────────────
print(f"\n{INFO} === SUMMARY ===")
total = len(results)
passed = sum(1 for v in results.values() if v)
print(f"   {passed}/{total} checks passed")
for name, ok in results.items():
    print(f"   {'✅' if ok else '❌'} {name}")
sys.exit(0 if passed == total else 1)
