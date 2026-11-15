// /id コマンドを Discord に登録する
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.js
//   特定サーバーだけに即時反映したい場合は DISCORD_GUILD_ID も指定
import { COMMANDS } from '../src/commands.js';

const { DISCORD_APPLICATION_ID: appId, DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId } = process.env;
if (!appId || !token) {
  console.error('DISCORD_APPLICATION_ID と DISCORD_BOT_TOKEN を環境変数で指定してください');
  process.exit(1);
}
const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;
const res = await fetch(url, {
  method: 'PUT',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(guildId ? COMMANDS.map(({ integration_types, contexts, ...c }) => c) : COMMANDS),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
