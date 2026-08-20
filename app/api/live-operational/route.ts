import { GET as getLiveV7 } from "../live-v7/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const upstreamOrigin = productionHost
    ? `https://${productionHost.replace(/^https?:\/\//, "").replace(/\/$/, "")}`
    : requestUrl.origin;

  // live-v7 isolates the heavy v6 refresh over HTTP. On authenticated Vercel
  // previews, an internal request to the preview hostname is intercepted by
  // Deployment Protection. Point its upstream at the public production host so
  // previews exercise the new enrichment/runtime layer against a real v6 feed.
  const delegated = new Request(`${upstreamOrigin}/api/live-operational`, {
    method: "GET",
    headers: { "user-agent": "StandbyRadar/2.2-operational" },
  });
  return getLiveV7(delegated);
}
