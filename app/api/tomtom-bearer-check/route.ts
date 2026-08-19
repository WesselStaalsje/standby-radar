import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function inspect(url: string, headers: Record<string, string>) {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    let detail: string | null = null;
    if (contentType.includes("json") || contentType.includes("text")) {
      detail = new TextDecoder().decode(bytes).slice(0, 600);
    }
    return {
      status: response.status,
      ok: response.ok,
      contentType,
      bytes: bytes.length,
      detail,
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      contentType: null,
      bytes: 0,
      detail: error instanceof Error ? error.message : "request failed",
    };
  }
}

export async function GET() {
  const apiKey = process.env.TOMTOM_API_KEY?.trim();
  const authToken = process.env.TOMTOM_AUTH_TOKEN?.trim();

  if (!apiKey || !authToken) {
    return NextResponse.json({
      apiKeyConfigured: Boolean(apiKey),
      bearerConfigured: Boolean(authToken),
      ready: false,
      note: "Set TOMTOM_AUTH_TOKEN to an Azure access token; secrets are never returned by this route.",
    }, { headers: { "cache-control": "no-store" } });
  }

  const trafficUrl = "https://api.tomtom.com/maps/orbis/traffic/flow/vector/tile/9/263/169?apiVersion=2&attributes=tags(relative_speed,road_category,road_closure),roadCategories(motorway,motorway_link)";
  const traffic = await inspect(trafficUrl, {
    "TomTom-Api-Key": apiKey,
    "TomTom-Api-Version": "2",
    "Authorization": `Bearer ${authToken}`,
    "Accept": "application/vnd.mapbox-vector-tile",
    "User-Agent": "StandbyRadar/tomtom-bearer-diagnostic",
  });

  const gem = await inspect("https://api.tomtom.com/maps/orbis/platform/private-gateway/storages", {
    "tomtom-api-key": apiKey,
    "Authorization": `Bearer ${authToken}`,
    "Accept": "application/json",
    "User-Agent": "StandbyRadar/tomtom-bearer-diagnostic",
  });

  return NextResponse.json({
    apiKeyConfigured: true,
    bearerConfigured: true,
    ready: true,
    traffic,
    gem,
    note: "Temporary diagnostic only. No credential values are exposed.",
  }, { headers: { "cache-control": "no-store" } });
}
