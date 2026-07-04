// Applies the SQL migrations in ./drizzle and seeds default categories.
// Uses only `pg` so it can run inside the Next.js standalone output.
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

const CATEGORIES = [
  "Art",
  "Fashion",
  "Functional",
  "Gadgets",
  "Games & Toys",
  "Household",
  "Miniatures",
  "Tools",
  "Other",
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS applied_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rowCount } = await client.query(
        "SELECT 1 FROM applied_migrations WHERE name = $1",
        [file],
      );
      if (rowCount > 0) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const statements = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      await client.query("BEGIN");
      try {
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query(
          "INSERT INTO applied_migrations (name) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    for (const name of CATEGORIES) {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      await client.query(
        "INSERT INTO categories (name, slug) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [name, slug],
      );
    }
    console.log("Database is up to date");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
