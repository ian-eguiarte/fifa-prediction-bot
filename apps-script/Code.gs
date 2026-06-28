/**
 * FIFA Prediction Bot — Google Apps Script web app.
 *
 * Receives JSON POSTs from the Discord bot (index.js / importPoll.js) and
 * mutates the backing spreadsheet:
 *   - PollMap            poll_message_id, match_id, answer_1..3
 *   - Matches            match_id, stage, kickoff_time, team_a, team_b, correct_answer, points
 *   - PredictionLog      append-only audit log of every vote event
 *   - CurrentPredictions one row per (user, match); cols I/J are SCORE FORMULAS
 *
 * IMPORTANT: columns I (points) and J (correct) on CurrentPredictions are
 * spreadsheet formulas. This script writes rows of width 8 (A..H) ONLY, so the
 * score formulas in I/J are never clobbered. Do not widen the writes.
 */

// Prefer a Script Property so the secret need not live in source control.
// In the Apps Script editor: Project Settings > Script Properties >
// add SHEET_SECRET. The literal fallback keeps existing deploys working until
// you migrate; once the property is set, delete the fallback (and rotate the
// secret, since it has been shared in plaintext).
const SECRET =
  PropertiesService.getScriptProperties().getProperty("SHEET_SECRET") ||
  "t0j1F13nd!";

// CurrentPredictions / PollMap layout — keep these widths in sync with the sheet.
const PRED_WRITE_WIDTH = 8; // A..H; I/J are formula columns, never written here.

function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== SECRET) {
      return jsonResponse({ ok: false, error: "Bad secret" });
    }

    // Read-only actions: no lock needed.
    if (body.action === "get_leaderboard") {
      return getLeaderboard(ss, body);
    }

    if (body.action === "get_user_predictions") {
      return getUserPredictions(ss, body);
    }

    // Everything below mutates the spreadsheet. Apps Script can run doPost
    // concurrently, and read-modify-write on shared sheets races without a
    // lock (lost updates, duplicate rows). Serialize the mutating section.
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(20000);
    } catch (lockErr) {
      return jsonResponse({
        ok: false,
        error: "Busy, could not acquire lock. Please retry."
      });
    }

    try {
      if (body.action === "create_match") {
        return createMatchAndPollMap(ss, body);
      }

      if (body.action === "set_result") {
        return setMatchResult(ss, body);
      }

      return handleVote(ss, body);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: String(err)
    });
  }
}

function handleVote(ss, body) {
  const pollInfo = getPollInfo(ss, body.message_id);
  const matchId = pollInfo.match_id;
  const answerText =
    pollInfo[`answer_${body.answer_id}`] || String(body.answer_id);

  const logSheet = mustGetSheet(ss, "PredictionLog");

  logSheet.appendRow([
    new Date(),
    body.action,
    body.user_id,
    body.username,
    body.guild_id,
    body.channel_id,
    body.message_id,
    matchId,
    body.answer_id,
    answerText
  ]);

  if (!matchId) {
    return jsonResponse({
      ok: false,
      error: "Poll message ID was not found in PollMap"
    });
  }

  const isImport = body.action === "import_vote";

  if (!isImport && isMatchLocked(ss, matchId)) {
    return jsonResponse({
      ok: true,
      ignored: true,
      reason: "Match already locked"
    });
  }

  updateCurrentPrediction(ss, body, matchId, answerText);

  return jsonResponse({
    ok: true,
    match_id: matchId,
    answer: answerText
  });
}

function mustGetSheet(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error(`Sheet "${name}" not found`);
  }
  return sheet;
}

function getPollInfo(ss, pollMessageId) {
  const sheet = mustGetSheet(ss, "PollMap");
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    if (String(row[0]) === String(pollMessageId)) {
      return {
        match_id: row[1],
        answer_1: row[2],
        answer_2: row[3],
        answer_3: row[4]
      };
    }
  }

  return {
    match_id: "",
    answer_1: "",
    answer_2: "",
    answer_3: ""
  };
}

