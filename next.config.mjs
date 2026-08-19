/** @type {import('next').NextConfig} */
// Redeploy marker: refreshed TOMTOM_API_KEY in Vercel on 2026-08-19 19:39 CEST.
const nextConfig = {
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: "/api/live",
        destination: "/api/live-v3",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
