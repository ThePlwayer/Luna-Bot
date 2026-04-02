
import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
} from "discord.js";
import Groq, { toFile } from "groq-sdk";
import { readdirSync } from "fs";
import { pathToFileURL } from "url";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  processVideoAttachment,
  processVideoUrl,
  detectVideoUrls,
} from "./bot/videoWatcher.js";

import {
  PREFIX,
  COOLDOWN,
  REPLY_CHANCE,
  TOPIC_WINDOW_MS,
  LUNA_NAMES,
  userCooldown,
  allowedChannels,
  lastLunaSentTime,
  lunaMood,
  setLunaMood,
  detectEmotion,
  getUserProfile,
  userProfiles,
  getHistory,
  addToHistory,
  loadHistory,
  getAddressTag,
  shouldReply,
  executeActions,
  sanitizeOutput,
  sanitizeMentions,
  injectAllPings,
  buildSystemPrompt,
  fetchUserInfo,
  cacheMember,
  getMembersContext,
  normalizeEveryonePing,
  isMuted,
  muteChannel,
  unmuteChannel,
  detectIndirectCommand,
  loadUserNotes,
  getUserNotes,
  setUserNotes,
  loadAllowedChannels,
  getTrustLevel,
  TRUST_THRESHOLDS,
  getCachedPfpVision,
  setCachedPfpVision,
  describeTimeGap,
  loadUserProfiles,
  saveUserProfiles,
} from "./bot/luna.js";

/* ───────── ENV CHECK ───────── */
const token    = process.env["DISCORD_BOT_TOKEN"];
const clientId = process.env["DISCORD_CLIENT_ID"];
const groqKey  = process.env["GROQ_API_KEY"];

if (!token)    { console.error("Error: DISCORD_BOT_TOKEN is not set."); process.exit(1); }
if (!clientId) { console.error("Error: DISCORD_CLIENT_ID is not set."); process.exit(1); }
if (!groqKey)  { console.error("Error: GROQ_API_KEY is not set."); process.exit(1); }

const groq = new Groq({ apiKey: groqKey });
const GROQ_MODEL         = "llama-3.3-70b-versatile";
const GROQ_FALLBACK      = "llama-3.1-8b-instant";

/* ── Reaction-only responses (used instead of a full AI reply) ── */
const QUICK_REACTIONS    = ["😭", "💀", "real", "fr", "lmaooo", "no way", "omg", "👀", "💀💀"];
const QUICK_REACT_CHANCE = 0.08; // 8 % chance to fire

/** Wrapper that falls back to a smaller model on rate-limit errors */
async function groqChat(messages, maxTokens = 280, signal = undefined) {
  const body    = { model: GROQ_MODEL, messages, max_tokens: maxTokens, temperature: 0.85 };
  const reqOpts = signal ? { signal } : {};
  try {
    return await groq.chat.completions.create(body, reqOpts);
  } catch (err) {
    if (err?.name === "AbortError" || signal?.aborted) throw err;
    const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit");
    if (!isRateLimit) throw err;
    console.warn(`[groq] primary model rate-limited — falling back to ${GROQ_FALLBACK}`);
    return await groq.chat.completions.create({ ...body, model: GROQ_FALLBACK }, reqOpts);
  }
}

