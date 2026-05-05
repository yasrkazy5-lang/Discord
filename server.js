// ============================================================
//  DISCORD BOT - FULL DASHBOARD BACKEND
//  server.js - All logic in one file
// ============================================================
'use strict';

const express      = require('express');
const cors         = require('cors');
const bodyParser   = require('body-parser');
const path         = require('path');
const http         = require('http');
const WebSocket    = require('ws');
const fs           = require('fs');

// ─── Express Setup ───────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ─── In-Memory Storage ───────────────────────────────────────
let BOT_CLIENT     = null;
let BOT_TOKEN      = null;
let START_TIME     = null;
let isConnected    = false;

// Persistent data stored in memory (reset on restart)
const DATA = {
  warns:           {},   // { userId: [{ reason, date, mod }] }
  autoRoles:       [],   // roleIds given on join
  welcomeConfig:   { channelId: '', message: '', embedColor: '#5865F2', enabled: false },
  leaveConfig:     { channelId: '', message: '', embedColor: '#ED4245', enabled: false },
  autoResponses:   [],   // [{ trigger, response, exact }]
  tickets:         { categoryId: '', supportRoleId: '', count: 0, list: [] },
  mutedUsers:      {},   // { userId: { until, channelId, timeoutId } }
  lockedChannels:  [],   // channelIds
  badWords:        ['fuck','shit','ass','bitch','damn','اهبل','كلب','حمار','خرا','زبالة','منيوك','كس','زب','شرموط','عاهر'],
  antiSpam:        {},   // { userId: [timestamps] }
  antiGhostPing:   true,
  antiLinks:       true,
  antiMention:     { enabled: true, max: 3 },
  antiRepeat:      { enabled: true, threshold: 3 },
  recentMessages:  {},   // { userId: [content] }
  violations:      0,
  stats:           { joins: 0, leaves: 0, ticketsOpened: 0, messagesDeleted: 0 },
  allowedRoles:    [],   // roles that bypass moderation
  logChannel:      '',
  muteRole:        '',
};

// ─── WebSocket broadcast ─────────────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ─── Discord.js Dynamic Import ───────────────────────────────
async function getDiscord() {
  return require('discord.js');
}