function isMatchLocked(ss, matchId) {
  const sheet = mustGetSheet(ss, "Matches");
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    if (String(row[0]) === String(matchId)) {
      const kickoff = new Date(row[2]);

      if (isNaN(kickoff.getTime())) {
        return false;
      }

      return new Date() >= kickoff;
    }
  }

  return false;
}

/**
 * Earliest-seen username per user_id, from PredictionLog.
 * Reads only columns C (user_id) and D (username) instead of the whole sheet.
 */
function getCanonicalUsernameMap(ss) {
  const logSheet = mustGetSheet(ss, "PredictionLog");
  const lastRow = logSheet.getLastRow();
  const names = {};

  if (lastRow < 2) {
    return names;
  }

  // Columns 3..4 (user_id, username), skipping the header row.
  const values = logSheet.getRange(2, 3, lastRow - 1, 2).getValues();

  for (let i = 0; i < values.length; i++) {
    const userId = String(values[i][0] || "");
    const username = values[i][1];

    if (userId && username && !names[userId]) {
      names[userId] = username;
    }
  }

  return names;
}

function getCanonicalUsername(ss, userId, fallbackUsername, canonicalNames) {
  const names = canonicalNames || getCanonicalUsernameMap(ss);
  const key = String(userId || "");

  return names[key] || fallbackUsername || key;
}

function updateCurrentPrediction(ss, body, matchId, answerText) {
  const sheet = mustGetSheet(ss, "CurrentPredictions");
  const values = sheet.getDataRange().getValues();

  let existingRow = -1;

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    const sameUser = String(row[0]) === String(body.user_id);
    const sameMatch = String(row[2]) === String(matchId);

    if (sameUser && sameMatch) {
      existingRow = i + 1;
      break;
    }
  }

  if (body.action === "vote_added" || body.action === "import_vote") {
    const canonicalUsername = getCanonicalUsername(ss, body.user_id, body.username);

    // Width 8 (A..H) ONLY — leaves the score formulas in columns I/J intact.
    const newRow = [
      body.user_id,
      canonicalUsername,
      matchId,
      answerText,
      new Date(),
      body.message_id,
      body.answer_id,
      "valid"
    ];

    if (existingRow === -1) {
      // Append A..H; the I/J ARRAYFORMULA fills the score columns automatically.
      sheet
        .getRange(sheet.getLastRow() + 1, 1, 1, PRED_WRITE_WIDTH)
        .setValues([newRow]);
    } else {
      sheet.getRange(existingRow, 1, 1, PRED_WRITE_WIDTH).setValues([newRow]);
    }
  }

  if (body.action === "vote_removed" && existingRow !== -1) {
    const currentPrediction = values[existingRow - 1][3];

    if (String(currentPrediction) === String(answerText)) {
      sheet.deleteRow(existingRow);
    }
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function createMatchAndPollMap(ss, body) {
  const pollSheet = mustGetSheet(ss, "PollMap");
  const matchSheet = mustGetSheet(ss, "Matches");

  if (!body.poll_message_id || !body.match_id) {
    return jsonResponse({
      ok: false,
      error: "Missing poll_message_id or match_id"
    });
  }

  const pollRow = [
    body.poll_message_id,
    body.match_id,
    body.answer_1 || "",
    body.answer_2 || "",
    body.answer_3 || ""
  ];

  // Preserve an already-entered correct_answer (col F) if this match is being
  // re-created/edited — otherwise re-running /createprediction would wipe a
  // result that was already scored.
  const existingCorrect = getExistingCorrectAnswer(matchSheet, body.match_id);

  const matchRow = [
    body.match_id,
    body.stage || "",
    body.kickoff_time || "",
    body.team_a || "",
    body.team_b || "",
    existingCorrect,
    body.points || 0
  ];

  upsertByKey(pollSheet, 2, body.match_id, pollRow);
  upsertByKey(matchSheet, 1, body.match_id, matchRow);

  return jsonResponse({
    ok: true,
    message: "PollMap and Matches updated",
    match_id: body.match_id,
    poll_message_id: body.poll_message_id
  });
}

/**
 * Sets (or clears) Matches col F (correct_answer) for a match. The score
 * formulas in CurrentPredictions I/J recompute automatically from col F, so no
 * recount is needed here. The result must exactly match one of the poll's
 * answer options (from PollMap), or be "clear"/"none"/empty to reset.
 */
function setMatchResult(ss, body) {
  const matchId = String(body.match_id || "").trim();
  const result = String(body.result || "").trim();

  if (!matchId) {
    return jsonResponse({ ok: false, error: "Missing match_id" });
  }

  const matchSheet = mustGetSheet(ss, "Matches");
  const values = matchSheet.getDataRange().getValues();

  let matchRowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === matchId) {
      matchRowIndex = i + 1;
      break;
    }
  }

  if (matchRowIndex === -1) {
    return jsonResponse({
      ok: false,
      error: `Match "${matchId}" was not found in Matches`
    });
  }

  const lower = result.toLowerCase();
  const isClear = result === "" || lower === "clear" || lower === "none";

  if (isClear) {
    matchSheet.getRange(matchRowIndex, 6).setValue("");
    return jsonResponse({ ok: true, match_id: matchId, correct_answer: "" });
  }

  // Validate against the actual poll answer options so the stored
  // correct_answer matches the prediction text used for scoring.
  const validOptions = getPollAnswerOptions(ss, matchId);
  const canonical = validOptions.find(
    (opt) => opt.toLowerCase() === lower
  );

  if (validOptions.length && !canonical) {
    return jsonResponse({
      ok: false,
      error: `"${result}" is not a valid result for ${matchId}.`,
      valid_options: validOptions
    });
  }

  const finalValue = canonical || result;
  matchSheet.getRange(matchRowIndex, 6).setValue(finalValue);

  return jsonResponse({
    ok: true,
    match_id: matchId,
    correct_answer: finalValue
  });
}

