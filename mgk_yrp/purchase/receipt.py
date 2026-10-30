import frappe
from frappe import _
from frappe.utils import flt

from mgk_yrp.stock.dimensions import copy_row_dimensions
from mgk_yrp.stock.locking import lock_documents, lock_stock_buckets
from mgk_yrp.stock.transit import get_transit_warehouse, is_internal_route, is_transaction_aborted
from mgk_yrp.stock.uom import copy_uom_snapshot


class PurchaseReceipt:
	def __init__(self, order):
		self.order = order

	def check_permissions(self):
		self.order.check_permission("read")
		doctypes = ["MGK Goods Received Note"]
		if self.order.deliver_to_supplier:
			doctypes.append("MGK Delivery Challan")
		for doctype in doctypes:
			for permission in ("create", "submit"):
				frappe.has_permission(doctype, permission, throw=True)

	def submit(self):
		"""Call from a request or transaction that rolls back on error."""
		self.check_permissions()
		lock_documents({self.order.doctype: [self.order.name]})
		self.order.flags.for_update = True
		self.order.reload()
		self.check_permissions()
		if self.order.docstatus != 1:
			frappe.throw(_("Purchase Order {0} must be submitted.").format(self.order.name))
		if not any(flt(row.pending_qty) > 0 for row in self.order.items):
			frappe.throw(_("Purchase Order {0} is already fully received.").format(self.order.name))
		if self.is_internal_transfer and self.order.deliver_to_supplier:
			frappe.throw(_("This receipt is an internal transfer; cannot Deliver to Supplier while goods are in transit."))
		lock_stock_buckets(self.stock_buckets)
		checkpoint = f"purchase_receipt_{frappe.generate_hash(length=10)}"
		frappe.db.savepoint(checkpoint)
		try:
			result = self.submit_documents()
		except Exception as error:
			if not is_transaction_aborted(error):
				frappe.db.rollback(save_point=checkpoint)
			raise
		frappe.db.release_savepoint(checkpoint)
		return result

	@property
	def is_internal_transfer(self):
		return is_internal_route(self.order.supplier, self.order.receipt_location["location"])

	@property
	def stock_buckets(self):
		warehouse = get_transit_warehouse(shared_lock=True) if self.is_internal_transfer else self.order.receipt_location["warehouse"]
		warehouses = [warehouse]
		if self.order.deliver_to_supplier:
			warehouses.append(self.order.warehouse)
		return sorted(
			{
				(row.item, warehouse)
				for row in self.order.items
				if flt(row.pending_qty) > 0
				for warehouse in warehouses
			}
		)

	def submit_documents(self):
		from mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order import make_goods_received_note

		receipt = make_goods_received_note(self.order.name)
		receipt.insert().submit()
		challan = self.make_delivery_challan(receipt) if self.order.deliver_to_supplier else None
		if challan:
			challan.insert().submit()
		return {"goods_received_note": receipt.name, "delivery_challan": challan.name if challan else None}

	def make_delivery_challan(self, receipt):
		challan = frappe.new_doc("MGK Delivery Challan")
		challan.update(
			{
				"from_location": receipt.delivery_location,
				"from_warehouse": receipt.warehouse,
				"to_location": self.order.delivery_location,
				"to_warehouse": self.order.warehouse,
				"process_name": self.order.process_name,
				"purchase_order": self.order.name,
				"goods_received_note": receipt.name,
			}
		)
		for source in receipt.items:
			row = challan.append("items", {
				"item": source.item, "qty": source.qty, "rate": source.rate,
				"goods_received_note": receipt.name, "goods_received_note_item": source.name,
			})
			copy_row_dimensions(source, row)
			copy_uom_snapshot(row, source)
		return challan