async function detectIndirectCommandAI(text, groqClient) {
  try {
    const res = await groqClient.chat.completions.create({
      model: GROQ_FALLBACK,
      messages: [
        {
          role: "system",
          content:
            "You are a classifier. Determine if the message is DIRECTLY telling a bot to stop talking or start talking again. " +
            "Only return 'mute', 'unmute', or 'none'. " +
            "Examples of mute: 'shut up', 'stop talking', 'be quiet', 'stfu'. " +
            "Examples of unmute: 'you can talk now', 'start talking again', 'come back'. " +
            "Examples of none: 'let's talk about fish', 'i love you', 'do you know grok?'. " +
            "Return ONLY one word: mute, unmute, or none.",
        },
        { role: "user", content: text },
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const result = res.choices[0]?.message?.content?.trim().toLowerCase();
    if (result === "mute" || result === "unmute") return result;
    return null;
  } catch {
    return detectIndirectCommand(text); // fallback to regex if AI fails
  }
}

async function shouldLunaJoin(history, newMessage, topicWarm) {
  try {
    const recentLines = history.slice(-5).map(h => h.content).join("\n");
    const res = await groq.chat.completions.create({
      model: GROQ_FALLBACK,
      messages: [
        {
          role: "system",
          content:
            "You decide if Luna (a cat girl Discord bot) should join a conversation. " +
            "Reply ONLY with YES or NO.\n" +
            "ALWAYS join if: only one person is talking (1-on-1 with Luna), message contains 'you' referring to Luna, " +
            "message is a follow-up to what Luna just said, message has a question mark, " +
            "topic is fun/emotional/interesting, or someone seems sad or excited.\n" +
            "Don't join if: two OTHER people are having a private conversation not involving Luna, " +
            "message is pure spam or gibberish, or Luna has already sent 3+ consecutive messages with no user reply.\n" +
            "When in doubt — JOIN. Luna is sociable and present.",
        },
        {
          role: "user",
          content: `Recent chat:\n${recentLines}\n\nNew message: ${newMessage}\nTopic warm: ${topicWarm}\n\nShould Luna join?`,
        },
      ],
      max_tokens: 3,
      temperature: 0,
    });
    const answer = res.choices[0]?.message?.content?.trim().toUpperCase();
    return answer === "YES";
  } catch {
    // fallback to random chance if AI fails
    return Math.random() < REPLY_CHANCE;
  }
}

/* ───────── TOKEN HELPERS ───────── */

/** Rough token estimate: ~3.5 chars per token */
function estimateTokens(text) {
  return Math.ceil((text ?? "").length / 3.5);
}

/**
 * Trim history to fit within maxTokens.
 * Strips [profile: ...] blocks from older messages to save tokens —
 * only the most-recent message keeps its full profile tag.
 * Always keeps the most recent message intact.
 */
function trimHistoryForGroq(history, maxTokens = 2800) {
  if (!history.length) return [];

  const stripped = history.map((h, i) => {
    if (i === history.length - 1) return { role: h.role, content: h.content };
    const content = h.content.replace(/\[profile:[^\]]{1,600}\]/g, "").replace(/\s{2,}/g, " ").trim();
    return { role: h.role, content };
  });

  let total = stripped.reduce((sum, h) => sum + estimateTokens(h.content), 0);
  while (total > maxTokens && stripped.length > 1) {
    const removed = stripped.shift();
    total -= estimateTokens(removed.content);
  }
  return stripped;
}

/** Extract numeric Discord user IDs from recent history for focused member list */
function getActiveUserIds(history, limit = 12) {
  const ids = new Set();
  const recent = history.slice(-limit);
  for (const h of recent) {
    const matches = h.content.matchAll(/<@(\d+)>/g);
    for (const m of matches) ids.add(m[1]);
  }
  return ids;
}

/** Per-user DM notes update throttle: once per 10 minutes */
const notesLastUpdated = new Map();
const NOTES_UPDATE_INTERVAL = 10 * 60_000;

/** Returns a human-readable trust progress line, e.g. "friendly (42 msgs) → close in 8 msgs" */
function buildTrustProgressLine(userId) {
  const LEVELS = ["shy", "warming_up", "friendly", "close", "bonded"];
  const profile = userProfiles.get(userId) ?? { messages: 0 };
  const msgs    = profile.messages ?? 0;
  const current = getTrustLevel(profile);
  const idx     = LEVELS.indexOf(current);
  const nextLevel = LEVELS[idx + 1] ?? null;
  const nextAt    = nextLevel ? TRUST_THRESHOLDS[nextLevel] : null;
  const toNext    = nextAt ? Math.max(nextAt - msgs, 0) : 0;

  if (!nextLevel) {
    return `trust: ${current} (${msgs} msgs total) — max bond reached`;
  }
  return `trust: ${current} (${msgs} msgs) → ${nextLevel} in ${toNext} more msg${toNext === 1 ? "" : "s"}`;
}

/**
 * After an exchange, update bullet-point notes about the user using Groq.
 * Always includes a trust-progress bullet so Luna knows how well she knows them.
 */
async function updateUserNotes(userId, displayName, channelId) {
  try {
    const history = getHistory(channelId).slice(-14);
    if (history.length < 2) return;

    const existing     = getUserNotes(userId) ?? "No notes yet.";
    const convo        = history.map((h) => h.content).join("\n");
    const trustLine    = buildTrustProgressLine(userId);

    const res = await groqChat([
      {
        role: "system",
        content:
          "Memory assistant for Luna bot. Write updated concise bullet-point notes (max 6 bullets) about the user. " +
          "RULES:\n" +
          "• ALWAYS include exactly one bullet that starts with 'trust:' showing their trust progress (copy it from the provided line — do not alter the wording).\n" +
          "• The remaining bullets cover personality, preferences, habits, and recurring topics from the conversation.\n" +
          "• Output ONLY bullet points — no intro, no headings, no extra text.",
      },
      {
        role: "user",
        content:
          `User: ${displayName}\n` +
          `Trust progress (include verbatim as the first bullet): ${trustLine}\n\n` +
          `Existing notes:\n${existing}\n\n` +
          `Recent conversation:\n${convo}\n\n` +
          `Updated notes:`,
      },
    ], 220);

    const updated = res.choices[0]?.message?.content?.trim();
    if (updated) {
      // Guarantee the trust bullet is always present even if the model forgot it
      const hasTrustBullet = /^[•\-*]\s*trust:/im.test(updated);
      const final = hasTrustBullet
        ? updated
        : `• ${trustLine}\n${updated}`;
      setUserNotes(userId, final);
      console.log(`[memory] Updated notes for ${displayName} (${userId}) [${trustLine}]`);
    }
  } catch (err) {
    console.warn("[memory] Failed to update user notes:", err.message);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ───────── PFP VISION ───────── */
const PFP_VISION_TIMEOUT_MS = 5000;

/**
 * Analyze a user or bot's profile picture using the Groq vision model.
 * Result is cached for 2 hours per user ID.
 */
async function analyzePfp(userId, pfpUrl, label) {
  const cached = getCachedPfpVision(userId);
  if (cached) return cached;

  try {
    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(), PFP_VISION_TIMEOUT_MS);

    const res = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `Describe this ${label}'s Discord profile picture in one short sentence. Note what's depicted (character, anime art, real photo, logo, etc.) and the dominant color(s). Be concise.`,
          },
          { type: "image_url", image_url: { url: pfpUrl } },
        ],
      }],
      max_tokens: 80,
    }, { signal: ac.signal });

    clearTimeout(timer);
    const desc = res.choices[0]?.message?.content?.trim();
    if (desc) {
      setCachedPfpVision(userId, desc);
      console.log(`[pfp-vision] ${label} (${userId}): ${desc.slice(0, 90)}`);
      return desc;
    }
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.warn(`[pfp-vision] Failed for ${userId}:`, err.message);
    }
  }
  return null;
}

