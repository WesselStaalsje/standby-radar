import { NextResponse } from "next/server";
import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = (process.env.TOMTOM_API_KEY ?? "").trim();
  return NextResponse.json({
    configured: Boolean(key),
    length: key.length,
    sha256Prefix: key ? createHash("sha256").update(key).digest("hex").slice(0, 12) : null,
  }, { headers: { "cache-control": "no-store" } });
}
