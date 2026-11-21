import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemonOrigin = process.env.SUPERAGENTTEAM_DAEMON_ORIGIN ?? "http://127.0.0.1:3011";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: {
		port: 3000,
		strictPort: true,
		proxy: {
			"/api": { target: daemonOrigin, changeOrigin: false },
			"/auth/console": { target: daemonOrigin, changeOrigin: false },
		},
	},
});
