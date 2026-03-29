
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import { join } from "path";
import { tmpdir } from "os";

const execFileAsync = promisify(execFile);

const YTDLP_BIN      = "/nix/store/39bpsx6xv7qrcnnbv65zmh8sabqdyl49-yt-dlp-2024.12.23/bin/yt-dlp";
const MAX_VIDEO_BYTES = 60 * 1024 * 1024; // 60 MB download cap
const MAX_FRAMES      = 4;                 // frames to sample
const MAX_AUDIO_SEC   = 300;               // cap audio at 5 min for transcription

/* ─── helpers ─── */

function makeTmpDir() {
  return fs.mkdtempSync(join(tmpdir(), "luna-video-"));
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function getVideoDuration(videoPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      videoPath,
    ], { timeout: 10_000 });
    const data = JSON.parse(stdout);
    return Math.max(parseFloat(data.format?.duration) || 5, 1);
  } catch {
    return 30;
  }
}

async function extractFrames(videoPath, duration, dir, numFrames = MAX_FRAMES) {
  const frames   = [];
  const interval = duration / (numFrames + 1);

  for (let i = 1; i <= numFrames; i++) {
    const ts        = Math.min(interval * i, duration - 0.5).toFixed(2);
    const framePath = join(dir, `frame_${i}.jpg`);
    try {
      await execFileAsync("ffmpeg", [
        "-ss", ts,
        "-i",  videoPath,
        "-vframes", "1",
        "-vf", "scale=640:-1",
        "-q:v", "3",
        "-y",
        framePath,
      ], { timeout: 15_000 });
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
        frames.push(framePath);
      }
    } catch (err) {
      console.warn(`[video] Frame ${i} extraction failed:`, err.message);
    }
  }
  return frames;
}

async function extractAudio(videoPath, dir) {
  const audioPath = join(dir, "audio.mp3");
  try {
    await execFileAsync("ffmpeg", [
      "-i",     videoPath,
      "-vn",
      "-acodec", "libmp3lame",
      "-ac",    "1",
      "-ar",    "16000",
      "-b:a",   "64k",
      "-t",     String(MAX_AUDIO_SEC),
      "-y",
      audioPath,
    ], { timeout: 30_000 });
    if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 200) {
      return audioPath;
    }
  } catch (err) {
    console.warn("[video] Audio extraction failed:", err.message);
  }
  return null;
}

/* ─── core analysis ─── */

