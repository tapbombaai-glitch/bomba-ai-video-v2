// FILE: app/api/video/finalize/route.js

import { NextResponse } from "next/server";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 300;

const CLOUDINARY_CLOUD_NAME =
  process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || "";

const CLOUDINARY_VIDEO_PRESET =
  process.env.NEXT_PUBLIC_CLOUDINARY_VIDEO_PRESET || "";

const CLOUDINARY_UPLOAD_URL = CLOUDINARY_CLOUD_NAME
  ? `https://api.cloudinary.com/v1_1/${encodeURIComponent(
      CLOUDINARY_CLOUD_NAME
    )}/video/upload`
  : "";

const MAX_VOICE_TRACKS = 20;
const MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;

function jsonError(message, status = 500) {
  return NextResponse.json(
    {
      status: "failed",
      error: message,
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "http:"
    );
  } catch {
    return false;
  }
}

function cloudinaryAudioUrl(track) {
  const publicId = String(
    track?.cloudinaryPublicId ||
      track?.publicId ||
      ""
  )
    .trim()
    .replace(/^\/+/, "");

  if (!publicId || !CLOUDINARY_CLOUD_NAME) {
    return "";
  }

  const resourceType =
    track?.resourceType === "video" ||
    track?.resourceType === "raw" ||
    track?.resourceType === "image"
      ? track.resourceType
      : "video";

  const format =
    typeof track?.format === "string" &&
    /^[a-zA-Z0-9]+$/.test(track.format)
      ? track.format
      : "mp3";

  return (
    `https://res.cloudinary.com/` +
    `${encodeURIComponent(CLOUDINARY_CLOUD_NAME)}/` +
    `${resourceType}/upload/` +
    `${publicId}.${format}`
  );
}

function normalizeVoiceTracks(body) {
  const incoming = Array.isArray(body?.voiceTracks)
    ? body.voiceTracks
    : [];

  const legacyPublicId =
    typeof body?.voicePublicId === "string"
      ? body.voicePublicId.trim()
      : "";

  const tracks =
    incoming.length > 0
      ? incoming
      : legacyPublicId
      ? [
          {
            publicId: legacyPublicId,
            startTime: 0,
          },
        ]
      : [];

  if (tracks.length > MAX_VOICE_TRACKS) {
    throw new Error(
      `A maximum of ${MAX_VOICE_TRACKS} voice tracks is allowed.`
    );
  }

  return tracks.map((track, index) => {
    const startTime = Number(track?.startTime ?? 0);

    if (
      !Number.isFinite(startTime) ||
      startTime < 0 ||
      startTime > 3600
    ) {
      throw new Error(
        `Voice track ${index + 1} has an invalid start time.`
      );
    }

    const suppliedUrl =
      typeof track?.audioUrl === "string"
        ? track.audioUrl.trim()
        : "";

    const publicId =
      typeof track?.cloudinaryPublicId === "string"
        ? track.cloudinaryPublicId.trim()
        : typeof track?.publicId === "string"
        ? track.publicId.trim()
        : "";

    const audioUrl = isHttpUrl(suppliedUrl)
      ? suppliedUrl
      : cloudinaryAudioUrl(track);

    if (!audioUrl) {
      throw new Error(
        `Voice track ${index + 1} has no usable audio URL or Cloudinary public ID.`
      );
    }

    return {
      publicId,
      audioUrl,
      startTime,
    };
  });
}

async function downloadFile(url, outputPath) {
  if (!isHttpUrl(url)) {
    throw new Error(
      "Media URL must use HTTP or HTTPS."
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 90000);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(
        `Unable to download media. HTTP ${response.status}.`
      );
    }

    const declaredLength = Number(
      response.headers.get("content-length") || 0
    );

    if (
      declaredLength > MAX_DOWNLOAD_BYTES
    ) {
      throw new Error(
        "The media file is too large to process."
      );
    }

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!buffer.length) {
      throw new Error(
        "The downloaded media file is empty."
      );
    }

    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        "The media file exceeds the allowed size."
      );
    }

    await fs.writeFile(outputPath, buffer);

    return outputPath;
  } finally {
    clearTimeout(timeout);
  }
}

