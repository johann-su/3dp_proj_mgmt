import type { NextConfig } from "next";

// Next's dev server compiles with eval(); production bundles don't need it.
const dev = process.env.NODE_ENV !== "production";

// Nearly everything the app loads is same-origin: Tailwind ships a static
// stylesheet, next/font self-hosts, and every uploaded image goes through
// /api/files (see images.localPatterns below). The exception is gallery videos
// (src/lib/video.ts): YouTube's poster frames from i.ytimg.com, and the player
// itself, which is framed only after the viewer clicks play. Both srcs are
// built from a parsed 11-character video id, never from a stored string.
// 'unsafe-inline' stays because Next inlines its bootstrap/flight scripts and
// React inlines style attributes; tightening that needs a nonce, which means
// making every page dynamic. blob: covers the three.js preview's object URLs.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://i.ytimg.com",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' https://www.youtube.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // The catalog is private; nothing here is meant to be framed.
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // Baseline security headers for an internet-facing deployment. Applied here
  // rather than at the reverse proxy so they hold however the app is fronted.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          // Belt and braces next to frame-ancestors, for older browsers.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Model URLs shouldn't leak to third parties via the browser's
          // background features either.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          // Ignored by browsers over plain HTTP, so this is inert in local dev.
          // Drop includeSubDomains if any sibling subdomain is HTTP-only.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ],
      },
    ];
  },
  images: {
    // 75 (default) for the homepage grid where bandwidth is the constraint;
    // 90 for the model detail preview where image quality matters more. Next 16
    // requires every quality used by next/image to be allowlisted here.
    qualities: [75, 90],
    // Next 16 rejects local image srcs with query strings unless allowlisted.
    // All next/image sources are /api/files/<id>?token=<signed>; `search` must
    // stay unset because the token varies per file — access control happens in
    // the route itself, which verifies the token (see src/lib/file-token.ts).
    localPatterns: [{ pathname: "/api/files/**" }],
  },
};

export default nextConfig;
