// ============================================================
//  Discord Dashboard Pro - server.js
//  Combines Express Web Server + Discord.js Bot in ONE file
//  Author: Dashboard Pro | discord.js v14 + Express v4
// ============================================================

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Client, GatewayIntentBits, Partials, EmbedBuilder,
        PermissionsBitField, ChannelType, ActionRowBuilder,
        ButtonBuilder, ButtonStyle, Collection } = require('discord.js');

// ── Load Config ─────────────────────────────────────────────
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// ── Express App ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Discord Client ───────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.GuildMember],
});

// ── In-Memory Stores ─────────────────────────────────────────
const liveLogs       = [];          // Live violation logs
const warnings       = new Map();   // userId => [{reason, time}]
const xpData         = new Map();   // userId => {xp, level, messages}
const tickets        = new Map();   // channelId => {userId, transcript:[]}
const memberHistory  = new Map();   // guildId => [{timestamp, count}]
const giveaways      = new Map();   // messageId => {prize, endTime, entries:Set, channelId, hostId}
const polls          = new Map();   // messageId => {question, options, votes:{}}
const slowmodeMap    = new Map();   // channelId => seconds
const ghostPingTrack = new Map();   // messageId => {authorId, mentions:[]}
const botStartTime   = Date.now();

// ── Helper: Push Live Log ────────────────────────────────────
function pushLog(type, message, userId = null, guildId = null) {
  const entry = {
    id: Date.now() + Math.random(),
    type,       // 'violation' | 'moderation' | 'system' | 'join' | 'leave' | 'level'
    message,
    userId,
    guildId,
    timestamp: new Date().toISOString(),
  };
  liveLogs.unshift(entry);
  if (liveLogs.length > 200) liveLogs.pop();
  return entry;
}

// ── XP & Leveling ────────────────────────────────────────────
function addXP(userId, amount = 15) {
  const data = xpData.get(userId) || { xp: 0, level: 1, messages: 0 };
  data.xp += amount + Math.floor(Math.random() * 10);
  data.messages++;
  const xpNeeded = data.level * 100;
  let leveledUp = false;
  if (data.xp >= xpNeeded) {
    data.level++;
    data.xp -= xpNeeded;
    leveledUp = true;
  }
  xpData.set(userId, data);
  return { ...data, leveledUp };
}

// ── Bad Words AI-Simulated Filter ────────────────────────────
const badWordPatterns = [
  ...config.badWords.map(w => new RegExp(w, 'i')),
  /f+u+c+k/i, /s+h+i+t/i, /b+i+t+c+h/i, /a+s+s+h+o+l+e/i,
  /n+i+g+g/i, /f+a+g/i, /c+u+n+t/i, /d+i+c+k/i,
];

function containsBadWord(text) {
  return badWordPatterns.some(p => p.test(text));
}

function containsLink(text) {
  return /https?:\/\/|discord\.gg\/|www\./i.test(text);
}

function isAllowedLink(text) {
  return config.allowedLinks.some(domain => text.includes(domain));
}

// ────────────────────────────────────────────────────────────
//  BOT EVENTS
// ────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  pushLog('system', `Bot started: ${client.user.tag}`, client.user.id);
  client.user.setActivity('🛡️ Protecting the server', { type: 3 });

  // Track member counts every 5 minutes
  setInterval(() => {
    client.guilds.cache.forEach(guild => {
      const hist = memberHistory.get(guild.id) || [];
      hist.push({ timestamp: Date.now(), count: guild.memberCount });
      if (hist.length > 288) hist.shift(); // 24h of 5-min intervals
      memberHistory.set(guild.id, hist);
    });
  }, 300000);

  // Initial snapshot
  client.guilds.cache.forEach(guild => {
    memberHistory.set(guild.id, [{ timestamp: Date.now(), count: guild.memberCount }]);
  });
});

