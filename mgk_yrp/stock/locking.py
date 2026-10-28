import frappe
from yrp.stock.stock_ledger import lock_valuation_bucket
from yrp.yrp_stock.doctype.yrp_stock_valuation_closing.yrp_stock_valuation_closing import (
	lock_stock_valuation_period,
)

LOCK_ORDER = (
	"MGK Purchase Order",
	"MGK Delivery Challan",
	"MGK Goods Received Note",
	"MGK Purchase Invoice",
	"MGK Delivery Challan Close",
)


def lock_documents(documents: dict[str, list[str]], *, wait=True) -> None:
	unknown = documents.keys() - set(LOCK_ORDER)
	if unknown:
		raise ValueError(f"Unknown lock doctypes: {', '.join(sorted(unknown))}")
	locking_clause = "FOR UPDATE" if wait else "FOR UPDATE NOWAIT"
	for doctype in LOCK_ORDER:
		for name in sorted(set(filter(None, documents.get(doctype, [])))):
			frappe.db.sql(f"SELECT name FROM `tab{doctype}` WHERE name = %s {locking_clause}", (name,))


def lock_stock_buckets(buckets) -> None:
	lock_stock_valuation_period(shared=True)
	for item, warehouse in sorted(set(buckets)):
		lock_valuation_bucket({"item": item, "warehouse": warehouse})
