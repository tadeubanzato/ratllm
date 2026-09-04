import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || request.nextUrl.pathname.startsWith("/api/health") || request.nextUrl.pathname.startsWith("/api/ready") || request.nextUrl.pathname.startsWith("/api/internal/")) return NextResponse.next();
  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${token}`) return NextResponse.next();
  return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Admin token required", correlationId: request.headers.get("x-correlation-id") ?? crypto.randomUUID() } }, { status: 401, headers: { "www-authenticate": "Bearer" } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
