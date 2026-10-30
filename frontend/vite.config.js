import { defineConfig } from "vite"
import vue from "@vitejs/plugin-vue"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	server: { port: 8083, proxy: getProxyOptions() },
	plugins: [vue()],
	resolve: { alias: { "@": path.resolve(frontendDirectory, "src") } },
	build: {
		outDir: "../mgk_yrp/public/frontend",
		emptyOutDir: true,
		target: "es2015",
		rollupOptions: {
			output: {
				entryFileNames: "assets/mgkyrp-[hash].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash].[ext]",
			},
		},
	},
})

function getProxyOptions() {
	const config = getCommonSiteConfig()
	const port = config?.webserver_port || 8001
	return {
		"^/(app|desk|login|api|assets|files|private|socket.io)": {
			target: `http://127.0.0.1:${port}`,
			ws: true,
			router(request) {
				const site = request.headers.host.split(":")[0]
				return `http://${site}:${port}`
			},
		},
	}
}

function getCommonSiteConfig() {
	let directory = frontendDirectory
	while (directory !== path.dirname(directory)) {
		const configPath = path.join(directory, "sites", "common_site_config.json")
		if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, "utf8"))
		directory = path.dirname(directory)
	}
	return null
}
