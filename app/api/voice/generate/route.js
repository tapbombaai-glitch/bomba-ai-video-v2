// FILE: app/api/voice/generate/route.js

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const NAIJALINGO_API_KEY = process.env.NAIJALINGO_API_KEY;
const NAIJALINGO_URL = "https://api.9jalingo.org/v1/audio/speech";

const MAX_TEXT_LENGTH = 5000;
const REQUEST_TIMEOUT_MS = 45000;

const DEFAULT_VOICE = "ada_pcm";
const DEFAULT_LANGUAGE = "pcm";

function jsonError(
  message,
  {
    status = 500,
    errorCode = "VOICE_GENERATION_ERROR",
    diagnostic = "UNKNOWN",
    retryable = false,
    providerStatus,
    retryAfterSeconds,
  } = {}
) {
  const body = {
    success: false,
    error: message,
    errorCode,
    diagnostic,
    retryable,
  };

  if (Number.isInteger(providerStatus)) {
    body.providerStatus = providerStatus;
  }

  if (Number.isInteger(retryAfterSeconds)) {
    body.retryAfterSeconds = retryAfterSeconds;
  }

  return NextResponse.json(body, { status });
}

function parseRetryAfter(value) {
  if (!value) return undefined;

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }

  return undefined;
}

async function readProviderError(response) {
  let raw = "";

  try {
    raw = await response.text();
  } catch {
    return {};
  }

  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);

    const detail =
      parsed?.detail ??
      parsed?.error?.message ??
      parsed?.error ??
      parsed?.message ??
      parsed?.message_detail ??
      "";

    const code =
      parsed?.error_code ??
      parsed?.code ??
      parsed?.error?.code ??
      "";

    return {
      message:
        typeof detail === "string"
          ? detail.slice(0, 300)
          : "",
      code:
        typeof code === "string"
          ? code.slice(0, 100)
          : "",
    };
  } catch {
    // Do not return arbitrary provider response text.
    // It could contain sensitive information.
    return {};
  }
}

function classifyProviderError(status, providerError) {
  const providerMessage = (
    providerError.message || ""
  ).toLowerCase();

  const providerCode = (
    providerError.code || ""
  ).toLowerCase();

  const combined = `${providerMessage} ${providerCode}`;

  if (
    status === 401 ||
    status === 403 ||
    combined.includes("invalid api key") ||
    combined.includes("unauthorized") ||
    combined.includes("authentication")
  ) {
    return {
      status: 502,
      errorCode: "VOICE_API_AUTH_ERROR",
      diagnostic: "API_KEY_OR_PERMISSION",
      retryable: false,
      message:
        "9jaLingo rejected the API credentials. Check that NAIJALINGO_API_KEY is correct in your Vercel environment variables.",
    };
  }

  if (
    status === 429 ||
    combined.includes("rate limit") ||
    combined.includes("quota exceeded") ||
    combined.includes("insufficient credits") ||
    combined.includes("credit balance")
  ) {
    return {
      status: 429,
      errorCode: "VOICE_API_LIMIT_ERROR",
      diagnostic: "RATE_LIMIT_OR_CREDITS",
      retryable: true,
      message:
        "The voice provider reported a usage limit or credit problem. Check your 9jaLingo account, credits, and API usage limits.",
    };
  }

  if (
    status === 400 ||
    status === 404 ||
    status === 413 ||
    status === 415 ||
    status === 422
  ) {
    return {
      status: 422,
      errorCode: "VOICE_INPUT_OR_SETTINGS_ERROR",
      diagnostic: "VOICE_SETTINGS_OR_INPUT",
      retryable: false,
      message:
        "9jaLingo rejected the voice request. Check the voice ID, language, text, and response format.",
    };
  }

  if (status >= 500) {
    return {
      status: 503,
      errorCode: "VOICE_PROVIDER_UNAVAILABLE",
      diagnostic: "PROVIDER_SERVER_ERROR",
      retryable: true,
      message:
        "The voice provider returned a server error. Try again later.",
    };
  }

  return {
    status: 502,
    errorCode: "VOICE_PROVIDER_ERROR",
    diagnostic: "PROVIDER_REJECTED_REQUEST",
    retryable: false,
    message:
      "The voice provider could not complete the request. Check the provider status and configuration.",
  };
}

