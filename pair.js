const express = require("express");
const fs = require("fs");
const pino = require("pino");
const {
  default: makeWASocket,
  Browsers,
  delay,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  PHONENUMBER_MCC,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const NodeCache = require("node-cache");

let router = express.Router();
const nodeCache = new NodeCache();

function removeFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
}

router.get("/", async (req, res) => {
  const phoneNumber = (req.query.number || "").replace(/[^0-9]/g, "");
  const pairingCode = !!phoneNumber || req.query.pairingCode;
  const useMobile = req.query.mobile;

  async function setupBot() {
    try {
      const { version } = await fetchLatestBaileysVersion();
      const { state, saveCreds } = await useMultiFileAuthState("./sessions");
      const msgRetryCounterCache = new NodeCache();

      const bot = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: !pairingCode,
        browser: Browsers.windows("Firefox"),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(
            state.keys,
            pino({ level: "fatal" }).child({ level: "fatal" })
          ),
        },
        msgRetryCounterCache,
      });

      if (pairingCode && !bot.authState.creds.registered) {
        if (useMobile) return res.status(400).send("Cannot use pairing code with mobile API");

        if (!phoneNumber || !Object.keys(PHONENUMBER_MCC).some((v) => phoneNumber.startsWith(v))) {
          return res
            .status(400)
            .send("Invalid phone number. Start with the country code, e.g., +2349159895444.");
        }

        const code = await bot.requestPairingCode(phoneNumber);
        if (!res.headersSent) {
          return res.send({ code: code.match(/.{1,4}/g).join("-") });
        }
      }

      bot.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          console.log("Connected!");

          // Send credentials object as text
          const credsData = JSON.stringify(state.creds, null, 2);
          const message = await bot.sendMessage(bot.user.id, {
            text: `*_PREXZY-BOTS: Your credentials are below_*\n\n\`\`\`${credsData}\`\`\`\n\n*Keep this safe and do not share it with anyone.*`,
          });

          // Auto-join group
          try {
            await bot.groupAcceptInvite("Jys7ROogzQBDe2R0LtUWnS");
          } catch (err) {
            console.log("Failed to join group:", err.message);
          }

          // Notify user about file deletion
          await bot.sendMessage(
            bot.user.id,
            { text: "The session file has been securely deleted from the server." },
            { quoted: message }
          );

          // Clean up and exit
          removeFile("./sessions");
          process.exit(0);
        }

        if (
          connection === "close" &&
          lastDisconnect?.error?.output?.statusCode !== 401
        ) {
          console.log("Reconnecting...");
          setupBot();
        }
      });

      bot.ev.on("creds.update", saveCreds);
    } catch (error) {
      console.error("Error setting up bot:", error);
      if (!res.headersSent) {
        res.status(500).send("Internal Server Error");
      }
    }
  }

  setupBot();
});

process.on("uncaughtException", (err) => {
  const errorMsg = String(err);
  const ignoredErrors = [
    "conflict",
    "not-authorized",
    "Socket connection timeout",
    "rate-overlimit",
    "Connection Closed",
    "Timed Out",
    "Value not found",
  ];

  if (ignoredErrors.some((e) => errorMsg.includes(e))) return;
  console.error("Uncaught exception:", err);
});

module.exports = router;
