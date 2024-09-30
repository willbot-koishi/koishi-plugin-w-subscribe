import { Context, h, Query, Schema, Service, Session, SessionError, Tables, Update, z } from 'koishi'
import yaml from 'js-yaml'

export interface SubscriptionRules {
    zero: {}
}

export type SubscriptionKind = keyof SubscriptionRules

export interface Subscriber {
    uid: string
}

export interface SubscribedMessage {
    id: number
    subscriber: string
    kind: string
    sender: string
    guild: string
    content: string
    timestamp: number
    hasRead: boolean
}

export interface SubscriptionFilter<K extends SubscriptionKind = SubscriptionKind> {
    (session: Session, config: SubscriptionRules[K], subscriber: Subscriber): boolean
}

export interface SubscriptionRule<K extends SubscriptionKind = SubscriptionKind> {
    kind: K
    filter: SubscriptionFilter<K>
    render: (session: Session, msg: SubscribedMessage) => string | Promise<string>
    schema: z<SubscriptionRules[K]>
}

export interface Subscription<K extends SubscriptionKind = SubscriptionKind> {
    id: number
    name: string
    uid: string
    kind: K
    config: SubscriptionRules[K]
}

declare module 'koishi' {
    interface Context {
        subscribe: SubscribeService
    }

    interface Tables {
        'w-subscribe-message': SubscribedMessage
        'w-subscribe-subscription': Subscription
    }
}

export const withKind = (kind: string) => (rule: SubscriptionRule) => rule.kind === kind

class SubscribeService extends Service {
    static readonly inject = [ 'database' ]

    private rules: SubscriptionRule[] = []

    private isKind = (str: string): str is SubscriptionKind => this.rules.some(withKind(str))