function runFfmpeg({
  videoPath,
  audioPaths,
  audioStartTimes,
  soundPath,
  outputPath,
}) {
  return new Promise((resolve, reject) => {
    if (!videoPath) {
      reject(
        new Error("FFmpeg video input is missing.")
      );
      return;
    }

    if (!audioPaths?.length) {
      reject(
        new Error(
          "At least one character voice track is required."
        )
      );
      return;
    }

    const command = ffmpeg(videoPath);

    /*
      Input order:
      0 = video
      1 = background music, if present
      Remaining inputs = character voices
    */

    if (soundPath) {
      command.input(soundPath);
    }

    for (const audioPath of audioPaths) {
      command.input(audioPath);
    }

    const filters = [];

    audioPaths.forEach((_, index) => {
      const seconds = Number(
        audioStartTimes[index] ?? 0
      );

      const safeSeconds =
        Number.isFinite(seconds) && seconds >= 0
          ? seconds
          : 0;

      const delayMs = Math.round(
        safeSeconds * 1000
      );

      const inputIndex =
        index + (soundPath ? 2 : 1);

      filters.push(
        `[${inputIndex}:a]` +
          `adelay=${delayMs}|${delayMs},` +
          `aresample=44100,` +
          `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo` +
          `[voice${index}]`
      );
    });

    const voiceInputs = audioPaths
      .map((_, index) => `[voice${index}]`)
      .join("");

    filters.push(
      `${voiceInputs}` +
        `amix=inputs=${audioPaths.length}:duration=longest:dropout_transition=0:normalize=0,` +
        `alimiter=limit=0.95[mixedVoice]`
    );

    if (soundPath) {
      filters.push(
        `[1:a]` +
          `volume=0.18,` +
          `aresample=44100,` +
          `aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo` +
          `[backgroundMusic]`
      );

      filters.push(
        `[mixedVoice][backgroundMusic]` +
          `amix=inputs=2:duration=first:dropout_transition=0:normalize=0,` +
          `alimiter=limit=0.95[mixedAudio]`
      );
    } else {
      filters.push(
        `[mixedVoice]anull[mixedAudio]`
      );
    }

    command
      .complexFilter(filters)
      .outputOptions([
        "-map 0:v:0",
        "-map [mixedAudio]",
        "-c:v copy",
        "-c:a aac",
        "-b:a 192k",
        "-ar 44100",
        "-ac 2",
        "-movflags +faststart",
        "-max_muxing_queue_size 2048",
      ])
      .on("start", (commandLine) => {
        console.log(
          "BOMBA FINALIZER FFMPEG START:",
          commandLine
        );
      })
      .on("progress", (progress) => {
        if (typeof progress?.percent === "number") {
          console.log(
            `BOMBA FINALIZER PROGRESS: ${progress.percent.toFixed(1)}%`
          );
        }
      })
      .on("error", (error) => {
        console.error(
          "BOMBA FINALIZER FFMPEG ERROR:",
          error
        );

        reject(error);
      })
      .on("end", () => {
        console.log(
          "BOMBA FINALIZER FFMPEG COMPLETE"
        );

        resolve();
      })
      .save(outputPath);
  });
}

