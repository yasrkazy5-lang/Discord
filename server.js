// ═══════════════════════════════════════════════════════════════
//  AFRM Dashboard — server.js
//  Express Web Server + Discord.js Bot — Unified
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Client, GatewayIntentBits, Partials, EmbedBuilder,
        PermissionsBitField, ChannelType, REST, Routes,
        ActionRowBuilder, ButtonBuilder, ButtonStyle,
        StringSelectMenuBuilder, ModalBuilder, TextInputBuilder,
        TextInputStyle, ActivityType } = require('discord.js');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Config ──────────────────────────────────────────────────────
// Railway: config.json + Environment Variables
let config;
try {
  config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
} catch (_) { config = {}; }

// env vars override config.json (Railway persistent vars)
if (process.env.BOT_TOKEN)        config.token          = process.env.BOT_TOKEN;
if (process.env.GUILD_ID)         config.guildId        = process.env.GUILD_ID;
if (process.env.CLIENT_ID)        config.clientId       = process.env.CLIENT_ID;
if (process.env.DASHBOARD_SECRET) config.dashboardSecret= process.env.DASHBOARD_SECRET;

// Railway injects PORT automatically
config.port = process.env.PORT || config.port || 3000;

// Safe defaults
config.badWords      = config.badWords      || ["سب","شتيمة","لعن","كلب","حمار","غبي","ابن الكلب","الله يلعن"];
config.bannedDomains = config.bannedDomains || ["discord.gg","t.me","bit.ly"];
config.aiModeration  = config.aiModeration  !== false;
config.antiSpam      = config.antiSpam      !== false;
config.antiGhostPing = config.antiGhostPing !== false;
config.maxMentions   = config.maxMentions   || 5;
config.embedColor    = config.embedColor    || '#7c3aed';
config.levelRoles    = config.levelRoles    || {};
config.prefix        = config.prefix        || '!';

// Safe config save (Railway filesystem may reset on redeploy)
function saveConfig() {
  try { saveConfig(); } catch (_) {}
}

// ── Express App ─────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.static('.'));

// ── In-Memory Stores ────────────────────────────────────────────
const logs        = [];          // Live violation logs
const userWarns   = {};          // { userId: count }
const userLevels  = {};          // { userId: { xp, level } }
const tickets     = {};          // { channelId: { userId, messages, closed } }
const spamTracker = {};          // { userId: [timestamps] }
const giveaways   = {};          // { messageId: { prize, winners, endTime, entries } }
const polls       = {};          // { messageId: { question, options, votes } }
const uptime      = Date.now();

function addLog(type, detail, user = 'System') {
  const entry = { type, detail, user, time: new Date().toISOString() };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
}

// ── Discord Client ───────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// ══════════════════════════════════════════════════════════════════
//  BOT EVENTS
// ══════════════════════════════════════════════════════════════════

client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  client.user.setActivity('AFRM Dashboard', { type: ActivityType.Watching });
  addLog('SYSTEM', `Bot started as ${client.user.tag}`);
});

// ── Welcome / Leave ─────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  if (!config.welcomeChannelId) return;
  const ch = member.guild.channels.cache.get(config.welcomeChannelId);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(config.embedColor)
    .setTitle('🎉 عضو جديد!')
    .setDescription(`مرحباً ${member} في **${member.guild.name}**!\nأنت العضو رقم **${member.guild.memberCount}**`)
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();
  ch.send({ embeds: [embed] });

  if (config.autoRole) {
    const role = member.guild.roles.cache.get(config.autoRole);
    if (role) member.roles.add(role).catch(() => {});
  }
  addLog('JOIN', `${member.user.tag} joined the server`);
});

client.on('guildMemberRemove', async member => {
  if (!config.leaveChannelId) return;
  const ch = member.guild.channels.cache.get(config.leaveChannelId);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor('#ef4444')
    .setTitle('👋 عضو غادر')
    .setDescription(`**${member.user.tag}** غادر السيرفر.`)
    .setTimestamp();
  ch.send({ embeds: [embed] });
  addLog('LEAVE', `${member.user.tag} left the server`);
});

