
import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from "discord.js";

export default {
  name: "ban",
  type: "slash",

  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to ban").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    const member = interaction.options.getMember("user");
    if (!member || !(member instanceof GuildMember)) {
      return interaction.reply({ content: "Could not find that member.", ephemeral: true });
    }
    try {
      await member.ban();
      await interaction.reply(`✅ ${member.user.tag} was banned.`);
    } catch (err) {
      console.error("[ban] error:", err.message);
      await interaction.reply({ content: "Failed to ban. Make sure I have the required permissions.", ephemeral: true });
    }
  },
};
