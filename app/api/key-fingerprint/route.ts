import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const raw = process.env.TOMTOM_API_KEY ?? "";
  const key = raw.trim();
  return NextResponse.json({
    configured: Boolean(key),
    length: key.length,
    first4: key ? key.slice(0, 4) : null,
    last4: key ? key.slice(-4) : null,
    sha256Prefix: key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : null,
  }, { headers: { "cache-control": "no-store" } });
}
