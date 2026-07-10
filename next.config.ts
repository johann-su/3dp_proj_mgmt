import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    // 75 (default) for the homepage grid where bandwidth is the constraint;
    // 90 for the model detail preview where image quality matters more. Next 16
    // requires every quality used by next/image to be allowlisted here.
    qualities: [75, 90],
  },
};

export default nextConfig;
