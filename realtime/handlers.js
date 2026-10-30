function handlers(socket) {
	socket.on("mgk_doc_subscribe", async (doctype, name, acknowledge) => {
		await socket.has_permission(doctype, name)
		if (!socket.connected) return
		await socket.join(`doc:${doctype}/${name}`)
		if (typeof acknowledge === "function") acknowledge()
	})
}

module.exports = handlers
