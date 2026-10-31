import { computed, onScopeDispose, ref, shallowRef } from "vue"
import { useRouter } from "vue-router"
import { callMethod } from "../api/client.js"
import { runAction } from "./actionRunner.js"

export function useActionRunner({ reload = async () => {}, settled = async () => {} } = {}) {
	const router = useRouter()
	const is_running = ref(false)
	const error = ref("")
	const result = ref(null)
	const dialog = shallowRef(null)
	const confirmation = ref(null)
	const busy = computed(() => is_running.value || Boolean(dialog.value) || Boolean(confirmation.value))
	let sequence = 0
	const ask = (text) => new Promise((resolve) => { confirmation.value = { text, resolve } })
	function answer(value) { confirmation.value?.resolve(value); confirmation.value = null }
	async function finished(value, current, target) {
		await settled(target)
		if (current !== sequence) return
		if (value) result.value = value
		await reload()
	}
	async function openDialog(action, target, current) {
		const loaded = await action.dialog()
		if (current === sequence) dialog.value = { component: loaded.default || loaded, action, target }
	}
	async function run(action, target) {
		if (busy.value) return
		const current = ++sequence
		is_running.value = true
		error.value = ""
		result.value = null
		const ctx = { call: callMethod, navigate: (to) => current === sequence && router.push(to), confirm: ask,
			finished: (value) => finished(value, current, target), openDialog: (action, target) => openDialog(action, target, current),
			isCurrent: () => current === sequence }
		try { await runAction(action, target, ctx) }
		catch (cause) { if (current === sequence) error.value = cause.message }
		finally { is_running.value = false }
	}
	async function dialogDone(value) {
		if (!dialog.value || is_running.value) return
		const current = sequence
		const target = dialog.value.target
		dialog.value = null
		is_running.value = true
		try { await finished(value, current, target) }
		catch (cause) { if (current === sequence) error.value = cause.message }
		finally { is_running.value = false }
	}
	function dialogClosed() { dialog.value = null }
	function reset() {
		sequence += 1
		answer(false)
		dialog.value = null
		result.value = null
		error.value = ""
	}
	onScopeDispose(reset)
	return { busy, error, result, dialog, confirmation, run, answer, dialogDone, dialogClosed, reset }
}
