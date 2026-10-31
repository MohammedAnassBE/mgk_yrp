export default {
	heading: "Delivery Challan", itemsTitle: "Delivered items",
	help: "Review delivered items and linked GRN outputs.",
	paperFields: ["delivery_challan", "posting_date", "supplier", "warehouse"],
	panelFields: ["value_per_unit", "loss_value", "posting_time"],
	gridForm: true,
	outputColumns: ["item", "input_item", "goods_received_note", "stock_qty", "stock_uom", "allocation_weight",
		"allocated_value", "allocated_rate", "warehouse", "output_receipt_sle"],
}
