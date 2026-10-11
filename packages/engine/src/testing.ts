// Test helpers for packages that talk to Home Assistant (e.g. typegen). Not for production use;
// importing this needs the `ws` package.
export {
  MockHomeAssistant,
  newContext,
  type MockHomeAssistantOptions,
  type ServiceDescription,
  type StatisticRow,
} from "./adapters/home-assistant/testing/mock-server.js";
