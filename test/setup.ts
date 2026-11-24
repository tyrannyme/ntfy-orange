import { afterAll } from "bun:test";
import { stopServer } from "./e2e/server";

// Runs once after every test file has finished.
afterAll(stopServer);
