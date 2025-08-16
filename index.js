/**
 * index.js
 * Full ticket bot - single file (discord.js v14)
 * - !ticket panel (editable banner)
 * - dropdown categories: 📬 SUPPORT, 💵 BILLINGS
 * - Creates ticket channel in Tickets category (auto-create) or parent category set by !ticketcategory
 * - Buttons: Lock, Unlock, Claim (adds ✅ prefix), Delete (modal reason), Delete & Transcript (modal reason)
 * - Transcript HTML generated and optionally uploaded to transcripts channel
 * - Admin commands: !ticketcategory #channel, !setstaff @role, !settranscripts #channel, !setbanner <url>
 * - Render-ready (express keep-alive) - TOKEN in .env
 */

require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

// ========== Keep-alive (Render) ==========
const app = express();
app.get("/", (_req, res) => res.send("Ticket bot is alive"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Keep-alive server running on port ${PORT}`));

// ========== Client ==========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User, Partials.GuildMember]
});

// ========== In-memory config (non-persistent) ==========
const config = {
  ticketCategoryId: null,      // parent category id (if admin sets with !ticketcategory)
  staffRoleId: null,           // staff role id (set with !setstaff)
  transcriptsChannelId: null,  // channel id to upload transcripts to (!settranscripts)
  panelBannerUrl: null,        // banner image URL for ticket panel (!setbanner)
  prefix: "!"
};

// In-memory tickets map: channelId -> ticket data
const tickets = {};
let ticketCounter = 1;

// Colors & emoji
const COLORS = { panel: 0xFF5050, ticketHeader: 0x2B2D31, accent: 0xFF6B6B };
const EMOJI = {
  support: "📬",
  billings: "💵",
  lock: "🔒",
  unlock: "🔓",
  claim: "✅",
  delete: "🗑️",
  transcript: "🧾"
};

// ========== Utility builders ==========

function buildPanelEmbed(guild) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.panel)
    .setAuthor({ name: `${guild.name} • Support`, iconURL: guild.iconURL({ size: 128 }) ?? undefined })
    .setTitle("Open a Ticket")
    .setDescription(`Select a category from the menu below to open a private support ticket. Our staff will respond as soon as possible.`)
    .addFields(
      { name: "How to create a ticket", value: "`1.` Choose the correct category\n`2.` Answer follow-up questions (if any)\n`3.` Wait for staff to respond", inline: false },
      { name: "Rules", value: "Don't open multiple tickets for the same issue. Abuse may lead to punishment.", inline: false }
    )
    .setFooter({ text: "Support • Select a category to start" })
    .setTimestamp();

  if (config.panelBannerUrl) embed.setImage(config.panelBannerUrl);
  return embed;
}

function buildPanelComponents() {
  const select = new StringSelectMenuBuilder()
    .setCustomId("ticket_select")
    .setPlaceholder("Choose a category to open a ticket")
    .addOptions(
      {
        label: "SUPPORT",
        value: "support",
        description: "General support & help",
        emoji: EMOJI.support
      },
      {
        label: "BILLINGS",
        value: "billings",
        description: "Payments & purchases help",
        emoji: EMOJI.billings
      }
    );
  return [ new ActionRowBuilder().addComponents(select) ];
}

function buildTicketButtons(isLocked = false, isClaimed = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_lock").setLabel("Lock").setStyle(ButtonStyle.Primary).setEmoji(EMOJI.lock).setDisabled(isLocked),
    new ButtonBuilder().setCustomId("ticket_unlock").setLabel("Unlock").setStyle(ButtonStyle.Secondary).setEmoji(EMOJI.unlock).setDisabled(!isLocked),
    new ButtonBuilder().setCustomId("ticket_claim").setLabel(isClaimed ? "Claimed" : "Claim").setStyle(ButtonStyle.Success).setEmoji(EMOJI.claim).setDisabled(isClaimed)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ticket_delete").setLabel("Delete").setStyle(ButtonStyle.Danger).setEmoji(EMOJI.delete),
    new ButtonBuilder().setCustomId("ticket_delete_transcript").setLabel("Delete & Transcript").setStyle(ButtonStyle.Danger).setEmoji(EMOJI.transcript)
  );
  return [row1, row2];
}

function buildTicketHeaderEmbed(ticketName, opener, categoryLabel) {
  return new EmbedBuilder()
    .setColor(COLORS.panel)
    .setTitle(`#${ticketName}`)
    .setDescription(`<@${opener.id}> has created a ticket under **${categoryLabel}**.`)
    .addFields(
      { name: "Opened by", value: `<@${opener.id}>`, inline: true },
      { name: "Category", value: categoryLabel, inline: true }
    )
    .setTimestamp();
}

function buildClosedDMEmbed({ guild, ticketId, opener, closedBy, claimedBy, reason, openTime, transcriptUrl }) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ size: 128 }) ?? undefined })
    .setTitle("Ticket Closed")
    .setColor(COLORS.panel)
    .addFields(
      { name: "🔢 Ticket ID", value: String(ticketId), inline: true },
      { name: "✅ Opened By", value: `<@${opener.id}>`, inline: true },
      { name: "🛑 Closed By", value: closedBy ? `<@${closedBy.id}>` : "Unknown", inline: true },
      { name: "🧰 Claimed By", value: claimedBy ? `<@${claimedBy.id}>` : "Not claimed", inline: true },
      { name: "⏰ Open Time", value: openTime ? openTime.toLocaleString() : "Unknown", inline: true },
      { name: "📝 Reason", value: reason || "No reason provided", inline: false }
    )
    .setTimestamp();

  const components = [];
  if (transcriptUrl) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel("View Online Transcript").setStyle(ButtonStyle.Link).setURL(transcriptUrl)
    ));
  }

  return { embed, components };
}

