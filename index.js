const Discord = require('discord.js')
const { LoggerFactory } = require('logger.js')
require('dotenv').config()

const { Intents, Permissions, MessageEmbed, MessageActionRow, MessageButton } = Discord

const client = new Discord.Client({
  // MESSAGE_CONTENT is only needed for the legacy "//" text commands.
  intents: Intents.FLAGS.GUILDS | Intents.FLAGS.GUILD_MESSAGES | Intents.FLAGS.MESSAGE_CONTENT,
})
const logger = LoggerFactory.getLogger('client', 'green')

const DYE_NAME = 'すごい染料'
const PAGE_SIZE = 10
const ROLE_LIMIT = 250

// these colors are just bad (hard to see)
// #000000 is used as default color
const bannedColors = new Set([0x000000, 0x444444])

// all colors that /setup creates
const DYE_COLORS = (() => {
  const steps = ['0', '4', '8', 'c', 'f']
  const colors = []
  for (const r of steps) for (const g of steps) for (const b of steps) {
    const color = parseInt(`${r}${r}${g}${g}${b}${b}`, 16)
    if (!bannedColors.has(color)) colors.push(color)
  }
  return colors
})()

const hex = color => color.toString(16).padStart(6, '0')

const diffColor = (a, b) =>
  Math.abs(((a >> 16) & 0xFF) - ((b >> 16) & 0xFF)) +
  Math.abs(((a >> 8) & 0xFF) - ((b >> 8) & 0xFF)) +
  Math.abs((a & 0xFF) - (b & 0xFF))

