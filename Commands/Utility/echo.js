
export default {
  name: "echo",
  description: "Repeats back what you say (usage: L!echo <message>)",
  type: "prefix",

  execute(message, args) {
    if (!args.length) {
      message.reply("Please provide a message to echo. Usage: `L!echo <message>`");
      return;
    }
    message.channel.send(args.join(" "));
  },
};
