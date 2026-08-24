/** One complete Config generated from the backend's factory defaults. */
import defaultsContract from "../../../../contracts/config-defaults.json";
import type { Config } from "@/types/api";

export const TEST_CONFIG = defaultsContract.config as Config;