// Convert messages to HTML transcript buffer
function messagesToHTML(transcriptTitle, messages) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = messages.map(m => {
    const time = new Date(m.createdTimestamp).toLocaleString();
    const author = esc(m.author?.tag || "Unknown");
    const content = esc(m.content || "");
    const attachments = [...m.attachments.values()].map(a => `<div class="att"><a href="${esc(a.url)}" target="_blank">${esc(a.name)}</a></div>`).join("");
    return `<div class="msg"><div class="meta">${time} — <b>${author}</b></div><div class="content">${content}</div>${attachments}</div>`;
  }).join("\n");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(transcriptTitle)}</title>
  <style>body{background:#0d0f12;color:#e6e6e6;font-family:Arial,Helvetica,sans-serif;padding:20px}
  h1{color:#ffb3b3} .msg{padding:8px;border-bottom:1px solid #1f1f1f}.meta{color:#b8b8b8;font-size:12px}.content{white-space:pre-wrap}
  .att a{color:#8ab4ff;text-decoration:none}</style></head><body><h1>${esc(transcriptTitle)}</h1>${rows}</body></html>`;
  return Buffer.from(html, "utf-8");
}

// Fetch messages (up to cap)
async function fetchAllMessages(channel) {
  const collected = [];
  try {
    let lastId;
    while (true) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;
      const batch = await channel.messages.fetch(options);
      if (!batch || batch.size === 0) break;
      collected.push(...batch.values());
      lastId = batch.at(batch.size - 1).id;
      if (collected.length >= 5000) break;
    }
    return Array.from(collected).reverse();
  } catch (e) {
    console.error("fetchAllMessages error:", e);
    return collected.reverse();
  }
}

// Ensure Tickets category exists; returns category id
async function ensureTicketsCategory(guild) {
  if (config.ticketCategoryId) {
    const cat = guild.channels.cache.get(config.ticketCategoryId);
    if (cat && cat.type === ChannelType.GuildCategory) return config.ticketCategoryId;
  }

  const existing = guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase().includes("ticket"));
  if (existing) return existing.id;

  try {
    const created = await guild.channels.create({ name: "Tickets", type: ChannelType.GuildCategory });
    return created.id;
  } catch (e) {
    console.error("Failed to create Tickets category:", e);
    return null;
  }
}

// ========== Message (prefix) commands ==========
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content.startsWith(config.prefix)) return;

  const [cmdRaw, ...args] = message.content.slice(config.prefix.length).trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const member = message.member;
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

  // !ticket -> post the panel
  if (cmd === "ticket") {
    const embed = buildPanelEmbed(message.guild);
    const components = buildPanelComponents();
    await message.channel.send({ embeds: [embed], components });
    return;
  }

  // Admin-only setup commands
  if (!isAdmin) return;

  // !ticketcategory #channel -> uses parent category of the mentioned channel
  if (cmd === "ticketcategory") {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply("Please mention a channel that is inside the category you want to use (I will use its parent category).");
    if (!ch.parentId) return message.reply("That channel has no parent category. Put it inside a category and try again.");
    config.ticketCategoryId = ch.parentId;
    return message.reply(`✅ Ticket parent category set to <#${config.ticketCategoryId}>.`);
  }

  // !setstaff @role
  if (cmd === "setstaff") {
    const role = message.mentions.roles.first();
    if (!role) return message.reply("Please mention a role to set as staff.");
    config.staffRoleId = role.id;
    return message.reply(`✅ Staff role set to <@&${role.id}>.`);
  }

  // !settranscripts #channel
  if (cmd === "settranscripts") {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply("Please mention a channel to upload transcripts to.");
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(ch.type)) return message.reply("Transcripts channel must be a text channel.");
    config.transcriptsChannelId = ch.id;
    return message.reply(`✅ Transcripts channel set to <#${ch.id}>.`);
  }

  // !setbanner <url>
  if (cmd === "setbanner") {
    const url = args[0];
    if (!url || !/^https?:\/\//i.test(url)) return message.reply("Please provide a valid image URL (http/https).");
    config.panelBannerUrl = url;
    return message.reply("✅ Panel banner image updated.");
  }
});

