import frappe
from frappe import _
from yrp.stock.dimensions import get_dimension_fieldnames
from yrp.stock.utils import apply_posting_datetime
from yrp.yrp.doctype.yrp_item.yrp_item import get_or_create_variant, get_parent_item

from mgk_yrp.party_defaults import get_own_location
from mgk_yrp.stock import locking
from mgk_yrp.stock.dimensions import get_dimension_defaults
from mgk_yrp.stock.item_editor import get_item_details
from mgk_yrp.stock.process_conversion import get_process_conversion
from mgk_yrp.stock.uom import apply_independent_uom


@frappe.whitelist()
def make_job_work_grn(source_names=None, source_name=None):
	"""Prefill a draft receipt from submitted job-work challans."""
	frappe.has_permission("MGK Goods Received Note", "create", throw=True)
	names = get_source_names(source_names if source_names is not None else source_name)
	locking.lock_documents({"MGK Delivery Challan": names})
	challans = [get_source_challan(name) for name in names]
	validate_common_supplier_and_process(challans)
	target = frappe.new_doc("MGK Goods Received Note")
	target.update({
		"against_purchase_order": 0,
		"supplier": challans[0].to_location,
		"process_name": challans[0].process_name,
	})
	set_receiving_location(target, challans)
	for index, challan in enumerate(challans):
		target.append("delivery_challans", {"delivery_challan": challan.name})
		rows = get_planned_outputs(challan) if challan.mgk_process_planning else get_converted_outputs(challan)
		for row in rows:
			row["row_index"] = f"{index}-{row['row_index']}"
			target.append("items", row)
	apply_posting_datetime(target)
	target.set_onload("item_details", get_item_details(target))
	return target


def get_source_names(value):
	if isinstance(value, str):
		value = frappe.parse_json(value) if value.lstrip().startswith("[") else [value]
	if not isinstance(value, (list, tuple)) or not value or any(not isinstance(name, str) or not name for name in value):
		frappe.throw(_("Select at least one Delivery Challan."))
	return list(dict.fromkeys(value))


def get_source_challan(name):
	challan = frappe.get_doc("MGK Delivery Challan", name, for_update=True)
	challan.check_permission("read")
	if challan.docstatus != 1 or challan.is_return:
		frappe.throw(_("Delivery Challan {0} must be submitted and non-return.").format(name))
	challan.validate_open(_("create a GRN"))
	return challan


def validate_common_supplier_and_process(challans):
	if len({(challan.to_location, challan.process_name) for challan in challans}) != 1:
		frappe.throw(_("Selected Delivery Challans must have the same supplier and process."))


def set_receiving_location(target, challans):
	locations = {(challan.from_location, challan.from_warehouse) for challan in challans}
	if len(locations) == 1:
		target.delivery_location, target.warehouse = locations.pop()
	else:
		defaults = get_own_location()
		target.delivery_location, target.warehouse = defaults["location"], defaults["warehouse"]


def get_planned_outputs(challan):
	plan = frappe.get_doc("MGK Process Planning", challan.mgk_process_planning, for_update=True)
	plan.check_permission("read")
	if plan.delivery_challan != challan.name:
		frappe.throw(_("Process Planning must belong to Delivery Challan {0}.").format(challan.name))
	rows = []
	for index, source in enumerate(plan.items):
		dimensions = {field: source.get(field) for field in get_dimension_fieldnames()}
		line = source.row_index if source.row_index not in (None, "") else index
		rows.append(prefilled_output(source.item, str(line), dimensions))
	return rows


def get_converted_outputs(challan):
	rows = []
	for index, source in enumerate(challan.items):
		conversions = get_process_conversion(source.item, challan.process_name)
		outputs = [resolve_output_item(row.item, source.item) for row in conversions] or [source.item]
		line = source.row_index if source.row_index not in (None, "") else f"auto-{index}"
		for output_index, item in enumerate(outputs):
			row = prefilled_output(item, f"{line}-{output_index}")
			row.delivery_challan_item = source.name
			rows.append(row)
	return rows


