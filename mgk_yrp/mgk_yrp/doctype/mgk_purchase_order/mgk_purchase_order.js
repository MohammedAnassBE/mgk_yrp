frappe.ui.form.on("MGK Purchase Order", {
	refresh(frm) {
		if (frm.doc.docstatus === 1 && (frm.doc.items || []).some(row => flt(row.pending_qty) > 0)
			&& frappe.model.can_create("MGK Goods Received Note")) {
			frm.add_custom_button(__("Create GRN"), () => frappe.model.open_mapped_doc({
				method: "mgk_yrp.mgk_yrp.doctype.mgk_purchase_order.mgk_purchase_order.make_goods_received_note",
				frm,
			}));
		}
	},
	setup(frm) {
		for (const fieldname of ["supplier", "delivery_location", "handling_supplier"]) {
			frm.set_query(fieldname, () => ({ filters: { disabled: 0 } }));
		}
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
		await frm.set_value({
			supplier_address: "", address_display: "", contact_person: "", contact_display: "", contact_mobile: "",
		});
		if (!frm.doc.supplier) return;
		await Promise.all([set_supplier_address(frm), set_supplier_contact(frm)]);
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
		if (!frm.doc.delivery_location || frm.doc.warehouse) return;
		const supplier = frm.doc.delivery_location;
		const warehouses = await frappe.db.get_list("Warehouse", {
			filters: { supplier, disabled: 0 }, fields: ["name"], limit: 2,
		});
		if (frm.doc.delivery_location === supplier && !frm.doc.warehouse && warehouses.length === 1) {
			await frm.set_value("warehouse", warehouses[0].name);
		}
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

async function set_supplier_address(frm) {
	const supplier = frm.doc.supplier;
	const { message } = await frappe.call({
		method: "yrp.party_addresses.get_party_address", args: { supplier },
	});
	if (frm.doc.supplier === supplier && !frm.doc.supplier_address) {
		await frm.set_value("supplier_address", message || "");
	}
}

async function set_supplier_contact(frm) {
	const supplier = frm.doc.supplier;
	const contacts = await frappe.db.get_list("Contact", {
		filters: [
			["Dynamic Link", "link_doctype", "=", "Supplier"],
			["Dynamic Link", "link_name", "=", supplier],
			["Dynamic Link", "parenttype", "=", "Contact"],
		],
		fields: ["name"], order_by: "is_primary_contact desc, creation asc", limit: 1,
	});
	if (frm.doc.supplier === supplier && !frm.doc.contact_person && contacts.length) {
		await frm.set_value("contact_person", contacts[0].name);
	}
}

function update_order_totals(frm) {
	const rows = frm.doc.items || [];
	return frm.set_value({
		total_qty: rows.reduce((total, row) => total + flt(row.qty), 0),
		total_amount: rows.reduce((total, row) => total + flt(row.amount), 0),
	});
}

