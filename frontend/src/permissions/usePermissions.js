import { masters } from "../masters/mastersConfig.js"

export function hasPermission(doctype, permission = "read", user = globalThis.window?.frappe?.boot?.user || {}) {
	return (user[`can_${permission}`] || []).includes(doctype)
}

export function readableMasters(user = globalThis.window?.frappe?.boot?.user || {}) {
	return masters.filter((master) => hasPermission(master.doctype, "read", user))
}

export function canReadBook(book, user = globalThis.window?.frappe?.boot?.user || {}) {
	if (book.key === "stock") return hasPermission(book.doctype, "read", user) && hasPermission("Warehouse", "read", user)
	return book.key === "masters" ? readableMasters(user).length > 0 : hasPermission(book.doctype, "read", user)
}

export function usePermissions() {
	return { hasPermission, canReadBook, readableMasters }
}
