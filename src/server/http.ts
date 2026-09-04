import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export function correlationId(request?: Request) { return request?.headers.get("x-correlation-id") ?? randomUUID(); }
export function apiError(code: string, message: string, status: number, id: string) { return NextResponse.json({ error: { code, message, correlationId: id } }, { status, headers: { "x-correlation-id": id } }); }
export function secretMatches(actual: string | null, expected: string | undefined) {
  if (!expected || !actual) return false;
  const left=Buffer.from(actual); const right=Buffer.from(expected);
  return left.length===right.length && timingSafeEqual(left,right);
}