/* ───────── LOAD COMMANDS ───────── */
const prefixCommands = {};
const slashCommands  = {};
const slashDefs      = [];

const categories = ["utility", "fun", "moderation"];

for (const category of categories) {
  const dir = join(__dirname, "commands", category);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    continue;
  }

  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const cmd = mod.default;
    if (!cmd) continue;

    if ((cmd.type === "prefix" || cmd.type === "both") && cmd.name) {
      prefixCommands[cmd.name] = {
        description: cmd.description ?? "",
        execute: (cmd.prefixExecute ?? cmd.execute).bind(cmd),
      };
    }

    if ((cmd.type === "slash" || cmd.type === "both") && cmd.data) {
      slashCommands[cmd.name] = cmd;
      slashDefs.push(cmd.data.toJSON());
    }
  }
}

/* ───────── REGISTER SLASH COMMANDS ───────── */
const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    await rest.put(Routes.applicationCommands(clientId), { body: slashDefs });
    console.log(`✅ Registered ${slashDefs.length} slash command(s): ${slashDefs.map((c) => "/" + c.name).join(" ")}`);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
})();

/* ───────── DISCORD CLIENT ───────── */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

/* ── Ready ── */
client.once(Events.ClientReady, async (readyClient) => {
  loadHistory();
  loadUserNotes();
  loadUserProfiles();
  loadAllowedChannels();
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  console.log(`📋 Serving ${readyClient.guilds.cache.size} server(s)`);
  console.log(`🤖 Prefix: ${PREFIX}`);
  console.log(`🧠 AI: Groq (${GROQ_MODEL})`);
  
  let totalCached = 0;
  for (const guild of readyClient.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        cacheMember(guild.id, member);
      }
      totalCached += members.size;
    } catch (err) {
      console.warn(`[members] Could not fetch members for ${guild.name}:`, err.message);
    }
  }
  console.log(`👥 Cached ${totalCached} member(s) across all guilds`);

  readyClient.user.setPresence({
    activities: [{ name: "watching server chaos 👀" }],
    status: "online",
  });

  const ACTIVE_STATUSES = [
  "watching server chaos 👀",
  "protecting my master 💖",
  "listening to chat 🐾",
  "thinking about fish 🐟",
  "looking for fun 😸",
];

const IDLE_STATUSES = [
  "zoning out... 🐱",
  "staring at nothing 👀",
  "waiting for someone to talk to~ 🌸",
];

const SLEEPY_STATUSES = [
  "taking a nap 😴",
  "zzz... 💤",
  "dreaming of fish 🐟💤",
];

