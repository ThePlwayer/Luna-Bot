
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { allowedChannels, saveAllowedChannels } from "../../bot/luna.js";

export default {
  name: "clearchannel",
  type: "both",
  description: "Remove a channel from Luna's allowed list, or clear all",

  data: new SlashCommandBuilder()
    .setName("clearchannel")
    .setDescription("Remove a channel from Luna's allowed list (leave empty to clear all channels)")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel to remove (leave empty to clear all)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    const channel = interaction.options.getChannel("channel");
    const set     = allowedChannels.get(interaction.guildId);

    if (!channel) {
      allowedChannels.delete(interaction.guildId);
      saveAllowedChannels();
      await interaction.reply("✅ Cleared all of Luna's allowed channels. Use `/setchannel` to set new ones.");
      return;
    }

    if (!set || !set.has(channel.id)) {
      await interaction.reply({ content: `<#${channel.id}> isn't in Luna's allowed channels.`, ephemeral: true });
      return;
    }

    set.delete(channel.id);
    if (set.size === 0) allowedChannels.delete(interaction.guildId);
    saveAllowedChannels();
    await interaction.reply(`✅ Removed <#${channel.id}> from Luna's allowed channels.`);
  },

  prefixExecute(message) {
    const mentioned = message.mentions.channels.first();
    const set       = allowedChannels.get(message.guildId);

    if (!mentioned) {
      allowedChannels.delete(message.guildId);
      saveAllowedChannels();
      message.reply("✅ Cleared all of Luna's allowed channels. Use `L!setchannel` to set new ones.");
      return;
    }

    if (!set || !set.has(mentioned.id)) {
      message.reply(`<#${mentioned.id}> isn't in Luna's allowed channels.`);
      return;
    }

    set.delete(mentioned.id);
    if (set.size === 0) allowedChannels.delete(message.guildId);
    saveAllowedChannels();
    message.reply(`✅ Removed <#${mentioned.id}> from Luna's allowed channels.`);
  },
};
