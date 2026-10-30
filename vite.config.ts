import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ command }) => ({
  plugins: [
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
      // nitro/vite builds from this
      server: { entry: "server" },
    }),
    viteReact(),
    tailwindcss(),
    tsconfigPaths(),
    // Nitro only bundles the production server (npm run build → .output/ with
    // the node-server preset). In dev it sits in front of Vite's module
    // middleware and 404s .json module requests, so it stays out of dev.
    ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
  ],
}));