setInterval(() => {
  const mostRecent = lastLunaSentTime.size > 0
    ? Math.max(...lastLunaSentTime.values())
    : 0;
  const idleMs = Date.now() - mostRecent;

  if (idleMs > 45 * 60_000) {
    client.user.setPresence({ activities: [], status: "invisible" });
  } else if (idleMs > 30 * 60_000) {
    const pick = SLEEPY_STATUSES[Math.floor(Math.random() * SLEEPY_STATUSES.length)];
    client.user.setPresence({ activities: [{ name: pick }], status: "idle" });
  } else if (idleMs > 10 * 60_000) {
    const pick = IDLE_STATUSES[Math.floor(Math.random() * IDLE_STATUSES.length)];
    client.user.setPresence({ activities: [{ name: pick }], status: "idle" });
  } else {
    const pick = ACTIVE_STATUSES[Math.floor(Math.random() * ACTIVE_STATUSES.length)];
    client.user.setPresence({ activities: [{ name: pick }], status: "online" });
  }
}, 60_000);
});
/* ───────── UNPROMPTED "MISSING YOU" MESSAGES ───────── */
const lastUnprompted = new Map(); // channelId -> timestamp
const UNPROMPTED_SILENCE_MS  = 45 * 60_000;  // 45 mins of silence
const UNPROMPTED_COOLDOWN_MS = 60 * 60_000;  // max once per hour per channel
const UNPROMPTED_GLOBAL_COOLDOWN_MS = 60 * 60_000; // max once per hour globally
let lastUnpromptedGlobal = 0;

setInterval(async () => {
  if (Date.now() - lastUnpromptedGlobal < UNPROMPTED_GLOBAL_COOLDOWN_MS) return;

  for (const [channelId, lastSent] of lastLunaSentTime) {
    const silenceMs = Date.now() - lastSent;
    if (silenceMs < UNPROMPTED_SILENCE_MS) continue;

    const lastFired = lastUnprompted.get(channelId) ?? 0;
    if (Date.now() - lastFired < UNPROMPTED_COOLDOWN_MS) continue;

    // Get recent history to find who was talking and their trust level
    const history = getHistory(channelId);
    if (history.length < 2) continue;

    // Find the highest trust level of recent users from history
    let highestTrust = "shy";
    let highestTrustUserId = null;
    const TRUST_ORDER = ["shy", "warming_up", "friendly", "close", "bonded"];

    for (const [userId, profile] of userProfiles) {
      const trust = getTrustLevel(profile);
      if (TRUST_ORDER.indexOf(trust) > TRUST_ORDER.indexOf(highestTrust)) {
        highestTrust = trust;
        highestTrustUserId = userId;
      }
    }

    // Only fire for friendly+ in servers, close+ in DMs
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) continue;
    const isDM = !channel.guild;
    if (isDM && !["close", "bonded"].includes(highestTrust)) continue;
    if (!isDM && !["friendly", "close", "bonded"].includes(highestTrust)) continue;
    if (!isDM && isMuted(channelId)) continue;

    // Check channel is still allowed
    if (!isDM) {
      const allowedSet = allowedChannels.get(channel.guild?.id ?? "");
      if (!allowedSet || !allowedSet.has(channelId)) continue;
    }

    // Build a short unprompted message via Groq
    const recentConvo = history.slice(-6).map(h => h.content).join("\n");
    const trustDesc = highestTrust === "bonded" ? "your closest bond, very personal and warm" :
                      highestTrust === "close"   ? "a close friend, affectionate" :
                                                   "a friendly acquaintance, casual";

    try {
      const res = await groqChat([
        {
          role: "system",
          content:
            "You are Luna, a cute cat girl. The chat has gone quiet for a while. " +
            `Your relationship with the most recent person is: ${trustDesc}. ` +
            "Send ONE short, natural unprompted message (1-2 sentences max) that feels like you genuinely miss the vibe or the person. " +
            "Be subtle and emotional — don't say 'i noticed it got quiet'. Just express your feeling naturally. " +
            "Use cat-girl expressions. End with one emoji.",
        },
        {
          role: "user",
          content: `Recent conversation context:\n${recentConvo}\n\nSend your unprompted message:`,
        },
      ], 80);

      const msg = res.choices[0]?.message?.content?.trim();
      if (!msg) continue;

      await channel.send({ content: msg, allowedMentions: { parse: ["users"] } });
      lastUnprompted.set(channelId, Date.now());
      lastUnpromptedGlobal = Date.now();
      lastLunaSentTime.set(channelId, Date.now());
      addToHistory(channelId, "assistant", msg);
      console.log(`[unprompted] Sent message to ${channelId}: ${msg.slice(0, 60)}`);

      break; // only one channel per interval tick
    } catch (err) {
      console.warn("[unprompted] Failed:", err.message);
    }
  }
}, 5 * 60_000); // check every 5 minutes