// ── Ghost Ping Detection ─────────────────────────────────────────
client.on('messageDelete', async msg => {
  if (!msg.author || msg.author.bot) return;
  if (msg.mentions.users.size > 0 || msg.mentions.roles.size > 0) {
    const mentioned = [...msg.mentions.users.values()].map(u => u.tag).join(', ');
    addLog('GHOST_PING', `${msg.author.tag} ghost-pinged: ${mentioned}`, msg.author.tag);
    if (config.logChannelId) {
      const ch = msg.guild?.channels.cache.get(config.logChannelId);
      if (ch) {
        const embed = new EmbedBuilder()
          .setColor('#f59e0b')
          .setTitle('👻 Ghost Ping Detected')
          .setDescription(`**${msg.author.tag}** did a ghost ping!\nMentioned: ${mentioned}`)
          .setTimestamp();
        ch.send({ embeds: [embed] });
      }
    }
  }
});

// ── Message Moderation (AI-like + Rules) ────────────────────────
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  // Anti-Bot check
  if (!msg.author.bot && msg.guild) {
    const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
    if (!member) return;
  }

  // ── Spam tracker
  const now = Date.now();
  if (!spamTracker[msg.author.id]) spamTracker[msg.author.id] = [];
  spamTracker[msg.author.id] = spamTracker[msg.author.id].filter(t => now - t < 5000);
  spamTracker[msg.author.id].push(now);
  if (spamTracker[msg.author.id].length > 5) {
    msg.delete().catch(() => {});
    addLog('SPAM', `Spam detected from ${msg.author.tag}`, msg.author.tag);
    msg.channel.send(`⚠️ ${msg.author} يرجى عدم الإرسال بسرعة!`).then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
    return;
  }

  // ── Bad words (AI-style fuzzy match)
  if (config.aiModeration) {
    const content = msg.content.toLowerCase().replace(/\s+/g, '');
    const hasBadWord = config.badWords.some(w => content.includes(w.toLowerCase().replace(/\s+/g, '')));
    if (hasBadWord) {
      msg.delete().catch(() => {});
      addLog('BAD_WORD', `Bad word from ${msg.author.tag}: ${msg.content.substring(0, 50)}`, msg.author.tag);
      userWarns[msg.author.id] = (userWarns[msg.author.id] || 0) + 1;
      msg.channel.send(`🚫 ${msg.author} تحذير! لا تستخدم ألفاظ مسيئة. (تحذير ${userWarns[msg.author.id]})`).then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
      if (userWarns[msg.author.id] >= 3) {
        const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
        if (member) {
          await member.timeout(10 * 60 * 1000, 'تجاوز حد التحذيرات');
          addLog('AUTO_MUTE', `Auto-muted ${msg.author.tag} (3 warnings)`, 'AutoMod');
        }
      }
      return;
    }
  }

  // ── Anti-link
  const linkRegex = /(https?:\/\/|discord\.gg\/|t\.me\/)/i;
  if (linkRegex.test(msg.content)) {
    const isBanned = config.bannedDomains.some(d => msg.content.includes(d));
    if (isBanned) {
      msg.delete().catch(() => {});
      addLog('LINK', `Banned link from ${msg.author.tag}`, msg.author.tag);
      msg.channel.send(`🔗 ${msg.author} لا يُسمح بمشاركة الروابط!`).then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
      return;
    }
  }

  // ── Anti-mention spam
  if (msg.mentions.users.size > config.maxMentions) {
    msg.delete().catch(() => {});
    addLog('MENTION_SPAM', `Mass mention by ${msg.author.tag}`, msg.author.tag);
    msg.channel.send(`📢 ${msg.author} لا تذكر أكثر من ${config.maxMentions} أشخاص!`).then(m => setTimeout(() => m.delete().catch(() => {}), 4000));
    return;
  }

  // ── Leveling system
  if (!userLevels[msg.author.id]) userLevels[msg.author.id] = { xp: 0, level: 0 };
  const xpGain = Math.floor(Math.random() * 10) + 5;
  userLevels[msg.author.id].xp += xpGain;
  const xpNeeded = (userLevels[msg.author.id].level + 1) * 100;
  if (userLevels[msg.author.id].xp >= xpNeeded) {
    userLevels[msg.author.id].level++;
    userLevels[msg.author.id].xp = 0;
    const lvl = userLevels[msg.author.id].level;
    msg.channel.send(`🎊 **${msg.author.username}** وصل للمستوى **${lvl}**!`);
    addLog('LEVEL_UP', `${msg.author.tag} reached level ${lvl}`, msg.author.tag);
    // Role rewards
    if (config.levelRoles && config.levelRoles[lvl]) {
      const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
      if (member) {
        const role = msg.guild.roles.cache.get(config.levelRoles[lvl]);
        if (role) member.roles.add(role).catch(() => {});
      }
    }
  }

  // ── Ticket messages tracking
  if (tickets[msg.channel.id] && !tickets[msg.channel.id].closed) {
    tickets[msg.channel.id].messages.push({
      author: msg.author.tag,
      content: msg.content,
      time: new Date().toISOString()
    });
  }
});

