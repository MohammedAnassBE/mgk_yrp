import { ref, readonly, onUnmounted } from "vue"
import { realtime, subscribeDoctype, subscribeDoc, onReconnect } from "./socket.js"

export { subscribeDoctype, subscribeDoc, onReconnect }

export function useConnectionState() {
	const state = ref(realtime.state)
	const dispose = realtime.onState((value) => { state.value = value })
	onUnmounted(dispose)
	return readonly(state)
}

export function useRealtime() { return { subscribeDoctype, subscribeDoc, onReconnect } }
