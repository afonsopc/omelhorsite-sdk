/** A fetch-shaped XMLHttpRequest, for the one thing fetch cannot do: report upload progress. */

import type { FetchLike, ProgressCallback } from "../types";

/** Whether this runtime can send a request through `XMLHttpRequest`. */
export function xhrAvailable(): boolean {
  return typeof XMLHttpRequest === "function";
}

/** A {@link FetchLike} over `XMLHttpRequest` that reports the bytes sent to `onUploadProgress`. */
export function xhrFetch(onUploadProgress: ProgressCallback): FetchLike {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(init?.method ?? "GET", input, true);
      xhr.responseType = "arraybuffer";
      xhr.withCredentials = init?.credentials === "include";
      applyHeaders(xhr, init?.headers);

      const signal = init?.signal ?? undefined;
      const onAbort = (): void => xhr.abort();
      if (signal) {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const settle = (): void => signal?.removeEventListener("abort", onAbort);

      xhr.upload.onprogress = (event) => {
        onUploadProgress({
          phase: "upload",
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : undefined,
        });
      };
      xhr.onload = () => {
        settle();
        if (xhr.status === 0) {
          reject(new TypeError("Network request failed"));
          return;
        }
        resolve(toResponse(xhr));
      };
      xhr.onerror = () => {
        settle();
        reject(new TypeError("Network request failed"));
      };
      xhr.onabort = () => {
        settle();
        reject(abortError());
      };

      xhr.send((init?.body ?? null) as XMLHttpRequestBodyInit | null);
    });
}

function applyHeaders(xhr: XMLHttpRequest, headers: HeadersInit | undefined): void {
  if (!headers) return;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => xhr.setRequestHeader(key, value));
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) xhr.setRequestHeader(key, value);
  } else {
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
  }
}

function toResponse(xhr: XMLHttpRequest): Response {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const bodyless = xhr.status === 204 || xhr.status === 205 || xhr.status === 304;
  return new Response(bodyless ? null : (xhr.response as ArrayBuffer), {
    status: xhr.status,
    statusText: xhr.statusText,
    headers,
  });
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
