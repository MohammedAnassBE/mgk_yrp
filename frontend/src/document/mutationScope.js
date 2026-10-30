export function mutationScope(getDocument, getRoute, isDisposed) {
	let generation = 0
	return {
		invalidate() { generation++ },
		begin() {
			const operation = ++generation
			const route = getRoute()
			let record = getDocument()
			const active = () => !isDisposed() && operation === generation && route === getRoute()
			const current = () => active() && record === getDocument()
			return {
				active,
				current,
				apply(action) {
					if (!current()) return
					action()
					record = getDocument()
				},
			}
		},
	}
}
