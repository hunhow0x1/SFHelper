/** CLI entry: start the dashboard server standalone (`npm start`). */
import { startServer } from "./server";

startServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
