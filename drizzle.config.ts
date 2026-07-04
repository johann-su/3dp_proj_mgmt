import { defineConfig } from "drizzle-kit";

// drizzle-kit does not load .env on its own (Node 21+)
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the process environment
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
