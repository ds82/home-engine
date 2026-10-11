// Programmatic entry point: start the engine with a backend adapter.
export { HomeAssistantAdapter, type HomeAssistantConfig } from "./adapters/home-assistant/index.js";
export type { AdapterContext, BackendAdapter, BackendStatus, SiteInfo } from "./core/adapter.js";
export { ConfigError } from "./core/config.js";
export { engineVersion, startEngine, type Engine, type EngineOptions } from "./core/engine.js";
