import { createApp } from "vue"
import PrimeVue from "primevue/config"
import ToastService from "primevue/toastservice"
import "@fontsource-variable/inter"
import "primeicons/primeicons.css"
import "./theme/tokens.css"
import "./theme/base.css"
import preset from "./theme/preset.js"
import App from "./App.vue"
import router from "./router/index.js"
import { bindToast } from "./shared/notify.js"

const app = createApp(App).use(PrimeVue, { theme: { preset, options: { darkModeSelector: false } } })
	.use(ToastService).use(router)
bindToast(app.config.globalProperties.$toast)
app.mount("#app")
