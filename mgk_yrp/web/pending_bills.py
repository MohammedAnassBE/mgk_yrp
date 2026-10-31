import frappe
from frappe import _
from frappe.utils import cint, date_diff, flt, getdate, today

from mgk_yrp.mgk_yrp.doctype.mgk_purchase_invoice.mgk_purchase_invoice import (
	get_grn_rows,
	get_unbilled_grn_filters,
)

GRN = "MGK Goods Received Note"
INVOICE = "MGK Purchase Invoice"
SAVEPOINT = "mgk_pending_bills"
AGING_BUCKETS = ((30, "30+"), (15, "16-30"), (7, "8-15"))
DRAFT_ROW_FIELDS = (
	"goods_received_note", "goods_received_note_item", "item", "qty", "uom", "stock_uom", "conversion_factor",
	"stock_qty", "grn_rate", "rate", "amount", "gst_tax_slab", "gst_rate", "cgst_amount", "sgst_amount", "igst_amount",
)
DRAFT_FIELDS = (
	"supplier", "against", "supplier_gstin", "company_gstin", "tax_type", "total_qty", "net_total",
	"total_cgst", "total_sgst", "total_igst", "total_tax", "grand_total",
)


def get_aging_bucket(days: int) -> str:
	for threshold, label in AGING_BUCKETS:
		if days > threshold:
			return label
	return "0-7"


def get_against(receipt) -> str:
	return "Purchase Order" if cint(receipt.against_purchase_order) else "Job Work"


def get_names(values, doctype) -> dict:
	if not values:
		return {}
	label = "supplier_name" if doctype == "Supplier" else "item_name"
	rows = frappe.get_all(doctype, filters={"name": ["in", list(values)]}, fields=["name", label], as_list=True)
	return dict(rows)


def get_grn_items(grn_names) -> dict:
	rows = frappe.get_all(
		"MGK Goods Received Note Item",
		filters={"parent": ["in", grn_names], "parenttype": GRN, "parentfield": "items"},
		fields=["parent", "item", "qty", "uom", "rate", "amount"],
		order_by="parent, idx",
		limit_page_length=0,
	) if grn_names else []
	item_names = get_names({row.item for row in rows}, "Item")
	items = {}
	for row in rows:
		items.setdefault(row.parent, []).append({
			"item": row.item, "item_name": item_names.get(row.item) or row.item, "qty": flt(row.qty),
			"uom": row.uom, "rate": flt(row.rate), "amount": flt(row.amount),
		})
	return items


def get_pending_grns() -> list[frappe._dict]:
	"""Submitted GRNs with no Purchase Invoice link, as shown by Billing's Get GRNs."""
	receipts = frappe.get_list(
		GRN, filters=get_unbilled_grn_filters(),
		fields=["name", "supplier", "posting_date", "against_purchase_order", "total_qty", "total_amount"],
		limit_page_length=0,
	)
	items = get_grn_items([receipt.name for receipt in receipts])
	current = today()
	for receipt in receipts:
		receipt.aging = max(date_diff(current, receipt.posting_date), 0)
		receipt.bucket = get_aging_bucket(receipt.aging)
		receipt.against = get_against(receipt)
		receipt.items = items.get(receipt.name, [])
		del receipt["against_purchase_order"]
	return receipts


def group_by_supplier(receipts) -> list[dict]:
	"""Suppliers by summed GRN aging, then GRNs oldest first."""
	names = get_names({receipt.supplier for receipt in receipts}, "Supplier")
	groups = {}
	for receipt in receipts:
		group = groups.setdefault(receipt.supplier, {
			"supplier": receipt.supplier, "supplier_name": names.get(receipt.supplier) or receipt.supplier, "grns": [],
		})
		group["grns"].append(receipt)
	for group in groups.values():
		group["grns"].sort(key=lambda receipt: (-receipt.aging, receipt.name))
		group["grn_count"] = len(group["grns"])
		group["total_qty"] = flt(sum(flt(receipt.total_qty) for receipt in group["grns"]), 6)
		group["total_amount"] = flt(sum(flt(receipt.total_amount) for receipt in group["grns"]), 2)
		group["total_aging"] = sum(receipt.aging for receipt in group["grns"])
	return sorted(groups.values(), key=lambda group: (-group["total_aging"], group["supplier_name"], group["supplier"]))


