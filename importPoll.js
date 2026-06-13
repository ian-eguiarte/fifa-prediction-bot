require("dotenv").config();

const channelId = process.argv[2];
const messageId = process.argv[3];
const answerIds = process.argv[4].split(",");

if (!channelId || !messageId || !answerIds.length) {
  console.log("Usage: node importPoll.js CHANNEL_ID MESSAGE_ID ANSWER_IDS");
  console.log("Example: node importPoll.js 123456789 987654321 1,2");
  process.exit(1);
}

async function fetchVoters(answerId) {
  let voters = [];
  let after = null;

  while (true) {
    let url = `https://discord.com/api/v10/channels/${channelId}/polls/${messageId}/answers/${answerId}?limit=100`;

    if (after) {
      url += `&after=${after}`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Discord API error for answer ${answerId}: ${text}`);
    }

    const data = await response.json();
    const users = data.users || [];

    voters.push(...users);

    if (users.length < 100) {
      break;
    }

    after = users[users.length - 1].id;
  }

  return voters;
}

async function sendImportToSheet(user, answerId) {
  const payload = {
    secret: process.env.SHEET_SECRET,
    action: "import_vote",
    user_id: user.id,
    username: user.global_name || user.username,
    guild_id: "",
    channel_id: channelId,
    message_id: messageId,
    answer_id: Number(answerId)
  };

  const response = await fetch(process.env.APPS_SCRIPT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  console.log(`${user.username} imported for answer ${answerId}`);
  console.log(text);
}

async function main() {
  for (const answerId of answerIds) {
    console.log(`Fetching voters for answer ${answerId}...`);

    const voters = await fetchVoters(answerId);

    console.log(`Found ${voters.length} voters for answer ${answerId}.`);

    for (const user of voters) {
      await sendImportToSheet(user, answerId);
    }
  }

  console.log("Import complete.");
}

main().catch((err) => {
  console.error(err);
});