/** @type {import('next').NextConfig} */
const nextConfig = {
  // Build into a staging directory while the current production bundle keeps
  // serving requests. Deployment can then swap directories during an idle,
  // seconds-long restart instead of taking the site offline for the full build.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  // The isolated runner resolves the package's signed native CLI at runtime.
  serverExternalPackages: ["@openai/codex"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            // 内网工具基线 CSP：禁止外部脚本/外链资源，内联脚本保留是因为 Next App Router 需要
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://h296025733-sys.github.io; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
