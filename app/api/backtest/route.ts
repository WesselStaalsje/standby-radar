import { NextResponse } from "next/server";
import { backtestReadiness, runStoredBacktest } from "@/lib/history-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const thresholdRaw = Number(url.searchParams.get("threshold") ?? "65");
  const threshold = Number.isFinite(thresholdRaw) ? Math.max(1, Math.min(99, Math.round(thresholdRaw))) : 65;

  if (!from || !to) {
    const readiness = await backtestReadiness();
    return NextResponse.json({
      ...readiness,
      modelVersion: "2.0-operational-reliability",
      note: readiness.configured
        ? "De eigen replay/backtestlaag wordt automatisch bruikbaarder naarmate meer live snapshots en later waargenomen incidenten zijn opgeslagen."
        : "Koppel STANDBY_DATABASE_URL in Vercel om eigen live snapshots en incidentlabels te gaan verzamelen.",
    }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return NextResponse.json({ error: "Gebruik geldige ISO-datums; 'to' moet na 'from' liggen." }, { status: 400 });
  }
  if (toMs - fromMs > 31 * 24 * 60 * 60 * 1000) {
    return NextResponse.json({ error: "Een backtestrun is begrensd op maximaal 31 dagen." }, { status: 400 });
  }

  const result = await runStoredBacktest(new Date(fromMs).toISOString(), new Date(toMs).toISOString(), threshold);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
