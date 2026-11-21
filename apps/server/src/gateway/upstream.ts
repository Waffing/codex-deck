export function upstreamUrl(baseUrl: string, endpoint: string): URL {
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid upstream base URL.");
  }
  const base = url.pathname.replace(/\/+$/, "") || "/v1";
  url.pathname = base + "/" + endpoint.replace(/^\/+/, "");
  return url;
}

export function upstreamHeaders(custom: Record<string, string>, apiKey: string, protocol?:string|null): Headers {
  const headers = new Headers(custom);
  headers.set("content-type", "application/json");
  if(protocol==="anthropic_messages") {
    if(apiKey) headers.set("x-api-key",apiKey);
    if(!headers.has("anthropic-version")) headers.set("anthropic-version","2023-06-01");
  } else if (apiKey) headers.set("authorization", "Bearer " + apiKey);
  return headers;
}