/* ── Keep member cache up to date ── */
client.on(Events.GuildMemberAdd, (member) => {
  cacheMember(member.guild.id, member);
});
client.on(Events.GuildMemberUpdate, (_old, member) => {
  cacheMember(member.guild.id, member);
});

/* ───────── PER-CHANNEL INTERRUPT STATE ───────── */
// Tracks the in-flight Groq request for each channel
const channelActive  = new Map(); // channelId -> { controller: AbortController, priority: number }
// Holds the latest "pending" message that should run after the current one finishes
const channelPending = new Map(); // channelId -> { message, ctx }
// Tracks every channel that currently has a Luna reply in-flight
const activeReplies  = new Map(); // channelId -> AbortController

/** 2 = master/direct/DM  |  1 = mention  |  0 = ambient */
function getMsgPriority(isVulp, addressTag, isDM) {
  if (isDM || isVulp || addressTag === "DIRECT") return 2;
  if (addressTag === "MENTION") return 1;
  return 0;
}

/**
 * Human-like read delay before Luna starts typing.
 * Scales with incoming message length — short glance for short msgs,
 * a moment to "read" for longer ones. Jitter keeps it feeling natural.
 */
function getReplyDelay(message) {
  const len  = (message.content ?? "").trim().length;
  const base = Math.min(Math.max(len * 15, 200), 1400); // 15 ms/char, 200–1400 ms
  const jitter = Math.floor((Math.random() - 0.5) * 400); // ±200 ms
  return Math.max(base + jitter, 150);
}