// ─── Start Bot ───────────────────────────────────────────────
async function startBot(token) {
  if (BOT_CLIENT) {
    try { BOT_CLIENT.destroy(); } catch(_) {}
    BOT_CLIENT = null;
    isConnected = false;
  }

  const {
    Client, GatewayIntentBits, Partials, EmbedBuilder,
    PermissionsBitField, ActionRowBuilder, ButtonBuilder,
    ButtonStyle, ChannelType, AuditLogEvent
  } = require('discord.js');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildBans,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
  });

  // ══════════════════════════════════════════════════════════
  //  PREFIX & COMMAND HANDLER
  // ══════════════════════════════════════════════════════════
  const PREFIX = '!';

  // ─── Helper: Send embed ───────────────────────────────────
  function sendEmbed(channel, { title, description, color = '#5865F2', fields = [], footer = '' }) {
    const embed = new EmbedBuilder()
      .setTitle(title || '')
      .setDescription(description || '')
      .setColor(color)
      .setTimestamp();
    if (fields.length) embed.addFields(fields);
    if (footer) embed.setFooter({ text: footer });
    return channel.send({ embeds: [embed] });
  }

  // ─── Helper: Has permission ───────────────────────────────
  function hasModPerm(member) {
    return member.permissions.has(PermissionsBitField.Flags.ManageMessages)
        || member.permissions.has(PermissionsBitField.Flags.Administrator)
        || member.permissions.has(PermissionsBitField.Flags.BanMembers);
  }

  // ─── Helper: Log to log channel ──────────────────────────
  async function logAction(guild, embed) {
    if (!DATA.logChannel) return;
    try {
      const ch = guild.channels.cache.get(DATA.logChannel);
      if (ch) await ch.send({ embeds: [embed] });
    } catch(_) {}
  }

  // ─── Helper: Parse duration (e.g. 10m, 2h, 1d) ───────────
  function parseDuration(str) {
    const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    const match = str.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    return parseInt(match[1]) * (units[match[2]] || 0);
  }

  // ══════════════════════════════════════════════════════════
  //  EVENT: MESSAGE CREATE - MODERATION + COMMANDS
  // ══════════════════════════════════════════════════════════
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const content  = message.content;
    const member   = message.member;
    const guild    = message.guild;
    const channel  = message.channel;
    const userId   = message.author.id;

    // ── Check if user has allowed (bypass) role ──────────────
    const isBypass = DATA.allowedRoles.some(r => member.roles.cache.has(r));

    // ══════════════════════════════════════════════════════════
    //  SMART MODERATION
    // ══════════════════════════════════════════════════════════
    if (!isBypass && !hasModPerm(member)) {

      // 1. Anti Bad Words
      const lc = content.toLowerCase();
      if (DATA.badWords.some(w => lc.includes(w.toLowerCase()))) {
        try { await message.delete(); } catch(_) {}
        DATA.violations++;
        const warn = sendEmbed(channel, {
          title: '⛔ تحذير - كلام غير لائق',
          description: `<@${userId}> يُمنع استخدام الألفاظ غير اللائقة!`,
          color: '#ED4245'
        });
        setTimeout(() => warn.then(m => m.delete().catch(()=>{})), 5000);
        addWarn(guild, userId, message.author.tag, 'كلام غير لائق', client.user?.tag || 'Bot');
        broadcast('violation', { type: 'badword', user: message.author.tag, content });
        return;
      }

      // 2. Anti Links
      if (DATA.antiLinks && /(https?:\/\/|discord\.gg\/|www\.)/i.test(content)) {
        try { await message.delete(); } catch(_) {}
        DATA.violations++;
        const warn = sendEmbed(channel, {
          title: '🔗 تحذير - روابط ممنوعة',
          description: `<@${userId}> لا يُسمح بإرسال الروابط هنا!`,
          color: '#FEE75C'
        });
        setTimeout(() => warn.then(m => m.delete().catch(()=>{})), 5000);
        broadcast('violation', { type: 'link', user: message.author.tag });
        return;
      }

      // 3. Anti Mass Mention
      if (DATA.antiMention.enabled && message.mentions.users.size >= DATA.antiMention.max) {
        try { await message.delete(); } catch(_) {}
        DATA.violations++;
        const warn = sendEmbed(channel, {
          title: '📢 تحذير - منشن مفرط',
          description: `<@${userId}> لا تذكر أكثر من ${DATA.antiMention.max} أشخاص في رسالة واحدة!`,
          color: '#FEE75C'
        });
        setTimeout(() => warn.then(m => m.delete().catch(()=>{})), 5000);
        broadcast('violation', { type: 'mention', user: message.author.tag });
        return;
      }

      // 4. Anti Spam (5 messages in 5 seconds)
      const now = Date.now();
      if (!DATA.antiSpam[userId]) DATA.antiSpam[userId] = [];
      DATA.antiSpam[userId] = DATA.antiSpam[userId].filter(t => now - t < 5000);
      DATA.antiSpam[userId].push(now);
      if (DATA.antiSpam[userId].length >= 5) {
        try { await message.delete(); } catch(_) {}
        DATA.violations++;
        const warn = sendEmbed(channel, {
          title: '🚫 تحذير - سبام',
          description: `<@${userId}> أنت ترسل رسائل بشكل متسارع! تهدأ قليلاً.`,
          color: '#ED4245'
        });
        setTimeout(() => warn.then(m => m.delete().catch(()=>{})), 5000);
        DATA.antiSpam[userId] = [];
        broadcast('violation', { type: 'spam', user: message.author.tag });
        return;
      }

      // 5. Anti Repeat Messages
      if (DATA.antiRepeat.enabled) {
        if (!DATA.recentMessages[userId]) DATA.recentMessages[userId] = [];
        DATA.recentMessages[userId].push(content);
        if (DATA.recentMessages[userId].length > DATA.antiRepeat.threshold) {
          DATA.recentMessages[userId].shift();
        }
        const last = DATA.recentMessages[userId];
        if (last.length >= DATA.antiRepeat.threshold && last.every(m => m === content)) {
          try { await message.delete(); } catch(_) {}
          DATA.violations++;
          const warn = sendEmbed(channel, {
            title: '🔁 تحذير - تكرار الرسائل',
            description: `<@${userId}> لا تكرر نفس الرسالة أكثر من مرة!`,
            color: '#FEE75C'
          });
          setTimeout(() => warn.then(m => m.delete().catch(()=>{})), 5000);
          DATA.recentMessages[userId] = [];
          broadcast('violation', { type: 'repeat', user: message.author.tag });
          return;
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    //  AUTO RESPONSES
    // ══════════════════════════════════════════════════════════
    for (const ar of DATA.autoResponses) {
      const trigger = ar.trigger.toLowerCase();
      const msgLc   = content.toLowerCase();
      const matched = ar.exact ? msgLc === trigger : msgLc.includes(trigger);
      if (matched) {
        try { await channel.send(ar.response); } catch(_) {}
        return;
      }
    }

    // ══════════════════════════════════════════════════════════
    //  COMMAND HANDLER
    // ══════════════════════════════════════════════════════════
    if (!content.startsWith(PREFIX)) return;

    const args    = content.slice(PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    // ── !help ─────────────────────────────────────────────────
    if (command === 'help') {
      await sendEmbed(channel, {
        title: '📋 قائمة الأوامر',
        description: 'جميع الأوامر المتاحة في البوت',
        color: '#5865F2',
        fields: [
          { name: '🛡️ الإشراف', value: '`!ban` `!kick` `!mute` `!unmute` `!warn` `!warns` `!clearwarn` `!clear` `!lock` `!unlock`', inline: false },
          { name: '👑 الرتب',    value: '`!giverole` `!removerole`', inline: false },
          { name: '🎭 التفاعل',  value: '`!giveaway` `!ticket` `!botinfo`', inline: false },
          { name: '📊 الإحصاء', value: '`!stats` `!ping` `!uptime`', inline: false },
        ],
        footer: 'لوحة التحكم متاحة عبر الويب'
      });
      return;
    }

    // ── !ping ─────────────────────────────────────────────────
    if (command === 'ping') {
      const ping = client.ws.ping;
      await sendEmbed(channel, {
        title: '🏓 Pong!',
        description: `البينق: **${ping}ms**`,
        color: ping < 100 ? '#57F287' : ping < 200 ? '#FEE75C' : '#ED4245'
      });
      return;
    }

    // ── !uptime ───────────────────────────────────────────────
    if (command === 'uptime') {
      const up = getUptime();
      await sendEmbed(channel, {
        title: '⏱️ وقت التشغيل',
        description: `البوت يعمل منذ: **${up}**`,
        color: '#57F287'
      });
      return;
    }

    // ── !stats ────────────────────────────────────────────────
    if (command === 'stats') {
      const g = guild;
      await sendEmbed(channel, {
        title: '📊 إحصائيات السيرفر',
        color: '#5865F2',
        fields: [
          { name: '👥 الأعضاء',       value: `${g.memberCount}`, inline: true },
          { name: '🏓 البينق',         value: `${client.ws.ping}ms`, inline: true },
          { name: '⏱️ Uptime',        value: getUptime(), inline: true },
          { name: '⚠️ المخالفات',     value: `${DATA.violations}`, inline: true },
          { name: '🎫 التذاكر',       value: `${DATA.stats.ticketsOpened}`, inline: true },
          { name: '🗑️ رسائل محذوفة', value: `${DATA.stats.messagesDeleted}`, inline: true },
        ]
      });
      return;
    }

    // ── !botinfo ──────────────────────────────────────────────
    if (command === 'botinfo') {
      await sendEmbed(channel, {
        title: '🤖 معلومات البوت',
        color: '#5865F2',
        fields: [
          { name: 'الاسم',       value: client.user.tag, inline: true },
          { name: 'المعرف',     value: client.user.id,  inline: true },
          { name: 'السيرفرات', value: `${client.guilds.cache.size}`, inline: true },
          { name: 'Uptime',    value: getUptime(), inline: true },
          { name: 'Ping',      value: `${client.ws.ping}ms`, inline: true },
        ]
      });
      return;
    }

    // ── MODERATION COMMANDS (require mod perms) ───────────────
    if (!hasModPerm(member)) {
      await sendEmbed(channel, {
        title: '❌ خطأ',
        description: 'ليس لديك صلاحية لاستخدام هذا الأمر!',
        color: '#ED4245'
      });
      return;
    }

    // ── !ban <@user> [reason] ─────────────────────────────────
    if (command === 'ban') {
      const target = message.mentions.members.first();
      if (!target) { await channel.send('❌ حدد عضواً للبان.'); return; }
      const reason = args.slice(1).join(' ') || 'لا يوجد سبب';
      try {
        await target.ban({ reason });
        await sendEmbed(channel, {
          title: '🔨 تم البان',
          description: `تم بان **${target.user.tag}**\n**السبب:** ${reason}`,
          color: '#ED4245',
          footer: `بواسطة: ${message.author.tag}`
        });
        await logAction(guild, new EmbedBuilder().setTitle('🔨 Ban').setDescription(`**العضو:** ${target.user.tag}\n**السبب:** ${reason}\n**المشرف:** ${message.author.tag}`).setColor('#ED4245').setTimestamp());
        broadcast('modAction', { action: 'ban', target: target.user.tag, mod: message.author.tag, reason });
      } catch(e) { await channel.send(`❌ فشل البان: ${e.message}`); }
      return;
    }

    // ── !kick <@user> [reason] ────────────────────────────────
    if (command === 'kick') {
      const target = message.mentions.members.first();
      if (!target) { await channel.send('❌ حدد عضواً للطرد.'); return; }
      const reason = args.slice(1).join(' ') || 'لا يوجد سبب';
      try {
        await target.kick(reason);
        await sendEmbed(channel, {
          title: '👢 تم الطرد',
          description: `تم طرد **${target.user.tag}**\n**السبب:** ${reason}`,
          color: '#FEE75C',
          footer: `بواسطة: ${message.author.tag}`
        });
        await logAction(guild, new EmbedBuilder().setTitle('👢 Kick').setDescription(`**العضو:** ${target.user.tag}\n**السبب:** ${reason}\n**المشرف:** ${message.author.tag}`).setColor('#FEE75C').setTimestamp());
        broadcast('modAction', { action: 'kick', target: target.user.tag, mod: message.author.tag, reason });
      } catch(e) { await channel.send(`❌ فشل الطرد: ${e.message}`); }
      return;
    }

    // ── !mute <@user> <duration> [reason] ────────────────────
    if (command === 'mute') {
      const target = message.mentions.members.first();
      if (!target) { await channel.send('❌ حدد عضواً للكتم.'); return; }
      const durStr = args[1];
      const dur    = durStr ? parseDuration(durStr) : 600000; // default 10m
      const reason = args.slice(2).join(' ') || 'لا يوجد سبب';
      if (!dur) { await channel.send('❌ مدة غير صالحة. مثال: 10m, 2h, 1d'); return; }
      try {
        await target.timeout(dur, reason);
        await sendEmbed(channel, {
          title: '🔇 تم الكتم',
          description: `تم كتم **${target.user.tag}** لمدة **${durStr || '10m'}**\n**السبب:** ${reason}`,
          color: '#FEE75C',
          footer: `بواسطة: ${message.author.tag}`
        });
        await logAction(guild, new EmbedBuilder().setTitle('🔇 Mute').setDescription(`**العضو:** ${target.user.tag}\n**المدة:** ${durStr || '10m'}\n**السبب:** ${reason}\n**المشرف:** ${message.author.tag}`).setColor('#FEE75C').setTimestamp());
        broadcast('modAction', { action: 'mute', target: target.user.tag, mod: message.author.tag, duration: durStr, reason });
      } catch(e) { await channel.send(`❌ فشل الكتم: ${e.message}`); }
      return;
    }

    // ── !unmute <@user> ───────────────────────────────────────
    if (command === 'unmute') {
      const target = message.mentions.members.first();
      if (!target) { await channel.send('❌ حدد عضواً.'); return; }
      try {
        await target.timeout(null);
        await sendEmbed(channel, {
          title: '🔊 تم رفع الكتم',
          description: `تم رفع الكتم عن **${target.user.tag}**`,
          color: '#57F287'
        });
        broadcast('modAction', { action: 'unmute', target: target.user.tag, mod: message.author.tag });
      } catch(e) { await channel.send(`❌ فشل: ${e.message}`); }
      return;
    }

    // ── !warn <@user> <reason> ────────────────────────────────
    if (command === 'warn') {
      const target = message.mentions.members.first();
      if (!target) { await channel.send('❌ حدد عضواً.'); return; }
      const reason = args.slice(1).join(' ') || 'لا يوجد سبب';
      addWarn(guild, target.user.id, target.user.tag, reason, message.author.tag);
      const count = (DATA.warns[target.user.id] || []).length;
      await sendEmbed(channel, {
        title: '⚠️ تحذير',
        description: `تم تحذير **${target.user.tag}**\n**السبب:** ${reason}\n**إجمالي التحذيرات:** ${count}`,
        color: '#FEE75C',
        footer: `بواسطة: ${message.author.tag}`
      });
      broadcast('modAction', { action: 'warn', target: target.user.tag, mod: message.author.tag, reason, total: count });
      // Auto action on 3 warns
      if (count >= 3) {
        try { await target.timeout(3600000, 'تجاوز 3 تحذيرات'); } catch(_) {}
        await channel.send(`⚠️ **${target.user.tag}** وصل لـ 3 تحذيرات، تم الكتم تلقائياً لمدة ساعة!`);
      }
      return;
    }

    // ── !warns <@user> ────────────────────────────────────────
    if (command === 'warns') {
      const target = message.mentions.users.first();
      if (!target) { await channel.send('❌ حدد عضواً.'); return; }
      const warns = DATA.warns[target.id] || [];
      if (!warns.length) { await channel.send(`✅ **${target.tag}** ليس لديه تحذيرات.`); return; }
      const fields = warns.map((w, i) => ({
        name: `تحذير #${i + 1}`,
        value: `**السبب:** ${w.reason}\n**بواسطة:** ${w.mod}\n**التاريخ:** ${w.date}`,
        inline: false
      }));
      await sendEmbed(channel, {
        title: `⚠️ تحذيرات ${target.tag}`,
        description: `إجمالي التحذيرات: **${warns.length}**`,
        color: '#FEE75C',
        fields
      });
      return;
    }

    // ── !clearwarn <@user> ────────────────────────────────────
    if (command === 'clearwarn') {
      const target = message.mentions.users.first();
      if (!target) { await channel.send('❌ حدد عضواً.'); return; }
      DATA.warns[target.id] = [];
      await sendEmbed(channel, {
        title: '✅ تم مسح التحذيرات',
        description: `تم مسح جميع تحذيرات **${target.tag}**`,
        color: '#57F287'
      });
      return;
    }

    // ── !clear <count> ────────────────────────────────────────
    if (command === 'clear') {
      const count = parseInt(args[0]);
      if (!count || count < 1 || count > 100) { await channel.send('❌ حدد عدداً من 1 إلى 100.'); return; }
      try {
        const deleted = await channel.bulkDelete(count, true);
        DATA.stats.messagesDeleted += deleted.size;
        const msg = await sendEmbed(channel, {
          title: '🗑️ تم المسح',
          description: `تم مسح **${deleted.size}** رسالة`,
          color: '#57F287'
        });
        setTimeout(() => msg.delete().catch(()=>{}), 3000);
        broadcast('modAction', { action: 'clear', count: deleted.size, mod: message.author.tag });
      } catch(e) { await channel.send(`❌ فشل المسح: ${e.message}`); }
      return;
    }

    // ── !lock [reason] ────────────────────────────────────────
    if (command === 'lock') {
      const reason = args.join(' ') || 'تم قفل القناة';
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        if (!DATA.lockedChannels.includes(channel.id)) DATA.lockedChannels.push(channel.id);
        await sendEmbed(channel, {
          title: '🔒 تم قفل القناة',
          description: `**السبب:** ${reason}`,
          color: '#ED4245',
          footer: `بواسطة: ${message.author.tag}`
        });
        broadcast('modAction', { action: 'lock', channel: channel.name, mod: message.author.tag });
      } catch(e) { await channel.send(`❌ فشل القفل: ${e.message}`); }
      return;
    }

    // ── !unlock ───────────────────────────────────────────────
    if (command === 'unlock') {
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
        DATA.lockedChannels = DATA.lockedChannels.filter(id => id !== channel.id);
        await sendEmbed(channel, {
          title: '🔓 تم فتح القناة',
          description: 'تم فتح القناة للإرسال مجدداً',
          color: '#57F287',
          footer: `بواسطة: ${message.author.tag}`
        });
        broadcast('modAction', { action: 'unlock', channel: channel.name, mod: message.author.tag });
      } catch(e) { await channel.send(`❌ فشل الفتح: ${e.message}`); }
      return;
    }

    // ── !giverole <@user> <roleId> ───────────────────────────
    if (command === 'giverole') {
      const target = message.mentions.members.first();
      const roleId = args[1];
      if (!target || !roleId) { await channel.send('❌ الاستخدام: `!giverole @عضو roleId`'); return; }
      try {
        const role = guild.roles.cache.get(roleId);
        if (!role) { await channel.send('❌ الرتبة غير موجودة.'); return; }
        await target.roles.add(role);
        await sendEmbed(channel, {
          title: '✅ تم إعطاء الرتبة',
          description: `تم إعطاء **${target.user.tag}** رتبة **${role.name}**`,
          color: '#57F287'
        });
        broadcast('modAction', { action: 'giverole', target: target.user.tag, role: role.name });
      } catch(e) { await channel.send(`❌ فشل: ${e.message}`); }
      return;
    }

    // ── !removerole <@user> <roleId> ─────────────────────────
    if (command === 'removerole') {
      const target = message.mentions.members.first();
      const roleId = args[1];
      if (!target || !roleId) { await channel.send('❌ الاستخدام: `!removerole @عضو roleId`'); return; }
      try {
        const role = guild.roles.cache.get(roleId);
        if (!role) { await channel.send('❌ الرتبة غير موجودة.'); return; }
        await target.roles.remove(role);
        await sendEmbed(channel, {
          title: '✅ تم سحب الرتبة',
          description: `تم سحب رتبة **${role.name}** من **${target.user.tag}**`,
          color: '#FEE75C'
        });
        broadcast('modAction', { action: 'removerole', target: target.user.tag, role: role.name });
      } catch(e) { await channel.send(`❌ فشل: ${e.message}`); }
      return;
    }

    // ── !giveaway <duration> <prize> ─────────────────────────
    if (command === 'giveaway') {
      const durStr = args[0];
      const prize  = args.slice(1).join(' ');
      if (!durStr || !prize) { await channel.send('❌ الاستخدام: `!giveaway 1h جائزة`'); return; }
      const dur = parseDuration(durStr);
      if (!dur) { await channel.send('❌ مدة غير صالحة.'); return; }

      const gEmbed = new EmbedBuilder()
        .setTitle('🎉 مسابقة!')
        .setDescription(`**الجائزة:** ${prize}\n**المدة:** ${durStr}\n\nاضغط على 🎉 للمشاركة!`)
        .setColor('#FFD700')
        .setFooter({ text: `تنتهي في ${new Date(Date.now() + dur).toLocaleTimeString('ar')}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('giveaway_join').setLabel('🎉 اشترك').setStyle(ButtonStyle.Success)
      );

      const gMsg = await channel.send({ embeds: [gEmbed], components: [row] });
      const participants = new Set();

      const collector = gMsg.createMessageComponentCollector({ time: dur });
      collector.on('collect', async (i) => {
        if (participants.has(i.user.id)) {
          await i.reply({ content: '✅ أنت مسجل بالفعل!', ephemeral: true });
        } else {
          participants.add(i.user.id);
          await i.reply({ content: `🎉 تم تسجيلك! عدد المشاركين: **${participants.size}**`, ephemeral: true });
        }
      });

      collector.on('end', async () => {
        if (participants.size === 0) {
          await gMsg.edit({ content: '❌ لا يوجد مشاركون في المسابقة!', components: [] });
          return;
        }
        const winnerId = [...participants][Math.floor(Math.random() * participants.size)];
        const winner   = await guild.members.fetch(winnerId).catch(()=>null);
        const winEmbed = new EmbedBuilder()
          .setTitle('🏆 انتهت المسابقة!')
          .setDescription(`**الجائزة:** ${prize}\n**الفائز:** ${winner ? `<@${winnerId}>` : winnerId}\n**المشاركون:** ${participants.size}`)
          .setColor('#FFD700').setTimestamp();
        await gMsg.edit({ embeds: [winEmbed], components: [] });
        await channel.send(`🎊 مبروك <@${winnerId}>! لقد فزت بـ **${prize}**!`);
        broadcast('giveaway', { prize, winner: winner?.user?.tag || winnerId, participants: participants.size });
      });
      return;
    }

    // ── !ticket ───────────────────────────────────────────────
    if (command === 'ticket') {
      const topic = args.join(' ') || 'طلب دعم';
      await createTicket(guild, member, channel, topic);
      return;
    }
  });

  // ══════════════════════════════════════════════════════════
  //  GHOST PING DETECTION
  // ══════════════════════════════════════════════════════════
  client.on('messageDelete', async (message) => {
    if (!message.guild || !DATA.antiGhostPing) return;
    if (message.author?.bot) return;
    if (message.mentions?.users?.size > 0 || message.mentions?.roles?.size > 0) {
      DATA.violations++;
      const ch = message.channel;
      try {
        await sendEmbed(ch, {
          title: '👻 Ghost Ping مكتشف!',
          description: `**${message.author?.tag}** قام بمنشن ثم حذف الرسالة!\n**الرسالة:** ${message.content?.slice(0, 200) || 'غير متاحة'}`,
          color: '#ED4245'
        });
        broadcast('violation', { type: 'ghostping', user: message.author?.tag });
      } catch(_) {}
    }
  });

  // ══════════════════════════════════════════════════════════
  //  WELCOME & LEAVE EVENTS
  // ══════════════════════════════════════════════════════════
  client.on('guildMemberAdd', async (member) => {
    DATA.stats.joins++;
    broadcast('memberJoin', { user: member.user.tag, count: member.guild.memberCount });

    // Auto Role
    for (const roleId of DATA.autoRoles) {
      try {
        const role = member.guild.roles.cache.get(roleId);
        if (role) await member.roles.add(role);
      } catch(_) {}
    }

    // Welcome Message
    if (DATA.welcomeConfig.enabled && DATA.welcomeConfig.channelId) {
      try {
        const ch = member.guild.channels.cache.get(DATA.welcomeConfig.channelId);
        if (!ch) return;
        const msg = DATA.welcomeConfig.message
          .replace('{user}', `<@${member.id}>`)
          .replace('{username}', member.user.username)
          .replace('{server}', member.guild.name)
          .replace('{count}', member.guild.memberCount);
        const embed = new EmbedBuilder()
          .setTitle('👋 عضو جديد!')
          .setDescription(msg)
          .setColor(DATA.welcomeConfig.embedColor)
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
          .setFooter({ text: `العضو رقم ${member.guild.memberCount}` })
          .setTimestamp();
        await ch.send({ embeds: [embed] });
      } catch(_) {}
    }
  });

  client.on('guildMemberRemove', async (member) => {
    DATA.stats.leaves++;
    broadcast('memberLeave', { user: member.user.tag, count: member.guild.memberCount });

    if (DATA.leaveConfig.enabled && DATA.leaveConfig.channelId) {
      try {
        const ch = member.guild.channels.cache.get(DATA.leaveConfig.channelId);
        if (!ch) return;
        const msg = DATA.leaveConfig.message
          .replace('{user}', member.user.username)
          .replace('{server}', member.guild.name)
          .replace('{count}', member.guild.memberCount);
        const embed = new EmbedBuilder()
          .setTitle('👋 مغادرة عضو')
          .setDescription(msg)
          .setColor(DATA.leaveConfig.embedColor)
          .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
          .setTimestamp();
        await ch.send({ embeds: [embed] });
      } catch(_) {}
    }
  });

  // ══════════════════════════════════════════════════════════
  //  BUTTON INTERACTIONS (Tickets etc.)
  // ══════════════════════════════════════════════════════════
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    const { customId, guild, member } = interaction;

    if (customId === 'ticket_create') {
      await interaction.deferReply({ ephemeral: true });
      await createTicket(guild, member, interaction.channel, 'طلب دعم');
      await interaction.editReply({ content: '✅ تم إنشاء تذكرتك!' });
    }

    if (customId === 'ticket_close') {
      try {
        await interaction.channel.delete();
        DATA.tickets.list = DATA.tickets.list.filter(t => t.channelId !== interaction.channel.id);
      } catch(_) {
        await interaction.reply({ content: '❌ فشل إغلاق التذكرة', ephemeral: true });
      }
    }
  });

  // ══════════════════════════════════════════════════════════
  //  HELPER FUNCTIONS
  // ══════════════════════════════════════════════════════════
  function addWarn(guild, userId, userTag, reason, modTag) {
    if (!DATA.warns[userId]) DATA.warns[userId] = [];
    DATA.warns[userId].push({
      reason,
      mod: modTag,
      date: new Date().toLocaleDateString('ar')
    });
    DATA.violations++;
    broadcast('warnAdded', { user: userTag, reason, total: DATA.warns[userId].length });
  }

  async function createTicket(guild, member, channel, topic) {
    try {
      DATA.tickets.count++;
      DATA.stats.ticketsOpened++;
      const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
      const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: member.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ];
      if (DATA.tickets.supportRoleId) {
        overwrites.push({ id: DATA.tickets.supportRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] });
      }
      const ticketChannel = await guild.channels.create({
        name: `ticket-${DATA.tickets.count}-${member.user.username}`,
        type: ChannelType.GuildText,
        parent: DATA.tickets.categoryId || null,
        permissionOverwrites: overwrites
      });
      const embed = new EmbedBuilder()
        .setTitle(`🎫 تذكرة #${DATA.tickets.count}`)
        .setDescription(`**الموضوع:** ${topic}\n**المستخدم:** <@${member.id}>\n\nسيرد عليك فريق الدعم قريباً.`)
        .setColor('#5865F2').setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('🔒 إغلاق التذكرة').setStyle(ButtonStyle.Danger)
      );
      await ticketChannel.send({ content: `<@${member.id}>`, embeds: [embed], components: [row] });
      DATA.tickets.list.push({ channelId: ticketChannel.id, userId: member.id, topic, number: DATA.tickets.count });
      broadcast('ticketCreated', { number: DATA.tickets.count, user: member.user.tag, topic });
    } catch(e) {
      console.error('Ticket error:', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════
  //  BOT READY
  // ══════════════════════════════════════════════════════════
  client.once('ready', () => {
    isConnected = true;
    START_TIME  = Date.now();
    BOT_CLIENT  = client;
    console.log(`✅ Bot ready: ${client.user.tag}`);
    broadcast('botReady', {
      tag:   client.user.tag,
      id:    client.user.id,
      avatar: client.user.displayAvatarURL(),
      guilds: client.guilds.cache.size
    });
    // Status
    client.user.setPresence({ activities: [{ name: 'لوحة التحكم 🎛️', type: 4 }], status: 'online' });
  });

  client.on('error', (e) => {
    console.error('Bot error:', e.message);
    broadcast('botError', { message: e.message });
  });

  try {
    await client.login(token);
    return { success: true };
  } catch(e) {
    return { success: false, error: e.message };
  }
}

// ─── Uptime Helper ────────────────────────────────────────────
function getUptime() {
  if (!START_TIME) return 'غير متصل';
  const ms  = Date.now() - START_TIME;
  const d   = Math.floor(ms / 86400000);
  const h   = Math.floor((ms % 86400000) / 3600000);
  const m   = Math.floor((ms % 3600000) / 60000);
  const s   = Math.floor((ms % 60000) / 1000);
  return `${d}يوم ${h}س ${m}د ${s}ث`;
}

// ══════════════════════════════════════════════════════════════
//  REST API ROUTES
// ══════════════════════════════════════════════════════════════

// ─── Connect Bot ─────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ success: false, error: 'التوكن مطلوب' });
  BOT_TOKEN = token;
  const result = await startBot(token);
  res.json(result);
});

// ─── Disconnect ───────────────────────────────────────────────
app.post('/api/disconnect', (req, res) => {
  if (BOT_CLIENT) { try { BOT_CLIENT.destroy(); } catch(_) {} BOT_CLIENT = null; }
  isConnected = false; START_TIME = null;
  broadcast('botDisconnected', {});
  res.json({ success: true });
});

// ─── Status ───────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const bot = BOT_CLIENT;
  res.json({
    connected: isConnected,
    tag:       bot?.user?.tag || null,
    id:        bot?.user?.id  || null,
    avatar:    bot?.user?.displayAvatarURL() || null,
    guilds:    bot?.guilds?.cache?.size || 0,
    ping:      bot?.ws?.ping || 0,
    uptime:    getUptime(),
    violations: DATA.violations,
    members:   bot?.guilds?.cache?.reduce((a, g) => a + g.memberCount, 0) || 0,
    stats:     DATA.stats,
    tickets:   DATA.tickets.count,
  });
});

