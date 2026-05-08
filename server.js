// ═══════════════════════════════════════════════════════════════
//  AFRM Dashboard — server.js v3
//  Express + Discord.js — متجر / مزاد / اقتصاد / حماية كاملة
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionsBitField, ChannelType, ActivityType
} = require('discord.js');
const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────
let config;
try { config = JSON.parse(fs.readFileSync('./config.json', 'utf8')); }
catch (_) { config = {}; }

if (process.env.BOT_TOKEN)        config.token           = process.env.BOT_TOKEN;
if (process.env.GUILD_ID)         config.guildId         = process.env.GUILD_ID;
if (process.env.CLIENT_ID)        config.clientId        = process.env.CLIENT_ID;
if (process.env.DASHBOARD_SECRET) config.dashboardSecret = process.env.DASHBOARD_SECRET;

config.port          = process.env.PORT || config.port || 3000;
config.prefix        = config.prefix        || '/';
config.embedColor    = config.embedColor    || '#7c3aed';
config.levelRoles    = config.levelRoles    || {};
config.badWords      = config.badWords      || ["سب","شتيمة","لعن","كلب","حمار","غبي","ابن الكلب","الله يلعن","يلعن ابوك","عاهرة","قحبة","زبالة","حيوان","تبا لك","منيوك","عرص"];
config.bannedDomains = config.bannedDomains || ["discord.gg","t.me","bit.ly","grabify","iplogger"];
config.aiModeration  = config.aiModeration  !== false;
config.antiSpam      = config.antiSpam      !== false;
config.antiGhostPing = config.antiGhostPing !== false;
config.maxMentions   = config.maxMentions   || 5;
config.shopItems     = config.shopItems     || [];
config.shopWarns     = config.shopWarns     || {};
config.economy       = config.economy       || {};
config.autoResponses = config.autoResponses || [];
config.mentionPacks  = config.mentionPacks  || {};
config.mentionPrice  = config.mentionPrice  || 50;
config.banPrice      = config.banPrice      || 500;
config.dailyAmount   = config.dailyAmount   || 200;

function saveConfig() {
  try { fs.writeFileSync('./config.json', JSON.stringify(config, null, 2)); } catch (_) {}
}

// ── Express ───────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.static('.'));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Memory stores ─────────────────────────────────────────────────
const logs        = [];
const userWarns   = {};
const userLevels  = {};
const tickets     = {};
const spamTracker = {};
const giveaways   = {};
const polls       = {};
const auctions    = {};
const uptime      = Date.now();

function addLog(type, detail, user = 'System') {
  logs.unshift({ type, detail, user, time: new Date().toISOString() });
  if (logs.length > 300) logs.pop();
}

// ── Economy helpers ───────────────────────────────────────────────
const getBal  = id => config.economy[id] || 0;
function addBal(id, n)    { config.economy[id] = (config.economy[id]||0)+n; saveConfig(); }
function deductBal(id, n) { config.economy[id] = Math.max(0,(config.economy[id]||0)-n); saveConfig(); }

// ── Discord Client ────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

async function sendDM(userId, embed) {
  try { const u = await client.users.fetch(userId); await u.send({ embeds: [embed] }); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
//  EVENTS
// ═══════════════════════════════════════════════════════════════

client.once('ready', () => {
  console.log(`✅ Bot: ${client.user.tag}`);
  client.user.setActivity('AFRM Dashboard v3', { type: ActivityType.Watching });
  addLog('SYSTEM', `Bot ready: ${client.user.tag}`);
});

// ── Welcome / Leave ───────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  addBal(member.id, 100);
  if (config.welcomeChannelId) {
    const ch = member.guild.channels.cache.get(config.welcomeChannelId);
    if (ch) ch.send({ embeds: [new EmbedBuilder().setColor(config.embedColor)
      .setTitle('🎉 عضو جديد!')
      .setDescription(`أهلاً ${member} في **${member.guild.name}**!\nأنت العضو رقم **${member.guild.memberCount}**\n💰 حصلت على **100 عملة** كهدية!`)
      .setThumbnail(member.user.displayAvatarURL()).setTimestamp()] });
  }
  if (config.autoRole) {
    const role = member.guild.roles.cache.get(config.autoRole);
    if (role) member.roles.add(role).catch(() => {});
  }
  addLog('JOIN', `${member.user.tag} joined`, member.user.tag);
});

client.on('guildMemberRemove', async member => {
  if (!config.leaveChannelId) return;
  const ch = member.guild.channels.cache.get(config.leaveChannelId);
  if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#ef4444').setTitle('👋 عضو غادر')
    .setDescription(`**${member.user.tag}** غادر السيرفر.`).setTimestamp()] });
  addLog('LEAVE', `${member.user.tag} left`, member.user.tag);
});

// ── Ghost Ping ────────────────────────────────────────────────────
client.on('messageDelete', async msg => {
  if (!msg.author || msg.author.bot || !config.antiGhostPing) return;
  if (msg.mentions.users.size > 0 || msg.mentions.roles.size > 0) {
    const mentioned = [...msg.mentions.users.values()].map(u => u.tag).join(', ');
    userWarns[msg.author.id] = (userWarns[msg.author.id]||0) + 1;
    addLog('GHOST_PING', `${msg.author.tag} ghost-pinged: ${mentioned}`, msg.author.tag);
    await sendDM(msg.author.id, new EmbedBuilder().setColor('#f59e0b').setTitle('👻 Ghost Ping!')
      .setDescription(`تم رصدك!\nذكرت: ${mentioned}\nتحذير رقم: **${userWarns[msg.author.id]}**`).setTimestamp());
    if (config.logChannelId) {
      const lch = msg.guild?.channels.cache.get(config.logChannelId);
      if (lch) lch.send({ embeds: [new EmbedBuilder().setColor('#f59e0b').setTitle('👻 Ghost Ping Detected')
        .setDescription(`**${msg.author.tag}** ذكر ومسح!\nذكر: ${mentioned}`).setTimestamp()] });
    }
  }
});