function getPollAnswerOptions(ss, matchId) {
  const pollSheet = mustGetSheet(ss, "PollMap");
  const values = pollSheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1]) === String(matchId)) {
      return [values[i][2], values[i][3], values[i][4]]
        .map((v) => String(v || "").trim())
        .filter((v) => v.length);
    }
  }

  return [];
}

function getExistingCorrectAnswer(matchSheet, matchId) {
  const values = matchSheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(matchId)) {
      return values[i][5] || "";
    }
  }

  return "";
}

function upsertByKey(sheet, keyColumnNumber, key, rowValues) {
  const values = sheet.getDataRange().getValues();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    if (String(row[keyColumnNumber - 1]) === String(key)) {
      sheet.getRange(i + 1, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }

  sheet.appendRow(rowValues);
}

function getLeaderboard(ss, body) {
  const canonicalNames = getCanonicalUsernameMap(ss);

  const sheet = mustGetSheet(ss, "CurrentPredictions");
  const values = sheet.getDataRange().getValues();

  const limit = Number(body.limit || 200);
  const byUser = {};

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    const userId = row[0];
    if (!userId) continue;

    const key = String(userId);
    const username = getCanonicalUsername(ss, key, row[1], canonicalNames);
    const points = Number(row[8] || 0);
    const correct = Number(row[9] || 0);

    if (!byUser[key]) {
      byUser[key] = {
        username,
        points: 0,
        correct: 0,
        predictions: 0
      };
    }

    byUser[key].points += points;
    byUser[key].correct += correct;
    byUser[key].predictions += 1;
  }

  const rows = Object.values(byUser)
    .sort((a, b) => b.points - a.points)
    .slice(0, limit)
    .map((row, index) => ({
      rank: index + 1,
      username: row.username,
      points: row.points,
      correct: row.correct,
      predictions: row.predictions
    }));

  return jsonResponse({
    ok: true,
    leaderboard: rows
  });
}

