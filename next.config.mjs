/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async redirects() {
    return [
      {
        source: "/api/live",
        destination: "/api/live-v5",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
