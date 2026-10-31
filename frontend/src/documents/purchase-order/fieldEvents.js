export function purchaseOrderChanges(name, doc) {
	const changes = {
		supplier: { supplier_address: "", address_display: "", contact_person: "", contact_display: "", contact_mobile: "" },
		supplier_address: { address_display: "" }, contact_person: { contact_display: "", contact_mobile: "" },
		delivery_location: { warehouse: "" },
	}
	if (changes[name]) return changes[name]
	if (name === "deliver_to_supplier" && doc.deliver_to_supplier) return { delivery_location: "", warehouse: "" }
	if (name === "goods_routing" && doc.goods_routing === "Direct") return { handling_supplier: "" }
	const exclusiveField = { is_karigan_order: "is_salavai_cone_order", is_salavai_cone_order: "is_karigan_order" }[name]
	if (exclusiveField && doc[name]) return { [exclusiveField]: 0 }
	return {}
}

async function isEnabledCompanyLocation(location, call) {
	const supplier = await call("frappe.client.get_value", { doctype: "Supplier", filters: { name: location }, fieldname: ["is_company_location", "disabled"] })
	return !supplier.disabled && Boolean(supplier.is_company_location)
}

function fillOwnLocation(doc, defaults, setCandidates, markAuto) {
	doc.delivery_location = defaults.location
	setCandidates("warehouse", defaults.warehouses)
	markAuto(["delivery_location"])
	if (!doc.warehouse && defaults.warehouse) {
		doc.warehouse = defaults.warehouse
		markAuto(["warehouse"])
	}
}

export function createFieldEvents({ getDoc, call, setCandidates = () => {}, markAuto = () => {} }) {
	const versions = new Map()
	async function refillLocation(doc, version) {
		let location = doc.delivery_location
		const isCurrent = () => getDoc() === doc && !doc.deliver_to_supplier
			&& doc.delivery_location === location && versions.get("deliver_to_supplier") === version
		try {
			if (location) {
				const isCompanyLocation = await isEnabledCompanyLocation(location, call)
				if (!isCurrent() || isCompanyLocation) return
				Object.assign(doc, { delivery_location: "", warehouse: "" })
				location = ""
			}
			const defaults = await call("mgk_yrp.party_defaults.get_own_location")
			if (!isCurrent() || !defaults.location) return
			fillOwnLocation(doc, defaults, setCandidates, markAuto)
		} catch (cause) { if (isCurrent()) throw cause }
	}
	async function change(name) {
		const doc = getDoc()
		Object.assign(doc, purchaseOrderChanges(name, doc))
		if (["deliver_to_supplier", "delivery_location"].includes(name)) {
			const version = (versions.get("deliver_to_supplier") || 0) + 1
			versions.set("deliver_to_supplier", version)
			if (name === "deliver_to_supplier" && !doc.deliver_to_supplier) return refillLocation(doc, version)
		}
		if (name === "supplier") {
			for (const field of ["supplier_address", "contact_person"]) versions.set(field, (versions.get(field) || 0) + 1)
		}
		if (!["supplier_address", "contact_person"].includes(name)) return
		const version = (versions.get(name) || 0) + 1
		versions.set(name, version)
		const value = doc[name]
		if (!value) return
		const isCurrent = () => getDoc() === doc && doc[name] === value && versions.get(name) === version
		try {
			const address = name === "supplier_address"
			const result = await call(address ? "frappe.contacts.doctype.address.address.get_address_display"
				: "frappe.contacts.doctype.contact.contact.get_contact_details", address ? { address_dict: value } : { contact: value })
			if (!isCurrent()) return
			Object.assign(doc, address ? { address_display: result || "" }
				: { contact_display: result?.contact_display || "", contact_mobile: result?.contact_mobile || "" })
		} catch (cause) { if (isCurrent()) throw cause }
	}
	return { change }
}
