/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // @react-pdf/renderer resolves fonts and streams at runtime; bundling it
  // breaks both. It only ever runs on the server (invoice rendering).
  serverExternalPackages: ["@react-pdf/renderer"],
  // Security headers baked in (matches SECURITY.md posture)
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        // Drivers photograph stops from their own device, so the camera has to
        // be allowed for our own origin — everything else stays off.
        { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" }
      ]
    }];
  }
};
export default nextConfig;