// ========== Interactions (selects, buttons, modals) ==========
client.on("interactionCreate", async (interaction) => {
  try {
    // Select menu: create ticket
    if (interaction.isStringSelectMenu() && interaction.customId === "ticket_select") {
      const value = interaction.values[0]; // support | billings
      const categoryLabel = value === "billings" ? "BILLINGS" : "SUPPORT";
      const opener = interaction.user;
      const guild = interaction.guild;

      // Prevent user from creating multiple tickets
      const existing = Object.entries(tickets).find(([cId, data]) => data.openerId === opener.id);
      if (existing) {
        return interaction.reply({ content: `You already have an open ticket: <#${existing[0]}>`, ephemeral: true });
      }

      // Ensure category
      const categoryId = await ensureTicketsCategory(guild);
      if (!categoryId) return interaction.reply({ content: "Failed to create/find Tickets category. Ask an admin to check permissions.", ephemeral: true });

      // Create channel
      const ticketName = `ticket-${ticketCounter}`;
      ticketCounter++;

      // Build permission overwrites
      const overwrites = [
        { id: guild.roles.everyone.id ?? guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: opener.id, allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks
        ] }
      ];
      if (config.staffRoleId) {
        overwrites.push({
          id: config.staffRoleId,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ManageChannels
          ]
        });
      }

      const channel = await guild.channels.create({
        name: ticketName,
        type: ChannelType.GuildText,
        parent: categoryId,
        permissionOverwrites: overwrites,
        topic: `Ticket for ${opener.tag} (${opener.id}) • Category: ${categoryLabel}`
      });

      // Save ticket data
      tickets[channel.id] = {
        openerId: opener.id,
        type: categoryLabel,
        openedAt: new Date(),
        claimedBy: null,
        locked: false,
        ticketNumber: ticketCounter - 1
      };

      const header = buildTicketHeaderEmbed(ticketName, opener, categoryLabel);
      const rows = buildTicketButtons(false, false);

      const mentionStaff = config.staffRoleId ? `<@&${config.staffRoleId}>` : "`(Set a staff role with !setstaff)`";

      await channel.send({ content: `<@${opener.id}> ${mentionStaff}`, embeds: [header], components: rows });
      return interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
    }

    // Button handling inside ticket channels
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // If inside a ticket channel
      const channel = interaction.channel;
      const ticketData = channel && tickets[channel.id] ? tickets[channel.id] : null;

      // LOCK
      if (customId === "ticket_lock" && ticketData) {
        const isStaff = config.staffRoleId && interaction.member.roles.cache.has(config.staffRoleId);
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        if (!(isStaff || isAdmin)) return interaction.reply({ content: "Only staff can lock tickets.", ephemeral: true });

        if (ticketData.locked) return interaction.reply({ content: "Ticket already locked.", ephemeral: true });

        await channel.permissionOverwrites.edit(ticketData.openerId, { SendMessages: false }).catch(() => {});
        ticketData.locked = true;
        const rows = buildTicketButtons(true, !!ticketData.claimedBy);
        await interaction.update({ components: rows });
        await channel.send(`${EMOJI.lock} Ticket locked by <@${interaction.user.id}>.`);
        return;
      }

      // UNLOCK
      if (customId === "ticket_unlock" && ticketData) {
        const isStaff = config.staffRoleId && interaction.member.roles.cache.has(config.staffRoleId);
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        if (!(isStaff || isAdmin)) return interaction.reply({ content: "Only staff can unlock tickets.", ephemeral: true });

        if (!ticketData.locked) return interaction.reply({ content: "Ticket is not locked.", ephemeral: true });

        await channel.permissionOverwrites.edit(ticketData.openerId, { SendMessages: true }).catch(() => {});
        ticketData.locked = false;
        const rows = buildTicketButtons(false, !!ticketData.claimedBy);
        await interaction.update({ components: rows });
        await channel.send(`${EMOJI.unlock} Ticket unlocked by <@${interaction.user.id}>.`);
        return;
      }

      // CLAIM => add ✅ prefix to channel name
      if (customId === "ticket_claim" && ticketData) {
        const isStaff = config.staffRoleId && interaction.member.roles.cache.has(config.staffRoleId);
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        if (!(isStaff || isAdmin)) return interaction.reply({ content: "Only staff can claim tickets.", ephemeral: true });

        if (ticketData.claimedBy) return interaction.reply({ content: `Already claimed by <@${ticketData.claimedBy}>.`, ephemeral: true });

        ticketData.claimedBy = interaction.user.id;
        let newName = channel.name;
        if (!newName.startsWith(`${EMOJI.claim} `)) {
          try { newName = `${EMOJI.claim} ${newName}`; await channel.setName(newName).catch(() => {}); } catch(e) {}
        }

        const rows = buildTicketButtons(ticketData.locked, true);
        await interaction.update({ components: rows });
        await channel.send(`${EMOJI.claim} Ticket claimed by <@${interaction.user.id}>.`);
        return;
      }

      // DELETE -> show modal to collect reason
      if ((customId === "ticket_delete" || customId === "ticket_delete_transcript") && ticketData) {
        const isStaff = config.staffRoleId && interaction.member.roles.cache.has(config.staffRoleId);
        const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
        if (!(isStaff || isAdmin)) return interaction.reply({ content: "Only staff can close/delete tickets.", ephemeral: true });

        const wantTranscript = customId === "ticket_delete_transcript";
        const modal = new ModalBuilder()
          .setCustomId(wantTranscript ? "close_modal:trans" : "close_modal:notrans")
          .setTitle("Reason for closing ticket");

        const reasonInput = new TextInputBuilder()
          .setCustomId("close_reason")
          .setLabel("Please provide a reason to close the ticket (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("E.g. Issue resolved / Duplicate / Abusive behavior")
          .setRequired(false)
          .setMinLength(0).setMaxLength(1000);

        const row = new ActionRowBuilder().addComponents(reasonInput);
        modal.addComponents(row);

        return interaction.showModal(modal);
      }
    }

    // Modal submit (closing ticket)
    if (interaction.isModalSubmit()) {
      const customId = interaction.customId; // "close_modal:trans" or "close_modal:notrans"
      if (!customId.startsWith("close_modal")) return;

      const withTranscript = customId.endsWith(":trans") || customId.includes("trans");
      const reason = interaction.fields.getTextInputValue("close_reason")?.trim() || "";
      const channel = interaction.channel;
      const ticketData = channel && tickets[channel.id] ? tickets[channel.id] : null;
      if (!ticketData) return interaction.reply({ content: "This channel is not recognized as a ticket.", ephemeral: true });

      // Acknowledge modal
      await interaction.reply({ content: "Closing ticket... processing.", ephemeral: true });

      // Build transcript if requested and transcripts channel set
      let transcriptUrl = null;
      if (withTranscript && config.transcriptsChannelId) {
        try {
          const allMessages = await fetchAllMessages(channel);
          const htmlBuffer = messagesToHTML(`${interaction.guild.name} • ${channel.name}`, allMessages);
          const attachment = new AttachmentBuilder(htmlBuffer, { name: `${channel.name}-transcript.html` });

          const transcriptsCh = await interaction.guild.channels.fetch(config.transcriptsChannelId).catch(() => null);
          if (transcriptsCh && transcriptsCh.isTextBased && transcriptsCh.isTextBased()) {
            const sent = await transcriptsCh.send({ content: `Transcript for ${channel} • Opened by <@${ticketData.openerId}>`, files: [attachment] });
            const att = sent.attachments.first();
            if (att) transcriptUrl = att.url;
          }
        } catch (e) {
          console.error("Transcript generation error:", e);
        }
      }

      // DM the opener if possible
      let openerUser = null;
      try { openerUser = await client.users.fetch(ticketData.openerId); } catch (e) { openerUser = null; }

      if (openerUser) {
        const { embed, components } = buildClosedDMEmbed({
          guild: interaction.guild,
          ticketId: ticketData.ticketNumber,
          opener: openerUser,
          closedBy: interaction.user ? interaction.user : null,
          claimedBy: ticketData.claimedBy ? { id: ticketData.claimedBy } : null,
          reason: reason || null,
          openTime: ticketData.openedAt,
          transcriptUrl
        });

        try { await openerUser.send({ embeds: [embed], components }).catch(() => {}); } catch (e) { console.warn("Failed to DM opener:", e); }
      }

      // Announce & delete channel
      try {
        await channel.send(`${EMOJI.delete} Ticket closed by <@${interaction.user.id}>. Deleting channel...`).catch(() => {});
      } catch {}

      // Remove ticket from memory
      delete tickets[channel.id];

      // Finally delete channel
      await channel.delete().catch(() => { /* ignore */ });
      return;
    }
  } catch (err) {
    console.error("interaction error:", err);
    if (interaction && interaction.isRepliable && interaction.isRepliable()) {
      try { await interaction.reply({ content: "An error occurred while processing that action.", ephemeral: true }); } catch {}
    }
  }
});

// ========== Ready & Login ==========
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.TOKEN).catch(err => {
  console.error("Failed to login. Did you set TOKEN in .env?", err);
});

