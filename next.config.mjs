/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: "/api/live",
        destination: "/api/live-v3",
      },
    ];
  },
};

export default nextConfig;
