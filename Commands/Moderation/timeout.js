
import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from "discord.js";

export default {
  name: "timeout",
  type: "slash",

  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout a member for 10 minutes")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to timeout").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const member = interaction.options.getMember("user");
    if (!member || !(member instanceof GuildMember)) {
      return interaction.reply({ content: "Could not find that member.", ephemeral: true });
    }
    try {
      await member.timeout(600_000);
      await interaction.reply(`✅ ${member.user.tag} was timed out for 10 minutes.`);
    } catch (err) {
      console.error("[timeout] error:", err.message);
      await interaction.reply({ content: "Failed to timeout. Make sure I have the required permissions.", ephemeral: true });
    }
  },
};
