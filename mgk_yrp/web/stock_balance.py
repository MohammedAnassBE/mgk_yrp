import frappe
from frappe.utils import cint, flt, getdate

from mgk_yrp.stock.dimensions import get_stock_dimensions
from mgk_yrp.web.stock_fifo import StockFIFO


def run_stock_balance(filters):
	"""Use permission-filtered ledger rows for balances and inward dates."""
	dimensions = [dimension["fieldname"] for dimension in get_stock_dimensions()]
	items = readable_items(filters.parent_item)
	if not items:
		return [], []
	ledger_filters = {
		"docstatus": ["<", 2], "is_cancelled": 0, "posting_date": ["<=", filters.to_date],
		"warehouse": ["in", filters.warehouse], "item": ["in", list(items)],
	}
	if filters.received_type and "received_type" in dimensions:
		ledger_filters["received_type"] = filters.received_type
	entries = frappe.get_list(
		"YRP Stock Ledger Entry", filters=ledger_filters,
		fields=["item", "warehouse", "posting_date", "qty", "valuation_rate", "voucher_type", "voucher_no",
			"qty_after_transaction", "stock_value_difference", "stock_value", *dimensions],
		order_by="posting_datetime asc, creation asc", limit_page_length=0,
	)
	balances = item_warehouse_balances(filters, entries, dimensions)
	fifo = StockFIFO(dimensions).generate(entries)
	rows = []
	for key, balance in balances.items():
		if not balance.bal_qty:
			continue
		row = frappe._dict(item=key[0], warehouse=key[1], **dict(zip(dimensions, key[2:], strict=True)))
		row.update(items[row.item])
		row.update(balance)
		row.inward_date_breakdown = inward_dates(fifo[key])
		row.inward_split = "\n".join(f"{entry['date']}: {entry['qty']:g}" for entry in row.inward_date_breakdown)
		rows.append(row)
	return [], rows


def readable_items(parent=None):
	filters = {"is_stock_item": 1}
	or_filters = [["name", "=", parent], ["variant_of", "=", parent]] if parent else None
	rows = frappe.get_list(
		"Item", filters=filters, or_filters=or_filters,
		fields=["name", "item_name", "item_group", "stock_uom", "variant_of", "has_variants"],
		limit_page_length=0,
	)
	items = {}
	for row in rows:
		if row.has_variants:
			continue
		items[row.name] = frappe._dict(
			item_name=row.item_name, item_group=row.item_group, stock_uom=row.stock_uom,
			parent_item=row.variant_of or row.name,
		)
	return items


def item_warehouse_balances(filters, entries, dimensions):
	"""Balance arithmetic copied from YRP Stock Balance."""
	balances = {}
	from_date, to_date = getdate(filters.from_date), getdate(filters.to_date)
	opening = set(frappe.get_list(
		"YRP Stock Reconciliation", filters={"docstatus": 1, "posting_date": ["<=", to_date], "purpose": "Opening Stock"},
		pluck="name", limit_page_length=0,
	)) if frappe.has_permission("YRP Stock Reconciliation", "read") else set()
	precision = cint(frappe.db.get_default("float_precision")) or 3
	for entry in entries:
		key = (entry.item, entry.warehouse, *(entry.get(field) or "" for field in dimensions))
		balance = balances.setdefault(key, frappe._dict(
			opening_qty=0.0, opening_val=0.0, in_qty=0.0, in_val=0.0, out_qty=0.0, out_val=0.0,
			bal_qty=0.0, bal_val=0.0, val_rate=0.0,
		))
		update_balance(balance, entry, from_date, opening, precision)
	for balance in balances.values():
		for field, value in balance.items():
			balance[field] = flt(value, precision)
	return balances


def update_balance(balance, entry, from_date, opening, precision):
	quantity = flt(entry.qty_after_transaction) - balance.bal_qty if entry.voucher_type == "YRP Stock Reconciliation" else flt(entry.qty)
	value = flt(entry.stock_value_difference)
	if entry.posting_date < from_date or (entry.voucher_type == "YRP Stock Reconciliation" and entry.voucher_no in opening):
		balance.opening_qty += quantity
		balance.opening_val += value
	else:
		prefix = "in" if flt(quantity, precision) >= 0 else "out"
		balance[f"{prefix}_qty"] += quantity if prefix == "in" else abs(quantity)
		balance[f"{prefix}_val"] += value if prefix == "in" else abs(value)
	balance.val_rate = entry.valuation_rate
	balance.bal_qty += quantity
	balance.bal_val += value


def inward_dates(queue):
	buckets = {}
	for quantity, date in queue:
		quantity = flt(quantity, 3, rounding_method="Banker's Rounding (legacy)")
		if quantity and date:
			date = getdate(date)
			buckets[date] = buckets.get(date, 0.0) + quantity
	return [
		{"date": date.strftime("%d-%m-%Y"), "qty": flt(quantity, 3)}
		for date, quantity in sorted(buckets.items()) if flt(quantity, 3)
	]