/** All Groq + typing + bubble-sending logic, shareable by both the main handler and pending replay */
async function runLunaReply(message, ctx) {
  const { isBot, isDM, historyLine, currentTrustLevel, topicWarm, priority } = ctx;

  const controller    = new AbortController();
  const { signal }    = controller;
  channelActive.set(message.channelId, { controller, priority });
  activeReplies.set(message.channelId, controller);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let typingInterval  = null;

  try {
    const mediaNotes = [];
    for (const attachment of message.attachments.values()) {
      const ct = attachment.contentType ?? "";

      if (ct.startsWith("image/")) {
        try {
          const visionRes = await groq.chat.completions.create({
            model: "meta-llama/llama-4-scout-17b-16e-instruct",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Describe this image in 1-2 concise sentences. Focus on what's clearly visible." },
                { type: "image_url", image_url: { url: attachment.url } },
              ],
            }],
            max_tokens: 180,
          });
          const desc = visionRes.choices[0]?.message?.content?.trim();
          mediaNotes.push(desc
            ? `[image: "${attachment.name}" — vision: ${desc}]`
            : `[image attached: "${attachment.name}"]`
          );
          console.log(`[vision] Analyzed image "${attachment.name}": ${desc?.slice(0, 80)}...`);
        } catch (err) {
          console.warn("[vision] Image analysis failed:", err.message);
          mediaNotes.push(`[image attached: "${attachment.name}"]`);
        }

      } else if (ct.startsWith("audio/")) {
        try {
          const audioRes = await fetch(attachment.url);
          const audioBuf = Buffer.from(await audioRes.arrayBuffer());
          const audioFile = await toFile(audioBuf, attachment.name, { type: ct });
          const transcription = await groq.audio.transcriptions.create({
            file: audioFile,
            model: "whisper-large-v3-turbo",
            response_format: "text",
          });
          const text = (typeof transcription === "string" ? transcription : transcription?.text ?? "").trim();
          mediaNotes.push(text
            ? `[audio transcription: "${text}"]`
            : `[audio attached: "${attachment.name}"]`
          );
          console.log(`[audio] Transcribed "${attachment.name}": ${text?.slice(0, 80)}`);
        } catch (err) {
          console.warn("[audio] Transcription failed:", err.message);
          mediaNotes.push(`[audio attached: "${attachment.name}"]`);
        }

      } else if (ct.startsWith("video/")) {
        try {
          console.log(`[video] Processing attachment "${attachment.name}"...`);
          const videoNote = await processVideoAttachment(attachment, groq, toFile);
          mediaNotes.push(videoNote);
        } catch (err) {
          console.warn("[video] Attachment failed:", err.message);
          mediaNotes.push(`[video attached: "${attachment.name}"]`);
        }
      }
    }

    // Detect and process video URLs in message content or embeds
    const videoUrls = detectVideoUrls(message.content ?? "");
    // Also check embeds for video links
    for (const embed of message.embeds) {
      if (embed.video?.url) videoUrls.push(...detectVideoUrls(embed.video.url));
      if (embed.url)        videoUrls.push(...detectVideoUrls(embed.url));
    }
    const uniqueVideoUrls = [...new Set(videoUrls)];
    for (const url of uniqueVideoUrls.slice(0, 2)) { // cap at 2 URLs per message
      try {
        console.log(`[video] Processing URL: ${url}`);
        const urlNote = await processVideoUrl(url, groq, toFile);
        if (urlNote) mediaNotes.push(urlNote);
      } catch (err) {
        console.warn("[video] URL failed:", err.message);
      }
    }

    await sleep(getReplyDelay(message));
    await message.channel.sendTyping();
    const startTime = Date.now();
    typingInterval  = setInterval(() => message.channel.sendTyping(), 8000);

    const fullHistoryLine = mediaNotes.length > 0
      ? `${historyLine}\n${mediaNotes.join("\n")}`
      : historyLine;

    const fullHistory = getHistory(message.channelId);
    const activeIds   = message.guild ? getActiveUserIds(fullHistory) : null;
    const membersCtx  = message.guild ? getMembersContext(message.guildId, activeIds) : null;
    const isNsfw      = isDM || (message.channel?.nsfw === true);

    // Fetch pfp description via vision model (cached, non-blocking on error)
    let userPfpDesc = null;
    if (!isBot) {
      const pfpUrl = message.member?.displayAvatarURL({ size: 256, extension: "png" })
                  ?? message.author.displayAvatarURL({ size: 256, extension: "png" });
      userPfpDesc = await analyzePfp(message.author.id, pfpUrl, message.author.username);
    }

    const systemPrompt = buildSystemPrompt(
      lunaMood,
      topicWarm,
      membersCtx,
      client.user.displayAvatarURL({ extension: "png", size: 256 }),
      getUserNotes(message.author.id),
      isNsfw,
      currentTrustLevel,
      userPfpDesc
    );

    const trimmedHistory = trimHistoryForGroq(fullHistory.slice(0, -1));

    const response = await groqChat([
      { role: "system", content: systemPrompt },
      ...trimmedHistory,
      { role: "user", content: fullHistoryLine },
    ], 200, signal);

    clearInterval(typingInterval);
    typingInterval = null;

    const reply = response.choices[0]?.message?.content?.trim() ?? "";

    if (!reply || /^\s*NO[_\s-]?REPLY[.!]?\s*$/i.test(reply)) {
      const history = getHistory(message.channelId);
      history.pop();
      return;
    }

    const { text: rawReply } = await executeActions(reply, message);
    const cleanReply = normalizeEveryonePing(injectAllPings(sanitizeMentions(sanitizeOutput(rawReply)), message.guildId));

    let bubbles = cleanReply
      .split(/\[SPLIT\]|<<<[^>]*>>>/gi)
      .map((b) => b.trim())
      .filter(Boolean);

    if (bubbles.length === 1 && bubbles[0].length > 300) {
  const sentences = bubbles[0]
    .split(/(?<=[.!?~])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 1) bubbles = sentences;
    }

    // Light emoji handling - only add one emoji at the very end sometimes
    const LUNA_EMOJIS = ["🐾", "💕", "😺", "🥺", "💖", "🌸", "🐱"];
    const endsWithEmoji = (s) => {
      const lastChar = [...s.trimEnd()].at(-1) ?? "";
      const cp = lastChar.codePointAt(0) ?? 0;
      return cp >= 0x2600;
    };

    // Only add to the LAST bubble, and only \~55% of the time
    if (bubbles.length > 0) {
      const lastIndex = bubbles.length - 1;
      const lastBubble = bubbles[lastIndex].trimEnd();
      if (!endsWithEmoji(lastBubble) && Math.random() < 0.55) {
        bubbles[lastIndex] = lastBubble + " " + LUNA_EMOJIS[Math.floor(Math.random() * LUNA_EMOJIS.length)];
      }
    }

    // Guard: if aborted after Groq responded but before sending, bail out entirely
    if (signal.aborted) return;

    for (let i = 0; i < bubbles.length; i++) {
      // Guard: stop mid-sequence if a newer message interrupted between bubbles
      if (signal.aborted) break;

      const bubble   = bubbles[i];
      const typingMs =
        Math.min(Math.max(bubble.length * 42, 900), 4500) +
        Math.floor((Math.random() - 0.5) * 600);

      if (i === 0) {
        const elapsed     = Date.now() - startTime;
        const remaining   = Math.max(typingMs - elapsed, 700);
        await message.channel.sendTyping();
        const keepTyping0 = setInterval(() => message.channel.sendTyping(), 8000);
        await sleep(remaining);
        clearInterval(keepTyping0);
      } else {
        await sleep(getReplyDelay(message));
        await message.channel.sendTyping();
        const keepTyping = setInterval(() => message.channel.sendTyping(), 8000);
        await sleep(typingMs);
        clearInterval(keepTyping);
      }

      // Final guard: don't send if aborted during the typing delay
      if (signal.aborted) break;

      if (i === 0) {
        await message.reply({ content: bubble, allowedMentions: { parse: ["users", "everyone"] } });
        lastLunaSentTime.set(message.channelId, Date.now());
      } else {
        await message.channel.send({ content: bubble, allowedMentions: { parse: ["users", "everyone"] } });
      }
    }

    if (Math.random() < 0.25) {
      const emojis = ["💖", "✨", "😂", "👀", "😭", "🔥"];
      message.react(emojis[Math.floor(Math.random() * emojis.length)]).catch(() => {});
    }

    addToHistory(message.channelId, "assistant", bubbles.join(" "));

    if (!isBot) {
      const profile  = getUserProfile(message.author);
      const lastNote = notesLastUpdated.get(message.author.id) ?? 0;
      if (Date.now() - lastNote > NOTES_UPDATE_INTERVAL) {
        notesLastUpdated.set(message.author.id, Date.now());
        updateUserNotes(message.author.id, profile.displayName, message.channelId);
      }
    }

  } catch (err) {
    clearInterval(typingInterval);
    typingInterval = null;

    // Silently swallow abort — just stop typing, leave history as-is
    if (err?.name === "AbortError" || signal.aborted) return;

    console.error("[groq] error:", err?.message ?? err);

    const isRateLimit = err?.status === 429 || err?.message?.includes("rate limit");
    const isAuthErr   = err?.status === 401 || err?.message?.includes("auth");

    if (isRateLimit) {
      message.reply({ content: "nyaa~ i'm thinking too fast, give me a moment~ 🐾", allowedMentions: { parse: [] } }).catch(() => {});
    } else if (isAuthErr) {
      message.reply({ content: "h-huh? Luna's brain has an auth problem... 💤", allowedMentions: { parse: [] } }).catch(() => {});
    }

    const hist = getHistory(message.channelId);
    if (hist.length > 0 && hist[hist.length - 1].role === "user") hist.pop();

  } finally {
    clearInterval(typingInterval);
    channelActive.delete(message.channelId);
    activeReplies.delete(message.channelId);

    // If a newer message was waiting, process it now
    const pending = channelPending.get(message.channelId);
    if (pending) {
      channelPending.delete(message.channelId);
      setImmediate(() => runLunaReply(pending.message, pending.ctx));
    }
  }
}

