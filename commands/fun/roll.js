
export default {
  name: "roll",
  description: "Rolls a dice (usage: L!roll or L!roll <sides>)",
  type: "prefix",

  execute(message, args) {
    const sides = parseInt(args[0] ?? "6") || 6;
    if (sides < 2 || sides > 1000) {
      message.reply("Please provide a number of sides between 2 and 1000.");
      return;
    }
    const result = Math.floor(Math.random() * sides) + 1;
    message.reply(`🎲 You rolled a **${result}** (d${sides})`);
  },
};