    constructor(ctx: Context, public config: SubscribeService.Config) {
        super(ctx, 'subscribe')

        ctx.model.extend('w-subscribe-subscription', {
            id: 'unsigned',
            name: 'string',
            uid: 'string',
            kind: 'string',
            config: 'json'
        }, {
            autoInc: true
        })

        ctx.model.extend('w-subscribe-message', {
            id: 'unsigned',
            subscriber: 'string',
            kind: 'string',
            sender: 'string',
            guild: 'string',
            content: 'string',
            timestamp: 'unsigned',
            hasRead: 'boolean'
        }, {
            autoInc: true
        })

        ctx.middleware(async (session, next) => {
            if (! this.config.doWrite) return

            const { uid: sender, guildId, gid, content, timestamp } = session
            if (! guildId) return

            const memberUids = (await session.bot.getGuildMemberList(guildId))
                .data.map(member => session.platform + ':' + member.user.id)
            const subscriptions = await ctx.database.get('w-subscribe-subscription', {
                uid: { $in: memberUids }
            })

            await Promise.all(subscriptions.map(({ uid, kind, config }) => {
                const rule = this.rules.find(withKind(kind))
                if (! rule) return
                const subscriber = { uid }
                if (rule.filter(session, config, subscriber)) {
                    return ctx.database.create('w-subscribe-message', {
                        subscriber: subscriber.uid,
                        sender,
                        guild: gid,
                        kind,
                        content,
                        timestamp,
                        hasRead: false
                    })
                }
            }))

            return next()
        })

        const getSubscriptionQuery = (label: string, uid: string): Query<Subscription> => {
            if (label[0] === '#') {
                const id = Number(label.slice(1))
                if (isNaN(id)) throw new SessionError(`${label} 不是合法的 id`)
                return { id }
            }
            return { uid, name: label }
        }

        const getSubscription = async (label: string, uid: string): Promise<Subscription> => {
            const [ subscription ] = await this.ctx.database.get('w-subscribe-subscription', getSubscriptionQuery(label, uid))
            if (subscription.uid !== uid) throw new SessionError(`你不是订阅 ${label} 的创建者`)
            if (! subscription) throw new SessionError(`未找到订阅 ${label}`)
            return subscription
        }

        const tryWith = <T>(fn: () => T, getMessage: (err: any) => string): T => {
            try {
                return fn()
            }
            catch (err) {
                throw new SessionError(getMessage(err))
            }
        }

        const loadConfig = <T>(configText: string, schema: z<T>): T => {
            const rawConfig = tryWith(() => yaml.load(configText) as any, err => `YAML 解析错误：${err}`)
            return tryWith(() => schema(rawConfig), err => `配置格式错误：${err}`)
        }

        ctx.command('subscribe', '消息订阅')

        ctx.command('subscribe.add <kind:string> <config:text>', '添加/修改订阅')
            .option('name', '-n <name:string> 设置订阅名称')
            .action(async ({ session: { uid }, options: { name } }, kind, configYaml) => {
                if (! this.isKind(kind)) return `订阅规则 [${kind}] 不存在`
                const rule = this.rules.find(withKind(kind))

                try {
                    const rawConfig = yaml.load(configYaml)
                    const config = rule.schema(rawConfig)
                    if (name) {
                        if (name[0] === '#') throw new SessionError('订阅名称不能以 # 开头')
                        const subscription = await getSubscription(name, uid)
                        if (subscription) throw new SessionError(`订阅名称 ${name} 与 #${subscription.id} 重复`)
                    }
                    const { id } = await this.ctx.database.create('w-subscribe-subscription', {
                        uid,
                        name,
                        kind,
                        config
                    })
                    return `已添加订阅 [${kind}] ${name || ''}#${id}`
                }
                catch (err) {
                    return `订阅配置解析失败：${err}`
                }
            })

        ctx.command('subscribe.modify <label:string>', '修改订阅')
            .option('name', '-n <name:string> 更改订阅名称')
            .option('config', '-c <config:text> 更改配置')
            .action(async ({ session: { uid }, options: { name: newName, config: newConfigText } }, label) => {
                const { id, name, kind } = await getSubscription(label, uid)
                if (! this.isKind(kind)) return `订阅 ${name || '未命名'}#${id} 已损坏：不存在的规则 [${kind}]`
                const rule = this.rules.find(withKind(kind))

                let update: Update<Subscription> = {}
                if (newName) update = { ...update, name: newName }
                if (newConfigText) update = { ...update, config: loadConfig(newConfigText, rule.schema) }
                if (! Object.keys(update).length) throw new SessionError('未作修改')
                await ctx.database.set('w-subscribe-subscription', id, update)
                return `已修改订阅 ${name || '未命名'}${newName ? '=>' + newName : ''}#${id}`
            })

        ctx.command('subscribe.remove <label:string>', '取消订阅')
            .action(async ({ session: { uid } }, label) => {
                const { id, name } = await getSubscription(label, uid)
                await this.ctx.database.remove('w-subscribe-subscription', id)
                return `已取消订阅 ${name || '未命名'}#${id}`
            })

        ctx.command('subscribe.query <label:string>', '查询订阅')
            .action(async ({ session: { uid } }, label) => {
                const { name, id, kind, config } = await getSubscription(label, uid)
                return `订阅 [${kind}] ${name || '未命名'}#${id}\n配置：\n` + yaml.dump(config, { indent: 2 })
            })

        ctx.command('subscribe.list', '列出所有订阅')
            .action(async ({ session: { uid } }) => {
                const subscriptions = await this.ctx.database.get('w-subscribe-subscription', { uid })
                const { length } = subscriptions
                if (! length) return '您没有订阅'
                return `您有 ${length} 个订阅：\n` + subscriptions
                    .map(({ id, name, kind }, index) => `${index + 1}. [${kind}] ${name || '未命名'}#${id}`)
                    .join('\n')
            })

        ctx.command('subscribe.check [kind:string]', '查看订阅的消息')
            .alias('sc')
            .option('clear', '-c 清除已读消息')
            .option('read', '-r 也查看已读消息')
            .option('global', '-G 查看所有群的消息（群内调用时，默认只查看本群消息）')
            .action(async ({ session, options }, kind) => {
                const { uid, guildId, gid } = session
                const messages = await ctx.database.get('w-subscribe-message', {
                    subscriber: uid,
                    kind: kind || {},
                    guild: (guildId && ! options.global) ? gid : {},
                    hasRead: (options.clear || options.read) ? {} : false
                })
                const { length } = messages
                if (! length) return '您没有订阅的消息'

                let removedCount = 0
                if (options.clear) {
                    removedCount = (await ctx.database.remove('w-subscribe-message', {
                        id: { $in: messages.map(messages => messages.id) }
                    })).removed
                }
                else {
                    await ctx.database.set('w-subscribe-message', {
                        id: { $in: messages.map(messages => messages.id) }
                    }, { hasRead: true })
                }

                const rendered = await Promise.all(messages.map(async (msg, index) => {
                    const rule = this.rules.find(withKind(msg.kind))
                    return `${index + 1}${msg.hasRead ? '.' : '*'} ${ kind ? '' : `[${msg.kind}] ` }${await rule.render(session, msg)}`
                }))

                return `您有 ${length} 条订阅的消息：${(removedCount ? `（已清除 ${removedCount} 条已读消息）` : '')}\n`
                    + rendered.join('\n')
            })

        ctx.command('subscribe.list-rules', '列出所有订阅规则')
            .action(() => {
                const { rules } = ctx.subscribe
                return `有 ${rules.length} 条订阅规则：` + rules.map(rule => `[${rule.kind}]`).join(', ')
            })
    }

    public rule<K extends keyof SubscriptionRules>(kind: K, rule: Omit<SubscriptionRule<K>, 'kind'>) {
        if (this.rules.some(withKind(kind))) return {
            dispose: () => {}
        }
        this.rules.push({ kind, ...rule })
        return {
            dispose: () => {
                const index = this.rules.findIndex(withKind(kind))
                if (index >= 0) this.rules.splice(index, 1)
            }
        }
    }

    public utils = {
        escapeAt: async (session: Session, msg: SubscribedMessage) => {
            const els = h.parse(msg.content)
            if (els.some(el => el.type === 'at')) {
                const { data: members } = await session.bot.getGuildMemberList(session.guildId)
                const memberDict = Object.fromEntries(members.map(member => [ member.user.id, member ]))
                return els.map(el => {
                    if (el.type === 'at') {
                        const { id } = el.attrs
                        const member = memberDict[id]
                        return `@${member?.nick || member?.user?.name || id}`
                    }
                    return el.toString()
                }).join('')
            }
            return msg.content
        }
    }
}

namespace SubscribeService {
    export interface Config {
        doWrite: boolean
    }

    export const Config: Schema<Config> = Schema.object({
        doWrite: z.boolean().default(true).description('是否写入订阅')
    })
}

export default SubscribeService