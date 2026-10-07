/** @type {import('next').NextConfig} */

const nextConfig = {
  experimental: {
    outputFileTracingIncludes: {
      "/api/video/finalize": [
        "./node_modules/ffmpeg-static/ffmpeg",
      ],
    },
  },

  serverExternalPackages: [
    "fluent-ffmpeg",
    "ffmpeg-static",
  ],
};

export default nextConfig;
