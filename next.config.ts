import type { NextConfig } from "next";

type SecurityEnvironment = Record<string, string | undefined>;

/**
 * Return the browser-facing websocket origin for Khloei's computer.
 *
 * `connect-src 'self'` does not cover the local computer because it listens on
 * another port, and a browser cannot open that socket when CSP omits it. Keep
 * this exact rather than allowing every insecure `ws:` endpoint.
 */
export function computerViewerConnectSource(
  environment: SecurityEnvironment = process.env,
): string | null {
  const configured =
    environment.KHLOEI_COMPUTER_PUBLIC_URL?.trim() ||
    environment.KHLOEI_COMPUTER_URL?.trim() ||
    environment.AGENT_COMPUTER_URL?.trim() ||
    (environment.NODE_ENV === "development" ? "http://127.0.0.1:4100" : "");
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicyFor(
  environment: SecurityEnvironment = process.env,
): string {
  const viewerSource = computerViewerConnectSource(environment);
  const connectSources = ["'self'", "https:", "wss:"];
  if (viewerSource && !connectSources.includes(viewerSource)) {
    connectSources.push(viewerSource);
  }

  return [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "font-src 'self' data:",
    "form-action 'self' https:",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    `script-src 'self' 'unsafe-inline'${
      environment.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
    }`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; ");
}

const contentSecurityPolicy = contentSecurityPolicyFor();

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), browsing-topics=()",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  outputFileTracingExcludes: {
    "/*": [".khloei/**/*"],
  },
};

export default nextConfig;
