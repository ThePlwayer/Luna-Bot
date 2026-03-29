
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";

export default {
  name: "avatar",
  type: "both",
  description: "Show a user's avatar (usage: L!avatar [@user])",

  data: new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Show a user's avatar")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("User to get avatar from")
        .setRequired(false)
    ),

  async execute(interaction) {
    const user = interaction.options.getUser("user") || interaction.user;
    const avatar = user.displayAvatarURL({ size: 1024, dynamic: true });

    const embed = new EmbedBuilder()
      .setTitle(`${user.username}'s Avatar`)
      .setImage(avatar)
      .setColor("Blue")
      .setFooter({ text: `Requested by ${interaction.user.username}` });

    await interaction.reply({ embeds: [embed] });
  },

  prefixExecute(message) {
    const user = message.mentions.users.first() || message.author;
    const avatar = user.displayAvatarURL({ size: 1024, dynamic: true });

    const embed = new EmbedBuilder()
      .setTitle(`${user.username}'s Avatar`)
      .setImage(avatar)
      .setColor("Blue")
      .setFooter({ text: `Requested by ${message.author.username}` });

    message.reply({ embeds: [embed] });
  },
};
