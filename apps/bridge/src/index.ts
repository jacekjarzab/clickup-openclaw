import { buildAndStartBridge } from "./app.js";

void buildAndStartBridge().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
