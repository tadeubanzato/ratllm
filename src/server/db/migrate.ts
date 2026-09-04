import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDb } from "./client";

async function main() {
  await migrate(getDb(), { migrationsFolder: "drizzle" });
  console.info("Database migrations applied");
}

main().then(() => process.exit(0)).catch((error: unknown) => { console.error(error); process.exit(1); });
