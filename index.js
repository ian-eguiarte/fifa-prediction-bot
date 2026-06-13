require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    Events,
    PermissionFlagsBits,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType
  } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessagePolls
  ]
});

const DEFAULT_POINTS = {
  Group: 2,
  "Round of 32": 3,
  "Round of 16": 3,
  Quarterfinal: 4,
  Semifinal: 5,
  Final: 7
};

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === "leaderboard") {
    await handleLeaderboardCommand(interaction);
    return;
  }

  if (interaction.commandName === "userpredictions") {
    await handleUserPredictionsCommand(interaction);
    return;
  }
  
  if (interaction.commandName !== "createprediction") {
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: "You need Manage Messages permission to create prediction polls.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const matchId = interaction.options.getString("match_id", true).trim();
    const teamA = interaction.options.getString("team_a", true).trim();
    const teamB = interaction.options.getString("team_b", true).trim();
    const stage = interaction.options.getString("stage", true);
    const kickoff = interaction.options.getString("kickoff", true).trim();
    const durationHours = interaction.options.getInteger("duration_hours") ?? 24;
    const points = interaction.options.getInteger("points") ?? DEFAULT_POINTS[stage] ?? 2;

    const isGroupStage = stage === "Group";

    const question = isGroupStage
      ? `${matchId}: ${teamA} vs ${teamB} — who wins?`
      : `${matchId}: ${teamA} vs ${teamB} — who advances?`;

    const answerTexts = isGroupStage
      ? [teamA, "Draw", teamB]
      : [`${teamA} advances`, `${teamB} advances`];

    validatePollText(question, answerTexts);

    const pollMessage = await interaction.channel.send({
      poll: {
        question: {
          text: question
        },
        answers: answerTexts.map((answer) => ({
          text: answer
        })),
        duration: durationHours,
        allowMultiselect: false,
        layoutType: 1
      }
    });

    await sendCreatedMatchToSheet({
      match_id: matchId,
      stage: stage,
      kickoff_time: kickoff,
      team_a: teamA,
      team_b: teamB,
      points: points,
      poll_message_id: pollMessage.id,
      answer_1: answerTexts[0] || "",
      answer_2: answerTexts[1] || "",
      answer_3: answerTexts[2] || ""
    });

    await interaction.editReply(
      `Created and linked prediction poll.\n\n` +
      `Match ID: ${matchId}\n` +
      `Poll Message ID: ${pollMessage.id}\n` +
      `Stage: ${stage}\n` +
      `Points: ${points}`
    );

    console.log(`Created poll ${pollMessage.id} for ${matchId}`);
  } catch (err) {
    console.error(err);

    await interaction.editReply(
      `Something went wrong while creating the prediction poll:\n${err.message}`
    );
  }
});

client.on("raw", async (packet) => {
  if (packet.t === "MESSAGE_POLL_VOTE_ADD") {
    await sendVoteToSheet("vote_added", packet.d);
  }

  if (packet.t === "MESSAGE_POLL_VOTE_REMOVE") {
    await sendVoteToSheet("vote_removed", packet.d);
  }
});

function validatePollText(question, answers) {
  if (question.length > 300) {
    throw new Error("Poll question is too long. Discord allows up to 300 characters.");
  }

  for (const answer of answers) {
    if (answer.length > 55) {
      throw new Error(`Poll answer is too long: "${answer}". Discord allows up to 55 characters.`);
    }
  }
}