def prefilled_output(item, row_index, dimensions=None):
	row = frappe._dict({
		**get_dimension_defaults(), **(dimensions or {}), "item": item,
		"row_index": row_index, "qty": 0, "rate": 0, "is_prefilled": 1,
		"allow_zero_valuation_rate": 1,
	})
	apply_independent_uom(row)
	return row


def resolve_output_item(output_item, source_item):
	"""Variant matching the source; the template itself when the source lacks an attribute, for the user to fill."""
	output = frappe.get_doc("Item", output_item)
	if not output.has_variants:
		return output_item
	source = frappe.get_doc("Item", source_item)
	values = {row.attribute: row.attribute_value for row in source.attributes}
	if any(not values.get(row.attribute) for row in output.attributes):
		return output_item
	return get_or_create_variant(output_item, {row.attribute: values[row.attribute] for row in output.attributes})


def get_linked_challans(grn):
	return [frappe.get_doc("MGK Delivery Challan", name) for name in grn.linked_delivery_challans]


def validate_process_name(grn):
	if grn.against_purchase_order:
		return
	for challan in get_linked_challans(grn):
		if not grn.process_name:
			grn.process_name = challan.process_name
		if grn.process_name != challan.process_name:
			frappe.throw(_("Process must match Delivery Challan {0}.").format(challan.name))


def validate_output_route(grn):
	"""Send exact, unprocessed returns through the DC Return action."""
	if grn.against_purchase_order:
		return
	challans = get_linked_challans(grn)
	inputs = {
		(row.item, challan.from_warehouse)
		for challan in challans for row in challan.items
	}
	worker_inputs = {
		(row.item, challan.to_warehouse)
		for challan in challans for row in challan.items
	}
	for row in grn.items:
		if (row.item, grn.warehouse) in inputs:
			frappe.throw(_("Row {0}: Unprocessed goods? Use Return on the DC.").format(row.idx))
		if (row.item, grn.warehouse) in worker_inputs:
			frappe.throw(_("Row {0}: {1} cannot be received into the job worker's warehouse {2}.").format(
				row.idx, row.item, grn.warehouse
			))


def validate_output_templates(grn):
	"""Check template routes without comparing variant attributes."""
	if grn.against_purchase_order:
		return
	challans = get_linked_challans(grn)
	if not challans:
		return
	validate_template_rows(grn.items, challans, grn.process_name)


def validate_output_sources(grn, challans):
	sources = {row.name: row for challan in challans for row in challan.items}
	for row in grn.items:
		if not row.delivery_challan_item:
			continue
		source = sources.get(row.delivery_challan_item)
		if not source:
			frappe.throw(
				_("Row {0}: its Delivery Challan line {1} is not on the linked Delivery Challans.").format(
					row.idx, row.delivery_challan_item
				)
			)
		validate_template_outputs([row], [get_parent_item(source.item)], grn.process_name)


def validate_template_rows(rows, challans, process_name):
	inputs = list(dict.fromkeys(get_parent_item(row.item) for challan in challans for row in challan.items))
	validate_template_outputs(rows, inputs, process_name)


def validate_template_outputs(rows, inputs, process_name):
	allowed = set()
	for item in inputs:
		conversions = get_process_conversion(item, process_name)
		outputs = [row.item for row in conversions] if conversions else [item]
		allowed.update(get_parent_item(output) for output in outputs)
	for row in rows:
		if get_parent_item(row.item) not in allowed:
			frappe.throw(
				_("Row {0}: {1} is not an output of {2} for process {3}.").format(
					row.idx, get_parent_item(row.item), ", ".join(inputs), process_name
				)
			)


def validate_output_tracing(grn):
	"""Reject ambiguous outputs before receipt submission and Close."""
	from mgk_yrp.job_work.close_valuation import OutputTracing

	if grn.against_purchase_order:
		return
	challans = get_linked_challans(grn)
	validate_output_sources(grn, challans)
	for challan in challans:
		tracing = OutputTracing(challan)
		for row in grn.items:
			input_item = tracing.get_input_item(grn, row)
			if input_item:
				tracing.get_weight(input_item, row, grn)
