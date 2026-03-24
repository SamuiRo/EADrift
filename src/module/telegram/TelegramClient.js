import os from "os";
import input from "input";
import { TelegramClient as MTProtoClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import {
    TELEGRAM_SESSION_STRING,
  TELEGRAM_API_ID,
  TELEGRAM_API_HASH,
  PKG,
} from "../../config/app.config.js";
import { print } from "../../shared/utils.js";

class TelegramClient {
  constructor() {
    this.string_session = new StringSession(TELEGRAM_SESSION_STRING);
    this.client = null;
    this.isConnected = false;
    this.client_options = {
      deviceModel: `${PKG.name}@${os.hostname()}`,
      systemVersion: os.version() || "Inemuri Unknown Node",
      appVersion: PKG.version,
      useWSS: true, // not sure if it works in node at all
      testServers: false, // this one should be the default for node env, but who knows for sure :)
      connectionRetries: 5,
    };
  }

  async connect() {
    if (this.isConnected) {
      print("Telegram client already connected", "warning");
      return this.client;
    }

    try {
      print("Connecting to Telegram...");

      this.client = new MTProtoClient(
        this.string_session,
        TELEGRAM_API_ID,
        TELEGRAM_API_HASH,
        this.client_options,
      );

      await this.client.start({
        phoneNumber: async () => await input.text("Phone number: "),
        password: async () => await input.text("Password (if enabled): "),
        phoneCode: async () => await input.text("Verification code: "),
        onError: (error) => {
          print(`Authentication error: ${error.message}`, "error");
          console.error(error);
        },
      });

      this.isConnected = true;
      print("Telegram client connected successfully", "success");

      // Зберігаємо сесію для наступних запусків
      const sessionString = this.client.session.save();
      if (sessionString !== TELEGRAM_SESSION_STRING) {
        print("New session string generated. Save it to .env:", "warning");
        console.log(sessionString);
      }

      return this.client;
    } catch (error) {
      print(`Failed to connect to Telegram: ${error.message}`, "error");
      console.error(error);
      throw error;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
      print("Telegram client disconnected");
    }
  }

  getClient() {
    if (!this.isConnected || !this.client) {
      throw new Error(
        "Telegram client is not connected. Call connect() first.",
      );
    }
    return this.client;
  }
}

const telegramClient = new TelegramClient();
export default telegramClient;