// ─── Get Guilds ───────────────────────────────────────────────
app.get('/api/guilds', (req, res) => {
  if (!BOT_CLIENT) return res.json([]);
  const guilds = BOT_CLIENT.guilds.cache.map(g => ({
    id: g.id, name: g.name, icon: g.iconURL(), members: g.memberCount
  }));
  res.json(guilds);
});

// ─── Get Channels ─────────────────────────────────────────────
app.get('/api/guilds/:guildId/channels', (req, res) => {
  if (!BOT_CLIENT) return res.json([]);
  const guild = BOT_CLIENT.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);
  const channels = guild.channels.cache
    .filter(c => c.type === 0)
    .map(c => ({ id: c.id, name: c.name }));
  res.json(channels);
});

// ─── Get Roles ────────────────────────────────────────────────
app.get('/api/guilds/:guildId/roles', (req, res) => {
  if (!BOT_CLIENT) return res.json([]);
  const guild = BOT_CLIENT.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);
  const roles = guild.roles.cache
    .filter(r => r.name !== '@everyone')
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, members: r.members.size }));
  res.json(roles);
});

// ─── Create Role ──────────────────────────────────────────────
app.post('/api/guilds/:guildId/roles', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false, error: 'Bot not connected' });
  const { name, color } = req.body;
  const guild = BOT_CLIENT.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json({ success: false, error: 'Guild not found' });
  try {
    const role = await guild.roles.create({ name, color: color || '#99AAB5', reason: 'Created via Dashboard' });
    res.json({ success: true, role: { id: role.id, name: role.name, color: role.hexColor } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Give Role to Member ──────────────────────────────────────
app.post('/api/guilds/:guildId/members/:userId/roles', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false });
  const { roleId, action } = req.body;
  const guild = BOT_CLIENT.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json({ success: false, error: 'Guild not found' });
  try {
    const member = await guild.members.fetch(req.params.userId);
    if (action === 'add') await member.roles.add(roleId);
    else await member.roles.remove(roleId);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Moderation Actions ───────────────────────────────────────
app.post('/api/guilds/:guildId/mod', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false, error: 'Bot not connected' });
  const { action, userId, reason, duration } = req.body;
  const guild = BOT_CLIENT.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json({ success: false, error: 'Guild not found' });
  try {
    const member = await guild.members.fetch(userId).catch(()=>null);
    if (!member) return res.json({ success: false, error: 'Member not found' });
    if (action === 'ban')    await member.ban({ reason: reason || 'Dashboard' });
    if (action === 'kick')   await member.kick(reason || 'Dashboard');
    if (action === 'mute') {
      const dur = duration ? parseDuration(duration) : 600000;
      await member.timeout(dur, reason || 'Dashboard');
    }
    if (action === 'unmute') await member.timeout(null);
    broadcast('modAction', { action, target: member.user.tag, reason, mod: 'Dashboard' });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }

  function parseDuration(str) {
    const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
    const match = str.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    return parseInt(match[1]) * (units[match[2]] || 0);
  }
});

