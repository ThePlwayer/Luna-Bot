
export default {
  name: "help",
  description: "Lists all available commands",
  type: "prefix",

  execute(message, _args, _client, { prefix, prefixCommands }) {
    const commandList = Object.entries(prefixCommands)
      .map(([name, cmd]) => `\`${prefix}${name}\` — ${cmd.description}`)
      .join("\n");

    message.reply(
      `**Prefix Commands:**\n${commandList}\n\n` +
      `**Slash Commands:** \`/kick\` \`/ban\` \`/timeout\` \`/stoptimeout\` \`/setchannel\` \`/avatar\``
    );
  },
};
