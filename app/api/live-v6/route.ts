import { NextResponse } from "next/server";
import { GET as getV5 } from "../live-v5/route";
import type { LiveRadarData } from "@/lib/types";
import { saveAllDirectionalSegmentSnapshots } from "@/lib/all-segment-history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL_VERSION = "2.1-all-segment-history";

export async function GET() {
  const result = await getV5();
  if (!result.ok) return result;

  const data = await result.json() as LiveRadarData;
  let fullHistory = { configured: false, segmentCount: 0, addedRows: 0 };
  try {
    fullHistory = await saveAllDirectionalSegmentSnapshots(data, MODEL_VERSION);
  } catch {
    // Historical persistence is deliberately non-fatal: live operational advice must never fail because storage is unavailable.
  }

  return NextResponse.json({
    ...data,
    meta: {
      ...data.meta,
      modelVersion: MODEL_VERSION,
      note: `${data.meta.note} Historie wordt nu voor alle directionele contractsegmenten opgeslagen, ook als er geen stand-byadvies aan dat segment gekoppeld is.`,
      historyStoredSegmentCount: fullHistory.segmentCount,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
