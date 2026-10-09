// FILE: app/api/voice/generate/route.js

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const NAIJALINGO_API_KEY = process.env.NAIJALINGO_API_KEY;
const NAIJALINGO_URL = "https://api.9jalingo.org/v1/audio/speech";

const MAX_TEXT_LENGTH = 5000;

function jsonError(message, status, extra = {}) {
  return NextResponse.json(
    {
      status: "failed",
      error: message,
      ...extra,
    },
    { status }
  );
}

function getRetryAfterSeconds(errorText) {
  // The provider may return retry information inside a JSON string.
  const match = errorText.match(
    /retry_after_seconds['"]?\s*:\s*['"]?(\d+)/i
  );

  return match ? Number(match[1]) : null;
}

export async function POST(request) {
  try {
    // 1. Check server configuration.
    if (!NAIJALINGO_API_KEY) {
      console.error(
        "BOMBA VOICE: NAIJALINGO_API_KEY is missing."
      );

      return jsonError(
        "Voice service is not configured. Please contact support.",
        500
      );
    }

    // 2. Read the request.
    let body;

    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid request body.", 400);
    }

    const text =
      typeof body?.text === "string"
        ? body.text.trim()
        : "";

    const voiceId =
      typeof body?.voiceId === "string"
        ? body.voiceId.trim()
        : "";

    const language =
      typeof body?.language === "string"
        ? body.language.trim()
        : "";

    // 3. Validate the request.
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

    // 4. Request speech from 9jaLingo.
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
      signal: AbortSignal.timeout(45000),
      cache: "no-store",
    });

    // 5. Handle provider errors safely.
    if (!response.ok) {
      const errorText = await response.text();

      // Never log the API key or the complete dialogue.
      console.error("BOMBA VOICE: Provider request failed.", {
        status: response.status,
      });

      if (response.status === 429) {
        const retryAfterSeconds =
          getRetryAfterSeconds(errorText);

        return jsonError(
          "The voice service has reached its usage limit. Please wait before trying again.",
          429,
          retryAfterSeconds !== null
            ? { retryAfterSeconds }
            : {}
        );
      }

      if (response.status === 503) {
        return jsonError(
          "The voice service is temporarily unavailable. Please try again later.",
          503
        );
      }

      if (response.status >= 500) {
        return jsonError(
          "The voice provider encountered an error. Please try again later.",
          502
        );
      }

      return jsonError(
        "The voice provider rejected the request. Check the voice and language settings.",
        502
      );
    }

    // 6. Read the generated MP3.
    const audioBuffer = await response.arrayBuffer();

    if (audioBuffer.byteLength === 0) {
      console.error("BOMBA VOICE: Provider returned empty audio.");

      return jsonError(
        "The voice provider returned an empty audio file.",
        502
      );
    }

    console.log("BOMBA VOICE: Audio generated successfully.", {
      bytes: audioBuffer.byteLength,
    });

    // 7. Return audio to the frontend.
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
    const timedOut = error?.name === "TimeoutError";

    console.error("BOMBA VOICE: Server error.", {
      type: error?.name || "UnknownError",
      timedOut,
    });

    return jsonError(
      timedOut
        ? "Voice generation took too long. Please try again later."
        : "Unable to generate voice audio. Please try again later.",
      timedOut ? 504 : 500
    );
  }
}