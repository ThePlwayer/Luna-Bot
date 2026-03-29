
import { formatUptime } from "../../bot/luna.js";

export default {
  name: "info",
  description: "Shows information about this bot",
  type: "prefix",

  execute(message, _args, client) {
    message.reply(
      `**Bot Info**\n` +
      `- Library: discord.js v14\n` +
      `- AI: Groq (llama-3.3-70b-versatile)\n` +
      `- Servers: ${client.guilds.cache.size}\n` +
      `- Uptime: ${formatUptime(client.uptime ?? 0)}`
    );
  },
};
