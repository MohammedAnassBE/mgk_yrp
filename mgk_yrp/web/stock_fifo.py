from frappe.utils import flt


class StockFIFO:
	"""YRP FIFO arithmetic over an already authorized ledger snapshot."""

	def __init__(self, dimensions):
		self.dimensions = dimensions
		self.queues = {}
		self.transfers = {}
		self.balances = {}

	def generate(self, entries):
		for entry in entries:
			key = (entry.item, entry.warehouse, *(entry.get(field) or "" for field in self.dimensions))
			transfer_key = (entry.voucher_no, *key)
			queue = self.queues.setdefault(key, [])
			transfers = self.transfers.setdefault(transfer_key, [])
			quantity = flt(entry.qty)
			if entry.voucher_type == "YRP Stock Reconciliation":
				quantity = flt(entry.qty_after_transaction) - self.balances.get(key, 0)
			if quantity > 0:
				self.incoming(queue, transfers, quantity, entry.posting_date)
			else:
				self.outgoing(queue, transfers, abs(quantity), entry.posting_date)
			self.balances[key] = flt(entry.qty_after_transaction)
		return self.queues

	def incoming(self, queue, transfers, quantity, date):
		while quantity:
			if not transfers:
				slot = [quantity, date]
			elif 0 < transfers[0][0] <= quantity:
				slot = transfers.pop(0)
			else:
				slot = [quantity, transfers[0][1]]
				transfers[0][0] -= quantity
			quantity -= slot[0]
			if queue and flt(queue[0][0]) <= 0:
				queue[0][0] += slot[0]
				queue[0][1] = slot[1]
			else:
				queue.append(slot)

	def outgoing(self, queue, transfers, quantity, date):
		while quantity:
			if not queue:
				queue.append([-quantity, date])
				transfers.append([quantity, date])
				return
			slot = queue[0]
			if 0 < flt(slot[0]) <= quantity:
				quantity -= flt(slot[0])
				transfers.append(queue.pop(0))
			else:
				slot[0] = flt(slot[0]) - quantity
				transfers.append([quantity, slot[1]])
				return
