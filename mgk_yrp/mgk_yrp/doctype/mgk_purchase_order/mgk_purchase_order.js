frappe.ui.form.on("MGK Purchase Order", {
	async onload(frm) {
		if (frm.is_new()) await set_po_own_location(frm);
	},
	refresh(frm) {
		frm.ignore_doctypes_on_cancel_all = ["MGK Goods Received Note", "MGK Delivery Challan"];
		frm.dashboard?.links_area?.body.find('.document-link[data-doctype="MGK Delivery Challan"] .btn-new').hide();
		if (frm.doc.docstatus === 1 && (frm.doc.items || []).some(row => flt(row.pending_qty) > 0)
			&& frappe.model.can_create("MGK Goods Received Note")) {
			frm.add_custom_button(__("Create GRN"), () => frappe.model.open_mapped_doc({
				method: "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.make_goods_received_note",
				frm,
			}));
			if (!frm.doc.deliver_to_supplier || frappe.model.can_create("MGK Delivery Challan")) {
				add_mark_as_received_button(frm);
			}
		}
		return frappe.mgk_yrp?.mount_item_editor(frm);
	},
	validate(frm) {
		frappe.mgk_yrp?.sync_item_editor(frm);
	},
	setup(frm) {
		frm.set_query("warehouse", () => ({
			filters: { supplier: frm.doc.delivery_location || "", disabled: 0, is_group: 0 },
		}));
		frm.set_query("delivery_location", () => ({ filters: {
			disabled: 0, is_company_location: frm.doc.deliver_to_supplier ? 0 : 1,
		} }));
		frm.set_query("supplier", () => ({ filters: { disabled: 0, is_company_location: 0 } }));
		frm.set_query("handling_supplier", () => ({ filters: { disabled: 0 } }));
		frm.set_query("supplier_address", () => frm.doc.supplier ? ({
			query: "frappe.contacts.doctype.address.address.address_query",
			filters: { link_doctype: "Supplier", link_name: frm.doc.supplier, disabled: 0 },
		}) : ({ filters: { name: ["=", ""] } }));
		frm.set_query("contact_person", () => ({
			query: "frappe.contacts.doctype.contact.contact.contact_query",
			filters: { link_doctype: "Supplier", link_name: frm.doc.supplier || "" },
		}));
	},
	async supplier(frm) {
		frm.itemEditor?.update_status();
		await frm.set_value({
			supplier_address: "", address_display: "", contact_person: "", contact_display: "", contact_mobile: "",
		});
		if (!frm.doc.supplier) return;
		const supplier = frm.doc.supplier;
		const { message } = await frappe.call({
			method: "mgk_yrp.party_defaults.get_party_defaults", args: { supplier },
		});
		if (frm.doc.supplier !== supplier) return;
		if (!frm.doc.supplier_address) await frm.set_value("supplier_address", message.address || "");
		if (!frm.doc.contact_person) await frm.set_value("contact_person", message.contact || "");
	},
	async supplier_address(frm) {
		const address = frm.doc.supplier_address;
		if (!address) return frm.set_value("address_display", "");
		const { message } = await frappe.call({
			method: "frappe.contacts.doctype.address.address.get_address_display",
			args: { address_dict: address },
		});
		if (frm.doc.supplier_address === address) await frm.set_value("address_display", message || "");
	},
	async contact_person(frm) {
		const contact = frm.doc.contact_person;
		if (!contact) return frm.set_value({ contact_display: "", contact_mobile: "" });
		const { message } = await frappe.call({
			method: "frappe.contacts.doctype.contact.contact.get_contact_details",
			args: { contact },
		});
		if (frm.doc.contact_person === contact) {
			await frm.set_value({ contact_display: message.contact_display, contact_mobile: message.contact_mobile });
		}
	},
	async delivery_location(frm) {
		const supplier = frm.doc.delivery_location;
		await frm.set_value("warehouse", null);
		if (!supplier) return;
		const { message } = await frappe.call({
			method: "mgk_yrp.party_defaults.get_party_defaults", args: { supplier },
		});
		if (frm.doc.delivery_location === supplier && !frm.doc.warehouse && message.warehouse) {
			await frm.set_value("warehouse", message.warehouse);
		}
	},
	async deliver_to_supplier(frm) {
		const location = frm.doc.delivery_location;
		if (location) {
			const { message } = await frappe.db.get_value("Supplier", location, ["is_company_location", "disabled"]);
			if (frm.doc.delivery_location !== location) return;
			if (message.disabled || Boolean(message.is_company_location) === Boolean(frm.doc.deliver_to_supplier)) {
				await frm.set_value({ delivery_location: "", warehouse: "" });
			}
		}
		await set_po_own_location(frm);
	},
	goods_routing(frm) {
		if (frm.doc.goods_routing === "Direct") return frm.set_value("handling_supplier", "");
	},
	is_karigan_order(frm) {
		if (frm.doc.is_karigan_order) return frm.set_value("is_salavai_cone_order", 0);
	},
	is_salavai_cone_order(frm) {
		if (frm.doc.is_salavai_cone_order) return frm.set_value("is_karigan_order", 0);
	},
});

async function set_po_own_location(frm) {
	if (frm.doc.deliver_to_supplier || frm.doc.delivery_location) return;
	const doc = frm.doc;
	const { message } = await frappe.call({ method: "mgk_yrp.party_defaults.get_own_location" });
	if (frm.doc !== doc || doc.deliver_to_supplier || doc.delivery_location || !message.location) return;
	await frm.set_value("delivery_location", message.location);
	if (!frm.doc.warehouse) await frm.set_value("warehouse", message.warehouse);
}

function add_mark_as_received_button(frm) {
	const button = frm.add_custom_button(__("Mark as Received"), () => {
		if (frm._mgk_is_receiving) return;
		const location = frappe.utils.escape_html(frm.doc.delivery_location || "");
		const process = frappe.utils.escape_html(frm.doc.process_name || "");
		const message = frm.doc.deliver_to_supplier
			? __("Create and submit a GRN for the full pending quantity at Head Office, then a Delivery Challan from Head Office to {0} for process {1}?", [location, process])
			: __("Create and submit a GRN for the full pending quantity at {0}?", [location]);
		const source_name = frm.doc.name;
		frappe.confirm(message, () => receive_purchase_order(frm, button, source_name));
	});
}

async function receive_purchase_order(frm, button, source_name) {
	if (frm._mgk_is_receiving || frm.doc.name !== source_name) return;
	frm._mgk_is_receiving = true;
	button.prop("disabled", true);
	try {
		const { message } = await frappe.call({
			method: "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.mark_as_received",
			args: { source_name }, freeze: true,
		});
		await frm.reload_doc();
		const links = [frappe.utils.get_form_link("MGK Goods Received Note", message.goods_received_note, true)];
		if (message.delivery_challan) links.push(frappe.utils.get_form_link("MGK Delivery Challan", message.delivery_challan, true));
		frappe.msgprint({ title: __("Received"), indicator: "green", message: __("Created and submitted: {0}", [links.join(", ")]) });
	} finally {
		frm._mgk_is_receiving = false;
		button.prop("disabled", false);
	}
}
