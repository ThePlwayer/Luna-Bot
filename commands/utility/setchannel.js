
import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { allowedChannels, saveAllowedChannels } from "../../bot/luna.js";

export default {
  name: "setchannel",
  type: "both",
  description: "Add a channel where Luna is allowed to chat",

  data: new SlashCommandBuilder()
    .setName("setchannel")
    .setDescription("Add a channel where Luna is allowed to chat (leave empty for current channel)")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("The channel to allow (defaults to current channel)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    const channel   = interaction.options.getChannel("channel");
    const channelId = channel ? channel.id : interaction.channelId;

    if (!allowedChannels.has(interaction.guildId)) {
      allowedChannels.set(interaction.guildId, new Set());
    }
    const set = allowedChannels.get(interaction.guildId);

    if (set.has(channelId)) {
      await interaction.reply({ content: `<#${channelId}> is already in Luna's allowed channels.`, ephemeral: true });
      return;
    }

    set.add(channelId);
    saveAllowedChannels();
    await interaction.reply(`✅ Luna will now chat in <#${channelId}>.`);
  },

  prefixExecute(message) {
    const mentioned = message.mentions.channels.first();
    const channelId = mentioned ? mentioned.id : message.channelId;

    if (!allowedChannels.has(message.guildId)) {
      allowedChannels.set(message.guildId, new Set());
    }
    const set = allowedChannels.get(message.guildId);

    if (set.has(channelId)) {
      message.reply(`<#${channelId}> is already in Luna's allowed channels.`);
      return;
    }

    set.add(channelId);
    saveAllowedChannels();
    message.reply(`✅ Luna will now chat in <#${channelId}>.`);
  },
};