// ── Main Message Event ────────────────────────────────────────────
client.on('messageCreate', async msg => {
  if (!msg.guild) return;
  if (msg.author.bot) return;

  const isAdmin = msg.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
  const prefix  = config.prefix || '/';

  // ── Auto Responses
  for (const ar of config.autoResponses) {
    if (msg.content.toLowerCase().includes(ar.trigger.toLowerCase())) {
      msg.channel.send(ar.response);
      break;
    }
  }

  // ════ COMMANDS ════════════════════════════════════════════════
  if (msg.content.startsWith(prefix)) {
    const args = msg.content.slice(prefix.length).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();

    // /رصيد
    if (['رصيد','balance'].includes(cmd)) {
      const t = msg.mentions.users.first() || msg.author;
      msg.channel.send({ embeds: [new EmbedBuilder().setColor(config.embedColor)
        .setTitle('💰 الرصيد').setDescription(`**${t.username}** لديه **${getBal(t.id).toLocaleString()} عملة**`)
        .setThumbnail(t.displayAvatarURL()).setTimestamp()] });
      return;
    }

    // /يومي
    if (['يومي','daily'].includes(cmd)) {
      const last = config.economy[`daily_${msg.author.id}`] || 0;
      const diff = Date.now() - last;
      if (diff < 86400000) {
        const h = Math.ceil((86400000-diff)/3600000);
        return msg.reply(`⏰ انتظر **${h}** ساعة قبل المطالبة مجدداً.`);
      }
      addBal(msg.author.id, config.dailyAmount);
      config.economy[`daily_${msg.author.id}`] = Date.now();
      saveConfig();
      return msg.reply(`✅ حصلت على **${config.dailyAmount}** عملة يومية! رصيدك: **${getBal(msg.author.id).toLocaleString()}**`);
    }

    // /ترتيب
    if (['ترتيب','top'].includes(cmd)) {
      const top = Object.entries(config.economy)
        .filter(([k])=>!k.startsWith('daily_')).sort((a,b)=>b[1]-a[1]).slice(0,10);
      msg.channel.send({ embeds: [new EmbedBuilder().setColor(config.embedColor).setTitle('🏆 أغنى الأعضاء')
        .setDescription(top.map(([id,b],i)=>`**${i+1}.** <@${id}> — **${b.toLocaleString()}** عملة`).join('\n')).setTimestamp()] });
      return;
    }

    // /مستوى
    if (['مستوى','level'].includes(cmd)) {
      const t = msg.mentions.users.first() || msg.author;
      const d = userLevels[t.id] || { level:0, xp:0 };
      msg.channel.send({ embeds: [new EmbedBuilder().setColor(config.embedColor).setTitle('⭐ المستوى')
        .setDescription(`**${t.username}**\nالمستوى: **${d.level}**\nXP: **${d.xp}/${(d.level+1)*100}**`)
        .setThumbnail(t.displayAvatarURL()).setTimestamp()] });
      return;
    }

    // /متجر
    if (['متجر','shop'].includes(cmd)) {
      const items = config.shopItems.filter(i=>i.available!==false);
      if (!items.length) return msg.reply('🏪 المتجر فارغ حالياً.');
      msg.channel.send({ embeds: [new EmbedBuilder().setColor(config.embedColor).setTitle('🏪 المتجر')
        .setDescription(items.map(i=>`**#${i.id}** — ${i.name}\n💰 **${i.price}** عملة | ${i.type||'عام'}\n${i.description||''}`).join('\n\n'))
        .setFooter({text:`رصيدك: ${getBal(msg.author.id)} عملة`}).setTimestamp()] });
      return;
    }

    // /شراء
    if (cmd === 'شراء') {
      const sub = args[0];

      // شراء متجر <id>
      if (sub === 'متجر') {
        const item = config.shopItems.find(i=>i.id===parseInt(args[1]));
        if (!item || item.available===false) return msg.reply('❌ المنتج غير موجود أو غير متاح.');
        if (getBal(msg.author.id) < item.price) return msg.reply(`❌ رصيدك **${getBal(msg.author.id)}** غير كافٍ. السعر: **${item.price}**`);
        deductBal(msg.author.id, item.price);
        if (item.roleId) { const r=msg.guild.roles.cache.get(item.roleId); if(r) msg.member.roles.add(r).catch(()=>{}); }
        addLog('SHOP_BUY',`${msg.author.tag} bought "${item.name}" (${item.price})`,msg.author.tag);
        msg.channel.send({ embeds: [new EmbedBuilder().setColor('#4ade80').setTitle('✅ تم الشراء!')
          .setDescription(`اشتريت **${item.name}** بـ **${item.price}** عملة\nرصيدك الجديد: **${getBal(msg.author.id)}**`).setTimestamp()] });
        return;
      }

      // شراء رتبة <roleId>
      if (sub === 'رتبة') {
        const item = config.shopItems.find(i=>i.roleId===args[1]&&i.type==='role');
        if (!item) return msg.reply('❌ هذه الرتبة غير معروضة للبيع.');
        if (getBal(msg.author.id) < item.price) return msg.reply(`❌ تحتاج **${item.price}** عملة. رصيدك: **${getBal(msg.author.id)}**`);
        deductBal(msg.author.id, item.price);
        const role = msg.guild.roles.cache.get(args[1]);
        if (role) msg.member.roles.add(role).catch(()=>{});
        msg.reply(`✅ حصلت على رتبة **${role?.name||''}**!`);
        addLog('SHOP_ROLE',`${msg.author.tag} bought role ${role?.name}`,msg.author.tag);
        return;
      }

      // شراء منشنات <عدد>
      if (sub === 'منشنات') {
        const count = parseInt(args[1])||1;
        const total = count * config.mentionPrice;
        if (getBal(msg.author.id) < total) return msg.reply(`❌ تحتاج **${total}** عملة لـ ${count} منشن.`);
        deductBal(msg.author.id, total);
        config.mentionPacks[msg.author.id] = (config.mentionPacks[msg.author.id]||0)+count;
        saveConfig();
        msg.reply(`✅ حصلت على **${count}** منشن! إجمالي منشناتك: **${config.mentionPacks[msg.author.id]}**`);
        addLog('SHOP_MENTION',`${msg.author.tag} bought ${count} mentions`,msg.author.tag);
        return;
      }

      // شراء مزاد <id> <مبلغ>
      if (sub === 'مزاد') {
        const aId = args[1]; const auc = auctions[aId];
        if (!auc) return msg.reply('❌ المزاد غير موجود.');
        if (Date.now() > auc.endTime) return msg.reply('❌ انتهى المزاد.');
        const bid = parseInt(args[2]);
        if (!bid||bid<=auc.currentBid) return msg.reply(`❌ العرض يجب أن يكون أكثر من **${auc.currentBid}**`);
        if (getBal(msg.author.id) < bid) return msg.reply(`❌ رصيدك **${getBal(msg.author.id)}** غير كافٍ.`);
        if (auc.bidder) addBal(auc.bidder, auc.currentBid);
        deductBal(msg.author.id, bid);
        auc.currentBid=bid; auc.bidder=msg.author.id;
        msg.reply(`✅ عرضك **${bid}** عملة مقبول! أنت المزايد الحالي على **${auc.item}**.`);
        addLog('AUCTION_BID',`${msg.author.tag} bid ${bid} on "${auc.item}"`,msg.author.tag);
        return;
      }

      // شراء طلب <وصف>
      if (sub === 'طلب') {
        const desc = args.slice(1).join(' ');
        if (!desc) return msg.reply('❌ اكتب وصف الطلب.');
        if (config.requestChannelId) {
          const ch = msg.guild.channels.cache.get(config.requestChannelId);
          if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#f59e0b').setTitle('📋 طلب شراء جديد')
            .setDescription(`**العضو:** ${msg.author}\n**الطلب:** ${desc}`).setTimestamp()] });
        }
        msg.reply('✅ تم إرسال طلبك! انتظر رد الإدارة.');
        addLog('SHOP_REQUEST',`${msg.author.tag}: ${desc}`,msg.author.tag);
        return;
      }

      // شراء بان <userId>
      if (sub === 'بان') {
        if (getBal(msg.author.id) < config.banPrice) return msg.reply(`❌ تحتاج **${config.banPrice}** عملة.`);
        const target = await msg.guild.members.fetch(args[1]).catch(()=>null);
        if (!target) return msg.reply('❌ العضو غير موجود.');
        deductBal(msg.author.id, config.banPrice);
        await sendDM(target.id, new EmbedBuilder().setColor('#ef4444').setTitle('🔨 تم حظرك')
          .setDescription(`**السيرفر:** ${msg.guild.name}\n**السبب:** paid ban`).setTimestamp());
        await target.ban({ reason: `Paid ban by ${msg.author.tag}` });
        msg.reply(`✅ تم بان **${target.user.tag}**.`);
        addLog('SHOP_BAN',`${msg.author.tag} paid to ban ${target.user.tag}`,msg.author.tag);
        return;
      }
    }

    // /تحذير @user <سبب>
    if (cmd === 'تحذير') {
      if (!isAdmin && !msg.member?.permissions?.has(PermissionsBitField.Flags.ModerateMembers))
        return msg.reply('❌ ليس لديك صلاحية.');
      const target = msg.mentions.members.first();
      if (!target) return msg.reply('❌ اذكر عضواً.');
      const reason = args.slice(1).join(' ') || 'لم يُذكر سبب';
      userWarns[target.id] = (userWarns[target.id]||0)+1;
      const wc = userWarns[target.id];
      await sendDM(target.id, new EmbedBuilder().setColor('#f59e0b').setTitle('⚠️ تحذير')
        .setDescription(`**السيرفر:** ${msg.guild.name}\n**السبب:** ${reason}\n**تحذير رقم:** ${wc}\n${wc>=3?'🔴 تحذير أخير!':''}`).setTimestamp());
      if (wc>=3) { await target.timeout(30*60000,'3 تحذيرات').catch(()=>{}); userWarns[target.id]=0; msg.channel.send(`🔇 ${target} تم كتمه 30 دقيقة (3 تحذيرات)`); }
      addLog('WARN',`${target.user.tag} warned (${wc}). ${reason}`,msg.author.tag);
      msg.reply(`✅ تم تحذير **${target.user.tag}** (${wc}/3)`);
      return;
    }

    // /ازالة-تحذير @user
    if (cmd === 'ازالة-تحذير') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const target = msg.mentions.members.first();
      if (!target) return msg.reply('❌ اذكر عضواً.');
      if (userWarns[target.id]>0) userWarns[target.id]--;
      msg.reply(`✅ تم إزالة تحذير. المتبقي: **${userWarns[target.id]||0}**`);
      addLog('REMOVE_WARN',`${target.user.tag} warn removed`,msg.author.tag);
      return;
    }

    // /بان @user <سبب>
    if (cmd === 'بان') {
      if (!isAdmin && !msg.member?.permissions?.has(PermissionsBitField.Flags.BanMembers))
        return msg.reply('❌ ليس لديك صلاحية.');
      const target = msg.mentions.members.first();
      if (!target) return msg.reply('❌ اذكر عضواً.');
      const reason = args.slice(1).join(' ')||'لا سبب';
      await sendDM(target.id, new EmbedBuilder().setColor('#ef4444').setTitle('🔨 تم حظرك')
        .setDescription(`**السيرفر:** ${msg.guild.name}\n**السبب:** ${reason}`).setTimestamp());
      await target.ban({ reason });
      msg.reply(`✅ تم حظر **${target.user.tag}**.`);
      addLog('BAN',`${target.user.tag} banned. ${reason}`,msg.author.tag);
      return;
    }

    // /ردود كلمة | الرد
    if (cmd === 'ردود') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const full = args.join(' '); const [trigger,...rest] = full.split('|');
      if (!trigger||!rest.length) return msg.reply('❌ الاستخدام: /ردود كلمة | الرد');
      config.autoResponses.push({ trigger:trigger.trim(), response:rest.join('|').trim() });
      saveConfig();
      msg.reply(`✅ تم إضافة رد تلقائي على "**${trigger.trim()}**"`);
      return;
    }

    // /تكتات <نص>
    if (cmd === 'تكتات') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const text = args.join(' ');
      if (!text) return msg.reply('❌ اكتب النص.');
      msg.channel.send({ embeds: [new EmbedBuilder().setColor('#22d3ee').setTitle('📌 إعلان')
        .setDescription(text).setFooter({text:`بواسطة ${msg.author.tag}`}).setTimestamp()] });
      msg.delete().catch(()=>{});
      return;
    }

    // /اضافة-منشنات @user <عدد>
    if (cmd === 'اضافة-منشنات') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const target = msg.mentions.users.first(); const count = parseInt(args[1])||1;
      if (!target) return msg.reply('❌ اذكر عضواً.');
      config.mentionPacks[target.id] = (config.mentionPacks[target.id]||0)+count;
      saveConfig();
      msg.reply(`✅ أُضيف **${count}** منشن لـ **${target.username}** (إجمالي: ${config.mentionPacks[target.id]})`);
      return;
    }

    // /ازالة-منشنات @user
    if (cmd === 'ازالة-منشنات') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const target = msg.mentions.users.first();
      if (!target) return msg.reply('❌ اذكر عضواً.');
      config.mentionPacks[target.id]=0; saveConfig();
      msg.reply(`✅ تم حذف منشنات **${target.username}**`);
      return;
    }

    // /تحذير-متجر @user <سبب>
    if (cmd === 'تحذير-متجر') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const target = msg.mentions.users.first(); const reason = args.slice(1).join(' ')||'مخالفة متجر';
      if (!target) return msg.reply('❌ اذكر عضواً.');
      config.shopWarns[target.id] = (config.shopWarns[target.id]||0)+1; saveConfig();
      await sendDM(target.id, new EmbedBuilder().setColor('#f59e0b').setTitle('⚠️ تحذير متجر')
        .setDescription(`**السبب:** ${reason}\n**تحذيرات المتجر:** ${config.shopWarns[target.id]}/3`).setTimestamp());
      if (config.shopWarns[target.id]>=3) {
        config.shopItems = config.shopItems.filter(i=>i.sellerId!==target.id); saveConfig();
        msg.channel.send(`🔴 **${target.username}** محظور من المتجر (3 تحذيرات)`);
      }
      msg.reply(`✅ تحذير متجر لـ **${target.username}** (${config.shopWarns[target.id]}/3)`);
      addLog('SHOP_WARN',`${target.username}: ${reason}`,msg.author.tag);
      return;
    }

    // /ازالة-تحذير-متجر @user
    if (cmd === 'ازالة-تحذير-متجر') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const target = msg.mentions.users.first();
      if (!target) return msg.reply('❌ اذكر عضواً.');
      if (config.shopWarns[target.id]>0) { config.shopWarns[target.id]--; saveConfig(); }
      msg.reply(`✅ إزالة تحذير متجر. المتبقي: **${config.shopWarns[target.id]||0}**`);
      return;
    }

    // /اعطاء @user <مبلغ>
    if (['اعطاء','give'].includes(cmd)) {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const target = msg.mentions.users.first(); const amount = parseInt(args[1])||0;
      if (!target||!amount) return msg.reply('❌ الاستخدام: /اعطاء @user مبلغ');
      addBal(target.id, amount);
      msg.reply(`✅ أعطيت **${target.username}** مبلغ **${amount.toLocaleString()}** عملة.`);
      return;
    }

    // /سحب @user <مبلغ>
    if (['سحب','deduct'].includes(cmd)) {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const target = msg.mentions.users.first(); const amount = parseInt(args[1])||0;
      if (!target||!amount) return msg.reply('❌ الاستخدام: /سحب @user مبلغ');
      deductBal(target.id, amount);
      msg.reply(`✅ تم سحب **${amount.toLocaleString()}** عملة من **${target.username}**.`);
      return;
    }

    // /تحديد-سعر <mention/ban/daily> <مبلغ>
    if (cmd === 'تحديد-سعر') {
      if (!isAdmin) return msg.reply('❌ أدمن فقط.');
      const type = args[0]; const price = parseInt(args[1]);
      if (!type||!price) return msg.reply('❌ الاستخدام: /تحديد-سعر mention/ban/daily مبلغ');
      if (type==='mention') config.mentionPrice=price;
      else if (type==='ban') config.banPrice=price;
      else if (type==='daily') config.dailyAmount=price;
      saveConfig();
      msg.reply(`✅ تم تحديد سعر **${type}** بـ **${price}** عملة.`);
      return;
    }

    // /مساعدة
    if (['مساعدة','help'].includes(cmd)) {
      const e = new EmbedBuilder().setColor(config.embedColor).setTitle('📖 أوامر AFRM Bot')
        .addFields(
          { name:'💰 اقتصاد', value:'`/رصيد` `/يومي` `/ترتيب` `/مستوى`', inline:false },
          { name:'🏪 متجر', value:'`/متجر` `/شراء متجر <id>` `/شراء رتبة <id>` `/شراء منشنات <عدد>` `/شراء طلب <وصف>` `/شراء بان <id>` `/شراء مزاد <id> <مبلغ>`', inline:false },
          { name:'🛡️ إشراف', value:'`/تحذير @user` `/ازالة-تحذير @user` `/بان @user`', inline:false },
          { name:'🏪 إدارة متجر', value:'`/تحذير-متجر @user` `/ازالة-تحذير-متجر @user`', inline:false },
          { name:'👑 أدمن', value:'`/اعطاء @user` `/سحب @user` `/ردود` `/تكتات` `/اضافة-منشنات` `/ازالة-منشنات` `/تحديد-سعر`', inline:false }
        ).setTimestamp();
      msg.channel.send({ embeds: [e] });
      return;
    }
  }

  // ════ MODERATION (تطبق على الجميع حتى الأدمن) ════════════════

  // Anti-Spam
  const now = Date.now();
  if (!spamTracker[msg.author.id]) spamTracker[msg.author.id]=[];
  spamTracker[msg.author.id] = spamTracker[msg.author.id].filter(t=>now-t<5000);
  spamTracker[msg.author.id].push(now);
  if (config.antiSpam && spamTracker[msg.author.id].length > 5) {
    msg.delete().catch(()=>{});
    addLog('SPAM',`Spam: ${msg.author.tag}`,msg.author.tag);
    const w = await msg.channel.send(`⚠️ ${msg.author} لا ترسل بسرعة!`);
    setTimeout(()=>w.delete().catch(()=>{}),4000);
    return;
  }

  // Bad Words — على الجميع بلا استثناء
  if (config.aiModeration) {
    const clean = msg.content.toLowerCase()
      .replace(/[\s\u200b\u200c\u200d\u00ad]/g,'')
      .replace(/[أإآا]/g,'ا').replace(/[ةه]/g,'ه').replace(/[يى]/g,'ي');
    const hasBad = config.badWords.some(w =>
      clean.includes(w.toLowerCase().replace(/\s/g,'').replace(/[أإآا]/g,'ا').replace(/[ةه]/g,'ه'))
    );
    if (hasBad) {
      msg.delete().catch(()=>{});
      userWarns[msg.author.id] = (userWarns[msg.author.id]||0)+1;
      const wc = userWarns[msg.author.id];
      addLog('BAD_WORD',`${msg.author.tag} (${wc} warns)`,msg.author.tag);
      await sendDM(msg.author.id, new EmbedBuilder().setColor('#ec4899').setTitle('🚫 تحذير — ألفاظ مسيئة')
        .setDescription(`**السيرفر:** ${msg.guild.name}\n**تحذير رقم:** ${wc}/3\n${wc>=3?'🔴 سيتم كتمك!':''}`).setTimestamp());
      const w = await msg.channel.send(`🚫 ${msg.author} تحذير ${wc}/3`);
      setTimeout(()=>w.delete().catch(()=>{}),5000);
      if (wc>=3) {
        await msg.member.timeout(30*60000,'3 تحذيرات').catch(()=>{});
        msg.channel.send(`🔇 ${msg.author} تم كتمه 30 دقيقة.`);
        userWarns[msg.author.id]=0;
      }
      return;
    }
  }

  // Anti-Link
  if (/(https?:\/\/|discord\.gg\/|t\.me\/)/i.test(msg.content)) {
    if (config.bannedDomains.some(d=>msg.content.toLowerCase().includes(d))) {
      msg.delete().catch(()=>{});
      addLog('LINK',`Link: ${msg.author.tag}`,msg.author.tag);
      const w = await msg.channel.send(`🔗 ${msg.author} لا تشارك الروابط!`);
      setTimeout(()=>w.delete().catch(()=>{}),4000);
      return;
    }
  }

  // Anti Mass Mention
  if (msg.mentions.users.size > config.maxMentions) {
    msg.delete().catch(()=>{});
    addLog('MENTION_SPAM',`Mass mention: ${msg.author.tag}`,msg.author.tag);
    const w = await msg.channel.send(`📢 ${msg.author} لا تذكر أكثر من ${config.maxMentions} أشخاص!`);
    setTimeout(()=>w.delete().catch(()=>{}),4000);
    return;
  }

  // Leveling + Coins
  if (!userLevels[msg.author.id]) userLevels[msg.author.id]={xp:0,level:0};
  userLevels[msg.author.id].xp += Math.floor(Math.random()*10)+5;
  if (Math.random()<0.3) addBal(msg.author.id, Math.floor(Math.random()*5)+1);
  if (userLevels[msg.author.id].xp >= (userLevels[msg.author.id].level+1)*100) {
    userLevels[msg.author.id].level++;
    userLevels[msg.author.id].xp=0;
    const lvl = userLevels[msg.author.id].level;
    msg.channel.send(`🎊 **${msg.author.username}** وصل للمستوى **${lvl}**! 🎉`);
    addBal(msg.author.id, lvl*50);
    addLog('LEVEL_UP',`${msg.author.tag} → Lv${lvl}`,msg.author.tag);
    if (config.levelRoles?.[lvl]) {
      const role = msg.guild.roles.cache.get(config.levelRoles[lvl]);
      if (role) msg.member.roles.add(role).catch(()=>{});
    }
  }

  // Ticket messages
  if (tickets[msg.channel.id]&&!tickets[msg.channel.id].closed) {
    tickets[msg.channel.id].messages.push({ author:msg.author.tag, content:msg.content, time:new Date().toISOString() });
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name==='🎉'&&giveaways[reaction.message.id]) {
    if (!giveaways[reaction.message.id].entries.includes(user.id))
      giveaways[reaction.message.id].entries.push(user.id);
  }
});

