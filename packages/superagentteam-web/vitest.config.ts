import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	test: {
		environment: "jsdom",
		env: { NODE_ENV: "test" },
		setupFiles: ["./test/setup.ts"],
		include: ["test/**/*.test.{ts,tsx}"],
	},
});