async function analyzeVideoFile(videoPath, label, groq, toFile, dir) {
  const parts = [];

  const duration = await getVideoDuration(videoPath);
  parts.push(`duration: ${Math.round(duration)}s`);

  // ── visual ──
  const framePaths = await extractFrames(videoPath, duration, dir);
  if (framePaths.length > 0) {
    try {
      const content = [
        {
          type: "text",
          text:
            `You are analyzing ${framePaths.length} frames sampled evenly from a video. ` +
            "Describe what the video shows in 2–3 concise sentences: what's happening, " +
            "who/what appears, the setting, any visible text or on-screen content.",
        },
      ];
      for (const fp of framePaths) {
        const b64 = fs.readFileSync(fp).toString("base64");
        content.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${b64}` },
        });
      }

      const vRes = await groq.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{ role: "user", content }],
        max_tokens: 220,
      });
      const visualDesc = vRes.choices[0]?.message?.content?.trim();
      if (visualDesc) {
        parts.push(`visual: ${visualDesc}`);
        console.log(`[video] Visual "${label}": ${visualDesc.slice(0, 90)}...`);
      }
    } catch (err) {
      console.warn("[video] Vision analysis failed:", err.message);
    }
  }

  // ── audio ──
  const audioPath = await extractAudio(videoPath, dir);
  if (audioPath) {
    try {
      const audioBuf  = fs.readFileSync(audioPath);
      const audioFile = await toFile(audioBuf, "audio.mp3", { type: "audio/mp3" });
      const transcription = await groq.audio.transcriptions.create({
        file:            audioFile,
        model:           "whisper-large-v3-turbo",
        response_format: "text",
      });
      const text = (typeof transcription === "string"
        ? transcription
        : transcription?.text ?? ""
      ).trim();
      if (text && text.length > 5) {
        const capped = text.length > 600 ? text.slice(0, 597) + "…" : text;
        parts.push(`audio: "${capped}"`);
        console.log(`[video] Audio "${label}": ${text.slice(0, 80)}...`);
      } else {
        parts.push("no speech detected");
      }
    } catch (err) {
      console.warn("[video] Transcription failed:", err.message);
    }
  }

  const shortLabel = label.length > 60 ? label.slice(0, 57) + "…" : label;
  return `[video: "${shortLabel}" — ${parts.join(" | ")}]`;
}

/* ─── public API ─── */

/**
 * Process a Discord video attachment.
 * Returns a rich description string like:
 *   [video: "clip.mp4" — duration: 12s | visual: ... | audio: "..."]
 */
export async function processVideoAttachment(attachment, groq, toFile) {
  const dir = makeTmpDir();
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const cl = parseInt(res.headers.get("content-length") || "0");
    if (cl > MAX_VIDEO_BYTES) {
      return `[video: "${attachment.name}" — too large to analyze (${Math.round(cl / 1_048_576)}MB)]`;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_VIDEO_BYTES) {
      return `[video: "${attachment.name}" — too large to analyze (${Math.round(buf.length / 1_048_576)}MB)]`;
    }

    const videoPath = join(dir, "video.mp4");
    fs.writeFileSync(videoPath, buf);

    return await analyzeVideoFile(videoPath, attachment.name, groq, toFile, dir);
  } catch (err) {
    console.warn("[video] Attachment processing failed:", err.message);
    return `[video attached: "${attachment.name}"]`;
  } finally {
    cleanDir(dir);
  }
}

/**
 * Download and process a video from a URL (YouTube, TikTok, direct .mp4, etc.)
 * Returns a description string, or null if yt-dlp fails/isn't available.
 */
export async function processVideoUrl(url, groq, toFile) {
  if (!fs.existsSync(YTDLP_BIN)) {
    console.warn("[video] yt-dlp not found, skipping URL analysis");
    return null;
  }

  const dir = makeTmpDir();
  try {
    const outTemplate = join(dir, "video.%(ext)s");

    await execFileAsync(YTDLP_BIN, [
      "-f", "worstvideo[ext=mp4]+worstaudio[ext=m4a]/worst[ext=mp4]/worst",
      "--max-filesize", "60m",
      "--no-playlist",
      "--socket-timeout", "30",
      "-o", outTemplate,
      url,
    ], { timeout: 90_000 });

    const files = fs.readdirSync(dir).filter(f => /^video\.[a-z0-9]+$/i.test(f));
    if (files.length === 0) return null;

    const videoPath = join(dir, files[0]);
    if (fs.statSync(videoPath).size > MAX_VIDEO_BYTES) {
      return `[video link: "${url}" — downloaded file too large to analyze]`;
    }

    return await analyzeVideoFile(videoPath, url, groq, toFile, dir);
  } catch (err) {
    console.warn("[video] URL processing failed:", err.message);
    return null;
  } finally {
    cleanDir(dir);
  }
}

/**
 * Detect video URLs in a string (YouTube, TikTok, Twitter/X video, direct video files).
 * Returns an array of matched URLs.
 */
export function detectVideoUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/)[\w-]+|youtu\.be\/[\w-]+)[^\s]*/gi,
    /https?:\/\/(?:www\.)?tiktok\.com\/[^\s]*/gi,
    /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/\w+\/status\/\d+[^\s]*/gi,
    /https?:\/\/[^\s]+\.(?:mp4|webm|mov|avi|mkv)(?:\?[^\s]*)?/gi,
  ];

  const seen = new Set();
  const urls = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const u = match[0];
      if (!seen.has(u)) { seen.add(u); urls.push(u); }
    }
  }
  return urls;
}
