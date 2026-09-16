"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  REST,
  Routes
} = require("discord.js");

const token =
  process.env.DISCORD_TOKEN;

const clientId =
  process.env.CLIENT_ID;

const guildId =
  process.env.GUILD_ID;

if (!token) {
  throw new Error(
    "❌ DISCORD_TOKEN is missing."
  );
}

if (!clientId) {
  throw new Error(
    "❌ CLIENT_ID is missing."
  );
}

if (!guildId) {
  throw new Error(
    "❌ GUILD_ID is missing."
  );
}

const commandsPath =
  path.join(
    __dirname,
    "commands"
  );

if (
  !fs.existsSync(commandsPath)
) {
  throw new Error(
    "❌ commands folder does not exist."
  );
}

const commands = [];
const names = new Set();

const files =
  fs
    .readdirSync(commandsPath)
    .filter(
      file =>
        file.endsWith(".js") &&
        file !== "index.js"
    );

for (const file of files) {
  const fullPath =
    path.join(
      commandsPath,
      file
    );

  try {
    const command =
      require(fullPath);

    if (
      !command?.data ||
      !command?.execute
    ) {
      continue;
    }

    const data =
      command.data.toJSON();

    if (!data.name) {
      continue;
    }

    const name =
      data.name.toLowerCase();

    if (names.has(name)) {
      throw new Error(
        `❌ Duplicate command found: /${name} in ${file}`
      );
    }

    names.add(name);
    commands.push(data);

  } catch (error) {
    console.error(
      `❌ Failed loading ${file}:`,
      error
    );

    process.exit(1);
  }
}

console.log(
  `📦 Found ${commands.length} unique commands.`
);

console.log(
  "🧹 Removing ALL old global commands..."
);

const rest =
  new REST({
    version: "10"
  }).setToken(
    token
  );

(async () => {
  try {

    // ========================================================
    // 1. DELETE ALL GLOBAL COMMANDS
    // ========================================================

    await rest.put(
      Routes.applicationCommands(
        clientId
      ),
      {
        body: []
      }
    );

    console.log(
      "✅ All global commands removed."
    );

    // ========================================================
    // 2. DELETE ALL OLD GUILD COMMANDS
    // ========================================================

    await rest.put(
      Routes.applicationGuildCommands(
        clientId,
        guildId
      ),
      {
        body: []
      }
    );

    console.log(
      "✅ All old GMAO guild commands removed."
    );

    // ========================================================
    // 3. REGISTER EXACTLY ONE COPY
    // ========================================================

    await rest.put(
      Routes.applicationGuildCommands(
        clientId,
        guildId
      ),
      {
        body: commands
      }
    );

    console.log("");
    console.log(
      "════════════════════════════════════"
    );
    console.log(
      `✅ Registered ${commands.length} commands`
    );
    console.log(
      "✅ Registered ONLY to GMAO guild"
    );
    console.log(
      "❌ No global commands"
    );
    console.log(
      "❌ No duplicate command set"
    );
    console.log(
      "════════════════════════════════════"
    );
    console.log("");

  } catch (error) {
    console.error(
      "❌ Command deployment failed:"
    );

    console.error(error);

    process.exit(1);
  }
})();