// ── Message Events ───────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (!message.guild) return;
  if (message.author.bot) {
    if (config.antiBots && !message.author.system) {
      pushLog('violation', `Bot message detected: ${message.author.tag}`, message.author.id, message.guild.id);
    }
    return;
  }

  const content = message.content;
  const member  = message.member;

  // Track ghost ping (save mentions before possible deletion)
  if (message.mentions.users.size > 0) {
    ghostPingTrack.set(message.id, {
      authorId: message.author.id,
      authorTag: message.author.tag,
      mentions: message.mentions.users.map(u => u.tag),
      channelId: message.channel.id,
    });
    setTimeout(() => ghostPingTrack.delete(message.id), 5000);
  }

  // ── Anti-Bad-Words ──
  if (config.antiSpam && containsBadWord(content)) {
    try {
      await message.delete();
      await message.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0xff0000)
          .setDescription(`🚫 <@${message.author.id}> لا يُسمح بالكلمات المسيئة! تم حذف رسالتك.`)
        ]
      });
      pushLog('violation', `Bad word by ${message.author.tag}: "${content.substring(0,30)}..."`, message.author.id, message.guild.id);
    } catch {}
    return;
  }

  // ── Anti-Links ──
  if (config.antiLinks && containsLink(content) && !isAllowedLink(content)) {
    if (!member?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      try {
        await message.delete();
        await message.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xff6b00)
            .setDescription(`🔗 <@${message.author.id}> مشاركة الروابط غير مسموح هنا!`)
          ]
        });
        pushLog('violation', `Link posted by ${message.author.tag}`, message.author.id, message.guild.id);
      } catch {}
      return;
    }
  }

  // ── Anti-Mass-Mention ──
  if (config.antiMention && message.mentions.users.size >= 5) {
    if (!member?.permissions.has(PermissionsBitField.Flags.MentionEveryone)) {
      try {
        await message.delete();
        await message.channel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xff0000)
            .setDescription(`📢 <@${message.author.id}> المنشن الجماعي ممنوع!`)
          ]
        });
        pushLog('violation', `Mass mention by ${message.author.tag} (${message.mentions.users.size} mentions)`, message.author.id, message.guild.id);
      } catch {}
      return;
    }
  }

  // ── Ticket transcript tracking ──
  if (tickets.has(message.channel.id)) {
    const ticket = tickets.get(message.channel.id);
    ticket.transcript.push({
      author: message.author.tag,
      content: message.content,
      timestamp: new Date().toISOString(),
    });
    if (ticket.transcript.length > 100) ticket.transcript.shift();
  }

  // ── XP / Leveling ──
  if (config.levelingEnabled) {
    const result = addXP(message.author.id);
    if (result.leveledUp) {
      message.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle('🎉 ترقية مستوى!')
          .setDescription(`تهانينا <@${message.author.id}>! وصلت إلى **المستوى ${result.level}**! 🚀`)
        ]
      }).catch(() => {});
      pushLog('level', `${message.author.tag} reached level ${result.level}`, message.author.id, message.guild.id);
    }
  }
});

// ── Ghost Ping Detection ─────────────────────────────────────
client.on('messageDelete', async (message) => {
  if (!config.antiGhostPing) return;
  const data = ghostPingTrack.get(message.id);
  if (data) {
    pushLog('violation', `Ghost ping by ${data.authorTag} mentioning: ${data.mentions.join(', ')}`, data.authorId, message.guild?.id);
    ghostPingTrack.delete(message.id);
    try {
      const ch = await client.channels.fetch(data.channelId);
      if (ch) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0xff4500)
            .setTitle('👻 Ghost Ping مكتشف!')
            .setDescription(`<@${data.authorId}> قام بـ Ghost Ping على: ${data.mentions.join(', ')}`)
          ]
        });
      }
    } catch {}
  }
});

// ── Member Join ──────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  pushLog('join', `${member.user.tag} joined ${member.guild.name}`, member.user.id, member.guild.id);

  // Auto Role
  if (config.autoRole) {
    try {
      const role = member.guild.roles.cache.get(config.autoRole);
      if (role) await member.roles.add(role);
    } catch {}
  }

  // Welcome message
  if (config.welcomeChannelId) {
    try {
      const ch = member.guild.channels.cache.get(config.welcomeChannelId);
      if (ch) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0x00ff88)
            .setTitle('👋 مرحباً بعضو جديد!')
            .setDescription(`أهلاً وسهلاً <@${member.id}> في **${member.guild.name}**!\nأنت العضو رقم **${member.guild.memberCount}**`)
            .setThumbnail(member.user.displayAvatarURL())
            .setTimestamp()
          ]
        });
      }
    } catch {}
  }
});

// ── Member Leave ─────────────────────────────────────────────
client.on('guildMemberRemove', async (member) => {
  pushLog('leave', `${member.user.tag} left ${member.guild.name}`, member.user.id, member.guild.id);

  if (config.leaveChannelId) {
    try {
      const ch = member.guild.channels.cache.get(config.leaveChannelId);
      if (ch) {
        await ch.send({
          embeds: [new EmbedBuilder()
            .setColor(0xff4444)
            .setTitle('👋 وداعاً!')
            .setDescription(`**${member.user.tag}** غادر السيرفر. نتمنى له التوفيق!`)
            .setTimestamp()
          ]
        });
      }
    } catch {}
  }
});