/* ── Message handler ── */
client.on(Events.MessageCreate, async (message) => {
  if (message.author.id === client.user.id) return;

  const isBot   = message.author.bot;
  const rawText = message.content?.trim() ?? "";

  if (isBot) {
    if (!rawText) return;
    const botMentionsLuna = message.mentions.has(client.user) || LUNA_NAMES.test(rawText);
    addToHistory(message.channelId, "user", `[BOT] ${message.author.username}: ${rawText}`);
    if (!botMentionsLuna) return;
    const botKey = `bot:${message.author.id}`;
    const lastBot = userCooldown.get(botKey);
    if (lastBot && Date.now() - lastBot < COOLDOWN * 3) return;
    userCooldown.set(botKey, Date.now());
  }

  if (!isBot) {
  const isDMEarly = !message.guild;
  const last = userCooldown.get(message.author.id);
  if (!isDMEarly && last && Date.now() - last < COOLDOWN) return;
  userCooldown.set(message.author.id, Date.now());

    const profile = getUserProfile(message.author);
    profile.messages++;
    profile.trust = getTrustLevel(profile);
    saveUserProfiles(); // ✅ Persist trust counter
    
    const emotion = detectEmotion(message.content);
    if (emotion === "funny")  setLunaMood("playful");
    if (emotion === "sad")    setLunaMood("caring");
    if (emotion === "angry")  setLunaMood("calm");
  }

  if (!isBot && message.content.startsWith(PREFIX)) {
    const args        = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase() ?? "";
    const command     = prefixCommands[commandName];
    if (!command) {
      message.reply(`Unknown command: \`${PREFIX}${commandName}\`. Type \`${PREFIX}help\` to see all commands.`);
      return;
    }
    try {
      command.execute(message, args, client, { prefix: PREFIX, prefixCommands });
    } catch (err) {
      console.error(`Error executing ${PREFIX}${commandName}:`, err);
      message.reply("An error occurred while executing that command.");
    }
    return;
  }

  const isDM = !message.guild;

  if (!isDM) {
    const allowedSet       = allowedChannels.get(message.guildId ?? "");
    // Block completely if no channels have been configured for this server
    if (!allowedSet || allowedSet.size === 0) return;
    // Block if the current channel isn't in the allowed set — no exceptions
    if (!allowedSet.has(message.channelId)) return;
  }

  if (!isBot && !isDM && !shouldReply(message)) return;

  const addressTag = getAddressTag(message, client.user);
  const content    = message.content.replace(`<@${client.user.id}>`, "").trim() || "Hello!";

  if (!isBot && (addressTag === "DIRECT" || addressTag === "MENTION")) {
    const indirectCmd = await detectIndirectCommandAI(content, groq);
    if (indirectCmd === "mute") {
      muteChannel(message.channelId);
      await message.reply("ok ok, i'll be quiet~ 🤫");
      return;
    }
    if (indirectCmd === "unmute") {
      unmuteChannel(message.channelId);
      await message.reply("yay i can talk again!! 🐾✨");
      return;
    }
  }

  if (!isDM && isMuted(message.channelId) && addressTag !== "DIRECT") return;

  const isVulp  = !isBot && message.author.username.toLowerCase().includes("vulp.ss");
  const tagLabel =
    addressTag === "DIRECT"  ? " [→ LUNA]" :
    addressTag === "MENTION" ? " [~ LUNA]" : "";

  let historyLine;
  let currentTrustLevel = "friendly";
  if (isBot) {
    historyLine = `[BOT] ${message.author.username} [→ LUNA]: ${content}`;
    const h = getHistory(message.channelId);
    if (h.length > 0) h[h.length - 1].content = historyLine;
  } else {
    const member = message.guild
      ? await message.guild.members.fetch(message.author.id).catch(() => null)
      : null;
    const profileTag = await fetchUserInfo(message.author, member, client);
    const profile = getUserProfile(message.author);
    currentTrustLevel = getTrustLevel(profile, isVulp);

    const history = getHistory(message.channelId);
    const lastEntry = history.at(-1);
    const timeGap = lastEntry?.timestamp ? describeTimeGap(Date.now() - lastEntry.timestamp) : null;
    const timeTag = timeGap ? ` [last message: ${timeGap}]` : "";

    historyLine = `${profile.displayName} (@${profile.username}) [ping: <@${message.author.id}>] [trust: ${currentTrustLevel}] ${profileTag}${isVulp ? " [THIS IS VULP.SS!!!]" : ""}${tagLabel}${timeTag}: ${content}`;
    addToHistory(message.channelId, "user", historyLine);
  }

  const lastSent  = lastLunaSentTime.get(message.channelId) ?? 0;
  const topicWarm = Date.now() - lastSent < TOPIC_WINDOW_MS;

  if (!isDM) {
    if (addressTag === "DIRECT" || isBot) {
      /* always reply */
    } else if (addressTag === "MENTION") {
      const threshold = topicWarm ? 0.90 : 0.70;
      if (Math.random() > threshold) return;
    } else {
      const history = getHistory(message.channelId);
      const join = await shouldLunaJoin(history, content, topicWarm);
      if (!join) return;
    }
  }

  // Reaction-only path — skip full AI reply for ambient, non-bot messages occasionally
  if (!isDM && !isBot && addressTag !== "DIRECT" && Math.random() < QUICK_REACT_CHANCE) {
    const pick = QUICK_REACTIONS[Math.floor(Math.random() * QUICK_REACTIONS.length)];
    if (/^\p{Emoji}/u.test(pick)) {
      message.react(pick).catch(() => {});
    } else {
      message.reply({ content: pick, allowedMentions: { parse: [] } }).catch(() => {});
    }
    return;
  }

  // ── 1) Generate reply context ────────────────────────────────────────────
  const priority = getMsgPriority(isVulp, addressTag, isDM);
  const ctx      = { isBot, isDM, historyLine, currentTrustLevel, topicWarm, priority };

  // ── 2) Apply read delay (simulate Luna reading the message) ──────────────
  await new Promise((r) => setTimeout(r, getReplyDelay(message)));

  // ── 3) Send (interrupt in-flight reply if needed, then dispatch) ─────────
  const active = channelActive.get(message.channelId);
  if (active) {
    if (priority >= active.priority) {
      activeReplies.get(message.channelId)?.abort();
      activeReplies.delete(message.channelId);
      channelActive.delete(message.channelId);
    } else {
      channelPending.set(message.channelId, { message, ctx });
      return;
    }
  }

  runLunaReply(message, ctx);
});

/* ── Slash command handler ── */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = slashCommands[interaction.commandName];
  if (!command) {
    await interaction.reply({ content: "Unknown command.", ephemeral: true });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error executing /${interaction.commandName}:`, err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Failed to execute that command.",
        ephemeral: true,
      });
    }
  }
});

client.login(token);