export async function POST(request) {
  // 1. Confirm that the server has an API key.
  if (!NAIJALINGO_API_KEY) {
    return jsonError(
      "The voice API key is missing. Add NAIJALINGO_API_KEY to the Vercel environment variables.",
      {
        status: 500,
        errorCode: "VOICE_API_KEY_MISSING",
        diagnostic: "CONFIGURATION_MISSING",
      }
    );
  }

  // 2. Read and validate the incoming request.
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonError("The request body must contain valid JSON.", {
      status: 400,
      errorCode: "INVALID_REQUEST_JSON",
      diagnostic: "REQUEST_VALIDATION",
    });
  }

  const text =
    typeof body?.text === "string"
      ? body.text
      : typeof body?.input === "string"
        ? body.input
        : "";

  const voice =
    typeof body?.voiceId === "string"
      ? body.voiceId.trim()
      : typeof body?.voice === "string"
        ? body.voice.trim()
        : typeof body?.speaker === "string"
          ? body.speaker.trim()
          : DEFAULT_VOICE;

  const language =
    typeof body?.language === "string"
      ? body.language.trim()
      : typeof body?.lang === "string"
        ? body.lang.trim()
        : DEFAULT_LANGUAGE;

  if (!text.trim()) {
    return jsonError("Text is required to generate speech.", {
      status: 400,
      errorCode: "VOICE_TEXT_MISSING",
      diagnostic: "REQUEST_VALIDATION",
    });
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return jsonError(
      `Text is too long. The maximum is ${MAX_TEXT_LENGTH} characters.`,
      {
        status: 400,
        errorCode: "VOICE_TEXT_TOO_LONG",
        diagnostic: "REQUEST_VALIDATION",
      }
    );
  }

  if (!voice || !language) {
    return jsonError("A voice ID and language are required.", {
      status: 400,
      errorCode: "VOICE_SETTINGS_MISSING",
      diagnostic: "REQUEST_VALIDATION",
    });
  }

  // 3. Send the request to 9jaLingo.
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  let providerResponse;

  try {
    providerResponse = await fetch(NAIJALINGO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NAIJALINGO_API_KEY}`,
        "X-API-Key": NAIJALINGO_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg, audio/*, application/octet-stream",
      },
      body: JSON.stringify({
        input: text,
        voice,
        lang: language,
        response_format: "mp3",
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return jsonError(
        "The voice provider took too long to respond. The request timed out.",
        {
          status: 504,
          errorCode: "VOICE_PROVIDER_TIMEOUT",
          diagnostic: "PROVIDER_TIMEOUT",
          retryable: true,
        }
      );
    }

    // Do not log the API key or submitted dialogue.
    console.error("[BOMBA Voice] Provider connection failed.", {
      errorName: error?.name || "UnknownError",
    });

    return jsonError(
      "BOMBA could not connect to the voice provider. Check the provider connection and try again.",
      {
        status: 502,
        errorCode: "VOICE_PROVIDER_CONNECTION_ERROR",
        diagnostic: "NETWORK_CONNECTION",
        retryable: true,
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  // 4. Handle unsuccessful provider responses.
  if (!providerResponse.ok) {
    const providerError = await readProviderError(
      providerResponse
    );

    const classified = classifyProviderError(
      providerResponse.status,
      providerError
    );

    const retryAfterSeconds = parseRetryAfter(
      providerResponse.headers.get("retry-after")
    );

    console.error("[BOMBA Voice] Provider rejected request.", {
      providerStatus: providerResponse.status,
      errorCode: classified.errorCode,
      providerCode: providerError.code || undefined,
    });

    return jsonError(classified.message, {
      ...classified,
      providerStatus: providerResponse.status,
      retryAfterSeconds,
    });
  }

  // 5. Confirm the provider returned audio, not an error message.
  const contentType = (
    providerResponse.headers.get("content-type") || ""
  ).toLowerCase();

  const isAudio =
    contentType.startsWith("audio/") ||
    contentType.includes("application/octet-stream");

  if (!isAudio) {
    const providerError = await readProviderError(
      providerResponse
    );

    console.error(
      "[BOMBA Voice] Unexpected successful response format.",
      {
        contentType: contentType || "missing",
        providerCode: providerError.code || undefined,
      }
    );

    return jsonError(
      "The voice provider responded, but did not return an audio file. Check the provider response and account configuration.",
      {
        status: 502,
        errorCode: "VOICE_PROVIDER_INVALID_RESPONSE",
        diagnostic: "EXPECTED_AUDIO_RECEIVED_OTHER_DATA",
        retryable: false,
      }
    );
  }

  // 6. Read the audio and ensure it is not empty.
  let audioBuffer;

  try {
    audioBuffer = await providerResponse.arrayBuffer();
  } catch {
    return jsonError(
      "BOMBA received a response but could not read the audio data.",
      {
        status: 502,
        errorCode: "VOICE_AUDIO_READ_ERROR",
        diagnostic: "AUDIO_READ_FAILED",
        retryable: true,
      }
    );
  }

  if (!audioBuffer || audioBuffer.byteLength === 0) {
    return jsonError(
      "The voice provider returned an empty audio file.",
      {
        status: 502,
        errorCode: "VOICE_AUDIO_EMPTY",
        diagnostic: "EMPTY_AUDIO",
        retryable: true,
      }
    );
  }

  // 7. Return the MP3 audio to BOMBA.
  return new Response(audioBuffer, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audioBuffer.byteLength),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}