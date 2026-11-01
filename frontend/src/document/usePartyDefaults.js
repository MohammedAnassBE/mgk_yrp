import { ref, watch, onScopeDispose } from "vue"
import { callRead } from "../api/client.js"

export function usePartyDefaults(doc, change, canEdit, editing = ref(true), initialAutoFields = () => []) {
	const candidates = ref({})
	const createDefaults = ref({})
	const autoFields = ref([])
	const error = ref("")
	const loading = ref(false)
	let sequence = 0

	function fill(name, value) {
		if (!value || !canEdit(name)) return
		if (doc.value?.is_return && ["from_location", "from_warehouse", "to_location", "to_warehouse", "process_name"].includes(name)) return
		if (!doc.value[name]) {
			change(name, value)
			autoFields.value = [...new Set([...autoFields.value, name])]
		}
	}

	async function load() {
		const current = ++sequence
		const record = doc.value
		loading.value = false
		error.value = ""
		candidates.value = { ...candidates.value, supplier_address: [], contact_person: [], warehouse: [], from_warehouse: [], to_warehouse: [] }
		createDefaults.value = {}
		if (!record || Number(record.docstatus || 0) !== 0 || !editing.value) return
		if (["MGK Delivery Challan Close", "MGK Purchase Invoice"].includes(record.doctype)) return
		loading.value = true
		try {
			const ownReceipt = record.doctype === "MGK Goods Received Note" && !record.against_purchase_order && !record.delivery_location
			const isSupplierDelivery = record.doctype === "MGK Purchase Order" && record.deliver_to_supplier
			const own = !record.is_return && !isSupplierDelivery && (record.__islocal || ownReceipt) ? await callRead("mgk_yrp.party_defaults.get_own_location") : null
			if (current !== sequence || record !== doc.value) return
			const ownField = { "MGK Purchase Order": "delivery_location", "MGK Delivery Challan": "from_location" }[record.doctype]
			if (ownField && own?.location && !(record.doctype === "MGK Purchase Order" && record.deliver_to_supplier)) fill(ownField, own.location)
			if (ownReceipt && own) {
				candidates.value.warehouse = own.warehouses
				createDefaults.value.warehouse = { supplier: own.location }
				fill("warehouse", own.warehouse)
			}
			await loadParties(record, current)
		} catch (cause) { if (current === sequence) error.value = `Party defaults could not be loaded: ${cause.message}` }
		finally { if (current === sequence) loading.value = false }
	}

	async function loadParties(record, current) {
		const sources = [["supplier", null], ["delivery_location", "warehouse"], ["from_location", "from_warehouse"], ["to_location", "to_warehouse"]].filter(([source]) => record[source])
		await Promise.all(sources.map(async ([source, warehouseField]) => {
			const supplier = record[source]
			const defaults = await callRead("mgk_yrp.party_defaults.get_party_defaults", { supplier })
			if (current !== sequence || record !== doc.value || record[source] !== supplier) return
			if (warehouseField) {
				candidates.value[warehouseField] = defaults.warehouses
				createDefaults.value[warehouseField] = { supplier }
				fill(warehouseField, defaults.warehouse)
			}
			if (source === "supplier") {
				candidates.value.supplier_address = defaults.addresses
				candidates.value.contact_person = defaults.contacts
				const links = [{ link_doctype: "Supplier", link_name: supplier }]
				createDefaults.value.supplier_address = { links }
				createDefaults.value.contact_person = { links }
				fill("supplier_address", defaults.address)
				fill("contact_person", defaults.contact)
			}
		}))
	}

	watch(() => [doc.value, doc.value?.supplier, doc.value?.delivery_location, doc.value?.from_location, doc.value?.to_location, doc.value?.docstatus, doc.value?.against_purchase_order, doc.value?.purchase_order, editing.value, doc.value?.deliver_to_supplier], (next, previous) => {
		if (next[0] !== previous?.[0]) autoFields.value = initialAutoFields(doc.value)
		load()
	})
	onScopeDispose(() => { sequence += 1 })
	return { candidates, createDefaults, autoFields, error, loading, retry: load }
}