// ────────────────────────────────────────────────────────────
//  REST API ROUTES
// ────────────────────────────────────────────────────────────

// ── Serve Dashboard ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Bot Status ───────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const uptime = Math.floor((Date.now() - botStartTime) / 1000);
  const guild  = client.guilds.cache.first();
  res.json({
    online: client.isReady(),
    tag: client.user?.tag || 'Offline',
    avatar: client.user?.displayAvatarURL({ size: 128 }) || '',
    ping: client.ws.ping,
    uptime,
    guilds: client.guilds.cache.size,
    members: guild?.memberCount || 0,
    channels: guild?.channels.cache.size || 0,
    roles: guild?.roles.cache.size || 0,
    guildName: guild?.name || 'N/A',
    guildIcon: guild?.iconURL({ size: 128 }) || '',
    memberHistory: memberHistory.get(guild?.id) || [],
  });
});

// ── Live Logs ────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  res.json(liveLogs.slice(0, 50));
});

// ── Guild Info ───────────────────────────────────────────────
app.get('/api/guild', (req, res) => {
  const guild = client.guilds.cache.first();
  if (!guild) return res.json({ error: 'No guild found' });
  res.json({
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount,
    icon: guild.iconURL({ size: 256 }),
    channels: guild.channels.cache
      .filter(c => c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name })),
    roles: guild.roles.cache
      .filter(r => r.id !== guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => ({ id: r.id, name: r.name, color: r.hexColor, members: r.members.size })),
    members: guild.members.cache.map(m => ({
      id: m.id,
      tag: m.user.tag,
      displayName: m.displayName,
      avatar: m.user.displayAvatarURL({ size: 64 }),
      roles: m.roles.cache.filter(r => r.id !== guild.id).map(r => r.name),
      joinedAt: m.joinedAt?.toISOString(),
      bot: m.user.bot,
    })).slice(0, 100),
  });
});

// ── Members ──────────────────────────────────────────────────
app.get('/api/members', (req, res) => {
  const guild = client.guilds.cache.first();
  if (!guild) return res.json([]);
  const members = guild.members.cache.map(m => ({
    id: m.id,
    tag: m.user.tag,
    displayName: m.displayName,
    avatar: m.user.displayAvatarURL({ size: 64 }),
    roles: m.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
    joinedAt: m.joinedAt?.toISOString(),
    bot: m.user.bot,
    xp: xpData.get(m.id)?.xp || 0,
    level: xpData.get(m.id)?.level || 1,
    warnings: warnings.get(m.id)?.length || 0,
  }));
  res.json(members);
});