// ═══════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/status', (_, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  res.json({ online:client.isReady(), tag:client.user?.tag||'Offline', ping:client.ws.ping,
    uptime:Math.floor((Date.now()-uptime)/1000), guilds:client.guilds.cache.size,
    members:guild?.memberCount||0, channels:guild?.channels.cache.size||0,
    roles:guild?.roles.cache.size||0, avatarURL:client.user?.displayAvatarURL()||'' });
});

app.get('/api/logs',   (_, res) => res.json(logs.slice(0,100)));
app.get('/api/config', (_, res) => { const s={...config}; delete s.token; res.json(s); });

app.get('/api/members', async (_, res) => {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return res.json([]);
    const members = await guild.members.fetch();
    res.json(members.map(m=>({
      id:m.id, tag:m.user.tag, displayName:m.displayName,
      avatar:m.user.displayAvatarURL(), bot:m.user.bot,
      roles:m.roles.cache.filter(r=>r.name!=='@everyone').map(r=>({id:r.id,name:r.name,color:r.hexColor})),
      joinedAt:m.joinedAt, warns:userWarns[m.id]||0,
      level:userLevels[m.id]?.level||0, xp:userLevels[m.id]?.xp||0,
      balance:getBal(m.id), shopWarns:config.shopWarns[m.id]||0, mentions:config.mentionPacks[m.id]||0
    })));
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/channels', (_, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return res.json([]);
  res.json(guild.channels.cache.filter(c=>c.type===ChannelType.GuildText).map(c=>({id:c.id,name:c.name})));
});

