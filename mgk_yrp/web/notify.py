import frappe

OWNERS = {"MGK Purchase Invoice", "MGK Delivery Challan Close"}
FINAL_STATUSES = {"Completed", "Reversed", "Calculation Failed", "Apply Failed"}
VALUATION_METHOD = (
	"yrp.yrp_stock.doctype.yrp_stock_valuation_adjustment.yrp_stock_valuation_adjustment.process_adjustment"
)


def valuation_updated(doc, method=None):
	if doc.status not in FINAL_STATUSES:
		return
	frappe.publish_realtime(
		"list_update", {"doctype": "YRP Stock Ledger Entry"},
		doctype="YRP Stock Ledger Entry", after_commit=True,
	)
	owners = set()
	if doc.source_doctype in OWNERS and doc.source_name:
		owners.add((doc.source_doctype, doc.source_name))
	for name in frappe.get_all(
		"MGK Delivery Challan Close", filters={"stock_valuation_adjustment": doc.name}, pluck="name"
	):
		owners.add(("MGK Delivery Challan Close", name))
	for doctype, name in sorted(owners):
		if frappe.db.exists(doctype, name):
			frappe.get_doc(doctype, name).notify_update()


def valuation_job_finished(method, kwargs, result=None):
	"""YRP background progress uses db.set_value and bypasses document hooks."""
	if method != VALUATION_METHOD or not kwargs.get("adjustment"):
		return
	if not frappe.db.exists("YRP Stock Valuation Adjustment", kwargs["adjustment"]):
		return
	doc = frappe.get_doc("YRP Stock Valuation Adjustment", kwargs["adjustment"])
	valuation_updated(doc)
	if doc.reversal_of:
		valuation_updated(frappe.get_doc(doc.doctype, doc.reversal_of))
	frappe.db.commit()
