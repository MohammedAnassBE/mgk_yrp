import { createApp } from "vue"
import PrimeVue from "primevue/config"
import "@fontsource-variable/inter"
import "primeicons/primeicons.css"
import "./theme/tokens.css"
import "./theme/base.css"
import preset from "./theme/preset.js"
import App from "./App.vue"
import router from "./router/index.js"

createApp(App).use(PrimeVue, { theme: { preset, options: { darkModeSelector: false } } })
	.use(router).mount("#app")