app.get('/api/roles', (_, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return res.json([]);
  res.json(guild.roles.cache.filter(r=>r.name!=='@everyone').map(r=>({id:r.id,name:r.name,color:r.hexColor,members:r.members.size})));
});

app.get('/api/stats', (_, res) => {
  const guild = client.guilds.cache.get(config.guildId);
  const logTypes={};
  logs.forEach(l=>{logTypes[l.type]=(logTypes[l.type]||0)+1;});
  res.json({
    memberCount:guild?.memberCount||0,
    botCount:guild?.members.cache.filter(m=>m.user.bot).size||0,
    humanCount:guild?.members.cache.filter(m=>!m.user.bot).size||0,
    logTypes,
    topLevels:Object.entries(userLevels).sort((a,b)=>b[1].level-a[1].level).slice(0,5).map(([id,d])=>({id,...d})),
    topEconomy:Object.entries(config.economy).filter(([k])=>!k.startsWith('daily_')).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,bal])=>({id,bal})),
    totalWarns:Object.values(userWarns).reduce((a,b)=>a+b,0),
    openTickets:Object.values(tickets).filter(t=>!t.closed).length,
    shopItems:config.shopItems.length,
    activeAuctions:Object.values(auctions).filter(a=>Date.now()<a.endTime).length
  });
});