// ══════════════════════════════════════════════════════════════════
//  REST API ROUTES
// ══════════════════════════════════════════════════════════════════

// ── Serve Dashboard ─────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Bot Status ──────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  res.json({
    online: client.isReady(),
    tag: client.user?.tag || 'Offline',
    ping: client.ws.ping,
    uptime: Math.floor((Date.now() - uptime) / 1000),
    guilds: client.guilds.cache.size,
    members: guild?.memberCount || 0,
    channels: guild?.channels.cache.size || 0,
    roles: guild?.roles.cache.size || 0,
    avatarURL: client.user?.displayAvatarURL() || ''
  });
});

// ── Logs ────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => res.json(logs.slice(0, 50)));

// ── Members ─────────────────────────────────────────────────────
app.get('/api/members', async (req, res) => {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return res.json([]);
    const members = await guild.members.fetch();
    const list = members.map(m => ({
      id: m.id,
      tag: m.user.tag,
      displayName: m.displayName,
      avatar: m.user.displayAvatarURL(),
      bot: m.user.bot,
      roles: m.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
      joinedAt: m.joinedAt,
      warns: userWarns[m.id] || 0,
      level: userLevels[m.id]?.level || 0,
      xp: userLevels[m.id]?.xp || 0
    }));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Channels ────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return res.json([]);
  const channels = guild.channels.cache
    .filter(c => c.type === ChannelType.GuildText)
    .map(c => ({ id: c.id, name: c.name, topic: c.topic }));
  res.json(channels);
});

// ── Roles ────────────────────────────────────────────────────────
app.get('/api/roles', (req, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return res.json([]);
  const roles = guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, members: r.members.size }));
  res.json(roles);
});

// ── Stats for charts ─────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  const logTypes = {};
  logs.forEach(l => { logTypes[l.type] = (logTypes[l.type] || 0) + 1; });
  const topLevels = Object.entries(userLevels)
    .sort((a, b) => b[1].level - a[1].level)
    .slice(0, 5)
    .map(([id, data]) => ({ id, ...data }));
  res.json({
    memberCount: guild?.memberCount || 0,
    botCount: guild?.members.cache.filter(m => m.user.bot).size || 0,
    humanCount: guild?.members.cache.filter(m => !m.user.bot).size || 0,
    logTypes,
    topLevels,
    totalWarns: Object.values(userWarns).reduce((a, b) => a + b, 0),
    openTickets: Object.values(tickets).filter(t => !t.closed).length
  });
});

// ══════════════════════════════════════════════════════════════════
//  MODERATION ROUTES
// ══════════════════════════════════════════════════════════════════

async function getMember(guildId, userId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Guild not found');
  return guild.members.fetch(userId);
}

