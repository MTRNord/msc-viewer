import { defineConfig } from 'astro/config';
import tailwind from "@astrojs/tailwind";
import node from "@astrojs/node";

import lit from "@astrojs/lit";

// https://astro.build/config
export default defineConfig({
    output: 'hybrid',
    prefetch: true,
    //output: 'static',
    integrations: [tailwind(), lit()],
    adapter: node({
        mode: "standalone"
    }),
    experimental: {
        optimizeHoistedScript: true,
        contentCollectionCache: true,
    },
});