/** Accepts "ff8800", "#ff8800", "0xff8800". Returns null if invalid. */
const parseColor = input => {
  if (!input) return null
  const s = input.trim().replace(/^(#|0x)/i, '')
  return /^[0-9a-f]{1,6}$/i.test(s) ? parseInt(s, 16) : null
}

const isDye = role => role.name === DYE_NAME

/** Dye roles sorted by closeness to the given color (closest first). */
const sortedDyes = async (guild, color) => {
  const roles = await guild.roles.fetch()
  return [...roles.values()]
    .filter(isDye)
    .map(role => ({ role, diff: diffColor(color, role.color) }))
    .sort((a, b) => a.diff - b.diff)
    .map(x => x.role)
}

const simpleEmbed = (color, description) =>
  new MessageEmbed().setColor(color).setTitle(DYE_NAME).setDescription(description)

const errorPayload = description => ({ embeds: [simpleEmbed('RED', description)] })

// ---------------------------------------------------------------- actions
// Each action takes a context: { guild, member, user, defer(), reply(payload) }

const setDye = async (ctx, role) => {
  // one API call: keep every non-dye role, add the chosen one
  const keep = ctx.member.roles.cache.filter(r => !isDye(r)).map(r => r.id)
  await ctx.member.roles.set([...keep, role.id])
}

const actionSet = async (ctx, input) => {
  const color = parseColor(input)
  if (color === null) return ctx.reply({ ...errorPayload('色は `ff8800` のような16進数で指定してください。'), ephemeral: true })
  await ctx.defer()
  const [role] = await sortedDyes(ctx.guild, color)
  if (!role) return ctx.reply({ ...errorPayload('染料がありません。管理者に `/setup` を実行してもらってください。'), ephemeral: true })
  await setDye(ctx, role)
  return ctx.reply({ embeds: [simpleEmbed(role.color, `色を${hex(role.color)}に設定しました。`)] })
}

const actionRemove = async (ctx) => {
  const owned = ctx.member.roles.cache.filter(isDye)
  if (owned.size === 0) return ctx.reply({ ...errorPayload('すごい染料があなたについていません。削除することに失敗しました。'), ephemeral: true })
  const color = owned.first().color
  await ctx.member.roles.remove(owned)
  return ctx.reply({ embeds: [simpleEmbed(color, 'あなたの染料を削除しました。')] })
}

const buildPicker = (dyes, color, page, ownerId, tag) => {
  const pages = Math.max(1, Math.ceil(dyes.length / PAGE_SIZE))
  page = Math.min(Math.max(page, 1), pages)
  const slice = dyes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const embed = new MessageEmbed()
    .setColor(color)
    .setTitle(`${DYE_NAME} (${page}/${pages})`)
    .setFooter({ text: tag })
  slice.forEach((role, i) => embed.addField(`${i + 1}. #${hex(role.color)}`, `<@&${role.id}>`))

  const rows = []
  for (let i = 0; i < slice.length; i += 5) {
    rows.push(new MessageActionRow().addComponents(
      slice.slice(i, i + 5).map((role, j) =>
        new MessageButton()
          .setCustomId(`dye:pick:${role.id}:${ownerId}`)
          .setLabel(String(i + j + 1))
          .setStyle('SECONDARY')),
    ))
  }
  rows.push(new MessageActionRow().addComponents(
    new MessageButton().setCustomId(`dye:page:${hex(color)}:${page - 1}:${ownerId}`).setLabel('◀').setStyle('PRIMARY').setDisabled(page <= 1),
    new MessageButton().setCustomId(`dye:page:${hex(color)}:${page + 1}:${ownerId}`).setLabel('▶').setStyle('PRIMARY').setDisabled(page >= pages),
  ))
  return { embeds: [embed], components: rows }
}

const actionColor = async (ctx, input) => {
  const color = input ? parseColor(input) : 0
  if (color === null) return ctx.reply({ ...errorPayload('色は `ff8800` のような16進数で指定してください。'), ephemeral: true })
  await ctx.defer()
  const dyes = await sortedDyes(ctx.guild, color)
  if (dyes.length === 0) return ctx.reply({ ...errorPayload('染料がありません。管理者に `/setup` を実行してもらってください。'), ephemeral: true })
  return ctx.reply(buildPicker(dyes, color, 1, ctx.user.id, ctx.user.tag))
}

const requireManageRoles = ctx => {
  if (ctx.member.permissions.has(Permissions.FLAGS.MANAGE_ROLES)) return true
  ctx.reply({ content: 'この操作には「ロールの管理」権限が必要です。', ephemeral: true })
  return false
}

const actionSetup = async (ctx) => {
  if (!requireManageRoles(ctx)) return
  await ctx.defer()
  const roles = await ctx.guild.roles.fetch()
  // don't recreate colors that already exist
  const existing = new Set([...roles.values()].filter(isDye).map(r => r.color))
  const missing = DYE_COLORS.filter(c => !existing.has(c))
  if (missing.length === 0) return ctx.reply('染料はすでにすべて作成されています。')
  const free = ROLE_LIMIT - roles.size
  if (free < missing.length) {
    return ctx.reply(`ロール数の空きが${missing.length}個必要です。(あと${missing.length - free}個)`)
  }
  logger.info(`Attempting to create ${missing.length} roles in ${ctx.guild.id}`)
  // discord.js queues requests, so rate limits are handled for us
  await Promise.all(missing.map(color => ctx.guild.roles.create({ name: DYE_NAME, color, reason: '/setup' })))
  return ctx.reply(`ロールの作成が完了しました。(${missing.length}個作成)`)
}

const actionRemoveAll = async (ctx) => {
  if (!requireManageRoles(ctx)) return
  await ctx.defer()
  const roles = await ctx.guild.roles.fetch()
  const dyes = [...roles.values()].filter(isDye)
  await Promise.all(dyes.map(role => role.delete('/removeall')))
  return ctx.reply(`染料ロールをすべて削除しました。(${dyes.length}個)`)
}

const helpEmbed = canManage => {
  const embed = new MessageEmbed().setColor('GREEN').setTitle('コマンド')
    .addField('/set <RGB>', '色を設定します。指定した色が使用できない場合は一番近い色に設定されます。')
    .addField('/color [RGB]', '近い色の一覧から選んで設定します。')
    .addField('/remove', '自分が設定している色を削除します。')
  if (canManage) {
    embed.addField('/setup', 'すごい染料を作成します。')
    embed.addField('/removeall', 'すごい染料をすべて削除します。')
  }
  return embed
}

// ---------------------------------------------------------------- slash commands
const commandDefinitions = [
  {
    name: 'set',
    description: '色を設定します (一番近い染料が使われます)',
    options: [{ type: 'STRING', name: 'color', description: '16進数のRGB (例: ff8800)', required: true }],
    dmPermission: false,
  },
  {
    name: 'color',
    description: '近い色の一覧から染料を選びます',
    options: [{ type: 'STRING', name: 'color', description: '16進数のRGB (例: ff8800)', required: false }],
    dmPermission: false,
  },
  { name: 'remove', description: '自分の染料を削除します', dmPermission: false },
  { name: 'help', description: 'コマンド一覧を表示します', dmPermission: false },
  {
    name: 'setup',
    description: '染料ロールを作成します (管理者向け)',
    defaultMemberPermissions: Permissions.FLAGS.MANAGE_ROLES,
    dmPermission: false,
  },
  {
    name: 'removeall',
    description: '染料ロールをすべて削除します (管理者向け)',
    defaultMemberPermissions: Permissions.FLAGS.MANAGE_ROLES,
    dmPermission: false,
  },
]

const slashContext = interaction => {
  let deferred = false
  return {
    guild: interaction.guild,
    member: interaction.member,
    user: interaction.user,
    defer: async () => {
      if (!deferred) { deferred = true; await interaction.deferReply() }
    },
    reply: payload => {
      const p = typeof payload === 'string' ? { content: payload } : payload
      if (deferred) {
        // ephemeral can't be applied after deferring publicly
        const { ephemeral, ...rest } = p
        return interaction.editReply(rest)
      }
      return interaction.reply(p)
    },
  }
}

const messageContext = msg => ({
  guild: msg.guild,
  member: msg.member,
  user: msg.author,
  defer: async () => {},
  reply: payload => {
    const { ephemeral, ...rest } = typeof payload === 'string' ? { content: payload } : payload
    return msg.reply({ ...rest, failIfNotExists: false })
  },
})

const run = async (ctx, name, arg) => {
  switch (name) {
    case 'set': return actionSet(ctx, arg)
    case 'color': return actionColor(ctx, arg)
    case 'remove': return actionRemove(ctx)
    case 'setup': return actionSetup(ctx)
    case 'removeall': return actionRemoveAll(ctx)
    case 'help': return ctx.reply({ embeds: [helpEmbed(ctx.member.permissions.has(Permissions.FLAGS.MANAGE_ROLES))] })
  }
}

const safeRun = async (ctx, name, arg) => {
  try {
    await run(ctx, name, arg)
  } catch (e) {
    logger.error(`Command ${name} failed: ${e && e.stack || e}`)
    await ctx.reply({ content: 'エラーが発生しました。Botの権限(ロールの管理・ロール順位)を確認してください。', ephemeral: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------- events
client.once('ready', async () => {
  logger.info(`Logged in as ${client.user.tag}!`)
  try {
    // GUILD_ID makes commands appear instantly (useful for development)
    const target = process.env.GUILD_ID ? await client.guilds.fetch(process.env.GUILD_ID) : client.application
    await target.commands.set(commandDefinitions)
    logger.info('Slash commands registered.')
  } catch (e) {
    logger.error(`Failed to register slash commands: ${e}`)
  }
})

client.on('interactionCreate', async interaction => {
  if (!interaction.guild) return

  if (interaction.isCommand()) {
    const ctx = slashContext(interaction)
    return safeRun(ctx, interaction.commandName, interaction.options.getString('color'))
  }

  if (interaction.isButton() && interaction.customId.startsWith('dye:')) {
    const [, kind, a, b, ownerId] = interaction.customId.split(':')
    // pick:<roleId>:<ownerId>   page:<color>:<page>:<ownerId>
    const owner = kind === 'pick' ? b : ownerId
    if (interaction.user.id !== owner) {
      return interaction.reply({ content: 'これはあなたのメニューではありません。`/color` で開いてください。', ephemeral: true })
    }
    try {
      if (kind === 'page') {
        const color = parseInt(a, 16)
        const dyes = await sortedDyes(interaction.guild, color)
        return interaction.update(buildPicker(dyes, color, parseInt(b, 10), owner, interaction.user.tag))
      }
      if (kind === 'pick') {
        const role = await interaction.guild.roles.fetch(a)
        if (!role) return interaction.reply({ ...errorPayload('その染料は存在しません。'), ephemeral: true })
        await setDye({ member: interaction.member }, role)
        return interaction.reply({ embeds: [simpleEmbed(role.color, `色を${hex(role.color)}に設定しました。`)], ephemeral: true })
      }
    } catch (e) {
      logger.error(`Button failed: ${e && e.stack || e}`)
      const payload = { content: 'エラーが発生しました。', ephemeral: true }
      if (interaction.replied || interaction.deferred) interaction.followUp(payload).catch(() => {})
      else interaction.reply(payload).catch(() => {})
    }
  }
})

// Legacy text commands ("//set ff0000" and mention for help) kept for compatibility.
client.on('messageCreate', async msg => {
  if (!msg.guild || msg.system || msg.author.bot || !msg.member) return
  const ctx = messageContext(msg)
  if (msg.content === `<@${client.user.id}>` || msg.content === `<@!${client.user.id}>`) {
    return safeRun(ctx, 'help')
  }
  if (!msg.content.startsWith('//')) return
  const [cmd, arg] = msg.content.slice(2).split(/\s+/)
  if (['set', 'color', 'remove', 'setup', 'removeall'].includes(cmd)) {
    return safeRun(ctx, cmd, arg)
  }
})

logger.info('Logging in...')
client.login(process.env.TOKEN)
