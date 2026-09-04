import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/server/config";

function key() {
  if (!env.CREDENTIAL_ENCRYPTION_KEY) throw new Error("CREDENTIAL_ENCRYPTION_KEY is not configured");
  return createHash("sha256").update(env.CREDENTIAL_ENCRYPTION_KEY).digest();
}

export function encryptCredential(value: string) {
  const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key(),iv);
  const ciphertext=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]); const tag=cipher.getAuthTag();
  return ["v1",iv.toString("base64url"),tag.toString("base64url"),ciphertext.toString("base64url")].join(".");
}

export function decryptCredential(value: string) {
  const [version,iv,tag,ciphertext]=value.split("."); if(version!=="v1"||!iv||!tag||!ciphertext)throw new Error("Unsupported credential format");
  const decipher=createDecipheriv("aes-256-gcm",key(),Buffer.from(iv,"base64url")); decipher.setAuthTag(Buffer.from(tag,"base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext,"base64url")),decipher.final()]).toString("utf8");
}

export function credentialHint(value:string){return value.length<8?"••••":`${value.slice(0,3)}••••${value.slice(-3)}`}