// ── Mod ───────────────────────────────────────────────────────────
async function getMember(uid) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) throw new Error('Guild not found');
  return guild.members.fetch(uid);
}

app.post('/api/mod/kick', async (req,res) => {
  try {
    const {userId,reason}=req.body; const m=await getMember(userId);
    const guild=client.guilds.cache.get(config.guildId);
    await sendDM(userId, new EmbedBuilder().setColor('#f97316').setTitle('👢 تم طردك').setDescription(`**السيرفر:** ${guild.name}\n**السبب:** ${reason||'لا سبب'}`).setTimestamp());
    await m.kick(reason||'Dashboard'); addLog('KICK',`${m.user.tag} kicked`,`Dashboard`); res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/mod/ban', async (req,res) => {
  try {
    const {userId,reason,days}=req.body; const guild=client.guilds.cache.get(config.guildId);
    await sendDM(userId, new EmbedBuilder().setColor('#ef4444').setTitle('🔨 تم حظرك').setDescription(`**السيرفر:** ${guild.name}\n**السبب:** ${reason||'لا سبب'}`).setTimestamp());
    await guild.members.ban(userId,{deleteMessageDays:days||0,reason:reason||'Dashboard'});
    addLog('BAN',`${userId} banned`,`Dashboard`); res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/mod/unban', async (req,res) => {
  try { const guild=client.guilds.cache.get(config.guildId); await guild.members.unban(req.body.userId); addLog('UNBAN',`${req.body.userId} unbanned`,'Dashboard'); res.json({success:true}); }
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/mod/mute', async (req,res) => {
  try {
    const {userId,duration,reason}=req.body; const m=await getMember(userId);
    const mins=parseInt(duration)||10; const guild=client.guilds.cache.get(config.guildId);
    await sendDM(userId, new EmbedBuilder().setColor('#a855f7').setTitle('🔇 تم كتمك').setDescription(`**السيرفر:** ${guild.name}\n**المدة:** ${mins} دقيقة\n**السبب:** ${reason||'لا سبب'}`).setTimestamp());
    await m.timeout(mins*60000,reason||'Dashboard'); addLog('MUTE',`${m.user.tag} muted ${mins}m`,'Dashboard'); res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/mod/unmute',   async (req,res) => { try { const m=await getMember(req.body.userId); await m.timeout(null); addLog('UNMUTE',`${m.user.tag}`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/mod/nickname', async (req,res) => { try { const m=await getMember(req.body.userId); await m.setNickname(req.body.nickname||null); addLog('NICK',`${m.user.tag} → ${req.body.nickname}`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/mod/move',     async (req,res) => { try { const m=await getMember(req.body.userId); await m.voice.setChannel(req.body.channelId); addLog('MOVE',`${m.user.tag}`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });

app.post('/api/mod/warn', async (req,res) => {
  try {
    const {userId,reason}=req.body; const guild=client.guilds.cache.get(config.guildId);
    const m=await guild.members.fetch(userId);
    userWarns[userId]=(userWarns[userId]||0)+1; const wc=userWarns[userId];
    await sendDM(userId, new EmbedBuilder().setColor('#f59e0b').setTitle('⚠️ تحذير').setDescription(`**السيرفر:** ${guild.name}\n**السبب:** ${reason||'لا سبب'}\n**تحذير رقم:** ${wc}`).setTimestamp());
    if (wc>=3) { await m.timeout(30*60000,'3 تحذيرات').catch(()=>{}); userWarns[userId]=0; }
    addLog('WARN',`${m.user.tag} warned (${wc}). ${reason}`,'Dashboard'); res.json({success:true,warns:wc});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/mod/remove-warn', (req,res) => {
  const {userId}=req.body;
  if (userWarns[userId]>0) userWarns[userId]--;
  addLog('REMOVE_WARN',`Warn removed from ${userId}`,'Dashboard');
  res.json({success:true,warns:userWarns[userId]||0});
});

app.post('/api/mod/clear', async (req,res) => {
  try { const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(req.body.channelId); const d=await ch.bulkDelete(Math.min(parseInt(req.body.amount)||10,100),true); addLog('CLEAR',`Deleted ${d.size} in #${ch.name}`,'Dashboard'); res.json({success:true,deleted:d.size}); }
  catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/mod/lock',     async (req,res) => { try { const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(req.body.channelId); await ch.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:false}); addLog('LOCK',`#${ch.name}`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/mod/unlock',   async (req,res) => { try { const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(req.body.channelId); await ch.permissionOverwrites.edit(guild.roles.everyone,{SendMessages:null}); addLog('UNLOCK',`#${ch.name}`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/mod/slowmode', async (req,res) => { try { const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(req.body.channelId); await ch.setRateLimitPerUser(parseInt(req.body.seconds)||0); addLog('SLOWMODE',`#${ch.name} ${req.body.seconds}s`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });

// ── Roles ──────────────────────────────────────────────────────────
app.post('/api/roles/create', async (req,res) => { try { const guild=client.guilds.cache.get(config.guildId); const role=await guild.roles.create({name:req.body.name,color:req.body.color||'#99aab5',hoist:!!req.body.hoist,mentionable:!!req.body.mentionable}); addLog('ROLE_CREATE',`"${req.body.name}"`,'Dashboard'); res.json({success:true,role:{id:role.id,name:role.name,color:role.hexColor}}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/roles/delete', async (req,res) => { try { const guild=client.guilds.cache.get(config.guildId); const role=guild.roles.cache.get(req.body.roleId); await role.delete(); addLog('ROLE_DELETE',`"${role.name}"`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/roles/give',   async (req,res) => { try { const m=await getMember(req.body.userId); await m.roles.add(req.body.roleId); addLog('ROLE_GIVE',`→ ${m.user.tag}`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/roles/remove', async (req,res) => { try { const m=await getMember(req.body.userId); await m.roles.remove(req.body.roleId); addLog('ROLE_REMOVE',`← ${m.user.tag}`,'Dashboard'); res.json({success:true}); } catch(e){res.status(500).json({error:e.message});} });
app.post('/api/roles/autorole',(req,res) => { config.autoRole=req.body.roleId; saveConfig(); res.json({success:true}); });
app.post('/api/roles/mass-give', async (req,res) => {
  try { const guild=client.guilds.cache.get(config.guildId); const members=await guild.members.fetch(); let count=0; for(const [,m] of members){if(!m.user.bot){await m.roles.add(req.body.roleId).catch(()=>{}); count++;}} addLog('MASS_ROLE',`Given to ${count}`,'Dashboard'); res.json({success:true,count}); }
  catch(e){res.status(500).json({error:e.message});}
});

// ── Tickets ────────────────────────────────────────────────────────
app.post('/api/tickets/create', async (req,res) => {
  try {
    const {userId,topic}=req.body; const guild=client.guilds.cache.get(config.guildId);
    const member=await guild.members.fetch(userId);
    const ch=await guild.channels.create({name:`ticket-${member.user.username}`,type:ChannelType.GuildText,parent:config.ticketCategoryId||null,
      permissionOverwrites:[{id:guild.id,deny:[PermissionsBitField.Flags.ViewChannel]},{id:userId,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages]}]});
    tickets[ch.id]={userId,topic,messages:[],closed:false,createdAt:new Date().toISOString()};
    ch.send({embeds:[new EmbedBuilder().setColor(config.embedColor).setTitle('🎫 تذكرة جديدة').setDescription(`مرحباً ${member}!\n**الموضوع:** ${topic||'دعم عام'}`).setTimestamp()]});
    addLog('TICKET_OPEN',`${member.user.tag}: ${topic}`,'Dashboard'); res.json({success:true,channelId:ch.id,channelName:ch.name});
  } catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/tickets',(_, res)=>res.json(tickets));
app.post('/api/tickets/close', async (req,res) => {
  try {
    const {channelId}=req.body; if(!tickets[channelId]) return res.status(404).json({error:'Not found'});
    tickets[channelId].closed=true; tickets[channelId].closedAt=new Date().toISOString();
    const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(channelId);
    if(ch){await ch.send({embeds:[new EmbedBuilder().setColor('#ef4444').setTitle('🔒 تم إغلاق التذكرة').setTimestamp()]}); setTimeout(()=>ch.delete().catch(()=>{}),5000);}
    addLog('TICKET_CLOSE',`${channelId}`,'Dashboard'); res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── Embed ──────────────────────────────────────────────────────────
app.post('/api/embed/send', async (req,res) => {
  try {
    const {channelId,title,description,color,footer,image}=req.body;
    const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(channelId);
    const e=new EmbedBuilder().setColor(color||config.embedColor).setTitle(title||'Embed').setDescription(description||'').setTimestamp();
    if(footer) e.setFooter({text:footer}); if(image) e.setImage(image);
    await ch.send({embeds:[e]}); addLog('EMBED',`#${ch.name}: ${title}`,'Dashboard'); res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── Giveaway ───────────────────────────────────────────────────────
app.post('/api/giveaway/start', async (req,res) => {
  try {
    const {channelId,prize,duration,winners}=req.body;
    const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(channelId);
    const endTime=Date.now()+(parseInt(duration)||60)*60000;
    const msg=await ch.send({embeds:[new EmbedBuilder().setColor('#f59e0b').setTitle(`🎉 ${prize}`)
      .setDescription(`تفاعل بـ 🎉\nالفائزون: **${winners||1}**\nينتهي: <t:${Math.floor(endTime/1000)}:R>`).setTimestamp(endTime)]});
    await msg.react('🎉');
    giveaways[msg.id]={prize,winners:parseInt(winners)||1,endTime,entries:[],channelId};
    setTimeout(async()=>{
      const g=giveaways[msg.id]; if(!g?.entries.length) return;
      const winIds=g.entries.sort(()=>0.5-Math.random()).slice(0,g.winners);
      ch.send({embeds:[new EmbedBuilder().setColor('#22c55e').setTitle('🏆 انتهى Giveaway!').setDescription(`**${g.prize}**\nالفائزون: ${winIds.map(id=>`<@${id}>`).join(', ')}`).setTimestamp()]});
    },parseInt(duration)*60000);
    addLog('GIVEAWAY',`Started: ${prize}`,'Dashboard'); res.json({success:true,messageId:msg.id});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── Poll ───────────────────────────────────────────────────────────
app.post('/api/poll/create', async (req,res) => {
  try {
    const {channelId,question,options}=req.body; const emojis=['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
    const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(channelId);
    const optArr=options||['نعم','لا'];
    const msg=await ch.send({embeds:[new EmbedBuilder().setColor(config.embedColor).setTitle(`📊 ${question}`).setDescription(optArr.map((o,i)=>`${emojis[i]} ${o}`).join('\n')).setTimestamp()]});
    for(let i=0;i<optArr.length;i++) await msg.react(emojis[i]);
    polls[msg.id]={question,options:optArr}; addLog('POLL',`${question}`,'Dashboard'); res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── Shop API ───────────────────────────────────────────────────────
app.get('/api/shop/items',(_, res)=>res.json(config.shopItems));
app.post('/api/shop/add',(req,res)=>{
  const {name,price,description,type,roleId}=req.body;
  if(!name||!price) return res.status(400).json({error:'اسم وسعر مطلوبان'});
  const item={id:Date.now(),name,price:parseInt(price),description:description||'',type:type||'item',roleId:roleId||null,available:true,createdAt:new Date().toISOString()};
  config.shopItems.push(item); saveConfig(); addLog('SHOP_ADD',`${name} (${price})`,'Dashboard'); res.json({success:true,item});
});
app.post('/api/shop/remove',(req,res)=>{
  config.shopItems=config.shopItems.filter(i=>i.id!==parseInt(req.body.itemId)); saveConfig(); res.json({success:true});
});
app.post('/api/shop/toggle',(req,res)=>{
  const item=config.shopItems.find(i=>i.id===parseInt(req.body.itemId));
  if(!item) return res.status(404).json({error:'Not found'});
  item.available=!item.available; saveConfig(); res.json({success:true,available:item.available});
});
app.post('/api/shop/set-price',(req,res)=>{
  const {type,price}=req.body;
  if(type==='mention') config.mentionPrice=parseInt(price);
  if(type==='ban')     config.banPrice=parseInt(price);
  if(type==='daily')   config.dailyAmount=parseInt(price);
  saveConfig(); res.json({success:true});
});
app.post('/api/shop/warn-user',(req,res)=>{
  const {userId}=req.body; config.shopWarns[userId]=(config.shopWarns[userId]||0)+1; saveConfig();
  res.json({success:true,warns:config.shopWarns[userId]});
});
app.post('/api/shop/remove-warn',(req,res)=>{
  const {userId}=req.body; if(config.shopWarns[userId]>0) config.shopWarns[userId]--; saveConfig();
  res.json({success:true,warns:config.shopWarns[userId]||0});
});

// ── Economy API ────────────────────────────────────────────────────
app.get('/api/economy',(_, res)=>{
  const top=Object.entries(config.economy).filter(([k])=>!k.startsWith('daily_')).sort((a,b)=>b[1]-a[1]).slice(0,20).map(([id,bal])=>({id,bal}));
  res.json({top,total:Object.keys(config.economy).filter(k=>!k.startsWith('daily_')).length});
});
app.post('/api/economy/give',  (req,res)=>{ addBal(req.body.userId,parseInt(req.body.amount)||0); res.json({success:true,balance:getBal(req.body.userId)}); });
app.post('/api/economy/deduct',(req,res)=>{ deductBal(req.body.userId,parseInt(req.body.amount)||0); res.json({success:true,balance:getBal(req.body.userId)}); });

// ── Auction API ────────────────────────────────────────────────────
app.get('/api/auctions',(_, res)=>res.json(auctions));
app.post('/api/auction/start', async (req,res) => {
  try {
    const {channelId,item,startPrice,duration}=req.body;
    const guild=client.guilds.cache.get(config.guildId); const ch=guild.channels.cache.get(channelId);
    const endTime=Date.now()+(parseInt(duration)||60)*60000; const aId=Date.now().toString();
    const msg=await ch.send({embeds:[new EmbedBuilder().setColor('#f59e0b').setTitle(`🔨 مزاد: ${item}`)
      .setDescription(`**السعر الابتدائي:** ${startPrice} عملة\n**للمزايدة:** \`${config.prefix}شراء مزاد ${aId} <مبلغ>\`\n**ينتهي:** <t:${Math.floor(endTime/1000)}:R>`)
      .setFooter({text:`ID: ${aId}`}).setTimestamp(endTime)]});
    auctions[aId]={item,startPrice:parseInt(startPrice),currentBid:parseInt(startPrice),bidder:null,endTime,channelId,msgId:msg.id};
    setTimeout(async()=>{
      const a=auctions[aId]; if(!a) return;
      if(a.bidder) ch.send({embeds:[new EmbedBuilder().setColor('#22c55e').setTitle('🏆 انتهى المزاد!').setDescription(`**${a.item}**\nالفائز: <@${a.bidder}> بـ **${a.currentBid}** عملة`).setTimestamp()]});
      else ch.send({embeds:[new EmbedBuilder().setColor('#ef4444').setTitle('❌ المزاد انتهى بدون فائز').setTimestamp()]});
      delete auctions[aId];
    },parseInt(duration)*60000);
    addLog('AUCTION_START',`${item} (${startPrice})`,'Dashboard'); res.json({success:true,auctionId:aId});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── Auto Responses API ─────────────────────────────────────────────
app.get('/api/autoresponses',(_, res)=>res.json(config.autoResponses));
app.post('/api/autoresponses/add',(req,res)=>{
  const {trigger,response}=req.body; if(!trigger||!response) return res.status(400).json({error:'مطلوب'});
  config.autoResponses.push({trigger,response}); saveConfig(); res.json({success:true});
});
app.post('/api/autoresponses/remove',(req,res)=>{
  config.autoResponses.splice(parseInt(req.body.index),1); saveConfig(); res.json({success:true});
});

// ── Mentions API ───────────────────────────────────────────────────
app.post('/api/mentions/add',(req,res)=>{ config.mentionPacks[req.body.userId]=(config.mentionPacks[req.body.userId]||0)+parseInt(req.body.count||1); saveConfig(); res.json({success:true,total:config.mentionPacks[req.body.userId]}); });
app.post('/api/mentions/remove',(req,res)=>{ config.mentionPacks[req.body.userId]=0; saveConfig(); res.json({success:true}); });

// ── Config ─────────────────────────────────────────────────────────
app.post('/api/config/update',(req,res)=>{
  const allowed=['welcomeChannelId','leaveChannelId','logChannelId','ticketCategoryId','requestChannelId',
    'aiModeration','antiSpam','antiGhostPing','maxMentions','badWords','bannedDomains','mentionPrice','banPrice','dailyAmount'];
  Object.keys(req.body).forEach(k=>{if(allowed.includes(k)) config[k]=req.body[k];});
  saveConfig(); res.json({success:true});
});

// ═══════════════════════════════════════════════════════════════
//  BOT SESSION
// ═══════════════════════════════════════════════════════════════
let botConnected=false, botConnecting=false;

async function startBot(token) {
  if (botConnecting) return {success:false,error:'جاري الاتصال...'};
  if (botConnected) await stopBot();
  botConnecting=true;
  try {
    config.token=token; saveConfig();
    await client.login(token);
    botConnected=true; botConnecting=false;
    addLog('SYSTEM',`Connected: ${client.user?.tag}`);
    return {success:true,tag:client.user?.tag};
  } catch(err) {
    botConnected=false; botConnecting=false;
    addLog('ERROR',`Login failed: ${err.message}`);
    return {success:false,error:err.message};
  }
}

async function stopBot() {
  if (!botConnected) return;
  try { client.removeAllListeners(); await client.destroy(); botConnected=false; } catch(_){}
}

app.post('/api/bot/connect', async (req,res) => {
  let {token,guildId}=req.body;
  if (!token) return res.status(400).json({error:'التوكن مطلوب'});
  if (token==='__SAVED__') { token=config.token; if(!token) return res.status(400).json({error:'لا توكن محفوظ'}); }
  if (guildId) { config.guildId=guildId; saveConfig(); }
  res.json(await startBot(token.trim()));
});
app.post('/api/bot/disconnect', async (_, res)=>{ await stopBot(); res.json({success:true}); });
app.get('/api/bot/session',    (_, res) => res.json({connected:botConnected,connecting:botConnecting,tag:client.user?.tag||null,hasToken:!!config.token,guildId:config.guildId||null}));

// ═══════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════
server.listen(config.port, async () => {
  console.log(`🌐 AFRM Dashboard v3 → http://localhost:${config.port}`);
  if (config.token) {
    console.log('🔄 Auto-connecting...');
    const r = await startBot(config.token);
    console.log(r.success ? `✅ ${r.tag}` : `❌ ${r.error}`);
  } else {
    console.log('⚠️  افتح اللوحة وأدخل التوكن');
  }
});
