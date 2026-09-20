import postgres from "postgres";
import { bareModelKey } from "../src/server/discovery/model-key.ts";
const sql = postgres("postgresql://postgres:test@127.0.0.1:55433/curator");
const rows = await sql`select model_ref, model_key from model_candidates`;
let bad = 0; const ex: string[] = [];
for (const r of rows) { const ts = bareModelKey(r.model_ref); if (ts !== r.model_key) { bad++; if (ex.length < 8) ex.push(`${JSON.stringify(r.model_ref)} sql=${r.model_key} ts=${ts}`); } }
console.log({ rows: rows.length, mismatches: bad }); console.log(ex.join("\n"));
await sql.end();
