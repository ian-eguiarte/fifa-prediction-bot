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

const DEFAULT_APPS_SCRIPT_TIMEOUT_MS = 12000;
const APPS_SCRIPT_TIMEOUT_MS = getPositiveInteger(
  process.env.APPS_SCRIPT_TIMEOUT_MS,
  DEFAULT_APPS_SCRIPT_TIMEOUT_MS
);

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("error", (err) => {
  console.error("Discord client error:", err);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    if (interaction.commandName === "leaderboard") {
      await handleLeaderboardCommand(interaction);
      return;
    }

    if (interaction.commandName === "userpredictions") {
      await handleUserPredictionsCommand(interaction);
      return;
    }

    if (interaction.commandName === "setresult") {
      await handleSetResultCommand(interaction);
      return;
    }

    if (interaction.commandName !== "createprediction") {
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await safeInteractionReply(interaction, {
        content: "You need Manage Messages permission to create prediction polls.",
        flags: MessageFlags.Ephemeral
      }, {
        logLabel: "createprediction permission"
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

    await safeInteractionReply(
      interaction,
      `Created and linked prediction poll.\n\n` +
      `Match ID: ${matchId}\n` +
      `Poll Message ID: ${pollMessage.id}\n` +
      `Stage: ${stage}\n` +
      `Points: ${points}`,
      {
        logLabel: "createprediction success"
      }
    );

    console.log(`Created poll ${pollMessage.id} for ${matchId}`);
  } catch (err) {
    console.error(err);

    await safeInteractionReply(
      interaction,
      `Something went wrong while creating the prediction poll:\n${formatErrorForUser(err)}`,
      {
        logLabel: "createprediction error"
      }
    );
  }
  } catch (err) {
    console.error(`Unhandled error in /${interaction.commandName}:`, err);
    await safeInteractionReply(
      interaction,
      `Something went wrong while handling /${interaction.commandName}:\n${formatErrorForUser(err)}`,
      {
        logLabel: `${interaction.commandName} unhandled error`
      }
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

async function postToAppsScript(payload) {
  if (!process.env.APPS_SCRIPT_URL) {
    throw new Error("APPS_SCRIPT_URL is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPS_SCRIPT_TIMEOUT_MS);

  try {
    const response = await fetch(process.env.APPS_SCRIPT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();
    let result;

    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(`Apps Script returned invalid JSON: ${truncateForDiscord(text)}`);
    }

    if (!response.ok || !result.ok) {
      const error = new Error(result.error || truncateForDiscord(text));
      error.appsScriptResult = result;
      throw error;
    }

    return result;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(
        `Apps Script request timed out after ${Math.round(APPS_SCRIPT_TIMEOUT_MS / 1000)} seconds.`
      );
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendCreatedMatchToSheet(data) {
  const payload = {
    secret: process.env.SHEET_SECRET,
    action: "create_match",
    ...data
  };

  return postToAppsScript(payload);
}

async function setResultOnSheet(matchId, result) {
  const payload = {
    secret: process.env.SHEET_SECRET,
    action: "set_result",
    match_id: matchId,
    result: result
  };

  return postToAppsScript(payload);
}

async function handleSetResultCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await safeInteractionReply(interaction, {
      content: "You need Manage Messages permission to set match results.",
      flags: MessageFlags.Ephemeral
    }, {
      logLabel: "setresult permission"
    });
    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const matchId = interaction.options.getString("match_id", true).trim();
    const result = interaction.options.getString("result", true).trim();

    const response = await setResultOnSheet(matchId, result);

    const message = response.correct_answer
      ? `Set result for **${matchId}** to **${response.correct_answer}**.\n` +
        `Scores and the leaderboard will update automatically.`
      : `Cleared the result for **${matchId}**. Those predictions are pending again.`;

    await safeInteractionReply(interaction, message, {
      logLabel: "setresult success"
    });

    console.log(`Set result for ${matchId}: ${response.correct_answer || "(cleared)"}`);
  } catch (err) {
    console.error(err);

    const validOptions = err.appsScriptResult?.valid_options;
    const optionsHint =
      Array.isArray(validOptions) && validOptions.length
        ? `\nValid options for this match: ${validOptions.join(", ")}`
        : "";

    await safeInteractionReply(
      interaction,
      `Could not set the result:\n${formatErrorForUser(err)}${optionsHint}`,
      {
        logLabel: "setresult error"
      }
    );
  }
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
    const result = await postToAppsScript(payload);

    console.log(`${action}: ${username} voted answer ${data.answer_id}`);
    console.log(result);
  } catch (err) {
    console.log("Failed to send vote to Google Sheets:", err.message);
  }
}

async function handleLeaderboardCommand(interaction) {
    await interaction.deferReply();
  
    try {
      const count = interaction.options.getInteger("count") ?? 10;
      const leaderboard = await getLeaderboardFromSheet(count);
  
      if (!leaderboard.length) {
        await safeInteractionReply(interaction, "No leaderboard data found yet.", {
          logLabel: "leaderboard empty"
        });
        return;
      }
  
      const perPage = 10;
      let page = 0;
      const totalPages = Math.ceil(leaderboard.length / perPage);
  
      const prevId = `leaderboard_prev_${interaction.id}`;
      const nextId = `leaderboard_next_${interaction.id}`;
  
      const message = await safeInteractionReply(interaction, {
        content: formatLeaderboardPage(leaderboard, page, perPage, totalPages),
        components: [makeLeaderboardButtons(page, totalPages, prevId, nextId)]
      }, {
        logLabel: "leaderboard response"
      });
      if (!message) {
        return;
      }
  
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
  
      collector.on("collect", (buttonInteraction) => {
        void (async () => {
          if (buttonInteraction.user.id !== interaction.user.id) {
            await safeButtonNotice(
              buttonInteraction,
              "Only the person who ran this command can use these buttons.",
              "leaderboard collector"
            );
            return;
          }

          if (buttonInteraction.customId === prevId && page > 0) {
            page--;
          }

          if (buttonInteraction.customId === nextId && page < totalPages - 1) {
            page++;
          }

          await safeButtonUpdate(
            buttonInteraction,
            {
              content: formatLeaderboardPage(leaderboard, page, perPage, totalPages),
              components: [makeLeaderboardButtons(page, totalPages, prevId, nextId)]
            },
            "leaderboard collector"
          );
        })().catch(async (err) => {
          console.log(`leaderboard collector failed: ${formatErrorForLog(err)}`);
          await safeButtonNotice(
            buttonInteraction,
            "I could not update that leaderboard page. Please run /leaderboard again.",
            "leaderboard collector"
          );
        });
      });
  
      collector.on("end", () => {
        void safeMessageEdit(
          message,
          {
            content: formatLeaderboardPage(leaderboard, page, perPage, totalPages),
            components: [makeLeaderboardButtons(page, totalPages, prevId, nextId, true)]
          },
          "leaderboard collector end"
        );
      });
    } catch (err) {
      console.error(err);
  
      await safeInteractionReply(
        interaction,
        `Something went wrong while getting the leaderboard:\n${formatErrorForUser(err)}`,
        {
          logLabel: "leaderboard error"
        }
      );
    }
  }
  
  async function getLeaderboardFromSheet(limit) {
    const payload = {
      secret: process.env.SHEET_SECRET,
      action: "get_leaderboard",
      limit: limit
    };
  
    const result = await postToAppsScript(payload);
  
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
  
    const result = await postToAppsScript(payload);
  
    return result.predictions || [];
  }

  async function handleUserPredictionsCommand(interaction) {
    await interaction.deferReply();
  
    try {
      const targetUser = interaction.options.getUser("user", true);
      const filters = {
        stage: interaction.options.getString("stage"),
        group: interaction.options.getString("group"),
        team: interaction.options.getString("team"),
        day: interaction.options.getString("day")
      };

      const allPredictions = await getUserPredictionsFromSheet(targetUser.id);

      if (!allPredictions.length) {
        await safeInteractionReply(
          interaction,
          `No predictions found for **${targetUser.username}**.`,
          {
            logLabel: "userpredictions empty"
          }
        );
        return;
      }

      const rows = filterPredictions(allPredictions, filters);
      const filterLabel = describeFilters(filters);

      if (!rows.length) {
        await safeInteractionReply(
          interaction,
          `No predictions for **${targetUser.username}** match those filters ` +
          `(${filterLabel}).\n` +
          `${allPredictions.length} total predictions exist — try loosening the filters.`,
          {
            logLabel: "userpredictions no match"
          }
        );
        return;
      }

      const perPage = 5;
      let page = 0;
      const totalPages = Math.ceil(rows.length / perPage);

      const prevId = `userpredictions_prev_${interaction.id}`;
      const nextId = `userpredictions_next_${interaction.id}`;

      const message = await safeInteractionReply(interaction, {
        content: formatUserPredictionsPage(
          targetUser,
          rows,
          page,
          perPage,
          totalPages,
          filterLabel
        ),
        components: [
          makeUserPredictionsButtons(page, totalPages, prevId, nextId)
        ]
      }, {
        logLabel: "userpredictions response"
      });
      if (!message) {
        return;
      }
  
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
  
      collector.on("collect", (buttonInteraction) => {
        void (async () => {
          if (buttonInteraction.user.id !== interaction.user.id) {
            await safeButtonNotice(
              buttonInteraction,
              "Only the person who ran this command can use these buttons.",
              "userpredictions collector"
            );
            return;
          }

          if (buttonInteraction.customId === prevId && page > 0) {
            page--;
          }

          if (buttonInteraction.customId === nextId && page < totalPages - 1) {
            page++;
          }

          await safeButtonUpdate(
            buttonInteraction,
            {
              content: formatUserPredictionsPage(
                targetUser,
                rows,
                page,
                perPage,
                totalPages,
                filterLabel
              ),
              components: [
                makeUserPredictionsButtons(page, totalPages, prevId, nextId)
              ]
            },
            "userpredictions collector"
          );
        })().catch(async (err) => {
          console.log(`userpredictions collector failed: ${formatErrorForLog(err)}`);
          await safeButtonNotice(
            buttonInteraction,
            "I could not update that predictions page. Please run /userpredictions again.",
            "userpredictions collector"
          );
        });
      });
  
      collector.on("end", () => {
        void safeMessageEdit(
          message,
          {
            content: formatUserPredictionsPage(
              targetUser,
              rows,
              page,
              perPage,
              totalPages,
              filterLabel
            ),
            components: [
              makeUserPredictionsButtons(page, totalPages, prevId, nextId, true)
            ]
          },
          "userpredictions collector end"
        );
      });
    } catch (err) {
      console.error(err);
  
      await safeInteractionReply(
        interaction,
        `Something went wrong while getting that user's predictions:\n${formatErrorForUser(err)}`,
        {
          logLabel: "userpredictions error"
        }
      );
    }
  }
  
  function getMatchGroup(matchId) {
    // Group-stage ids look like "A-M1" (single-letter prefix); knockout ids
    // look like "R16-M2", "QF-M1", etc. Only the former map to a group.
    const prefix = String(matchId || "").split("-")[0].trim().toUpperCase();
    return /^[A-Z]$/.test(prefix) ? prefix : "";
  }

  function filterPredictions(predictions, filters) {
    const teamNeedle = filters.team ? filters.team.trim().toLowerCase() : null;
    const dayNeedle = filters.day ? filters.day.trim() : null;
    const groupNeedle = filters.group ? filters.group.trim().toUpperCase() : null;

    return predictions.filter((p) => {
      if (filters.stage && p.stage !== filters.stage) {
        return false;
      }

      if (groupNeedle && getMatchGroup(p.match_id) !== groupNeedle) {
        return false;
      }

      if (teamNeedle) {
        const teamA = String(p.team_a || "").toLowerCase();
        const teamB = String(p.team_b || "").toLowerCase();
        if (!teamA.includes(teamNeedle) && !teamB.includes(teamNeedle)) {
          return false;
        }
      }

      if (dayNeedle) {
        // kickoff_time is a display string like "2026-06-11 15:00:00".
        const kickoffDay = String(p.kickoff_time || "").slice(0, 10);
        if (kickoffDay !== dayNeedle) {
          return false;
        }
      }

      return true;
    });
  }

  function describeFilters(filters) {
    const parts = [];

    if (filters.stage) parts.push(`stage: ${filters.stage}`);
    if (filters.group) parts.push(`group: ${filters.group.toUpperCase()}`);
    if (filters.team) parts.push(`team: ${filters.team}`);
    if (filters.day) parts.push(`day: ${filters.day}`);

    return parts.length ? parts.join(" • ") : "all predictions";
  }

  function formatUserPredictionsPage(user, predictions, page, perPage, totalPages, filterLabel) {
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
      `Filter: ${filterLabel || "all predictions"}\n` +
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

  function getPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function normalizeMessageOptions(contentOrOptions) {
    if (typeof contentOrOptions === "string") {
      return {
        content: contentOrOptions
      };
    }

    return {
      ...contentOrOptions
    };
  }

  function truncateForDiscord(value, maxLength = 1500) {
    const text = String(value ?? "Unknown error");

    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
  }

  function formatErrorForUser(err) {
    return truncateForDiscord(err?.message || err);
  }

  function formatErrorForLog(err) {
    if (err?.code) {
      return `${err.code}: ${err.message}`;
    }

    return err?.message || String(err);
  }

  function makeChannelFallbackOptions(interaction, contentOrOptions) {
    const {
      flags,
      ephemeral,
      content,
      allowedMentions,
      ...channelOptions
    } = normalizeMessageOptions(contentOrOptions);
    const prefix = `Fallback response for /${interaction.commandName}:\n`;

    return {
      ...channelOptions,
      content: truncateForDiscord(`${prefix}${content || ""}`, 2000),
      allowedMentions: {
        parse: [],
        ...allowedMentions
      }
    };
  }

  async function safeInteractionReply(interaction, contentOrOptions, options = {}) {
    const {
      allowChannelFallback = true,
      logLabel = interaction.commandName || "interaction"
    } = options;
    const messageOptions = normalizeMessageOptions(contentOrOptions);

    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.editReply(messageOptions);
      }

      return await interaction.reply(messageOptions);
    } catch (err) {
      console.log(`${logLabel}: interaction reply failed: ${formatErrorForLog(err)}`);
    }

    if (!allowChannelFallback) {
      return null;
    }

    try {
      return await interaction.channel.send(
        makeChannelFallbackOptions(interaction, messageOptions)
      );
    } catch (sendErr) {
      console.log(`${logLabel}: fallback channel send failed: ${formatErrorForLog(sendErr)}`);
      return null;
    }
  }

  async function safeMessageEdit(message, contentOrOptions, logLabel) {
    try {
      return await message.edit(normalizeMessageOptions(contentOrOptions));
    } catch (err) {
      console.log(`${logLabel}: message edit failed: ${formatErrorForLog(err)}`);
      return null;
    }
  }

  async function safeButtonNotice(buttonInteraction, content, logLabel) {
    const payload = {
      content,
      flags: MessageFlags.Ephemeral
    };

    try {
      if (buttonInteraction.deferred || buttonInteraction.replied) {
        await buttonInteraction.followUp(payload);
      } else {
        await buttonInteraction.reply(payload);
      }
    } catch (err) {
      console.log(`${logLabel}: button notice failed: ${formatErrorForLog(err)}`);
    }
  }

  async function safeButtonUpdate(buttonInteraction, contentOrOptions, logLabel) {
    try {
      await buttonInteraction.update(normalizeMessageOptions(contentOrOptions));
      return true;
    } catch (err) {
      console.log(`${logLabel}: button update failed: ${formatErrorForLog(err)}`);
      await safeButtonNotice(
        buttonInteraction,
        "That button interaction expired. Run the command again if you need a fresh view.",
        logLabel
      );
      return false;
    }
  }

client.login(process.env.DISCORD_TOKEN);
