/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />
interface ImportMetaEnv {
    readonly API_KEY: string;
    readonly INDEX: string;
    readonly MEILI_HOST: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
