// ╔══════════════════════════════════════════════════════════════════╗
// ║          Discord Bot Dashboard — server.js                      ║
// ║          discord.js v14 + Express REST API                      ║
// ╚══════════════════════════════════════════════════════════════════╝

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Collection,
} = require('discord.js');

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// ─── Discord Client ────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ─── Slash Commands Definition ─────────────────────────────────────
const slashCommands = [
  // BAN
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('🔨 حظر عضو من السيرفر')
    .addUserOption(o => o.setName('user').setDescription('العضو المراد حظره').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('سبب الحظر').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  // KICK
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('👢 طرد عضو من السيرفر')
    .addUserOption(o => o.setName('user').setDescription('العضو المراد طرده').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('سبب الطرد').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  // MUTE (timeout)
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('🔇 كتم عضو مؤقتاً')
    .addUserOption(o => o.setName('user').setDescription('العضو المراد كتمه').setRequired(true))
    .addIntegerOption(o => o.setName('duration').setDescription('المدة بالدقائق').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('سبب الكتم').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // UNMUTE
  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('🔊 رفع كتم عضو')
    .addUserOption(o => o.setName('user').setDescription('العضو المراد رفع كتمه').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // PURGE
  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('🗑️ مسح رسائل من القناة')
    .addIntegerOption(o => o.setName('amount').setDescription('عدد الرسائل (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption(o => o.setName('user').setDescription('مسح رسائل عضو معين فقط').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  // WARN
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('⚠️ إنذار عضو')
    .addUserOption(o => o.setName('user').setDescription('العضو المراد إنذاره').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('سبب الإنذار').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // UNBAN
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('✅ رفع حظر عضو')
    .addStringOption(o => o.setName('userid').setDescription('معرف العضو').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  // CREATE ROLE
  new SlashCommandBuilder()
    .setName('createrole')
    .setDescription('🎭 إنشاء رتبة جديدة')
    .addStringOption(o => o.setName('name').setDescription('اسم الرتبة').setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('لون الرتبة (hex)').setRequired(false))
    .addBooleanOption(o => o.setName('hoist').setDescription('عرض الرتبة منفصلة').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // DELETE ROLE
  new SlashCommandBuilder()
    .setName('deleterole')
    .setDescription('🗑️ حذف رتبة')
    .addRoleOption(o => o.setName('role').setDescription('الرتبة المراد حذفها').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // GIVE ROLE
  new SlashCommandBuilder()
    .setName('giverole')
    .setDescription('🎁 إعطاء رتبة لعضو')
    .addUserOption(o => o.setName('user').setDescription('العضو').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('الرتبة').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // REMOVE ROLE
  new SlashCommandBuilder()
    .setName('removerole')
    .setDescription('❌ إزالة رتبة من عضو')
    .addUserOption(o => o.setName('user').setDescription('العضو').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('الرتبة').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // TICKET
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('🎫 إنشاء نظام تذاكر في القناة الحالية')
    .addStringOption(o => o.setName('category').setDescription('اسم كاتيجوري التذاكر').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // ANNOUNCE
  new SlashCommandBuilder()
    .setName('announce')
    .setDescription('📢 إرسال إعلان مميز')
    .addStringOption(o => o.setName('message').setDescription('نص الإعلان').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('القناة المراد الإرسال إليها').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // SLOWMODE
  new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('🐌 تفعيل الوضع البطيء للقناة')
    .addIntegerOption(o => o.setName('seconds').setDescription('التأخير بالثواني (0 لإلغاء)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // LOCK
  new SlashCommandBuilder()
    .setName('lock')
    .setDescription('🔒 قفل القناة الحالية')
    .addStringOption(o => o.setName('reason').setDescription('سبب القفل').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // UNLOCK
  new SlashCommandBuilder()
    .setName('unlock')
    .setDescription('🔓 فتح القناة الحالية')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  // SERVERINFO
  new SlashCommandBuilder()
    .setName('serverinfo')
    .setDescription('📊 عرض معلومات السيرفر'),

  // USERINFO
  new SlashCommandBuilder()
    .setName('userinfo')
    .setDescription('👤 عرض معلومات عضو')
    .addUserOption(o => o.setName('user').setDescription('العضو').setRequired(false)),

  // PING
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('🏓 اختبار سرعة البوت'),

  // SETLOG
  new SlashCommandBuilder()
    .setName('setlog')
    .setDescription('📋 تحديد قناة السجلات')
    .addChannelOption(o => o.setName('channel').setDescription('قناة السجلات').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ANTISPAM
  new SlashCommandBuilder()
    .setName('antispam')
    .setDescription('🛡️ تفعيل/إيقاف الحماية من السبام')
    .addBooleanOption(o => o.setName('enabled').setDescription('تفعيل أو إيقاف').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(cmd => cmd.toJSON());

// ─── Bot State Storage ──────────────────────────────────────────────
const warnings     = new Map(); // userId => count
let   logChannelId = null;
let   antispam     = false;
const spamTracker  = new Map();

// ─── Register Slash Commands ────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('⟳  تحديث Slash Commands ...');
    await rest.put(Routes.applicationCommands(config.clientId), { body: slashCommands });
    console.log('✅  تم تسجيل الأوامر بنجاح!');
  } catch (err) {
    console.error('❌  خطأ في تسجيل الأوامر:', err);
  }
}

// ─── Helper: Send Embed ─────────────────────────────────────────────
function makeEmbed(title, desc, color = 0x5865f2) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: 'Discord Dashboard Bot' });
}

// ─── Bot Events ─────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`\n🤖  تم تسجيل الدخول بنجاح كـ: ${client.user.tag}`);
  console.log(`🌐  الداشبورد: http://localhost:${config.port}`);
  client.user.setActivity('🛡️ حماية السيرفر | Dashboard', { type: 3 });
  await registerCommands();
});

// ─── Anti-Spam Logic ────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (!antispam || message.author.bot || !message.guild) return;
  const key  = `${message.guild.id}-${message.author.id}`;
  const now  = Date.now();
  const data = spamTracker.get(key) || { count: 0, last: now };
  if (now - data.last > 5000) { data.count = 0; data.last = now; }
  data.count++;
  spamTracker.set(key, data);
  if (data.count >= 5) {
    try {
      const member = await message.guild.members.fetch(message.author.id);
      await member.timeout(60000, 'Anti-Spam Auto-Mute');
      await message.channel.send({ embeds: [makeEmbed('🛡️ Anti-Spam', `${message.author} تم كتمه بسبب السبام!`, 0xff0000)] });
      data.count = 0;
    } catch (e) { /* ignore */ }
  }
});

// ─── Ticket Button Handler ──────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId === 'create_ticket') {
    const guild    = interaction.guild;
    const category = guild.channels.cache.find(c => c.name === 'تذاكر' && c.type === ChannelType.GuildCategory);
    const ch = await guild.channels.create({
      name:  `ticket-${interaction.user.username}`,
      type:  ChannelType.GuildText,
      parent: category?.id || null,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
    await ch.send({ embeds: [makeEmbed('🎫 تذكرة جديدة', `مرحباً ${interaction.user}!\nسيرد عليك فريق الدعم قريباً.`, 0x57f287)] });
    await interaction.reply({ content: `✅ تم إنشاء تذكرتك: ${ch}`, ephemeral: true });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member, channel } = interaction;

  try {
    // ── BAN ───────────────────────────────────────────────────────
    if (commandName === 'ban') {
      const user   = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'لم يذكر سبب';
      const target = await guild.members.fetch(user.id).catch(() => null);
      if (!target) return interaction.reply({ content: '❌ لم يتم إيجاد العضو.', ephemeral: true });
      await target.ban({ reason });
      await interaction.reply({ embeds: [makeEmbed('🔨 تم الحظر', `**${user.tag}** تم حظره\n**السبب:** ${reason}`, 0xed4245)] });
    }

    // ── KICK ──────────────────────────────────────────────────────
    else if (commandName === 'kick') {
      const user   = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'لم يذكر سبب';
      const target = await guild.members.fetch(user.id).catch(() => null);
      if (!target) return interaction.reply({ content: '❌ لم يتم إيجاد العضو.', ephemeral: true });
      await target.kick(reason);
      await interaction.reply({ embeds: [makeEmbed('👢 تم الطرد', `**${user.tag}** تم طرده\n**السبب:** ${reason}`, 0xffa500)] });
    }

    // ── MUTE ──────────────────────────────────────────────────────
    else if (commandName === 'mute') {
      const user     = interaction.options.getUser('user');
      const duration = interaction.options.getInteger('duration');
      const reason   = interaction.options.getString('reason') || 'لم يذكر سبب';
      const target   = await guild.members.fetch(user.id).catch(() => null);
      if (!target) return interaction.reply({ content: '❌ لم يتم إيجاد العضو.', ephemeral: true });
      await target.timeout(duration * 60000, reason);
      await interaction.reply({ embeds: [makeEmbed('🔇 تم الكتم', `**${user.tag}** تم كتمه لمدة **${duration} دقيقة**\n**السبب:** ${reason}`, 0xfee75c)] });
    }

    // ── UNMUTE ────────────────────────────────────────────────────
    else if (commandName === 'unmute') {
      const user   = interaction.options.getUser('user');
      const target = await guild.members.fetch(user.id).catch(() => null);
      if (!target) return interaction.reply({ content: '❌ لم يتم إيجاد العضو.', ephemeral: true });
      await target.timeout(null);
      await interaction.reply({ embeds: [makeEmbed('🔊 رفع الكتم', `**${user.tag}** تم رفع كتمه.`, 0x57f287)] });
    }

    // ── PURGE ─────────────────────────────────────────────────────
    else if (commandName === 'purge') {
      const amount   = interaction.options.getInteger('amount');
      const filterUser = interaction.options.getUser('user');
      let   messages  = await channel.messages.fetch({ limit: filterUser ? 100 : amount });
      if (filterUser) messages = messages.filter(m => m.author.id === filterUser.id).first(amount);
      const deleted = await channel.bulkDelete(messages, true);
      await interaction.reply({ embeds: [makeEmbed('🗑️ تم المسح', `تم حذف **${deleted.size}** رسالة.`, 0x5865f2)], ephemeral: true });
    }

    // ── WARN ──────────────────────────────────────────────────────
    else if (commandName === 'warn') {
      const user   = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason');
      const prev   = warnings.get(user.id) || 0;
      warnings.set(user.id, prev + 1);
      await interaction.reply({ embeds: [makeEmbed('⚠️ إنذار', `**${user.tag}** تلقى إنذاراً\n**السبب:** ${reason}\n**مجموع الإنذارات:** ${prev + 1}`, 0xfee75c)] });
    }

    // ── UNBAN ─────────────────────────────────────────────────────
    else if (commandName === 'unban') {
      const userId = interaction.options.getString('userid');
      await guild.members.unban(userId, 'رُفع الحظر من الداشبورد');
      await interaction.reply({ embeds: [makeEmbed('✅ رفع الحظر', `تم رفع الحظر عن المعرف: \`${userId}\``, 0x57f287)] });
    }

    // ── CREATE ROLE ───────────────────────────────────────────────
    else if (commandName === 'createrole') {
      const name  = interaction.options.getString('name');
      const color = interaction.options.getString('color') || '#99AAB5';
      const hoist = interaction.options.getBoolean('hoist') ?? false;
      const role  = await guild.roles.create({ name, color, hoist });
      await interaction.reply({ embeds: [makeEmbed('🎭 تم إنشاء الرتبة', `تم إنشاء الرتبة **${role.name}**`, 0x57f287)] });
    }

    // ── DELETE ROLE ───────────────────────────────────────────────
    else if (commandName === 'deleterole') {
      const role = interaction.options.getRole('role');
      await guild.roles.delete(role.id);
      await interaction.reply({ embeds: [makeEmbed('🗑️ حذف الرتبة', `تم حذف الرتبة **${role.name}**`, 0xed4245)] });
    }

    // ── GIVE ROLE ─────────────────────────────────────────────────
    else if (commandName === 'giverole') {
      const user   = interaction.options.getUser('user');
      const role   = interaction.options.getRole('role');
      const target = await guild.members.fetch(user.id);
      await target.roles.add(role);
      await interaction.reply({ embeds: [makeEmbed('🎁 إعطاء رتبة', `تم إعطاء **${user.tag}** رتبة **${role.name}**`, 0x57f287)] });
    }

    // ── REMOVE ROLE ───────────────────────────────────────────────
    else if (commandName === 'removerole') {
      const user   = interaction.options.getUser('user');
      const role   = interaction.options.getRole('role');
      const target = await guild.members.fetch(user.id);
      await target.roles.remove(role);
      await interaction.reply({ embeds: [makeEmbed('❌ إزالة رتبة', `تم إزالة رتبة **${role.name}** من **${user.tag}**`, 0xed4245)] });
    }

    // ── TICKET ────────────────────────────────────────────────────
    else if (commandName === 'ticket') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('create_ticket').setLabel('📩 فتح تذكرة').setStyle(ButtonStyle.Primary)
      );
      await interaction.reply({ embeds: [makeEmbed('🎫 نظام التذاكر', 'اضغط على الزر أدناه لفتح تذكرة دعم.', 0x5865f2)], components: [row] });
    }

    // ── ANNOUNCE ──────────────────────────────────────────────────
    else if (commandName === 'announce') {
      const msg       = interaction.options.getString('message');
      const targetCh  = interaction.options.getChannel('channel') || channel;
      await targetCh.send({ embeds: [makeEmbed('📢 إعلان', msg, 0xfee75c)] });
      await interaction.reply({ content: `✅ تم الإرسال إلى ${targetCh}`, ephemeral: true });
    }

    // ── SLOWMODE ──────────────────────────────────────────────────
    else if (commandName === 'slowmode') {
      const sec = interaction.options.getInteger('seconds');
      await channel.setRateLimitPerUser(sec);
      await interaction.reply({ embeds: [makeEmbed('🐌 Slow Mode', sec ? `تم تفعيل الوضع البطيء: **${sec}** ثانية` : 'تم إلغاء الوضع البطيء', 0x5865f2)] });
    }

    // ── LOCK ──────────────────────────────────────────────────────
    else if (commandName === 'lock') {
      const reason = interaction.options.getString('reason') || 'لم يذكر سبب';
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
      await interaction.reply({ embeds: [makeEmbed('🔒 القناة مقفلة', `**${channel.name}** تم قفلها\n**السبب:** ${reason}`, 0xed4245)] });
    }

    // ── UNLOCK ────────────────────────────────────────────────────
    else if (commandName === 'unlock') {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
      await interaction.reply({ embeds: [makeEmbed('🔓 القناة مفتوحة', `**${channel.name}** تم فتحها`, 0x57f287)] });
    }

    // ── SERVER INFO ───────────────────────────────────────────────
    else if (commandName === 'serverinfo') {
      const g = guild;
      await g.fetch();
      const embed = new EmbedBuilder()
        .setTitle(`📊 ${g.name}`)
        .setThumbnail(g.iconURL({ dynamic: true }) || null)
        .addFields(
          { name: '👥 الأعضاء',     value: `${g.memberCount}`,                inline: true },
          { name: '📅 تاريخ الإنشاء', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
          { name: '👑 المالك',       value: `<@${g.ownerId}>`,                 inline: true },
          { name: '💬 القنوات',      value: `${g.channels.cache.size}`,        inline: true },
          { name: '🎭 الرتب',        value: `${g.roles.cache.size}`,           inline: true },
          { name: '😀 الإيموجي',    value: `${g.emojis.cache.size}`,          inline: true },
        )
        .setColor(0x5865f2)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── USER INFO ─────────────────────────────────────────────────
    else if (commandName === 'userinfo') {
      const user   = interaction.options.getUser('user') || interaction.user;
      const target = await guild.members.fetch(user.id).catch(() => null);
      const embed  = new EmbedBuilder()
        .setTitle(`👤 ${user.tag}`)
        .setThumbnail(user.displayAvatarURL({ dynamic: true }))
        .addFields(
          { name: '🆔 المعرف',       value: user.id,                                           inline: true },
          { name: '📅 تاريخ الانضمام', value: target ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : 'غير معروف', inline: true },
          { name: '🗓️ تاريخ الإنشاء', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: '⚠️ الإنذارات',   value: `${warnings.get(user.id) || 0}`,                  inline: true },
        )
        .setColor(0x5865f2)
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    }

    // ── PING ──────────────────────────────────────────────────────
    else if (commandName === 'ping') {
      await interaction.reply({ embeds: [makeEmbed('🏓 Pong!', `البينج: **${client.ws.ping}ms**`, 0x57f287)] });
    }

    // ── SET LOG ───────────────────────────────────────────────────
    else if (commandName === 'setlog') {
      const ch = interaction.options.getChannel('channel');
      logChannelId = ch.id;
      await interaction.reply({ embeds: [makeEmbed('📋 قناة السجلات', `تم تحديد ${ch} كقناة للسجلات`, 0x57f287)] });
    }

    // ── ANTISPAM ──────────────────────────────────────────────────
    else if (commandName === 'antispam') {
      antispam = interaction.options.getBoolean('enabled');
      await interaction.reply({ embeds: [makeEmbed('🛡️ Anti-Spam', antispam ? '✅ تم تفعيل الحماية من السبام' : '❌ تم إيقاف الحماية من السبام', antispam ? 0x57f287 : 0xed4245)] });
    }

  } catch (error) {
    console.error(`[CMD ERROR] ${commandName}:`, error);
    const errMsg = { content: `❌ حدث خطأ: ${error.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errMsg).catch(() => {});
    } else {
      await interaction.reply(errMsg).catch(() => {});
    }
  }
});

// ─── Audit Log Events ────────────────────────────────────────────────
async function sendLog(guild, embed) {
  if (!logChannelId) return;
  const ch = guild.channels.cache.get(logChannelId);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

client.on('guildMemberAdd', member => {
  sendLog(member.guild, makeEmbed('📥 عضو انضم', `${member.user.tag} انضم للسيرفر`, 0x57f287));
});
client.on('guildMemberRemove', member => {
  sendLog(member.guild, makeEmbed('📤 عضو غادر', `${member.user.tag} غادر السيرفر`, 0xed4245));
});
client.on('guildBanAdd', (ban) => {
  sendLog(ban.guild, makeEmbed('🔨 حظر', `${ban.user.tag} تم حظره`, 0xed4245));
});
client.on('guildBanRemove', (ban) => {
  sendLog(ban.guild, makeEmbed('✅ رفع حظر', `${ban.user.tag} تم رفع حظره`, 0x57f287));
});

// ─── Express Dashboard API ───────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── GET /api/stats ────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  try {
    const guilds      = client.guilds.cache;
    const guildList   = [];
    let   totalMembers = 0;

    for (const [, guild] of guilds) {
      try {
        const g = await guild.fetch();
        totalMembers += g.memberCount;
        guildList.push({
          id:         g.id,
          name:       g.name,
          memberCount: g.memberCount,
          icon:       g.iconURL({ dynamic: true, size: 128 }) || null,
          ownerId:    g.ownerId,
          channels:   g.channels.cache.size,
          roles:      g.roles.cache.size,
          createdAt:  g.createdTimestamp,
        });
      } catch (_) { /* skip inaccessible */ }
    }

    res.json({
      bot: {
        id:            client.user?.id,
        tag:           client.user?.tag,
        username:      client.user?.username,
        avatar:        client.user?.displayAvatarURL({ dynamic: true, size: 256 }),
        status:        'online',
        ping:          client.ws.ping,
        guilds:        guilds.size,
        totalMembers,
        uptime:        process.uptime(),
        commands:      slashCommands.length,
        antispam,
        logChannelId,
      },
      guilds: guildList,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/guild/:id ────────────────────────────────────────────────
app.get('/api/guild/:id', async (req, res) => {
  try {
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const g = await guild.fetch();
    await g.members.fetch();
    const members = g.members.cache.map(m => ({
      id:       m.user.id,
      tag:      m.user.tag,
      avatar:   m.user.displayAvatarURL({ dynamic: true, size: 64 }),
      joinedAt: m.joinedTimestamp,
      roles:    m.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor })).filter(r => r.name !== '@everyone'),
      muted:    !!m.communicationDisabledUntilTimestamp,
    }));
    const roles    = g.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor, members: r.members.size }));
    const channels = g.channels.cache.map(c => ({ id: c.id, name: c.name, type: c.type }));
    res.json({ id: g.id, name: g.name, icon: g.iconURL({ dynamic: true, size: 256 }), memberCount: g.memberCount, members, roles, channels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/action ──────────────────────────────────────────────────
app.post('/api/action', async (req, res) => {
  const { guildId, action, data } = req.body;
  if (!guildId || !action) return res.status(400).json({ error: 'Missing guildId or action' });

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Bot is not in this guild' });

    let result = { success: true };

    switch (action) {
      // BAN
      case 'ban': {
        const member = await guild.members.fetch(data.userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        await member.ban({ reason: data.reason || 'Dashboard action' });
        result.message = `✅ تم حظر ${data.userId}`;
        break;
      }
      // KICK
      case 'kick': {
        const member = await guild.members.fetch(data.userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        await member.kick(data.reason || 'Dashboard action');
        result.message = `✅ تم طرد ${data.userId}`;
        break;
      }
      // MUTE
      case 'mute': {
        const member = await guild.members.fetch(data.userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        const ms = (data.minutes || 10) * 60000;
        await member.timeout(ms, data.reason || 'Dashboard mute');
        result.message = `✅ تم كتم ${data.userId} لمدة ${data.minutes || 10} دقيقة`;
        break;
      }
      // UNMUTE
      case 'unmute': {
        const member = await guild.members.fetch(data.userId).catch(() => null);
        if (!member) return res.status(404).json({ error: 'Member not found' });
        await member.timeout(null);
        result.message = `✅ تم رفع كتم ${data.userId}`;
        break;
      }
      // PURGE
      case 'purge': {
        const ch = guild.channels.cache.get(data.channelId);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        const deleted = await ch.bulkDelete(Math.min(data.amount || 10, 100), true);
        result.message = `✅ تم حذف ${deleted.size} رسالة`;
        break;
      }
      // WARN
      case 'warn': {
        const prev = warnings.get(data.userId) || 0;
        warnings.set(data.userId, prev + 1);
        result.message = `✅ تم إنذار ${data.userId} (إجمالي: ${prev + 1})`;
        break;
      }
      // UNBAN
      case 'unban': {
        await guild.members.unban(data.userId, 'Dashboard unban');
        result.message = `✅ تم رفع حظر ${data.userId}`;
        break;
      }
      // CREATE ROLE
      case 'createrole': {
        const role = await guild.roles.create({ name: data.name, color: data.color || '#99AAB5', hoist: data.hoist || false });
        result.message = `✅ تم إنشاء رتبة: ${role.name}`;
        result.roleId  = role.id;
        break;
      }
      // DELETE ROLE
      case 'deleterole': {
        await guild.roles.delete(data.roleId);
        result.message = `✅ تم حذف الرتبة`;
        break;
      }
      // GIVE ROLE
      case 'giverole': {
        const member = await guild.members.fetch(data.userId);
        await member.roles.add(data.roleId);
        result.message = `✅ تم إعطاء الرتبة`;
        break;
      }
      // REMOVE ROLE
      case 'removerole': {
        const member = await guild.members.fetch(data.userId);
        await member.roles.remove(data.roleId);
        result.message = `✅ تم إزالة الرتبة`;
        break;
      }
      // ANNOUNCE
      case 'announce': {
        const ch = guild.channels.cache.get(data.channelId) || guild.systemChannel;
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        await ch.send({ embeds: [makeEmbed('📢 إعلان', data.message, 0xfee75c)] });
        result.message = `✅ تم إرسال الإعلان`;
        break;
      }
      // TICKET SETUP
      case 'ticket': {
        const ch = guild.channels.cache.get(data.channelId) || guild.systemChannel;
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('create_ticket').setLabel('📩 فتح تذكرة').setStyle(ButtonStyle.Primary)
        );
        await ch.send({ embeds: [makeEmbed('🎫 نظام التذاكر', 'اضغط على الزر أدناه لفتح تذكرة دعم.', 0x5865f2)], components: [row] });
        result.message = `✅ تم إعداد نظام التذاكر في ${ch.name}`;
        break;
      }
      // LOCK
      case 'lock': {
        const ch = guild.channels.cache.get(data.channelId);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
        result.message = `✅ تم قفل القناة`;
        break;
      }
      // UNLOCK
      case 'unlock': {
        const ch = guild.channels.cache.get(data.channelId);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
        result.message = `✅ تم فتح القناة`;
        break;
      }
      // SLOWMODE
      case 'slowmode': {
        const ch = guild.channels.cache.get(data.channelId);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        await ch.setRateLimitPerUser(data.seconds || 0);
        result.message = `✅ تم تفعيل Slow Mode (${data.seconds}s)`;
        break;
      }
      // ANTISPAM
      case 'antispam': {
        antispam = !!data.enabled;
        result.message = `✅ ${antispam ? 'تم تفعيل' : 'تم إيقاف'} Anti-Spam`;
        break;
      }
      // SETLOG
      case 'setlog': {
        logChannelId   = data.channelId;
        result.message = `✅ تم تحديد قناة السجلات`;
        break;
      }
      // SEND MSG
      case 'sendmsg': {
        const ch = guild.channels.cache.get(data.channelId);
        if (!ch) return res.status(404).json({ error: 'Channel not found' });
        await ch.send(data.message);
        result.message = `✅ تم الإرسال`;
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown action' });
    }

    res.json(result);
  } catch (err) {
    console.error('[API ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve index.html ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`\n🚀  Dashboard يعمل على: http://localhost:${config.port}`);
});

client.login(config.token).catch(err => {
  console.error('❌  فشل تسجيل دخول البوت:', err.message);
  process.exit(1);
});
