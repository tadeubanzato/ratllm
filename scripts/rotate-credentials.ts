// Re-encrypts every stored credential with the active key from the keyring, so an old encryption key can be retired.
//   pnpm credentials:rotate            dry run: reports what would change, writes nothing
//   pnpm credentials:rotate --apply    performs the re-encryption
// Reads the same environment as the app (CREDENTIAL_ENCRYPTION_KEYS, CREDENTIAL_ENCRYPTION_KEY_ID, DATABASE_URL). Prints counts and
// key ids only — never a credential.
import { rotateCredentials } from "../src/server/credentials/rotate";

async function main() {
  const apply = process.argv.includes("--apply");
  const report = await rotateCredentials({ apply });
  console.log(`Target key: ${report.targetKeyId}   Mode: ${apply ? "APPLY" : "dry run (nothing written)"}`);
  console.log(`Stored values: ${report.total}   already on target: ${report.alreadyCurrent}   ${apply ? "re-encrypted" : "would re-encrypt"}: ${report.rotated}   unreadable: ${report.unreadable.length}`);
  console.log("Before this run, by key:", Object.entries(report.before).map(([key, n]) => `${key}=${n}`).join(", ") || "(none)");
  for (const item of report.unreadable) console.log(`  UNREADABLE  ${item.where}: ${item.reason}`);
  if (report.unreadable.length) { console.log("\nUnreadable values were left untouched. Do NOT remove the old key until they are resolved."); process.exitCode = 2; }
  else if (!apply && report.rotated) console.log("\nRe-run with --apply to perform the rotation.");
  else if (apply) console.log("\nDone. Once every value reports the target key, the old key can be removed from the keyring.");
  process.exit(process.exitCode ?? 0);
}
main().catch(error => { console.error(String(error instanceof Error ? error.message : error).slice(0, 300)); process.exit(1); });
