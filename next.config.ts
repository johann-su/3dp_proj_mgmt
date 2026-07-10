import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