export async function POST(request) {
  let workDir = "";

  try {
    /*
      01 — CONFIGURATION
    */

    if (!CLOUDINARY_CLOUD_NAME) {
      return jsonError(
        "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME is not configured.",
        500
      );
    }

    if (!CLOUDINARY_VIDEO_PRESET) {
      return jsonError(
        "NEXT_PUBLIC_CLOUDINARY_VIDEO_PRESET is not configured.",
        500
      );
    }

    if (!ffmpegPath) {
      return jsonError(
        "The FFmpeg binary is unavailable.",
        500
      );
    }

    ffmpeg.setFfmpegPath(ffmpegPath);

    /*
      02 — REQUEST
    */

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonError(
        "The request body must contain valid JSON.",
        400
      );
    }

    const videoUrl =
      typeof body?.videoUrl === "string"
        ? body.videoUrl.trim()
        : "";

    if (!isHttpUrl(videoUrl)) {
      return jsonError(
        "A valid HTTP or HTTPS videoUrl is required.",
        400
      );
    }

    /*
      03 — VOICE TRACKS
    */

    let voiceTracks;

    try {
      voiceTracks = normalizeVoiceTracks(body);
    } catch (error) {
      return jsonError(
        error.message,
        400
      );
    }

    if (!voiceTracks.length) {
      return jsonError(
        "At least one voice track is required.",
        400
      );
    }

    /*
      04 — TEMPORARY WORKSPACE
    */

    workDir = path.join(
      os.tmpdir(),
      `bomba-final-${crypto
        .randomBytes(8)
        .toString("hex")}`
    );

    await fs.mkdir(workDir, {
      recursive: true,
    });

    const videoInputPath = path.join(
      workDir,
      "input-video.mp4"
    );

    /*
      05 — DOWNLOAD VIDEO
    */

    await downloadFile(
      videoUrl,
      videoInputPath
    );

    /*
      06 — DOWNLOAD CHARACTER VOICES
    */

    const audioPaths = [];
    const audioStartTimes = [];

    for (let index = 0; index < voiceTracks.length; index++) {
      const track = voiceTracks[index];

      const audioPath = path.join(
        workDir,
        `voice-${index}.mp3`
      );

      console.log(
        `BOMBA DOWNLOADING VOICE ${index + 1}`
      );

      await downloadFile(
        track.audioUrl,
        audioPath
      );

      audioPaths.push(audioPath);
      audioStartTimes.push(track.startTime);
    }

    /*
      07 — OPTIONAL BACKGROUND MUSIC
    */

    let soundPath = "";

    const soundUrl =
      typeof body?.sound?.audioUrl === "string"
        ? body.sound.audioUrl.trim()
        : "";

    if (soundUrl) {
      if (!isHttpUrl(soundUrl)) {
        return jsonError(
          "The background music URL is invalid.",
          400
        );
      }

      soundPath = path.join(
        workDir,
        "background-music.mp3"
      );

      await downloadFile(
        soundUrl,
        soundPath
      );
    }

    /*
      08 — MIX AUDIO WITH VIDEO
    */

    const mixedVideoPath = path.join(
      workDir,
      "bomba-final-video.mp4"
    );

    await runFfmpeg({
      videoPath: videoInputPath,
      audioPaths,
      audioStartTimes,
      soundPath,
      outputPath: mixedVideoPath,
    });

    /*
      09 — VERIFY OUTPUT
    */

    const outputStats = await fs.stat(
      mixedVideoPath
    );

    if (
      !outputStats.isFile() ||
      outputStats.size === 0
    ) {
      throw new Error(
        "FFmpeg did not produce a valid final video."
      );
    }

    /*
      10 — UPLOAD FINAL VIDEO
    */

    const videoBuffer = await fs.readFile(
      mixedVideoPath
    );

    const uploadFormData = new FormData();

    uploadFormData.append(
      "file",
      new Blob([videoBuffer], {
        type: "video/mp4",
      }),
      "bomba-final-video.mp4"
    );

    uploadFormData.append(
      "upload_preset",
      CLOUDINARY_VIDEO_PRESET
    );

    const uploadResponse = await fetch(
      CLOUDINARY_UPLOAD_URL,
      {
        method: "POST",
        body: uploadFormData,
        cache: "no-store",
      }
    );

    const uploadText = await uploadResponse.text();
    const uploadData = safeParse(uploadText);

    if (!uploadResponse.ok) {
      console.error(
        "BOMBA CLOUDINARY UPLOAD ERROR:",
        uploadText.slice(0, 1200)
      );

      return jsonError(
        uploadData?.error?.message ||
          `Final video upload failed with HTTP ${uploadResponse.status}.`,
        502
      );
    }

    /*
      11 — VERIFY CLOUDINARY RESULT
    */

    const finalVideoUrl =
      uploadData?.secure_url ||
      uploadData?.url ||
      "";

    const finalVideoPublicId =
      uploadData?.public_id || "";

    if (
      !finalVideoUrl ||
      !finalVideoPublicId
    ) {
      return jsonError(
        "Cloudinary did not return a valid final video URL.",
        502
      );
    }

    /*
      12 — SUCCESS
    */

    console.log(
      "BOMBA FINAL VIDEO COMPLETE:",
      finalVideoPublicId
    );

    return NextResponse.json(
      {
        status: "completed",
        videoUrl: finalVideoUrl,
        finalVideoUrl,
        cloudinaryVideoPublicId: finalVideoPublicId,
        voiceTracks: voiceTracks.map((track) => ({
          publicId: track.publicId,
          startTime: track.startTime,
        })),
        soundIncluded: Boolean(soundPath),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (error) {
    console.error(
      "BOMBA FINAL VIDEO ERROR:",
      error
    );

    return jsonError(
      error?.message ||
        "Unable to combine the video, voices, and background music.",
      500
    );
  } finally {
    if (workDir) {
      try {
        await fs.rm(workDir, {
          recursive: true,
          force: true,
        });

        console.log(
          "BOMBA TEMPORARY FILES CLEANED"
        );
      } catch (error) {
        console.error(
          "BOMBA TEMP CLEANUP ERROR:",
          error
        );
      }
    }
  }
}