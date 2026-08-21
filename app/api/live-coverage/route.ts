import { NextResponse } from "next/server";
import type { LiveRadarData, SourceStatus } from "@/lib/types";
import { tightenArnhemNijmegenCoverage } from "@/lib/arnhem-nijmegen-coverage";
import { GET as getOperationalLive } from "../live-operational/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const response = await getOperationalLive(request);
  if (!response.ok) return response;

  const base = await response.json() as LiveRadarData;
  try {
    const result = await tightenArnhemNijmegenCoverage(base);
    return NextResponse.json(result.data, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    const source: SourceStatus = {
      id: "arnhem-nijmegen-coverage",
      name: "Arnhem–Nijmegen stand-bydekking",
      ok: false,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Dekkingsguard niet beschikbaar",
      lineage: "Fail-open: de bestaande operationele stand-byadviezen blijven actief wanneer de aanvullende VILD/NWB-dekkingscontrole niet kan draaien.",
    };

    return NextResponse.json({
      ...base,
      sources: [...base.sources.filter(item => item.id !== source.id), source],
      meta: {
        ...base.meta,
        note: `${base.meta.note} De aanvullende Arnhem–Nijmegen-dekkingscontrole kon bij deze refresh niet worden uitgevoerd; bestaande operationele adviezen zijn ongewijzigd behouden.`,
      },
    }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }
}
