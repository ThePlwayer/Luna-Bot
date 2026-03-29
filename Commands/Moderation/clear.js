
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";

async function clearChannel(channel) {
  let totalDeleted = 0;
  while (true) {
    const deleted = await channel.bulkDelete(100, true);
    totalDeleted += deleted.size;
    if (deleted.size < 2) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return totalDeleted;
}

export default {
  name: "clear",
  type: "both",
  description: "Clear all messages from this channel (usage: L!clear)",

  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear all messages from this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ content: "You don't have permission to manage messages.", ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const total = await clearChannel(interaction.channel);
      await interaction.editReply({ content: `✅ Cleared **${total}** message(s).` });
    } catch (err) {
      console.error("[clear] error:", err.message);
      await interaction.editReply({ content: "Failed to clear. Messages older than 14 days can't be bulk-deleted." });
    }
  },

  async prefixExecute(message) {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply("You don't have permission to manage messages.");
    }
    const notice = await message.reply("🧹 Clearing channel...");
    try {
      const total = await clearChannel(message.channel);
      await notice.edit(`✅ Cleared **${total}** message(s).`);
    } catch (err) {
      console.error("[clear] error:", err.message);
      await notice.edit("Failed to clear. Messages older than 14 days can't be bulk-deleted.").catch(() => {});
    }
  },
};
