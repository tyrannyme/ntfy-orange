import type { ConfigEnv } from "./config";
import type { Hub } from "./hub";

export interface Env extends ConfigEnv {
  HUB: DurableObjectNamespace<Hub>;
}