function getUserPredictions(ss, body) {
  const userId = String(body.user_id || "");

  if (!userId) {
    return jsonResponse({
      ok: false,
      error: "Missing user_id"
    });
  }

  const currentSheet = mustGetSheet(ss, "CurrentPredictions");
  const matchesSheet = mustGetSheet(ss, "Matches");

  const predictionValues = currentSheet.getDataRange().getDisplayValues();
  const matchValues = matchesSheet.getDataRange().getDisplayValues();

  const matches = {};

  for (let i = 1; i < matchValues.length; i++) {
    const row = matchValues[i];

    const matchId = row[0];

    if (!matchId) {
      continue;
    }

    matches[matchId] = {
      match_id: matchId,
      stage: row[1],
      kickoff_time: row[2],
      team_a: row[3],
      team_b: row[4],
      correct_answer: row[5],
      points_possible: row[6]
    };
  }

  const predictions = [];

  for (let i = 1; i < predictionValues.length; i++) {
    const row = predictionValues[i];

    const rowUserId = String(row[0]);

    if (rowUserId !== userId) {
      continue;
    }

    const username = row[1];
    const matchId = row[2];
    const prediction = row[3];
    const updatedAt = row[4];
    const points = row[8];
    const correct = row[9];

    const match = matches[matchId] || {};

    let result = "pending";

    if (match.correct_answer) {
      result = Number(correct) === 1 ? "correct" : "wrong";
    }

    predictions.push({
      username: username,
      match_id: matchId,
      stage: match.stage || "",
      kickoff_time: match.kickoff_time || "",
      team_a: match.team_a || "",
      team_b: match.team_b || "",
      prediction: prediction,
      correct_answer: match.correct_answer || "",
      points: points || "0",
      points_possible: match.points_possible || "",
      result: result,
      updated_at: updatedAt
    });
  }

  predictions.sort((a, b) => {
    return String(a.kickoff_time).localeCompare(String(b.kickoff_time));
  });

  return jsonResponse({
    ok: true,
    predictions: predictions
  });
}

/**
 * MAINTENANCE: run manually from the Apps Script editor (select this function
 * and click Run). Removes duplicate (user_id, match_id) rows in
 * CurrentPredictions, keeping the row with the most recent updated_at (col E) —
 * i.e. the user's final vote in a single-select poll. Duplicates were created
 * by vote-change races before LockService was added; this reconciles existing
 * data. Safe to run repeatedly (a no-op once clean). Logs how many it removed.
 */
function dedupeCurrentPredictions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = mustGetSheet(ss, "CurrentPredictions");
    const values = sheet.getDataRange().getValues();

    // Map "user_id|match_id" -> { keepRow, keepTime, deleteRows: [] }
    const groups = {};

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const userId = String(row[0] || "");
      const matchId = String(row[2] || "");

      if (!userId || !matchId) {
        continue;
      }

      const sheetRow = i + 1;
      const updatedAt = row[4] instanceof Date ? row[4].getTime() : 0;
      const key = `${userId}|${matchId}`;

      if (!groups[key]) {
        groups[key] = { keepRow: sheetRow, keepTime: updatedAt, deleteRows: [] };
        continue;
      }

      const g = groups[key];
      if (updatedAt >= g.keepTime) {
        // This row is newer — keep it, drop the previous keeper.
        g.deleteRows.push(g.keepRow);
        g.keepRow = sheetRow;
        g.keepTime = updatedAt;
      } else {
        g.deleteRows.push(sheetRow);
      }
    }

    // Collect every row to delete, then remove bottom-up so indices stay valid.
    const toDelete = [];
    Object.keys(groups).forEach((key) => {
      groups[key].deleteRows.forEach((r) => toDelete.push(r));
    });
    toDelete.sort((a, b) => b - a);

    toDelete.forEach((r) => sheet.deleteRow(r));

    Logger.log(`Removed ${toDelete.length} duplicate prediction row(s).`);
    return toDelete.length;
  } finally {
    lock.releaseLock();
  }
}