// ── Kick ─────────────────────────────────────────────────────
app.post('/api/mod/kick', async (req, res) => {
  const { userId, reason } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    await member.kick(reason || 'No reason provided');
    pushLog('moderation', `KICK: ${member.user.tag} | Reason: ${reason}`, userId, guild.id);
    res.json({ success: true, message: `Kicked ${member.user.tag}` });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Ban ──────────────────────────────────────────────────────
app.post('/api/mod/ban', async (req, res) => {
  const { userId, reason, days } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    await member.ban({ reason: reason || 'No reason', deleteMessageDays: days || 0 });
    pushLog('moderation', `BAN: ${member.user.tag} | Reason: ${reason}`, userId, guild.id);
    res.json({ success: true, message: `Banned ${member.user.tag}` });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Unban ────────────────────────────────────────────────────
app.post('/api/mod/unban', async (req, res) => {
  const { userId } = req.body;
  const guild = client.guilds.cache.first();
  try {
    await guild.members.unban(userId);
    pushLog('moderation', `UNBAN: User ${userId}`, userId, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Mute (Timeout) ───────────────────────────────────────────
app.post('/api/mod/mute', async (req, res) => {
  const { userId, duration, reason } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    const ms = (parseInt(duration) || 10) * 60 * 1000;
    await member.timeout(ms, reason || 'Muted via Dashboard');
    pushLog('moderation', `MUTE: ${member.user.tag} for ${duration} mins`, userId, guild.id);
    res.json({ success: true, message: `Muted ${member.user.tag}` });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Unmute ───────────────────────────────────────────────────
app.post('/api/mod/unmute', async (req, res) => {
  const { userId } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    await member.timeout(null);
    pushLog('moderation', `UNMUTE: ${member.user.tag}`, userId, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Warn ─────────────────────────────────────────────────────
app.post('/api/mod/warn', async (req, res) => {
  const { userId, reason } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    const userWarns = warnings.get(userId) || [];
    userWarns.push({ reason: reason || 'Warning', time: new Date().toISOString() });
    warnings.set(userId, userWarns);
    pushLog('moderation', `WARN: ${member.user.tag} | Reason: ${reason}`, userId, guild.id);
    try {
      await member.send({ embeds: [new EmbedBuilder().setColor(0xffaa00).setTitle('⚠️ تحذير').setDescription(`تم تحذيرك في **${guild.name}**\nالسبب: ${reason}`)] });
    } catch {}
    res.json({ success: true, totalWarnings: userWarns.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Get Warnings ─────────────────────────────────────────────
app.get('/api/mod/warnings/:userId', (req, res) => {
  res.json(warnings.get(req.params.userId) || []);
});

// ── Purge Messages ───────────────────────────────────────────
app.post('/api/mod/purge', async (req, res) => {
  const { channelId, amount } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const channel = guild.channels.cache.get(channelId);
    const deleted = await channel.bulkDelete(Math.min(parseInt(amount) || 10, 100), true);
    pushLog('moderation', `PURGE: ${deleted.size} messages in #${channel.name}`, null, guild.id);
    res.json({ success: true, deleted: deleted.size });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Nickname ─────────────────────────────────────────────────
app.post('/api/mod/nickname', async (req, res) => {
  const { userId, nickname } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    await member.setNickname(nickname || null);
    pushLog('moderation', `NICK: ${member.user.tag} → ${nickname}`, userId, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Lock Channel ─────────────────────────────────────────────
app.post('/api/mod/lock', async (req, res) => {
  const { channelId, lock } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const channel = guild.channels.cache.get(channelId);
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: lock ? false : null,
    });
    pushLog('moderation', `${lock ? 'LOCK' : 'UNLOCK'}: #${channel.name}`, null, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Slowmode ─────────────────────────────────────────────────
app.post('/api/mod/slowmode', async (req, res) => {
  const { channelId, seconds } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const channel = guild.channels.cache.get(channelId);
    await channel.setRateLimitPerUser(parseInt(seconds) || 0);
    slowmodeMap.set(channelId, seconds);
    pushLog('moderation', `SLOWMODE: #${channel.name} → ${seconds}s`, null, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Move Member ──────────────────────────────────────────────
app.post('/api/mod/move', async (req, res) => {
  const { userId, channelId } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    await member.voice.setChannel(channelId);
    pushLog('moderation', `MOVE: ${member.user.tag} to channel ${channelId}`, userId, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Create Role ──────────────────────────────────────────────
app.post('/api/roles/create', async (req, res) => {
  const { name, color, hoist, mentionable } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const role = await guild.roles.create({
      name: name || 'New Role',
      color: color || '#7c3aed',
      hoist: hoist || false,
      mentionable: mentionable || false,
    });
    pushLog('system', `ROLE CREATED: ${role.name}`, null, guild.id);
    res.json({ success: true, role: { id: role.id, name: role.name, color: role.hexColor } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Delete Role ──────────────────────────────────────────────
app.post('/api/roles/delete', async (req, res) => {
  const { roleId } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const role = guild.roles.cache.get(roleId);
    await role.delete();
    pushLog('system', `ROLE DELETED: ${role.name}`, null, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Assign Role ──────────────────────────────────────────────
app.post('/api/roles/assign', async (req, res) => {
  const { userId, roleId, remove } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member = await guild.members.fetch(userId);
    const role   = guild.roles.cache.get(roleId);
    if (remove) await member.roles.remove(role);
    else await member.roles.add(role);
    pushLog('system', `ROLE ${remove ? 'REMOVED' : 'ADDED'}: ${role.name} → ${member.user.tag}`, userId, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Bulk Assign Role ─────────────────────────────────────────
app.post('/api/roles/bulk-assign', async (req, res) => {
  const { roleId } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const role    = guild.roles.cache.get(roleId);
    const members = guild.members.cache.filter(m => !m.user.bot);
    let count = 0;
    for (const [, m] of members) {
      try { await m.roles.add(role); count++; } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    pushLog('system', `BULK ASSIGN: ${role.name} → ${count} members`, null, guild.id);
    res.json({ success: true, count });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Set Auto Role ────────────────────────────────────────────
app.post('/api/roles/auto', async (req, res) => {
  const { roleId } = req.body;
  config.autoRole = roleId;
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
  res.json({ success: true });
});

// ── Send Embed ───────────────────────────────────────────────
app.post('/api/embed/send', async (req, res) => {
  const { channelId, title, description, color, footer, image, thumbnail } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const channel = guild.channels.cache.get(channelId);
    const embed   = new EmbedBuilder()
      .setTitle(title || 'Embed')
      .setDescription(description || '')
      .setColor(color ? parseInt(color.replace('#',''), 16) : 0x7c3aed)
      .setTimestamp();
    if (footer)    embed.setFooter({ text: footer });
    if (image)     embed.setImage(image);
    if (thumbnail) embed.setThumbnail(thumbnail);
    await channel.send({ embeds: [embed] });
    pushLog('system', `EMBED SENT: ${title} → #${channel.name}`, null, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Create Giveaway ──────────────────────────────────────────
app.post('/api/giveaway/create', async (req, res) => {
  const { channelId, prize, duration, winners } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const channel = guild.channels.cache.get(channelId);
    const endTime = Date.now() + (parseInt(duration) || 60) * 60 * 1000;
    const embed   = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle(`🎉 GIVEAWAY | ${prize}`)
      .setDescription(`**الجائزة:** ${prize}\n**الفائزون:** ${winners || 1}\n**تنتهي في:** <t:${Math.floor(endTime/1000)}:R>\n\nاضغط 🎉 للمشاركة!`)
      .setTimestamp(endTime);
    const msg = await channel.send({ embeds: [embed] });
    await msg.react('🎉');
    giveaways.set(msg.id, { prize, endTime, winners: parseInt(winners) || 1, entries: new Set(), channelId, hostId: null, messageId: msg.id });

    // End timer
    setTimeout(async () => {
      const ga = giveaways.get(msg.id);
      if (!ga) return;
      const entriesArr = [...ga.entries];
      const winnerIds  = [];
      for (let i = 0; i < Math.min(ga.winners, entriesArr.length); i++) {
        const idx = Math.floor(Math.random() * entriesArr.length);
        winnerIds.push(entriesArr.splice(idx, 1)[0]);
      }
      const winnerMentions = winnerIds.map(id => `<@${id}>`).join(', ') || 'لا أحد';
      channel.send({ embeds: [new EmbedBuilder().setColor(0xffd700).setTitle('🎊 انتهى الجيف أواي!').setDescription(`الفائز: ${winnerMentions}\nالجائزة: **${ga.prize}**`)] });
      giveaways.delete(msg.id);
    }, (parseInt(duration) || 60) * 60 * 1000);

    pushLog('system', `GIVEAWAY: ${prize} in #${channel.name}`, null, guild.id);
    res.json({ success: true, messageId: msg.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Giveaway Reaction ────────────────────────────────────────
client.on('messageReactionAdd', (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name === '🎉' && giveaways.has(reaction.message.id)) {
    const ga = giveaways.get(reaction.message.id);
    ga.entries.add(user.id);
  }
});

// ── Create Poll ──────────────────────────────────────────────
app.post('/api/poll/create', async (req, res) => {
  const { channelId, question, options } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const channel = guild.channels.cache.get(channelId);
    const emojis  = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
    const optArr  = (options || ['نعم','لا']).slice(0, 5);
    const desc    = optArr.map((o, i) => `${emojis[i]} **${o}**`).join('\n');
    const embed   = new EmbedBuilder().setColor(0x7c3aed).setTitle(`📊 ${question}`).setDescription(desc).setTimestamp();
    const msg     = await channel.send({ embeds: [embed] });
    for (let i = 0; i < optArr.length; i++) await msg.react(emojis[i]);
    const votesObj = {};
    optArr.forEach((o, i) => votesObj[emojis[i]] = { option: o, count: 0 });
    polls.set(msg.id, { question, options: optArr, votes: votesObj, channelId });
    pushLog('system', `POLL: ${question} in #${channel.name}`, null, guild.id);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Create Ticket ────────────────────────────────────────────
app.post('/api/tickets/create', async (req, res) => {
  const { userId, topic } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const member  = await guild.members.fetch(userId);
    const channel = await guild.channels.create({
      name: `ticket-${member.user.username}-${Date.now().toString().slice(-4)}`,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ],
    });
    tickets.set(channel.id, { userId, topic: topic || 'Support', transcript: [], createdAt: new Date().toISOString() });
    const embed = new EmbedBuilder().setColor(0x00ff88).setTitle('🎫 تذكرة دعم').setDescription(`مرحباً <@${member.id}>!\nموضوع التذكرة: **${topic || 'Support'}**\n\nسيتواصل معك الدعم قريباً.`).setTimestamp();
    const row   = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('close_ticket').setLabel('إغلاق التذكرة').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
    await channel.send({ embeds: [embed], components: [row] });
    pushLog('system', `TICKET: ${member.user.tag} | ${topic}`, userId, guild.id);
    res.json({ success: true, channelId: channel.id, channelName: channel.name });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Get Tickets ──────────────────────────────────────────────
app.get('/api/tickets', (req, res) => {
  const result = [];
  tickets.forEach((data, channelId) => {
    result.push({ channelId, ...data });
  });
  res.json(result);
});

// ── Close Ticket ─────────────────────────────────────────────
app.post('/api/tickets/close', async (req, res) => {
  const { channelId } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const channel  = guild.channels.cache.get(channelId);
    const ticketData = tickets.get(channelId);
    pushLog('system', `TICKET CLOSED: #${channel?.name}`, null, guild.id);
    tickets.delete(channelId);
    await channel?.delete('Ticket closed via dashboard');
    res.json({ success: true, transcript: ticketData?.transcript || [] });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Button Interaction (Close Ticket) ────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'close_ticket') {
    const ch = interaction.channel;
    if (tickets.has(ch.id)) {
      await interaction.reply({ content: '🔒 جاري إغلاق التذكرة...', ephemeral: true });
      tickets.delete(ch.id);
      setTimeout(() => ch.delete().catch(() => {}), 3000);
    }
  }
});

// ── Get Leveling Board ───────────────────────────────────────
app.get('/api/levels', (req, res) => {
  const guild = client.guilds.cache.first();
  const board = [];
  xpData.forEach((data, userId) => {
    const member = guild?.members.cache.get(userId);
    board.push({
      userId,
      tag: member?.user.tag || `User#${userId}`,
      avatar: member?.user.displayAvatarURL({ size: 64 }) || '',
      ...data,
    });
  });
  board.sort((a, b) => (b.level * 1000 + b.xp) - (a.level * 1000 + a.xp));
  res.json(board.slice(0, 20));
});

// ── Get Config ───────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(config);
});

// ── Update Config ────────────────────────────────────────────
app.post('/api/config/update', (req, res) => {
  const updates = req.body;
  Object.assign(config, updates);
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
  res.json({ success: true, config });
});

// ── Get Giveaways ────────────────────────────────────────────
app.get('/api/giveaways', (req, res) => {
  const result = [];
  giveaways.forEach((ga, msgId) => {
    result.push({ messageId: msgId, ...ga, entries: ga.entries.size });
  });
  res.json(result);
});

// ── Stats Overview ───────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const guild = client.guilds.cache.first();
  res.json({
    totalWarnings: [...warnings.values()].reduce((a, b) => a + b.length, 0),
    totalViolations: liveLogs.filter(l => l.type === 'violation').length,
    totalTickets: tickets.size,
    totalGiveaways: giveaways.size,
    totalPolls: polls.size,
    levelingUsers: xpData.size,
    topLevel: Math.max(0, ...[...xpData.values()].map(d => d.level)),
  });
});

// ── Welcome / Leave Config ───────────────────────────────────
app.post('/api/config/welcome', (req, res) => {
  const { welcomeChannelId, leaveChannelId } = req.body;
  if (welcomeChannelId) config.welcomeChannelId = welcomeChannelId;
  if (leaveChannelId)   config.leaveChannelId   = leaveChannelId;
  fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
  res.json({ success: true });
});

// ── Test Welcome Message ─────────────────────────────────────
app.post('/api/test/welcome', async (req, res) => {
  const { channelId } = req.body;
  const guild = client.guilds.cache.first();
  try {
    const ch = guild.channels.cache.get(channelId);
    await ch.send({ embeds: [new EmbedBuilder().setColor(0x00ff88).setTitle('👋 رسالة ترحيب تجريبية').setDescription('مرحباً بك في السيرفر!').setTimestamp()] });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ────────────────────────────────────────────────────────────
//  START SERVER
// ────────────────────────────────────────────────────────────
const PORT = config.port || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
});

client.login(config.token).catch(err => {
  console.error('❌ Bot login failed:', err.message);
  pushLog('system', `Bot login failed: ${err.message}`);
});
