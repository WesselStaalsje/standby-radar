/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: "/api/live",
        destination: "/api/live-operational",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
