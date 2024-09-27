import { Context, Schema, Service, Session, z } from 'koishi'
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

const withKind = (kind: string) => (rule: SubscriptionRule) => rule.kind === kind

class SubscribeService extends Service {
    static readonly inject = [ 'database' ]

    private rules: SubscriptionRule[] = []

    private isKind = (str: string): str is SubscriptionKind => (str in this.rules)

    constructor(ctx: Context) {
        super(ctx, 'subscribe')

        ctx.model.extend('w-subscribe-subscription', {
            id: 'unsigned',
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
            const { uid: sender, guildId, gid, content, timestamp } = session
            if (! guildId) return

            const members = (await session.bot.getGuildMemberList(guildId))
                .data.map(member => session.platform + ':' + member.user.id)
            const subscriptions = await ctx.database.get('w-subscribe-subscription', {
                uid: { $in: members }
            })

            await Promise.all(subscriptions.map(({ uid, kind, config }) => {
                const rule = this.rules.find(withKind(kind))
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

        ctx.command('subscribe', '消息订阅')

        ctx.command('subscribe.add <kind:string> <config:text>', '订阅消息')
            .action(async ({ session: { uid } }, kind, configYaml) => {
                if (! this.isKind(kind)) return `订阅规则 ${kind} 不存在`
                const rule = this.rules.find(withKind(kind))

                try {
                    const rawConfig = yaml.load(configYaml)
                    const config = rule.schema(rawConfig)
                    const { id } = await this.ctx.database.create('w-subscribe-subscription', {
                        uid,
                        kind,
                        config
                    })
                    return `已添加订阅 [${kind}] #${id}`
                }
                catch (err) {
                    return `订阅配置解析失败：${err}`
                }
            })

        ctx.command('subscribe.remove <id:natural>', '取消订阅消息')
            .action(async ({ session: { uid } }, id) => {
                const [ subscription ] = await this.ctx.database.get('w-subscribe-subscription', id)
                if (! subscription) return `订阅 #${id} 不存在`
                if (subscription.uid !== uid) return `订阅 #${id} 不属于您`
                await this.ctx.database.remove('w-subscribe-subscription', id)
                return `已取消订阅 #${id}`
            })

        ctx.command('subscribe.list', '列出所有订阅')
            .action(async ({ session: { uid } }) => {
                const subscriptions = await this.ctx.database.get('w-subscribe-subscription', { uid })
                const { length } = subscriptions
                if (! length) return '您没有订阅'
                return `您有 ${length} 个订阅：\n` + subscriptions
                    .map(({ id, kind }, index) => `${index + 1}. [${kind}] #${id}`)
                    .join('\n')
            })

        ctx.command('subscribe.check [kind:string]', '查看订阅的消息')
            .option('clear', '-c 清除已读消息')
            .option('global', '-G 查看所有群的消息（群内调用时，默认只查看本群消息）')
            .action(async ({ session, options }, kind) => {
                const { uid, guildId, gid } = session
                const messages = await ctx.database.get('w-subscribe-message', {
                    subscriber: uid,
                    kind: kind || {},
                    guild: (guildId && ! options.global) ? gid : {}
                })
                const { length } = messages
                if (! length) return '您没有订阅的消息'
                return `您有 ${length} 条订阅的消息：\n` + (await Promise.all(messages.map(async (msg, index) => {
                    const rule = this.rules.find(withKind(msg.kind))
                    return `${index + 1}. ${ kind ? '' : `[${msg.kind}] ` }${await rule.render(session, msg)}`
                }))).join('\n')
            })

        ctx.command('subscribe.list-rules', '列出所有订阅规则')
            .action(() => {
                const { rules } = ctx.subscribe
                return `有 ${rules.length} 条订阅规则：` + rules.map(rule => `[${rule.kind}]`).join(', ')
            })
    }

    rule<K extends keyof SubscriptionRules>(kind: K, rule: Omit<SubscriptionRule<K>, 'kind'>) {
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
}

namespace SubscribeService {
    export interface Config {}

    export const Config: Schema<Config> = Schema.object({})
}

export default SubscribeService