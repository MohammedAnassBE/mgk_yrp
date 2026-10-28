import frappe
from frappe import _
from frappe.utils import flt
from yrp.stock.dimensions import get_dimension_fieldnames
from yrp.stock.stock_ledger import make_sl_entries


def post_stock_entries(entries: list[dict], *, cancel: bool = False) -> dict:
	validate_stock_dimensions()
	return make_sl_entries(entries, cancel=cancel, return_details=True, force_inline=True)


def validate_stock_dimensions() -> None:
	dimensions = get_dimension_fieldnames()
	if dimensions:
		frappe.throw(
			_("Stock dimensions are configured ({0}); MGK YRP does not support them.").format(
				", ".join(dimensions)
			)
		)


def receipt_entry(doc, row, warehouse: str) -> dict:
	return {
		"item": row.item,
		"uom": row.stock_uom,
		"voucher_type": doc.doctype,
		"voucher_no": doc.name,
		"voucher_detail_no": row.name,
		"posting_date": doc.posting_date,
		"posting_time": doc.posting_time,
		"warehouse": warehouse,
		"qty": row.stock_qty,
		"rate": row.get("stock_rate", 0),
		"is_cancelled": 0,
	}


def transfer_entries(doc, row, *, from_warehouse: str, to_warehouse: str) -> list[dict]:
	base = receipt_entry(doc, row, to_warehouse)
	base.update(rate=0, _transfer_key=f"{doc.doctype}:{doc.name}:{row.name}")
	return [
		{**base, "warehouse": from_warehouse, "qty": -row.stock_qty, "_transfer_role": "outgoing"},
		{**base, "_transfer_role": "incoming"},
	]


def get_voucher_sles(voucher_type, voucher_no) -> list[frappe._dict]:
	return frappe.get_all(
		"YRP Stock Ledger Entry",
		filters={"voucher_type": voucher_type, "voucher_no": voucher_no, "is_cancelled": 0},
		fields=[
			"name",
			"item",
			"warehouse",
			"qty",
			"rate",
			"posting_datetime",
			"voucher_detail_no",
			"paired_stock_ledger_entry",
			"stock_value_difference",
			"valuation_adjustment_value",
		],
		order_by="creation, name",
	)


def assert_transfer_pairs(voucher_type, voucher_no, *, expected_entries=None) -> None:
	entries = get_voucher_sles(voucher_type, voucher_no)
	if not entries:
		frappe.throw(_("Stock transfer did not create any ledger entries."))
	if expected_entries is not None:
		expected = sorted(transfer_signature(entry) for entry in expected_entries)
		actual = sorted(transfer_signature(entry) for entry in entries)
		if actual != expected:
			frappe.throw(
				_("Incomplete stock transfer: ledger entries do not match the Delivery Challan rows.")
			)
	by_name = {entry.name: entry for entry in entries}
	for entry in entries:
		paired = by_name.get(entry.paired_stock_ledger_entry)
		if not paired or not is_transfer_pair(entry, paired):
			frappe.throw(_("Incomplete stock transfer pair for ledger entry {0}.").format(entry.name))


def transfer_signature(entry):
	return (entry["voucher_detail_no"], entry["item"], entry["warehouse"], flt(entry["qty"], 6))


def is_transfer_pair(entry, paired) -> bool:
	return (
		paired.paired_stock_ledger_entry == entry.name
		and paired.item == entry.item
		and paired.voucher_detail_no == entry.voucher_detail_no
		and paired.warehouse != entry.warehouse
		and flt(entry.qty) != 0
		and flt(paired.qty + entry.qty, 6) == 0
	)
