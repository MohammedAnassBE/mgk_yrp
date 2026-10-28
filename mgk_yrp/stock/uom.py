import frappe
from frappe import _
from frappe.utils import flt
from yrp.stock.uom import apply_item_uom, resolve_item_uom

SNAPSHOT_FIELDS = ("uom", "stock_uom", "conversion_factor")


def has_uom_snapshot(row) -> bool:
	return all(row.get(fieldname) for fieldname in SNAPSHOT_FIELDS)


def apply_independent_uom(row) -> None:
	if isinstance(row, dict):
		if row.get("item"):
			details = resolve_item_uom(row["item"])
			row.update({fieldname: details.get(fieldname) for fieldname in SNAPSHOT_FIELDS})
	else:
		apply_item_uom(row, item_field="item")
	row.update({"stock_qty": flt(row.get("qty")) * flt(row.get("conversion_factor"))})


def copy_uom_snapshot(row, source_row) -> None:
	row.update({fieldname: source_row.get(fieldname) for fieldname in SNAPSHOT_FIELDS})
	row.update({"stock_qty": flt(row.get("qty")) * flt(row.get("conversion_factor"))})


def validate_uom_snapshot(row, source_row, label: str) -> None:
	for fieldname in SNAPSHOT_FIELDS:
		actual, expected = row.get(fieldname), source_row.get(fieldname)
		if fieldname == "conversion_factor":
			actual, expected = flt(actual), flt(expected)
		if actual != expected:
			frappe.throw(
				_("{0}: row {1} has a different {2} from its source.").format(
					label, row.get("idx"), fieldname
				)
			)
