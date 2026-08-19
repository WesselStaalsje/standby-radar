import { NextResponse } from "next/server";
import { GET as getMultisourceLive } from "../live-v4/route";
import type { LiveRadarData } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const response = await getMultisourceLive();
  const data = await response.json() as LiveRadarData;

  // The planning feed contains long-running project records as well as future
  // measures. Active impact is already represented by NDW Actueel Beeld, so
  // keep only future planning/bridge records on the operational map. This
  // prevents months-long project metadata from looking like dozens of live
  // incidents while preserving the forward-looking signal in the score.
  const events = data.events.filter(event => {
    const planningSource = event.source === "NDW planning" || event.source === "NDW brugopeningen";
    return !planningSource || event.planned === true;
  });

  const advice = data.advice.map(item => {
    const fcdOutOfCalibrationRange = item.fcdAverageSpeedKph !== null
      && item.fcdAverageSpeedKph !== undefined
      && item.fcdAverageSpeedKph > 135;

    const reasons = fcdOutOfCalibrationRange
      ? item.reasons.map(reason => reason.startsWith("NDW reistijden:")
          ? reason.replace(
              /afgeleide snelheid [0-9.]+ km\/u(?: · kwaliteit \d+%)?\./,
              "vrije doorstroming; ruwe trajectsnelheid boven kalibratiebereik.",
            )
          : reason)
      : item.reasons;

    return {
      ...item,
      reasons,
      // Do not publish an exact value outside the calibrated range. It already
      // contributes zero congestion points in v4; null here prevents a future
      // UI from presenting an unreliable raw trajectory speed as precision.
      fcdAverageSpeedKph: fcdOutOfCalibrationRange ? null : item.fcdAverageSpeedKph,
      // Existing UI was designed around a four-step confidence meter. Keep the
      // displayed value bounded while all supplemental sources still influence
      // score/confidence and remain visible in the explanation/source status.
      corroboratingSignals: Math.min(4, item.corroboratingSignals),
      corroboratingSignalMax: 4,
    };
  });

  const futurePlanning = events.filter(event => event.source === "NDW planning" && event.planned).length;
  const futureBridges = events.filter(event => event.source === "NDW brugopeningen" && event.planned).length;

  return NextResponse.json({
    ...data,
    events,
    advice,
    meta: {
      ...data.meta,
      eventCount: events.length,
      accidentCount: events.filter(event => event.kind === "accident").length,
      obstructionCount: events.filter(event => event.kind === "obstruction").length,
      trafficCount: events.filter(event => event.kind === "traffic").length,
      closureCount: events.filter(event => event.kind === "closure").length,
      plannedEventCount: futurePlanning,
      bridgeEventCount: futureBridges,
      modelVersion: "1.0-ndw-multisource-fusion",
      note: `${data.meta.note} De aparte planningfeed wordt op de kaart alleen vooruitkijkend gebruikt; langlopende projectrecords worden niet als actuele incidentmarkers getoond. FCD-trajectsnelheden boven 135 km/u worden alleen als vrije doorstroming geïnterpreteerd en niet als exact kalibratiegetal gepubliceerd.`,
    },
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