// ─── Auto Responses ───────────────────────────────────────────
app.get('/api/autoresponses',      (req, res) => res.json(DATA.autoResponses));
app.post('/api/autoresponses',     (req, res) => {
  const { trigger, response, exact } = req.body;
  if (!trigger || !response) return res.json({ success: false, error: 'trigger و response مطلوبان' });
  DATA.autoResponses.push({ trigger, response, exact: !!exact });
  res.json({ success: true, autoResponses: DATA.autoResponses });
});
app.delete('/api/autoresponses/:index', (req, res) => {
  const i = parseInt(req.params.index);
  if (i < 0 || i >= DATA.autoResponses.length) return res.json({ success: false });
  DATA.autoResponses.splice(i, 1);
  res.json({ success: true, autoResponses: DATA.autoResponses });
});

// ─── Welcome / Leave Config ───────────────────────────────────
app.get('/api/welcome',  (req, res) => res.json(DATA.welcomeConfig));
app.post('/api/welcome', (req, res) => {
  Object.assign(DATA.welcomeConfig, req.body);
  res.json({ success: true, config: DATA.welcomeConfig });
});
app.get('/api/leave',    (req, res) => res.json(DATA.leaveConfig));
app.post('/api/leave',   (req, res) => {
  Object.assign(DATA.leaveConfig, req.body);
  res.json({ success: true, config: DATA.leaveConfig });
});

