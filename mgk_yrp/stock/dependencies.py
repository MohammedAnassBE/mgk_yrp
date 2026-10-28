import frappe
from frappe import _

from mgk_yrp.stock.locking import lock_documents, lock_stock_buckets

CLOSE = "MGK Delivery Challan Close"


class StockDependencies:
	"""Discover routing before locking parents, buckets, then ledger rows."""

	def __init__(self, receipts, *, documents=None, entries=(), buckets=()):
		self.receipts = set(filter(None, receipts))
		self.entries = set(filter(None, entries))
		self.buckets = set(buckets)
		self.documents = {doctype: set(names) for doctype, names in (documents or {}).items()}
		self.outgoing = {}
		self.nodes = set()

	def scan(self, *, for_update=False, allowed=None):
		pending, visited, outgoing = set(self.receipts), set(), {}
		while pending - visited:
			receipts = tuple(sorted(pending - visited))
			if allowed is not None and not set(receipts) <= allowed:
				frappe.throw(_("Stock dependencies changed; retry the operation."))
			visited.update(receipts)
			rows = get_outgoing_entries(receipts, for_update=for_update)
			outgoing.update((row.name, row) for row in rows)
			pending = get_next_receipts(rows, for_update=for_update)
		self.nodes = visited | set(outgoing) | self.entries
		self.outgoing = outgoing

	@property
	def close_names(self):
		return {row.voucher_no for row in self.outgoing.values() if row.voucher_type == CLOSE}

	def lock(self):
		self.scan()
		self.documents.setdefault(CLOSE, set()).update(self.close_names)
		self.add_close_sources()
		buckets = self.buckets | set(self.get_buckets())
		known_nodes, known_closes = set(self.nodes), set(self.close_names)
		lock_documents(self.documents)
		lock_stock_buckets(buckets)
		self.scan(for_update=True, allowed=known_nodes)
		if not self.nodes <= known_nodes or not self.close_names <= known_closes:
			frappe.throw(_("Stock dependencies changed; retry the operation."))
		self.validate_close_sources()
		for name in sorted(self.nodes):
			frappe.db.sql("SELECT name FROM `tabYRP Stock Ledger Entry` WHERE name = %s FOR UPDATE", (name,))
		return self

	def add_close_sources(self):
		for name in sorted(self.documents[CLOSE]):
			challan = frappe.db.get_value(CLOSE, name, "delivery_challan")
			self.documents.setdefault("MGK Delivery Challan", set()).add(challan)
		challans = tuple(sorted(filter(None, self.documents.get("MGK Delivery Challan", ()))))
		self.challans = challans
		self.documents.setdefault("MGK Goods Received Note", set()).update(get_linked_grns(challans))

	def validate_close_sources(self):
		for name in sorted(self.documents[CLOSE]):
			challan = frappe.db.get_value(CLOSE, name, "delivery_challan", for_update=True)
			if challan not in self.challans:
				frappe.throw(_("Stock dependencies changed; retry the operation."))
		if (
			not set(get_linked_grns(self.challans, for_update=True))
			<= self.documents["MGK Goods Received Note"]
		):
			frappe.throw(_("Stock dependencies changed; retry the operation."))

	def get_buckets(self):
		if not self.nodes:
			return []
		return frappe.db.sql(
			"""SELECT DISTINCT item, warehouse FROM `tabYRP Stock Ledger Entry`
			WHERE name IN %(nodes)s""",
			{"nodes": tuple(sorted(self.nodes))},
		)


def get_linked_grns(challans, *, for_update=False):
	if not challans:
		return []
	locking_clause = "FOR UPDATE" if for_update else ""
	return frappe.db.sql(
		f"""SELECT parent FROM `tabMGK GRN Delivery Challan`
		WHERE delivery_challan IN %(challans)s AND parenttype = 'MGK Goods Received Note'
			AND parentfield = 'delivery_challans'
		ORDER BY name {locking_clause}""",
		{"challans": challans},
		pluck=True,
	)


def get_outgoing_entries(receipts, *, for_update=False):
	locking_clause = "FOR UPDATE" if for_update else ""
	return frappe.db.sql(
		f"""
		SELECT DISTINCT outgoing.name, outgoing.voucher_type, outgoing.voucher_no,
			outgoing.paired_stock_ledger_entry
		FROM `tabYRP Stock Ledger Entry` receipt
		JOIN `tabYRP Stock Ledger Entry` outgoing
			ON outgoing.item = receipt.item AND outgoing.warehouse = receipt.warehouse
			AND outgoing.posting_datetime >= receipt.posting_datetime
		WHERE receipt.name IN %(receipts)s AND receipt.is_cancelled = 0
			AND outgoing.is_cancelled = 0 AND outgoing.qty < 0
		ORDER BY outgoing.name {locking_clause}
		""",
		{"receipts": receipts},
		as_dict=True,
	)


def get_next_receipts(outgoing, *, for_update=False) -> set[str]:
	pending = {row.paired_stock_ledger_entry for row in outgoing if row.paired_stock_ledger_entry}
	locking_clause = "FOR UPDATE" if for_update else ""
	if outgoing:
		pending.update(
			frappe.db.sql(
				f"""SELECT output_receipt_sle FROM `tabYRP Stock Valuation Production Link`
				WHERE consumption_sle IN %(outgoing)s AND active = 1
				ORDER BY name {locking_clause}""",
				{"outgoing": tuple(row.name for row in outgoing)},
				pluck=True,
			)
		)
	return pending