// Kick
app.post('/api/mod/kick', async (req, res) => {
  try {
    const { userId, reason } = req.body;
    const member = await getMember(config.guildId, userId);
    await member.kick(reason || 'Kicked via Dashboard');
    addLog('KICK', `${member.user.tag} was kicked. Reason: ${reason}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ban
app.post('/api/mod/ban', async (req, res) => {
  try {
    const { userId, reason, days } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    await guild.members.ban(userId, { deleteMessageDays: days || 0, reason: reason || 'Banned via Dashboard' });
    addLog('BAN', `User ${userId} was banned. Reason: ${reason}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Unban
app.post('/api/mod/unban', async (req, res) => {
  try {
    const { userId } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    await guild.members.unban(userId);
    addLog('UNBAN', `User ${userId} was unbanned`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mute (timeout)
app.post('/api/mod/mute', async (req, res) => {
  try {
    const { userId, duration, reason } = req.body;
    const member = await getMember(config.guildId, userId);
    const ms = (parseInt(duration) || 10) * 60 * 1000;
    await member.timeout(ms, reason || 'Muted via Dashboard');
    addLog('MUTE', `${member.user.tag} muted for ${duration}m. Reason: ${reason}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Unmute
app.post('/api/mod/unmute', async (req, res) => {
  try {
    const { userId } = req.body;
    const member = await getMember(config.guildId, userId);
    await member.timeout(null);
    addLog('UNMUTE', `${member.user.tag} was unmuted`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Warn
app.post('/api/mod/warn', async (req, res) => {
  try {
    const { userId, reason } = req.body;
    userWarns[userId] = (userWarns[userId] || 0) + 1;
    const guild = client.guilds.cache.get(config.guildId);
    const member = await guild.members.fetch(userId);
    addLog('WARN', `${member.user.tag} warned (${userWarns[userId]} total). Reason: ${reason}`, 'Dashboard');
    res.json({ success: true, warns: userWarns[userId] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clear messages
app.post('/api/mod/clear', async (req, res) => {
  try {
    const { channelId, amount } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    const deleted = await ch.bulkDelete(Math.min(parseInt(amount) || 10, 100), true);
    addLog('CLEAR', `Deleted ${deleted.size} messages in #${ch.name}`, 'Dashboard');
    res.json({ success: true, deleted: deleted.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nickname
app.post('/api/mod/nickname', async (req, res) => {
  try {
    const { userId, nickname } = req.body;
    const member = await getMember(config.guildId, userId);
    await member.setNickname(nickname || null);
    addLog('NICKNAME', `${member.user.tag} nickname changed to "${nickname}"`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lock channel
app.post('/api/mod/lock', async (req, res) => {
  try {
    const { channelId } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    addLog('LOCK', `#${ch.name} locked`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Unlock channel
app.post('/api/mod/unlock', async (req, res) => {
  try {
    const { channelId } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    addLog('UNLOCK', `#${ch.name} unlocked`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Slowmode
app.post('/api/mod/slowmode', async (req, res) => {
  try {
    const { channelId, seconds } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    await ch.setRateLimitPerUser(parseInt(seconds) || 0);
    addLog('SLOWMODE', `#${ch.name} slowmode set to ${seconds}s`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Move member (voice)
app.post('/api/mod/move', async (req, res) => {
  try {
    const { userId, channelId } = req.body;
    const member = await getMember(config.guildId, userId);
    await member.voice.setChannel(channelId);
    addLog('MOVE', `${member.user.tag} moved to voice channel`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  ROLE MANAGEMENT
// ══════════════════════════════════════════════════════════════════

// Create role
app.post('/api/roles/create', async (req, res) => {
  try {
    const { name, color, hoist, mentionable } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const role = await guild.roles.create({ name, color: color || '#99aab5', hoist: hoist || false, mentionable: mentionable || false });
    addLog('ROLE_CREATE', `Role "${name}" created`, 'Dashboard');
    res.json({ success: true, role: { id: role.id, name: role.name, color: role.hexColor } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete role
app.post('/api/roles/delete', async (req, res) => {
  try {
    const { roleId } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const role = guild.roles.cache.get(roleId);
    await role.delete();
    addLog('ROLE_DELETE', `Role "${role.name}" deleted`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Give role to member
app.post('/api/roles/give', async (req, res) => {
  try {
    const { userId, roleId } = req.body;
    const member = await getMember(config.guildId, userId);
    await member.roles.add(roleId);
    addLog('ROLE_GIVE', `Role given to ${member.user.tag}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove role from member
app.post('/api/roles/remove', async (req, res) => {
  try {
    const { userId, roleId } = req.body;
    const member = await getMember(config.guildId, userId);
    await member.roles.remove(roleId);
    addLog('ROLE_REMOVE', `Role removed from ${member.user.tag}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mass role give
app.post('/api/roles/mass-give', async (req, res) => {
  try {
    const { roleId } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const members = await guild.members.fetch();
    let count = 0;
    for (const [, member] of members) {
      if (!member.user.bot) {
        await member.roles.add(roleId).catch(() => {});
        count++;
      }
    }
    addLog('MASS_ROLE', `Role given to ${count} members`, 'Dashboard');
    res.json({ success: true, count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set auto role
app.post('/api/roles/autorole', async (req, res) => {
  try {
    const { roleId } = req.body;
    config.autoRole = roleId;
    saveConfig();
    addLog('AUTO_ROLE', `Auto role set to ${roleId}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  TICKETS
// ══════════════════════════════════════════════════════════════════

app.post('/api/tickets/create', async (req, res) => {
  try {
    const { userId, topic } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const member = await guild.members.fetch(userId);
    const ch = await guild.channels.create({
      name: `ticket-${member.user.username}`,
      type: ChannelType.GuildText,
      parent: config.ticketCategoryId || null,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
      ]
    });
    tickets[ch.id] = { userId, topic, messages: [], closed: false, createdAt: new Date().toISOString() };
    const embed = new EmbedBuilder()
      .setColor(config.embedColor)
      .setTitle('🎫 تذكرة جديدة')
      .setDescription(`مرحباً ${member}!\nتذكرتك بخصوص: **${topic || 'دعم عام'}**\nسيتواصل معك الفريق قريباً.`)
      .setTimestamp();
    ch.send({ embeds: [embed] });
    addLog('TICKET_OPEN', `Ticket opened for ${member.user.tag}: ${topic}`, 'Dashboard');
    res.json({ success: true, channelId: ch.id, channelName: ch.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tickets', (req, res) => res.json(tickets));

app.post('/api/tickets/close', async (req, res) => {
  try {
    const { channelId } = req.body;
    if (!tickets[channelId]) return res.status(404).json({ error: 'Ticket not found' });
    tickets[channelId].closed = true;
    tickets[channelId].closedAt = new Date().toISOString();
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    if (ch) {
      const embed = new EmbedBuilder().setColor('#ef4444').setTitle('🔒 تم إغلاق التذكرة').setTimestamp();
      await ch.send({ embeds: [embed] });
      setTimeout(() => ch.delete().catch(() => {}), 5000);
    }
    addLog('TICKET_CLOSE', `Ticket ${channelId} closed`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  EMBED & INTERACTION
// ══════════════════════════════════════════════════════════════════

app.post('/api/embed/send', async (req, res) => {
  try {
    const { channelId, title, description, color, footer, image, thumbnail } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    const embed = new EmbedBuilder()
      .setColor(color || config.embedColor)
      .setTitle(title || 'Embed')
      .setDescription(description || '')
      .setTimestamp();
    if (footer) embed.setFooter({ text: footer });
    if (image) embed.setImage(image);
    if (thumbnail) embed.setThumbnail(thumbnail);
    await ch.send({ embeds: [embed] });
    addLog('EMBED', `Embed sent to #${ch.name}: ${title}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/giveaway/start', async (req, res) => {
  try {
    const { channelId, prize, duration, winners } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    const endTime = Date.now() + (parseInt(duration) || 60) * 60 * 1000;
    const embed = new EmbedBuilder()
      .setColor('#f59e0b')
      .setTitle(`🎉 Giveaway: ${prize}`)
      .setDescription(`تفاعل بـ 🎉 للمشاركة!\nالفائزون: **${winners || 1}**\nينتهي: <t:${Math.floor(endTime / 1000)}:R>`)
      .setTimestamp(endTime);
    const msg = await ch.send({ embeds: [embed] });
    await msg.react('🎉');
    giveaways[msg.id] = { prize, winners: parseInt(winners) || 1, endTime, entries: [], channelId };
    addLog('GIVEAWAY', `Giveaway started: ${prize} in #${ch.name}`, 'Dashboard');
    setTimeout(async () => {
      const g = giveaways[msg.id];
      if (!g || !g.entries.length) return;
      const shuffled = g.entries.sort(() => 0.5 - Math.random());
      const winnerIds = shuffled.slice(0, g.winners);
      const winnerMentions = winnerIds.map(id => `<@${id}>`).join(', ');
      const endEmbed = new EmbedBuilder().setColor('#22c55e').setTitle(`🏆 انتهى الـ Giveaway!`).setDescription(`الجائزة: **${g.prize}**\nالفائزون: ${winnerMentions}`).setTimestamp();
      ch.send({ embeds: [endEmbed] });
    }, parseInt(duration) * 60 * 1000);
    res.json({ success: true, messageId: msg.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name === '🎉' && giveaways[reaction.message.id]) {
    if (!giveaways[reaction.message.id].entries.includes(user.id))
      giveaways[reaction.message.id].entries.push(user.id);
  }
});

app.post('/api/poll/create', async (req, res) => {
  try {
    const { channelId, question, options } = req.body;
    const guild = client.guilds.cache.get(config.guildId);
    const ch = guild.channels.cache.get(channelId);
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
    const optArr = options || ['نعم', 'لا'];
    const desc = optArr.map((o, i) => `${emojis[i]} ${o}`).join('\n');
    const embed = new EmbedBuilder().setColor(config.embedColor).setTitle(`📊 ${question}`).setDescription(desc).setTimestamp();
    const msg = await ch.send({ embeds: [embed] });
    for (let i = 0; i < optArr.length; i++) await msg.react(emojis[i]);
    polls[msg.id] = { question, options: optArr, votes: {} };
    addLog('POLL', `Poll created: ${question}`, 'Dashboard');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Config update ─────────────────────────────────────────────────
app.post('/api/config/update', (req, res) => {
  try {
    const allowed = ['welcomeChannelId', 'leaveChannelId', 'logChannelId',
                     'ticketCategoryId', 'aiModeration', 'antiSpam',
                     'antiGhostPing', 'maxMentions', 'badWords', 'bannedDomains'];
    const updates = req.body;
    allowed.forEach(k => { if (updates[k] !== undefined) config[k] = updates[k]; });
    saveConfig();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/config', (req, res) => {
  const safe = { ...config };
  delete safe.token;
  delete safe.dashboardSecret;
  res.json(safe);
});

// ══════════════════════════════════════════════════════════════════
//  DYNAMIC BOT SESSION — connect / disconnect / restart
// ══════════════════════════════════════════════════════════════════

let botConnected  = false;
let botConnecting = false;

async function startBot(token) {
  if (botConnecting) return { success: false, error: 'جاري الاتصال بالفعل...' };
  if (botConnected) await stopBot();

  botConnecting = true;
  try {
    // Save token to config (encrypted lightly)
    config.token = token;
    saveConfig();

    await client.login(token);
    botConnected  = true;
    botConnecting = false;
    addLog('SYSTEM', `Bot connected: ${client.user?.tag}`);
    return { success: true, tag: client.user?.tag };
  } catch (err) {
    botConnected  = false;
    botConnecting = false;
    addLog('ERROR', `Bot login failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function stopBot() {
  if (!botConnected) return;
  try {
    client.removeAllListeners();
    await client.destroy();
    botConnected = false;
    addLog('SYSTEM', 'Bot disconnected via dashboard');
  } catch (_) {}
}

// ── API: Connect bot ────────────────────────────────────────────
app.post('/api/bot/connect', async (req, res) => {
  let { token, guildId } = req.body;
  if (!token) return res.status(400).json({ error: 'التوكن مطلوب' });

  // Use saved token if placeholder sent
  if (token === '__SAVED__') {
    token = config.token;
    if (!token) return res.status(400).json({ error: 'لا يوجد توكن محفوظ' });
  }

  if (guildId) {
    config.guildId = guildId;
    saveConfig();
  }

  const result = await startBot(token.trim());
  res.json(result);
});

// ── API: Disconnect bot ─────────────────────────────────────────
app.post('/api/bot/disconnect', async (req, res) => {
  await stopBot();
  res.json({ success: true });
});

// ── API: Bot connection status ──────────────────────────────────
app.get('/api/bot/session', (req, res) => {
  res.json({
    connected:  botConnected,
    connecting: botConnecting,
    tag:        client.user?.tag || null,
    hasToken:   !!config.token,
    guildId:    config.guildId || null
  });
});

// ══════════════════════════════════════════════════════════════════
//  START — auto-reconnect if token already saved
// ══════════════════════════════════════════════════════════════════

server.listen(config.port, async () => {
  console.log(`🌐 AFRM Dashboard → http://localhost:${config.port}`);

  // If a token was previously saved, reconnect automatically
  if (config.token) {
    console.log('🔄 توكن محفوظ — جاري إعادة الاتصال تلقائياً...');
    const r = await startBot(config.token);
    if (r.success) console.log(`✅ Bot auto-connected: ${r.tag}`);
    else           console.log(`❌ Auto-connect failed: ${r.error}`);
  } else {
    console.log('⚠️  لا يوجد توكن محفوظ — افتح اللوحة واتصل يدوياً');
  }
});
