
import { SlashCommandBuilder, PermissionFlagsBits, GuildMember } from "discord.js";

export default {
  name: "kick",
  type: "slash",

  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .addUserOption((option) =>
      option.setName("user").setDescription("User to kick").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  async execute(interaction) {
    const member = interaction.options.getMember("user");
    if (!member || !(member instanceof GuildMember)) {
      return interaction.reply({ content: "Could not find that member.", ephemeral: true });
    }
    try {
      await member.kick();
      await interaction.reply(`✅ ${member.user.tag} was kicked.`);
    } catch (err) {
      console.error("[kick] error:", err.message);
      await interaction.reply({ content: "Failed to kick. Make sure I have the required permissions.", ephemeral: true });
    }
  },
};
