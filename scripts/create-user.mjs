import { config } from "dotenv";
import { neon } from "@neondatabase/serverless";
import { hash } from "bcryptjs";

config({ path: ".env.local" });
config();

const [usernameArg, passwordArg, displayNameArg] = process.argv.slice(2);

if (!usernameArg || !passwordArg) {
  console.error("Usage: npm run user:create -- <username> <password> [displayName]");
  process.exit(1);
}

if (passwordArg.length < 12) {
  console.error("Password must be at least 12 characters (the CRM login is on the internet — planning/009).");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Add it to .env.local.");
  process.exit(1);
}

const username = usernameArg.trim().toLowerCase();
const displayName = displayNameArg?.trim() ? displayNameArg.trim() : null;

const passwordHash = await hash(passwordArg, 12);
const sql = neon(process.env.DATABASE_URL);

await sql`
  insert into users (username, password_hash, display_name)
  values (${username}, ${passwordHash}, ${displayName})
  on conflict (username)
  do update set
    password_hash = excluded.password_hash,
    display_name = excluded.display_name
`;

console.log(`User '${username}' created/updated successfully.`);