async function sendCreatedMatchToSheet(data) {
  const payload = {
    secret: process.env.SHEET_SECRET,
    action: "create_match",
    ...data
  };

  const response = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  let result;

  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned invalid JSON: ${text}`);
  }

  if (!response.ok || !result.ok) {
    throw new Error(result.error || text);
  }

  return result;
}

async function sendVoteToSheet(action, data) {
  let username = data.user_id;

  try {
    const user = await client.users.fetch(data.user_id);
    username = user.globalName || user.username;
  } catch (err) {
    console.log("Could not fetch username:", err.message);
  }

  const payload = {
    secret: process.env.SHEET_SECRET,
    action: action,
    user_id: data.user_id,
    username: username,
    guild_id: data.guild_id || "",
    channel_id: data.channel_id,
    message_id: data.message_id,
    answer_id: data.answer_id
  };

  try {
    const response = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    console.log(`${action}: ${username} voted answer ${data.answer_id}`);
    console.log(text);
  } catch (err) {
    console.log("Failed to send vote to Google Sheets:", err.message);
  }
}

async function handleLeaderboardCommand(interaction) {
    await interaction.deferReply();
  
    try {
      const count = interaction.options.getInteger("count") ?? 200;
      const leaderboard = await getLeaderboardFromSheet(count);
  
      if (!leaderboard.length) {
        await interaction.editReply("No leaderboard data found yet.");
        return;
      }
  
      const perPage = 10;
      let page = 0;
      const totalPages = Math.ceil(leaderboard.length / perPage);
  
      const prevId = `leaderboard_prev_${interaction.id}`;
      const nextId = `leaderboard_next_${interaction.id}`;
  
      const message = await interaction.editReply({
        content: formatLeaderboardPage(leaderboard, page, perPage, totalPages),
        components: [makeLeaderboardButtons(page, totalPages, prevId, nextId)]
      });
  
      if (totalPages <= 1) {
        return;
      }
  
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 120000,
        filter: (buttonInteraction) =>
          buttonInteraction.customId === prevId ||
          buttonInteraction.customId === nextId
      });
  
      collector.on("collect", async (buttonInteraction) => {
        if (buttonInteraction.customId === prevId && page > 0) {
          page--;
        }
  
        if (buttonInteraction.customId === nextId && page < totalPages - 1) {
          page++;
        }
  
        await buttonInteraction.update({
          content: formatLeaderboardPage(leaderboard, page, perPage, totalPages),
          components: [makeLeaderboardButtons(page, totalPages, prevId, nextId)]
        });
      });
  
      collector.on("end", async () => {
        try {
          await interaction.editReply({
            content: formatLeaderboardPage(leaderboard, page, perPage, totalPages),
            components: [makeLeaderboardButtons(page, totalPages, prevId, nextId, true)]
          });
        } catch (err) {
          console.log("Could not disable leaderboard buttons:", err.message);
        }
      });
    } catch (err) {
      console.error(err);
  
      await interaction.editReply(
        `Something went wrong while getting the leaderboard:\n${err.message}`
      );
    }
  }
  
  async function getLeaderboardFromSheet(limit) {
    const payload = {
      secret: process.env.SHEET_SECRET,
      action: "get_leaderboard",
      limit: limit
    };
  
    const response = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  
    const text = await response.text();
  
    let result;
  
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`Apps Script returned invalid JSON: ${text}`);
    }
  
    if (!response.ok || !result.ok) {
      throw new Error(result.error || text);
    }
  
    return result.leaderboard || [];
  }
  
  function formatLeaderboardPage(leaderboard, page, perPage, totalPages) {
    const start = page * perPage;
    const end = start + perPage;
    const pageRows = leaderboard.slice(start, end);
  
    const lines = pageRows.map((row) => {
      let rank = `${row.rank}.`;
  
      if (row.rank === 1) {
        rank = "🥇";
      } else if (row.rank === 2) {
        rank = "🥈";
      } else if (row.rank === 3) {
        rank = "🥉";
      }
  
      return `${rank} **${row.username}** — ${row.points} pts | ${row.correct} correct | ${row.predictions} predictions`;
    });
  
    return (
      `🏆 **FIFA Prediction Leaderboard**\n` +
      `Page ${page + 1}/${totalPages} • Showing ${leaderboard.length} players\n\n` +
      lines.join("\n")
    );
  }
  
  function makeLeaderboardButtons(page, totalPages, prevId, nextId, disabled = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(prevId)
        .setLabel("Previous")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === 0),
  
      new ButtonBuilder()
        .setCustomId(nextId)
        .setLabel("Next")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page >= totalPages - 1)
    );
  }
  
  async function getUserPredictionsFromSheet(userId) {
    const payload = {
      secret: process.env.SHEET_SECRET,
      action: "get_user_predictions",
      user_id: userId
    };
  
    const response = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  
    const text = await response.text();
  
    let result;
  
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`Apps Script returned invalid JSON: ${text}`);
    }
  
    if (!response.ok || !result.ok) {
      throw new Error(result.error || text);
    }
  
    return result.predictions || [];
  }

  async function handleUserPredictionsCommand(interaction) {
    await interaction.deferReply();
  
    try {
      const targetUser = interaction.options.getUser("user", true);
      const predictions = await getUserPredictionsFromSheet(targetUser.id);
  
      if (!predictions.length) {
        await interaction.editReply(
          `No predictions found for **${targetUser.username}**.`
        );
        return;
      }
  
      const perPage = 5;
      let page = 0;
      const totalPages = Math.ceil(predictions.length / perPage);
  
      const prevId = `userpredictions_prev_${interaction.id}`;
      const nextId = `userpredictions_next_${interaction.id}`;
  
      const message = await interaction.editReply({
        content: formatUserPredictionsPage(
          targetUser,
          predictions,
          page,
          perPage,
          totalPages
        ),
        components: [
          makeUserPredictionsButtons(page, totalPages, prevId, nextId)
        ]
      });
  
      if (totalPages <= 1) {
        return;
      }
  
      const collector = message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 120000
      });
  
      collector.on("collect", async (buttonInteraction) => {
        if (
          buttonInteraction.customId !== prevId &&
          buttonInteraction.customId !== nextId
        ) {
          return;
        }
  
        if (buttonInteraction.user.id !== interaction.user.id) {
          await buttonInteraction.reply({
            content: "Only the person who ran this command can use these buttons.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }
  
        if (buttonInteraction.customId === prevId && page > 0) {
          page--;
        }
  
        if (buttonInteraction.customId === nextId && page < totalPages - 1) {
          page++;
        }
  
        await buttonInteraction.update({
          content: formatUserPredictionsPage(
            targetUser,
            predictions,
            page,
            perPage,
            totalPages
          ),
          components: [
            makeUserPredictionsButtons(page, totalPages, prevId, nextId)
          ]
        });
      });
  
      collector.on("end", async () => {
        try {
          await interaction.editReply({
            content: formatUserPredictionsPage(
              targetUser,
              predictions,
              page,
              perPage,
              totalPages
            ),
            components: [
              makeUserPredictionsButtons(page, totalPages, prevId, nextId, true)
            ]
          });
        } catch (err) {
          console.log("Could not disable user prediction buttons:", err.message);
        }
      });
    } catch (err) {
      console.error(err);
  
      await interaction.editReply(
        `Something went wrong while getting that user's predictions:\n${err.message}`
      );
    }
  }
  
  function formatUserPredictionsPage(user, predictions, page, perPage, totalPages) {
    const start = page * perPage;
    const end = start + perPage;
    const pageRows = predictions.slice(start, end);
  
    const lines = pageRows.map((row) => {
      let icon = "⏳";
  
      if (row.result === "correct") {
        icon = "✅";
      } else if (row.result === "wrong") {
        icon = "❌";
      }
  
      const matchup = row.team_a && row.team_b
        ? `${row.team_a} vs ${row.team_b}`
        : row.match_id;
  
      const resultText = row.correct_answer
        ? `Correct answer: ${row.correct_answer}`
        : "Result: Pending";
  
      return (
        `${icon} **${row.match_id}: ${matchup}**\n` +
        `Prediction: ${row.prediction}\n` +
        `${resultText}\n` +
        `Points: ${row.points}`
      );
    });
  
    return (
      `📋 **Predictions for ${user.username}**\n` +
      `Page ${page + 1}/${totalPages} • Showing ${predictions.length} predictions\n\n` +
      lines.join("\n\n")
    );
  }
  
  function makeUserPredictionsButtons(page, totalPages, prevId, nextId, disabled = false) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(prevId)
        .setLabel("Previous")
        .setEmoji("⬅️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === 0),
  
      new ButtonBuilder()
        .setCustomId(nextId)
        .setLabel("Next")
        .setEmoji("➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page >= totalPages - 1)
    );
  }

client.login(process.env.DISCORD_TOKEN);