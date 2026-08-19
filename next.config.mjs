/** @type {import('next').NextConfig} */
// Redeploy marker: TOMTOM_API_KEY enabled in Vercel on 2026-08-19.
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
