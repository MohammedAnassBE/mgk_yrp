export function purchaseOrderChanges(name, doc) {
	if (name === "supplier") return { supplier_address: "", address_display: "", contact_person: "", contact_display: "", contact_mobile: "" }
	if (name === "supplier_address") return { address_display: "" }
	if (name === "contact_person") return { contact_display: "", contact_mobile: "" }
	if (name === "delivery_location") return { warehouse: "" }
	if (name === "goods_routing" && doc.goods_routing === "Direct") return { handling_supplier: "" }
	if (name === "is_karigan_order" && doc.is_karigan_order) return { is_salavai_cone_order: 0 }
	if (name === "is_salavai_cone_order" && doc.is_salavai_cone_order) return { is_karigan_order: 0 }
	return {}
}

export function createFieldEvents({ getDoc, call }) {
	const versions = new Map()
	async function change(name) {
		const doc = getDoc()
		Object.assign(doc, purchaseOrderChanges(name, doc))
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
