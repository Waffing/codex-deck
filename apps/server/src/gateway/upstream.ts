export function upstreamUrl(baseUrl: string, endpoint: string): URL {
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid upstream base URL.");
  }
  const base = url.pathname.replace(/\/+$/, "") || "/v1";
  url.pathname = base + "/" + endpoint.replace(/^\/+/, "");
  return url;
}

export function upstreamHeaders(custom: Record<string, string>, apiKey: string): Headers {
  const headers = new Headers(custom);
  headers.set("content-type", "application/json");
  if (apiKey) headers.set("authorization", "Bearer " + apiKey);
  return headers;
}
