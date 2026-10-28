import frappe

LOCK_ORDER = (
	"MGK Purchase Order",
	"MGK Delivery Challan",
	"MGK Goods Received Note",
	"MGK Purchase Invoice",
	"MGK Delivery Challan Close",
)


def lock_documents(documents: dict[str, list[str]]) -> None:
	unknown = documents.keys() - set(LOCK_ORDER)
	if unknown:
		raise ValueError(f"Unknown lock doctypes: {', '.join(sorted(unknown))}")
	for doctype in LOCK_ORDER:
		for name in sorted(set(filter(None, documents.get(doctype, [])))):
			frappe.db.sql(f"SELECT name FROM `tab{doctype}` WHERE name = %s FOR UPDATE", (name,))