// ─── Ticket Config ────────────────────────────────────────────
app.get('/api/tickets',  (req, res) => res.json({ config: DATA.tickets }));
app.post('/api/tickets', (req, res) => {
  Object.assign(DATA.tickets, req.body);
  res.json({ success: true });
});

// ─── Auto Roles ───────────────────────────────────────────────
app.get('/api/autoroles',           (req, res) => res.json(DATA.autoRoles));
app.post('/api/autoroles',          (req, res) => {
  const { roleId } = req.body;
  if (!DATA.autoRoles.includes(roleId)) DATA.autoRoles.push(roleId);
  res.json({ success: true, autoRoles: DATA.autoRoles });
});
app.delete('/api/autoroles/:roleId', (req, res) => {
  DATA.autoRoles = DATA.autoRoles.filter(r => r !== req.params.roleId);
  res.json({ success: true, autoRoles: DATA.autoRoles });
});

// ─── Moderation Settings ─────────────────────────────────────
app.get('/api/settings',  (req, res) => res.json({
  antiLinks:    DATA.antiLinks,
  antiGhostPing: DATA.antiGhostPing,
  antiMention:  DATA.antiMention,
  antiRepeat:   DATA.antiRepeat,
  badWords:     DATA.badWords,
  logChannel:   DATA.logChannel,
  allowedRoles: DATA.allowedRoles,
}));
app.post('/api/settings', (req, res) => {
  const { antiLinks, antiGhostPing, antiMention, antiRepeat, badWords, logChannel, allowedRoles } = req.body;
  if (antiLinks    !== undefined) DATA.antiLinks    = antiLinks;
  if (antiGhostPing!== undefined) DATA.antiGhostPing= antiGhostPing;
  if (antiMention  !== undefined) Object.assign(DATA.antiMention, antiMention);
  if (antiRepeat   !== undefined) Object.assign(DATA.antiRepeat, antiRepeat);
  if (badWords     !== undefined) DATA.badWords     = badWords;
  if (logChannel   !== undefined) DATA.logChannel   = logChannel;
  if (allowedRoles !== undefined) DATA.allowedRoles = allowedRoles;
  res.json({ success: true });
});

