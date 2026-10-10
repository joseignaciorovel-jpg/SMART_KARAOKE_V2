// Child process for the real restart test; no external metadata requests.
require("axios").get = async () => ({ data: { title: "Tema de reinicio" } });
const { server, io, stopTimers } = require("../../server");
server.listen(0, "127.0.0.1", () =>
  process.send({ port: server.address().port }),
);
process.on("message", (message) => {
  if (message === "stop") {
    stopTimers();
    io.close(() => process.exit(0));
  }
});
