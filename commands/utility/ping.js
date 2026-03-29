
export default {
  name: "ping",
  description: "Replies with Pong! and shows bot latency",
  type: "prefix",

  execute(message, _args, client) {
    const sent = Date.now();
    message.reply(
      `Pong! 🏓 Latency: ${sent - message.createdTimestamp}ms | API Latency: ${Math.round(client.ws.ping)}ms`
    );
  },
};
