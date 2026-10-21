---
name: invoice-reconcile
description: Use when reconciling a JSON invoice against recorded payments and deciding whether it is paid, partial, unpaid, or overpaid.
---

# Invoice reconcile

Reads `{ "invoice": { "id", "amount" }, "payments": [{ "id", "amount" }] }` from stdin and prints one JSON object.

Steps:

1. Validate the invoice id, amount, and payment records.
2. Sum the payments and compute the outstanding balance.
3. Print `status` (`paid`, `partial`, `unpaid`, `overpaid`), `outstanding`, or an `error` code.

Execute with `node scripts/reconcile.mjs`. When stdin is empty the script reads `data/input.json`.
