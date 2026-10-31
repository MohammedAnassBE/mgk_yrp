import frappe
from frappe import _
from frappe.utils import flt, getdate

DOCTYPE = "MGK Supplier Credit Debit"
BILL_DOCTYPE = "MGK Purchase Invoice"


def signed_amount(entry):
	return flt(entry.amount) if entry.entry_type == "Credit" else -flt(entry.amount)


def ledger_filters(supplier=None, from_date=None, to_date=None):
	filters = {}
	if supplier:
		filters["supplier"] = supplier
	if from_date and to_date and getdate(from_date) > getdate(to_date):
		frappe.throw(_("From Date cannot be after To Date."))
	if from_date and to_date:
		filters["posting_date"] = ["between", [from_date, to_date]]
	elif from_date:
		filters["posting_date"] = [">=", from_date]
	elif to_date:
		filters["posting_date"] = ["<=", to_date]
	return filters


def get_bill_reason(bill_no):
	return f"Bill · {bill_no}" if bill_no else "Bill"


def get_entries(filters):
	"""Credit/debit entries plus submitted bills as Credit rows, in posting order."""
	entries = frappe.get_list(
		DOCTYPE, filters=filters,
		fields=["name", "supplier", "posting_date", "entry_type", "amount", "reason", "creation"], limit_page_length=0,
	)
	for entry in entries:
		entry.type = "Credit Debit"
	if frappe.has_permission(BILL_DOCTYPE, "read"):
		bills = frappe.get_list(
			BILL_DOCTYPE, filters={**filters, "docstatus": 1},
			fields=["name", "supplier", "posting_date", "grand_total", "bill_no", "creation"], limit_page_length=0,
		)
		entries += [frappe._dict(
			name=bill.name, supplier=bill.supplier, posting_date=bill.posting_date, entry_type="Credit",
			amount=flt(bill.grand_total), reason=get_bill_reason(bill.bill_no), creation=bill.creation, type="Bill",
		) for bill in bills]
	return sorted(entries, key=lambda entry: (getdate(entry.posting_date), entry.creation))


def get_openings(supplier, from_date):
	if not from_date:
		return {}
	filters = {"posting_date": ["<", from_date]}
	if supplier:
		filters["supplier"] = supplier
	openings = {}
	for entry in get_entries(filters):
		openings[entry.supplier] = openings.get(entry.supplier, 0) + signed_amount(entry)
	return openings


def get_supplier_names(suppliers):
	if not suppliers:
		return {}
	return dict(frappe.get_all("Supplier", filters={"name": ["in", list(suppliers)]}, fields=["name", "supplier_name"], as_list=True))


def get_supplier_totals(entries, openings, names):
	totals = {name: {"supplier": name, "opening": amount, "credit": 0, "debit": 0} for name, amount in openings.items()}
	for entry in entries:
		row = totals.setdefault(entry.supplier, {"supplier": entry.supplier, "opening": 0, "credit": 0, "debit": 0})
		row["credit" if entry.entry_type == "Credit" else "debit"] += flt(entry.amount)
	for row in totals.values():
		row["supplier_name"] = names.get(row["supplier"]) or row["supplier"]
		row["balance"] = flt(row["opening"] + row["credit"] - row["debit"])
	return sorted(totals.values(), key=lambda row: row["supplier_name"])


def get_ledger_rows(entries, openings, names):
	"""Entry rows with each supplier's running balance."""
	balances = dict(openings)
	rows = []
	for entry in entries:
		balances[entry.supplier] = flt(balances.get(entry.supplier, 0) + signed_amount(entry))
		is_credit = entry.entry_type == "Credit"
		rows.append({
			"date": entry.posting_date, "name": entry.name, "type": entry.type, "entry_type": entry.entry_type,
			"supplier": entry.supplier, "supplier_name": names.get(entry.supplier) or entry.supplier, "reason": entry.reason,
			"debit": 0 if is_credit else flt(entry.amount), "credit": flt(entry.amount) if is_credit else 0,
			"balance": balances[entry.supplier],
		})
	return rows


@frappe.whitelist()
def get_payment_ledger(supplier=None, from_date=None, to_date=None):
	frappe.has_permission(DOCTYPE, "read", throw=True)
	entries = get_entries(ledger_filters(supplier, from_date, to_date))
	openings = get_openings(supplier, from_date)
	names = get_supplier_names({entry.supplier for entry in entries} | set(openings))
	opening = flt(sum(openings.values()))
	suppliers = get_supplier_totals(entries, openings, names)
	total_credit = flt(sum(row["credit"] for row in suppliers))
	total_debit = flt(sum(row["debit"] for row in suppliers))
	return {
		"opening_balance": opening, "rows": get_ledger_rows(entries, openings, names), "suppliers": suppliers,
		"totals": {"credit": total_credit, "debit": total_debit, "balance": flt(opening + total_credit - total_debit)},
	}