@frappe.whitelist()
def get_pending_bills() -> dict:
	receipts = get_pending_grns()
	return {"count": len(receipts), "suppliers": group_by_supplier(receipts)}


def parse_list(value) -> list:
	value = frappe.parse_json(value) if isinstance(value, str) else value
	if not isinstance(value, list):
		frappe.throw(_("Expected a list."))
	return value


def get_invoice_groups(grn_names) -> dict:
	"""Map (supplier, against) to GRN names: one Purchase Invoice holds one Against type."""
	names = sorted(set(grn_names))
	if not names:
		frappe.throw(_("Select at least one GRN."))
	receipts = frappe.get_list(
		GRN, filters={"name": ["in", names]}, fields=["name", "supplier", "against_purchase_order"],
		order_by="name", limit_page_length=0,
	)
	missing = set(names) - {receipt.name for receipt in receipts}
	if missing:
		frappe.throw(_("GRN {0} was not found.").format(", ".join(sorted(missing))))
	groups = {}
	for receipt in receipts:
		groups.setdefault((receipt.supplier, get_against(receipt)), []).append(receipt.name)
	return groups


def build_invoice(supplier, against, grn_names, *, rates=None, bill_no=None, bill_date=None):
	rows = get_grn_rows(grn_names)
	for row in rows:
		if row.goods_received_note_item in (rates or {}):
			row.rate = flt(rates[row.goods_received_note_item])
	return frappe.get_doc({
		"doctype": INVOICE, "supplier": supplier, "against": against,
		"bill_no": bill_no, "bill_date": bill_date, "items": rows,
	})


def get_draft(invoice) -> dict:
	item_names = get_names({row.item for row in invoice.items}, "Item")
	rows = [
		{**{field: row.get(field) for field in DRAFT_ROW_FIELDS}, "item_name": item_names.get(row.item) or row.item}
		for row in invoice.items
	]
	return {**{field: invoice.get(field) for field in DRAFT_FIELDS}, "items": rows}


@frappe.whitelist(methods=["POST"])
def get_bill_drafts(grn_names) -> list[dict]:
	"""Unsaved bills with GST preview, one per supplier and Against type."""
	drafts = []
	for (supplier, against), names in get_invoice_groups(parse_list(grn_names)).items():
		invoice = build_invoice(supplier, against, names)
		invoice.preview_taxes()
		drafts.append(get_draft(invoice))
	return drafts


def create_supplier_bills(bill) -> list[dict]:
	bill = frappe._dict(bill)
	bill_no = str(bill.bill_no or "").strip()
	if not bill_no:
		frappe.throw(_("Supplier Invoice No is required."))
	if not bill.bill_date:
		frappe.throw(_("Supplier Invoice Date is required."))
	groups = get_invoice_groups(parse_list(bill.grns or []))
	if any(supplier != bill.supplier for supplier, _against in groups):
		frappe.throw(_("Selected GRNs must belong to supplier {0}.").format(bill.supplier))
	created = []
	for (supplier, against), names in groups.items():
		invoice = build_invoice(
			supplier, against, names, rates=bill.rates, bill_no=bill_no, bill_date=getdate(bill.bill_date)
		)
		invoice.insert()
		invoice.submit()
		created.append({"name": invoice.name, "supplier": supplier, "against": against, "grand_total": invoice.grand_total})
	return created


@frappe.whitelist(methods=["POST"])
def create_bills(bills) -> list[dict]:
	"""Create and submit every bill, or none: a failure is raised with the supplier as its title."""
	bills = parse_list(bills)
	if not bills:
		frappe.throw(_("Select at least one GRN."))
	frappe.db.savepoint(SAVEPOINT)
	created = []
	for bill in bills:
		try:
			created += create_supplier_bills(bill)
		except (frappe.ValidationError, frappe.PermissionError) as error:
			frappe.db.rollback(save_point=SAVEPOINT)
			frappe.clear_messages()
			message = str(error) or _("Could not create the bill.")
			frappe.throw(message, exc=type(error), title=str(bill.get("supplier") or ""))
		except Exception:
			frappe.db.rollback(save_point=SAVEPOINT)
			raise
	return created
