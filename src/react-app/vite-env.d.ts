/// <reference types="vite/client" />

declare interface ImportMetaEnv {
	readonly VITE_SENTRY_DSN_FRONTEND?: string;
	readonly VITE_SENTRY_DSN_WORKER?: string;
	readonly VITE_SENTRY_ENVIRONMENT?: string;
	readonly VITE_SENTRY_RELEASE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
	readonly glob: import("vite").ImportMetaGlobFunction;
}