// ─── Warns API ────────────────────────────────────────────────
app.get('/api/warns',       (req, res) => res.json(DATA.warns));
app.get('/api/warns/:uid',  (req, res) => res.json(DATA.warns[req.params.uid] || []));
app.delete('/api/warns/:uid', (req, res) => {
  DATA.warns[req.params.uid] = [];
  res.json({ success: true });
});

// ─── Bot Appearance ───────────────────────────────────────────
app.post('/api/bot/appearance', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false, error: 'Bot not connected' });
  const { username, status, statusText, statusType, avatarUrl } = req.body;
  try {
    if (username)   await BOT_CLIENT.user.setUsername(username);
    if (avatarUrl)  await BOT_CLIENT.user.setAvatar(avatarUrl);
    if (status || statusText) {
      const activities = statusText ? [{ name: statusText, type: statusType || 4 }] : [];
      await BOT_CLIENT.user.setPresence({ activities, status: status || 'online' });
    }
    res.json({ success: true, tag: BOT_CLIENT.user.tag });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Send Message via Dashboard ──────────────────────────────
app.post('/api/send', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false, error: 'Bot not connected' });
  const { channelId, content, embed } = req.body;
  try {
    const ch = BOT_CLIENT.channels.cache.get(channelId);
    if (!ch) return res.json({ success: false, error: 'Channel not found' });
    if (embed) {
      const { EmbedBuilder } = require('discord.js');
      const e = new EmbedBuilder()
        .setTitle(embed.title || '')
        .setDescription(embed.description || '')
        .setColor(embed.color || '#5865F2')
        .setTimestamp();
      await ch.send({ embeds: [e] });
    } else {
      await ch.send(content);
    }
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Clear Channel via Dashboard ─────────────────────────────
app.post('/api/clear', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false, error: 'Bot not connected' });
  const { channelId, count } = req.body;
  try {
    const ch = BOT_CLIENT.channels.cache.get(channelId);
    if (!ch) return res.json({ success: false, error: 'Channel not found' });
    const deleted = await ch.bulkDelete(Math.min(count || 10, 100), true);
    DATA.stats.messagesDeleted += deleted.size;
    res.json({ success: true, deleted: deleted.size });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Lock/Unlock Channel via Dashboard ───────────────────────
app.post('/api/channel/lock', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false, error: 'Bot not connected' });
  const { channelId, lock } = req.body;
  try {
    const ch = BOT_CLIENT.channels.cache.get(channelId);
    if (!ch) return res.json({ success: false, error: 'Channel not found' });
    const guild = ch.guild;
    await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : null });
    if (lock) { if (!DATA.lockedChannels.includes(channelId)) DATA.lockedChannels.push(channelId); }
    else       { DATA.lockedChannels = DATA.lockedChannels.filter(id => id !== channelId); }
    res.json({ success: true, locked: lock });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Post Ticket Panel ────────────────────────────────────────
