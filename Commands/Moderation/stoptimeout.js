
import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from "discord.js";

export default {
  name: "stoptimeout",
  type: "slash",

  data: new SlashCommandBuilder()
    .setName("stoptimeout")
    .setDescription("Remove a timeout from a member")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to remove timeout from").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    const member = interaction.options.getMember("user");
    if (!member || !(member instanceof GuildMember)) {
      return interaction.reply({ content: "Could not find that member.", ephemeral: true });
    }
    try {
      await member.timeout(null);
      await interaction.reply(`✅ Timeout removed from ${member.user.tag}.`);
    } catch (err) {
      console.error("[stoptimeout] error:", err.message);
      await interaction.reply({ content: "Failed to remove timeout. Make sure I have the required permissions.", ephemeral: true });
    }
  },
};
