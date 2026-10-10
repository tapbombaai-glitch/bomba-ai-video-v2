hi I'm// FILE: app/api/voice/generate/route.js

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const NAIJALINGO_API_KEY = process.env.NAIJALINGO_API_KEY;
const NAIJALINGO_URL = "https://api.9jalingo.org/v1/audio/speech";

const MAX_TEXT_LENGTH = 5000;
const REQUEST_TIMEOUT_MS = 45000;

function jsonError(message, status, extra = {}) {
  return NextResponse.json(
    {
      status: "failed",
      error: message,
      ...extra,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

// Safely parse provider errors, including JSON inside "detail".
function parseProviderError(errorText) {
  try {
    const parsed = JSON.parse(errorText);

    if (typeof parsed?.detail === "string") {
      try {
        const nested = JSON.parse(parsed.detail);

        return {
          ...parsed,
          ...nested,
        };
      } catch {
        // The detail field may be ordinary text or a
        // Python-style dictionary rather than valid JSON.
      }
    }

    if (
      parsed?.detail &&
      typeof parsed.detail === "object"
    ) {
      return {
        ...parsed,
        ...parsed.detail,
      };
    }

    return parsed;
  } catch {
    return {};
  }
}

function getRetryAfterSeconds(errorText, response) {
  // First, respect a valid standard HTTP Retry-After header.
  const headerValue = response?.headers?.get("retry-after");

  if (headerValue) {
    const seconds = Number(headerValue);

    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds);
    }

    const retryDate = Date.parse(headerValue);

    if (Number.isFinite(retryDate)) {
      const remainingSeconds = Math.ceil(
        (retryDate - Date.now()) / 1000
      );

      if (remainingSeconds > 0) {
        return remainingSeconds;
      }
    }
  }

  // Next, inspect the provider's structured error.
  const data = parseProviderError(errorText);

  const candidates = [
    data?.retry_after_seconds,
    data?.retryAfterSeconds,
    data?.detail?.retry_after_seconds,
  ];

  for (const value of candidates) {
    const seconds = Number(value);

    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds);
    }
  }

  // Finally, inspect errors that contain a serialized
  // Python dictionary rather than valid JSON.
  const match = errorText.match(
    /retry_after_seconds['"]?\s*:\s*['"]?(\d+)/i
  );

  if (match) {
    return Number(match[1]);
  }

  return null;
}

function getProviderErrorCode(errorText) {
  const data = parseProviderError(errorText);

  return (
    data?.error_code ||
    data?.code ||
    data?.detail?.error_code ||
    null
  );
}

export async function POST(request) {
  let requestBody;

  try {
    // 1. Validate server configuration.
    if (!NAIJALINGO_API_KEY) {
      console.error(
        "BOMBA VOICE: Missing NAIJALINGO_API_KEY."
      );

      return jsonError(
        "The voice service is not configured. Please contact support.",
        500
      );
    }

    // 2. Validate the incoming request.
    try {
      requestBody = await request.json();
    } catch {
      return jsonError("Invalid request body.", 400);
    }

    const text =
      typeof requestBody?.text === "string"
        ? requestBody.text.trim()
        : "";

    const voiceId =
      typeof requestBody?.voiceId === "string"
        ? requestBody.voiceId.trim()
        : "";

    const language =
      typeof requestBody?.language === "string"
        ? requestBody.language.trim()
        : "";

    if (!text) {
      return jsonError("Voice text is required.", 400);
    }

    if (!voiceId) {
      return jsonError("A voice ID is required.", 400);
    }

    if (!language) {
      return jsonError("A language is required.", 400);
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return jsonError(
        `Voice text cannot exceed ${MAX_TEXT_LENGTH} characters.`,
        400
      );
    }

    console.log("BOMBA VOICE: Request started.", {
      voiceId,
      language,
      textLength: text.length,
    });

    // 3. Send exactly one request to the provider.
    // Do not automatically retry: the provider may enforce
    // a strict hourly request limit.
    const response = await fetch(NAIJALINGO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NAIJALINGO_API_KEY}`,
        "X-API-Key": NAIJALINGO_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg, application/json",
      },
      body: JSON.stringify({
        input: text,
        voice: voiceId,
        lang: language,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });

    // 4. Handle provider errors.
    if (!response.ok) {
      const errorText = await response.text();

      const retryAfterSeconds = getRetryAfterSeconds(
        errorText,
        response
      );

      const errorCode = getProviderErrorCode(errorText);

      // Log only safe diagnostic information.
      // Never log API keys or generated dialogue.
      console.error("BOMBA VOICE: Provider rejected request.", {
        httpStatus: response.status,
        errorCode,
        retryAfterSeconds,
      });

      if (
        response.status === 429 ||
        errorCode === "STARTER_RATE_LIMIT_EXCEEDED"
      ) {
        return jsonError(
          "The voice service has reached its usage limit. Please wait before generating more audio.",
          429,
          {
            ...(retryAfterSeconds !== null
              ? { retryAfterSeconds }
              : {}),
            retryable: true,
          }
        );
      }

      if (
        response.status === 503 ||
        response.status === 502 ||
        response.status === 504
      ) {
        return jsonError(
          "The voice service is starting up or temporarily unavailable. Please try again later.",
          503,
          {
            ...(retryAfterSeconds !== null
              ? { retryAfterSeconds }
              : {}),
            retryable: true,
          }
        );
      }

      if (response.status >= 500) {
        return jsonError(
          "The voice provider encountered a server error. Please try again later.",
          502,
          {
            retryable: true,
          }
        );
      }

      return jsonError(
        "The voice provider rejected the request. Check the voice and language settings.",
        502,
        {
          retryable: false,
        }
      );
    }

    // 5. Confirm the response contains audio.
    const contentType =
      response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      // A successful HTTP status with JSON is not an MP3 file.
      const errorText = await response.text();

      console.error(
        "BOMBA VOICE: Provider returned JSON instead of audio.",
        {
          httpStatus: response.status,
        }
      );

      return jsonError(
        "The voice provider did not return an audio file.",
        502
      );
    }

    const audioBuffer = await response.arrayBuffer();

    if (audioBuffer.byteLength === 0) {
      return jsonError(
        "The voice provider returned an empty audio file.",
        502
      );
    }

    console.log("BOMBA VOICE: Audio generated successfully.", {
      bytes: audioBuffer.byteLength,
    });

    // 6. Preserve the existing frontend audio response.
    return new Response(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audioBuffer.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const timedOut =
      error?.name === "TimeoutError" ||
      error?.name === "AbortError";

    console.error("BOMBA VOICE: Server request failed.", {
      type: error?.name || "UnknownError",
      timedOut,
    });

    return jsonError(
      timedOut
        ? "Voice generation timed out. Please try again later."
        : "Unable to connect to the voice service. Please try again later.",
      timedOut ? 504 : 502,
      {
        retryable: true,
      }
    );
  }
}