app.post('/api/tickets/panel', async (req, res) => {
  if (!BOT_CLIENT) return res.json({ success: false, error: 'Bot not connected' });
  const { channelId } = req.body;
  try {
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
    const ch = BOT_CLIENT.channels.cache.get(channelId);
    if (!ch) return res.json({ success: false, error: 'Channel not found' });
    const embed = new EmbedBuilder()
      .setTitle('🎫 نظام التذاكر')
      .setDescription('اضغط على الزر أدناه لفتح تذكرة دعم\n\nسيرد عليك فريق الدعم في أقرب وقت ممكن.')
      .setColor('#5865F2').setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_create').setLabel('🎫 فتح تذكرة').setStyle(ButtonStyle.Primary)
    );
    await ch.send({ embeds: [embed], components: [row] });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

// ─── Serve Dashboard ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── WebSocket ────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Dashboard connected via WebSocket');
  // Send current status immediately
  const bot = BOT_CLIENT;
  ws.send(JSON.stringify({ type: 'init', payload: {
    connected: isConnected,
    tag:    bot?.user?.tag || null,
    avatar: bot?.user?.displayAvatarURL() || null,
    guilds: bot?.guilds?.cache?.size || 0,
    ping:   bot?.ws?.ping || 0,
    uptime: getUptime(),
    violations: DATA.violations,
  }}));
});

// ─── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Dashboard running at http://localhost:${PORT}`);
});
