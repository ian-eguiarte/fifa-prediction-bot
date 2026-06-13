require("dotenv").config();

const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("createprediction")
    .setDescription("Create a FIFA prediction poll and connect it to Google Sheets.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)

    .addStringOption((option) =>
      option
        .setName("match_id")
        .setDescription("Example: A-M3, B-M1, R16-M2")
        .setRequired(true)
    )

    .addStringOption((option) =>
      option
        .setName("team_a")
        .setDescription("First team")
        .setRequired(true)
    )

    .addStringOption((option) =>
      option
        .setName("team_b")
        .setDescription("Second team")
        .setRequired(true)
    )

    .addStringOption((option) =>
      option
        .setName("stage")
        .setDescription("Match stage")
        .setRequired(true)
        .addChoices(
          { name: "Group", value: "Group" },
          { name: "Round of 32", value: "Round of 32" },
          { name: "Round of 16", value: "Round of 16" },
          { name: "Quarterfinal", value: "Quarterfinal" },
          { name: "Semifinal", value: "Semifinal" },
          { name: "Final", value: "Final" }
        )
    )

    .addStringOption((option) =>
      option
        .setName("kickoff")
        .setDescription("Use format YYYY-MM-DD HH:mm, example: 2026-06-13 15:00")
        .setRequired(true)
    )

    .addIntegerOption((option) =>
      option
        .setName("duration_hours")
        .setDescription("How many hours the poll stays open. Default: 24")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(768)
    )

    .addIntegerOption((option) =>
      option
        .setName("points")
        .setDescription("Optional custom points for this match")
        .setRequired(false)
        .setMinValue(0)
        .setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the current FIFA prediction leaderboard.")
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("How many users to show. Default: 10")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(200)
    ),

  new SlashCommandBuilder()
    .setName("userpredictions")
    .setDescription("Show what a specific user predicted for each match.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The user to check")
        .setRequired(true)
    )
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  try {
    console.log("Registering slash commands...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID
      ),
      { body: commands }
    );

    console.log("Slash commands registered.");
  } catch (err) {
    console.error(err);
  }
}

main();